import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import { TOOL_DEFINITIONS, handleToolCall, toCallToolResult } from "./tools.js";
import { WORKFLOW_TOOL_DEFINITIONS } from "./workflow-tools.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { config } from "../config.js";
import { z } from "zod";

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

    server.tool(tool.name, tool.description, shape, async (args) => {
      const engine = await engineCache.get(nestId);
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
