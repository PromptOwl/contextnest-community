import { Hono } from "hono";
import { credentialMayContribute } from "../governance/org-contribution.js";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import {
  TOOL_DEFINITIONS,
  MCP_READ_TOOLS,
  MCP_ADMIN_TOOLS,
  toolShape,
  handleToolCall,
  toCallToolResult,
} from "./tools.js";
import { toolAnnotations, toolTitle } from "./annotations.js";
import { SERVICE_VERSION } from "../shared/version.js";
import { HEADLESS_READER_TOOLS } from "../auth/headless.js";
import { WORKFLOW_TOOL_DEFINITIONS } from "./workflow-tools.js";
import { PLUGIN_TOOL_DEFINITIONS } from "./plugin-tools.js";
import { METACOGNITION_TOOL_DEFINITIONS } from "./metacognition-tools.js";
import { metacognitionEnabled } from "../metacognition/manage.js";
import { SURFACES_TOOL_DEFINITIONS } from "./surfaces-tools.js";
import { surfacesEnabled } from "../surfaces/flags.js";
import { requestBaseUrl } from "../shared/base-url.js";
import {
  attributeRequest,
  connectionClient,
} from "../shared/client-metadata.js";
import { config } from "../config.js";
import { isInitializeRequest, nestConnectInstructions } from "./connect-instructions.js";

export const mcpRoutes = new Hono<AuthEnv>();

async function getCaller(
  userId: string,
): Promise<{ email: string; headless: boolean; person: boolean }> {
  const db = getDb();
  const user = await db.get(
    `SELECT u.email, u.is_service,
            (SELECT 1 FROM system_accounts sa WHERE sa.user_id = u.id) AS is_system
       FROM users u WHERE u.id = ?`,
    [userId],
  ) as
    | { email: string; is_service: number | null; is_system: number | null }
    | undefined;
  return {
    email: user?.email || "anonymous@localhost",
    // A named system (CU-wdqcq0538g) is a service identity but not a headless
    // reader — it gets its collaborator-row access, not the reader clamp.
    headless: !!user?.is_service && !user?.is_system,
    person: !user?.is_service,
  };
}

