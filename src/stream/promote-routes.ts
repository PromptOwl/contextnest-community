/**
 * POST /nests/:nestId/threads/:threadId/promote { kind?: "decision" | "task", title?, summary?, folder? }
 *   → 201 { node, source_thread, reply, existing: false }
 *   → 200 { node, source_thread, reply, existing: true }   (this thread already has a node of that kind)
 *
 * Promote a comment thread — a channel post or a document comment thread — to
 * a decision or task node (PO-1181; stream/promote.ts has the rules). The
 * thread id names the thread on its own (threads are scoped to a nest), so
 * the route needs no node path. The nest middleware (app.ts) holds every POST
 * here at the write tier; the service checks node read, create and channel
 * posting rights itself, so MCP `context_promote_thread` shares the gate.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { ValidationError } from "../shared/errors.js";
import { promoteThread } from "./promote.js";
import { messageClient } from "../channels/message-meta.js";

export const promoteRoutes = new Hono<AuthEnv>();

promoteRoutes.post("/:threadId/promote", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const userId = c.get("userId") as string;
  const client = attributeRequest(c, b.client);
  const result = await promoteThread(
    {
      nestId: c.req.param("nestId") as string,
      userId,
      userEmail: await resolveCallerEmail(userId),
      client,
      replyClient: messageClient(client, b.client, c.get("apiKeyLabel")),
    },
    { thread: c.req.param("threadId"), kind: b.kind, title: b.title, summary: b.summary, folder: b.folder },
  );
  return c.json(result, result.existing ? 200 : 201);
});
