import { Hono } from "hono";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import { TOOL_DEFINITIONS, handleToolCall, toCallToolResult } from "./tools.js";
import { HEADLESS_READER_TOOLS } from "../auth/headless.js";
import { WORKFLOW_TOOL_DEFINITIONS } from "./workflow-tools.js";
import { requestBaseUrl } from "../shared/base-url.js";
import {
  attributeRequest,
  clientToolField,
  connectionClient,
} from "../shared/client-metadata.js";
import { config } from "../config.js";
import { z } from "zod";

export const mcpRoutes = new Hono<AuthEnv>();

async function getCaller(userId: string): Promise<{ email: string; headless: boolean }> {
  const db = getDb();
  const user = await db
    .get("SELECT email, is_service FROM users WHERE id = ?", [userId]) as
    | { email: string; is_service: number | null }
    | undefined;
  return { email: user?.email || "anonymous@localhost", headless: !!user?.is_service };
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
): McpServer {
  const server = new McpServer(
    { name: `contextnest-${nestId}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Advertise the workflow-plane tools only when the flag is on — the same
  // gate the REST requireWorkflowPlane middleware applies. config is read per
  // request (the server is rebuilt per call), so toggling the flag at runtime
  // takes effect immediately.
  const allDefs = config.FEATURE_WORKFLOW_PLANE
    ? [...TOOL_DEFINITIONS, ...WORKFLOW_TOOL_DEFINITIONS]
    : TOOL_DEFINITIONS;
  // A headless access key is offered only the tools it may call (CU-wdqcq0314u);
  // handleToolCall refuses the rest regardless.
  const toolDefs = headless
    ? allDefs.filter((t) => HEADLESS_READER_TOOLS.has(t.name))
    : allDefs;

  for (const tool of toolDefs) {
    const props = (tool.inputSchema as any).properties || {};
    const required = (tool.inputSchema as any).required || [];
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, def] of Object.entries(props) as Array<
      [string, any]
    >) {
      let field: z.ZodTypeAny;
      if (def.type === "string") field = z.string();
      else if (def.type === "number") field = z.number();
      else if (def.type === "array") field = z.array(z.string());
      else field = z.any();

      if (!required.includes(key)) field = field.optional();
      shape[key] = field;
    }
    // Caller attribution rides on EVERY tool (spec §9.4) — declared here
    // rather than in each tool's inputSchema, so no tool can be added without
    // it and the divergence guard sees no new inline schema. Validated against
    // the engine's own schema inside handleToolCall.
    Object.assign(shape, clientToolField);

    server.tool(tool.name, tool.description, shape, async (args) => {
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
      });
      return toCallToolResult(out);
    });
  }

  return server;
}

// POST/GET/DELETE /nests/:nestId/mcp
mcpRoutes.all("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const caller = await getCaller(userId);
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