function createMcpServerForNest(
  nestId: string,
  userId: string,
  userEmail: string,
  baseUrl: string,
  apiKeyId: string | null,
  apiKeyLabel: string | null,
  c: Context<AuthEnv>,
  headless = false,
  capability: "read" | "write" = "write",
  /** A person holding a full credential who administers this nest — gates
   *  MCP_ADMIN_TOOLS (each call is re-checked in the service layer). */
  isNestAdmin = false,
  /** Returned in the `initialize` result — CONTEXT.md plus the nest's
   *  always-include documents (connect-instructions.ts). */
  instructions?: string,
): McpServer {
  const server = new McpServer(
    { name: `contextnest-${nestId}`, title: "ContextNest", version: SERVICE_VERSION },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );

  // Advertise the workflow-plane tools only when the flag is on — the same
  // gate the REST requireWorkflowPlane middleware applies. config is read per
  // request (the server is rebuilt per call), so toggling the flag at runtime
  // takes effect immediately.
  // Nest Plugin tools follow FEATURE_PLUGINS the same way (REST 404s when off),
  // independently of the workflow plane.
  // Metacognition tools need FEATURE_METACOGNITION as well (the REST
  // requireMetacognition gate), and are admin tools on top.
  const allDefs = [
    ...TOOL_DEFINITIONS,
    ...(config.FEATURE_WORKFLOW_PLANE
      ? [
          ...WORKFLOW_TOOL_DEFINITIONS,
          ...(metacognitionEnabled() ? METACOGNITION_TOOL_DEFINITIONS : []),
          ...(surfacesEnabled() ? SURFACES_TOOL_DEFINITIONS : []),
        ]
      : []),
    ...(config.FEATURE_PLUGINS ? PLUGIN_TOOL_DEFINITIONS : []),
  ];
  // A headless access key is offered only the tools it may call (CU-wdqcq0314u);
  // handleToolCall refuses the rest regardless.
  const toolDefs = headless
    ? allDefs.filter((t) => HEADLESS_READER_TOOLS.has(t.name))
    : allDefs;

  for (const tool of toolDefs) {
    // A read-only key is only ADVERTISED the read tools, so tools/list tells
    // the agent the truth. runTool still refuses a write tool on its own
    // (the SDK answers an unregistered name with an error before that).
    if (capability === "read" && !MCP_READ_TOOLS.has(tool.name)) continue;
    // Admin tools are only advertised to the people who may use them.
    if (MCP_ADMIN_TOOLS.has(tool.name) && !isNestAdmin) continue;
    // `client` is validated against the engine's own schema in handleToolCall.
    const shape = toolShape(tool.name, tool.inputSchema);

    const meta = { title: toolTitle(tool.name), description: tool.description, inputSchema: shape, annotations: toolAnnotations(tool.name) };
    server.registerTool(tool.name, meta, async (args: Record<string, any>) => {
      const engine = await engineCache.get(nestId);
      // Caller attribution (§9.4.2), resolved HERE rather than when the server
      // was built: the `initialize` handshake completes inside the transport,
      // so `clientInfo` only exists once a call is being served. A `client`
      // sent with the tool call itself still wins, per key, in handleToolCall.
      // `attributeRequest` also stashes this on the request for the REST trace
      // middleware; that is inert here, since app.ts skips `/mcp` paths and the
      // MCP row is written by the tool logger with the FULLY merged client (the
      // tool call's own `client` wins over what is derived here).
      const client = attributeRequest(c, undefined, connectionClient(server));
      // Audit logging happens inside handleToolCall (covers per-nest +
      // server-level MCP, and thrown calls).
      const out = await handleToolCall(tool.name, args, {
        storage: engine.storage,
        queryEngine: engine.query,
        versionManager: engine.versions,
        nestId,
        userId,
        userEmail,
        baseUrl,
        apiKeyId,
        apiKeyLabel,
        client,
        capability,
        contributorCredential: credentialMayContribute(c),
      });
      return toCallToolResult(out);
    });
  }

  return server;
}

/**
 * Stateless transport: POST only. No standalone SSE stream and no session to
 * delete, so GET/DELETE (and anything else) answer 405 — the spec's "no stream
 * offered". Serving GET instead built a full server, opened an SSE stream and
 * closed it at once — clients reconnected in a tight loop and pinned prod's
 * CPU (Nov 2026 incident). OPTIONS never gets here: cors() answers it first.
 */
export const mcpNoStream = (c: Context) =>
  c.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    405,
    { Allow: "POST" },
  );

// POST /nests/:nestId/mcp
mcpRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const caller = await getCaller(userId);
  // The connect message carries the nest's rules (CU-wdqcq05rn0). Resolved
  // only for the initialize request — every tool call rebuilds this server.
  const instructions = (await isInitializeRequest(c.req.raw))
    ? await nestConnectInstructions(
        nestId,
        { userId, userEmail: caller.email },
        { headless: caller.headless },
      )
    : undefined;
  // Create a fresh server per request (stateless) with the current user's identity
  const server = createMcpServerForNest(
    nestId,
    userId,
    caller.email,
    requestBaseUrl(c.req.url),
    c.get("apiKeyId") ?? null,
    c.get("apiKeyLabel") ?? null,
    c,
    caller.headless,
    c.get("keyCapability") ?? "write",
    caller.person &&
      (c.get("keyCapability") ?? "write") === "write" &&
      (c.get("nestPermission") === "owner" || c.get("nestPermission") === "admin"),
    instructions,
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.server.connect(transport);

  try {
    const response = await transport.handleRequest(c.req.raw);
    return response;
  } finally {
    await transport.close();
    await server.server.close();
  }
});
mcpRoutes.all("/", mcpNoStream);
