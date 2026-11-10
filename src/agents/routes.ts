/**
 * /nests/:nestId — the nest in the conversation (team chat C7, PO-1198).
 * Experimental, behind EXPERIMENTAL_AGENT_STREAM (the nest middleware 404s
 * every route here while it is off).
 *
 *   POST /ask { channel | thread, question, post? }   → { answer, cited, proposals, posted, trail }
 *   GET  /agents                                       → { agents }
 *   GET  /agents/:handle                               → { agent }          (did / knows / wake)
 *   PATCH /agents/:handle { description }              → { agent }          (owner/admin)
 *   POST /threads/:threadId/handoff { to, note? }      → 201 { handoff, message, mentions }
 *   POST /handoffs/:messageId/accept | /done { note? } → { handoff, message }
 *
 * Thin: each handler calls the service its MCP twin calls (mcp/agent-tools.ts)
 * and returns that object. Hootie's answer and proposal cards are posted by
 * the service (src/agents/ask-nest.ts); proposals are decided with the
 * ordinary review routes (`POST …/nodes/:id/approve` · `/reject`), not here.
 *
 * Tiers (app.ts): /ask, /handoff, /accept and /done are member actions (a
 * read-only collaborator may), so they are not bumped to the write tier; a
 * read-only API key is still refused /ask (it spends model credits, as the
 * chat route) and every other POST (capability gate). PATCH /agents is write
 * tier and the handler asks for owner/admin.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { messageClient } from "../channels/message-meta.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { ValidationError } from "../shared/errors.js";
import { askNest, NoModelKeyError } from "./ask-nest.js";
import { getAgent, listAgents, setAgentDescription } from "./profiles.js";
import { createHandoff, updateHandoff } from "./handoffs.js";

export const agentRoutes = new Hono<AuthEnv>();

async function caller(c: any) {
  const userId = c.get("userId") as string;
  return { nestId: c.req.param("nestId") as string, userId, userEmail: await resolveCallerEmail(userId), baseUrl: requestBaseUrl(c.req.url) };
}

async function jsonObject(c: any): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("request body must be a JSON object");
  return body as Record<string, unknown>;
}

agentRoutes.post("/ask", async (c) => {
  const body = await jsonObject(c);
  try {
    return c.json(await askNest(await caller(c), { channel: body.channel, thread: body.thread, question: body.question, post: body.post === true }));
  } catch (err) {
    if (err instanceof NoModelKeyError) return c.json({ error: err.message, reason: err.reason }, 503);
    throw err;
  }
});

agentRoutes.get("/agents", async (c) => c.json(await listAgents(await caller(c))));
agentRoutes.get("/agents/:handle", async (c) => c.json(await getAgent(await caller(c), c.req.param("handle"))));
agentRoutes.patch("/agents/:handle", async (c) => {
  const body = await jsonObject(c);
  return c.json(await setAgentDescription(await caller(c), c.req.param("handle"), body.description));
});

agentRoutes.post("/threads/:threadId/handoff", async (c) => {
  const body = await jsonObject(c);
  const who = await caller(c);
  // The handoff is a message: an agent only when the caller declared one, a
  // bare key label is not (channels/message-meta.ts).
  const client = messageClient(attributeRequest(c, body.client), body.client, c.get("apiKeyLabel"));
  const result = await createHandoff({ ...who, client }, c.req.param("threadId"), { to: body.to, note: body.note });
  return c.json(result, 201);
});

for (const status of ["accepted", "done"] as const) {
  agentRoutes.post(`/handoffs/:messageId/${status === "accepted" ? "accept" : "done"}`, async (c) => {
    const body = await jsonObject(c);
    const who = await caller(c);
    const client = messageClient(attributeRequest(c, body.client), body.client, c.get("apiKeyLabel"));
    return c.json(await updateHandoff({ ...who, client }, c.req.param("messageId"), status, body.note));
  });
}
