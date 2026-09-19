import { Hono } from "hono";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import { TOOL_DEFINITIONS, handleToolCall, toCallToolResult } from "./tools.js";
import { WORKFLOW_TOOL_DEFINITIONS } from "./workflow-tools.js";
import { requestBaseUrl } from "../shared/base-url.js";
import {
  attributeRequest,
  connectionClient,
} from "../shared/client-metadata.js";
import { toolShape } from "./tool-shape.js";
import { config } from "../config.js";

export const mcpRoutes = new Hono<AuthEnv>();

async function getUserEmail(userId: string): Promise<string> {
  const db = getDb();
  const user = await db
    .get("SELECT email FROM users WHERE id = ?", [userId]) as { email: string } | undefined;
  return user?.email || "anonymous@localhost";
}

function createMcpServerForNest(
  nestId: string,
  userId: string,
  userEmail: string,
  baseUrl: string,
  c: Context<AuthEnv>,
): McpServer {
  const server = new McpServer(
    { name: `contextnest-${nestId}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Advertise the workflow-plane tools only when the flag is on — the same
  // gate the REST requireWorkflowPlane middleware applies. config is read per
  // request (the server is rebuilt per call), so toggling the flag at runtime
  // takes effect immediately.
  const toolDefs = config.FEATURE_WORKFLOW_PLANE
    ? [...TOOL_DEFINITIONS, ...WORKFLOW_TOOL_DEFINITIONS]
    : TOOL_DEFINITIONS;

  for (const tool of toolDefs) {
    server.tool(tool.name, tool.description, toolShape(tool), async (args) => {
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
  const userEmail = await getUserEmail(userId);
  // Create a fresh server per request (stateless) with the current user's identity
  const server = createMcpServerForNest(
    nestId,
    userId,
    userEmail,
    requestBaseUrl(c.req.url),
    c,
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
