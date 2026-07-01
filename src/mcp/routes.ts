import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import { TOOL_DEFINITIONS, handleToolCall } from "./tools.js";
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
): McpServer {
  const server = new McpServer(
    { name: `contextnest-${nestId}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  for (const tool of TOOL_DEFINITIONS) {
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
      const text = await handleToolCall(tool.name, args, {
        storage: engine.storage,
        queryEngine: engine.query,
        versionManager: engine.versions,
        nestId,
        userId,
        userEmail,
      });
      return { content: [{ type: "text" as const, text }] };
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
  const server = createMcpServerForNest(nestId, userId, userEmail);

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
