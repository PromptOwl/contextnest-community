/**
 * Memory snowball routes (team chat C6, PO-1199). Thin: each handler parses
 * the body and calls the service its MCP twin calls, so the two can't drift.
 *
 *   POST /nests/:nestId/threads/:threadId/remember { message_id?, kind?, title?, summary?, folder? }
 *        → 201 { node, kind, source_thread, source_message_id, proposer, reply, existing: false }
 *        → 200 { …, existing: true }
 *   POST /nests/:nestId/threads/:threadId/correct  { message_id, node_id, replacement?, note? }
 *        → 201 / 200 { node, source_thread, source_message_id, proposer, reply, existing }
 *   GET  /nests/:nestId/decisions[?limit=&offset=]  → { decisions, pagination }
 *   GET  /nests/:nestId/channels/:name/knowledge    → { channel, nodes, open_proposals, counts }
 *   GET  /nests/:nestId/channels/:name/watch        → { watch }      (members)
 *   PUT  /nests/:nestId/channels/:name/watch { enabled?, mode?, quiet_minutes?, agent? } → { watch }   (owner/admin)
 *   POST /nests/:nestId/channels/:name/watch/run    → { result }     (owner/admin)
 *
 * Remember and correct are admitted at read tier by the nest middleware
 * (app.ts), like promote's cousins submit-review and the comment routes,
 * so a read-only member reaches the service and is told to ask a writer
 * (AC-C6-04) instead of the generic 403; the service holds the real gate
 * (canCreateInNest / canUserEdit). The channel routes follow the channels
 * switch (404 while EXPERIMENTAL_AGENT_STREAM is off, app.ts).
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { ValidationError } from "../shared/errors.js";
import { messageClient } from "../channels/message-meta.js";
import { rememberThread } from "./remember.js";
import { correctNode } from "./correct.js";
import { listDecisions } from "./decisions.js";
import { channelKnowledge } from "./knowledge.js";
import { getChannelWatch, runChannelWatchAs, setChannelWatch } from "./watcher.js";

export const memoryThreadRoutes = new Hono<AuthEnv>();
export const memoryChannelRoutes = new Hono<AuthEnv>();
export const decisionRoutes = new Hono<AuthEnv>();

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

async function caller(c: any) {
  const userId = c.get("userId") as string;
  return { nestId: c.req.param("nestId") as string, userId, userEmail: await resolveCallerEmail(userId) };
}

function channelParam(c: any): string {
  const raw = c.req.param("name") as string;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

memoryThreadRoutes.post("/:threadId/remember", async (c) => {
  const b = await jsonObject(c);
  const who = await caller(c);
  const client = attributeRequest(c, b.client);
  const result = await rememberThread(
    { ...who, client, replyClient: messageClient(client, b.client, c.get("apiKeyLabel")) },
    { thread: c.req.param("threadId"), message_id: b.message_id, kind: b.kind, title: b.title, summary: b.summary, folder: b.folder },
  );
  return c.json(result, result.existing ? 200 : 201);
});

memoryThreadRoutes.post("/:threadId/correct", async (c) => {
  const b = await jsonObject(c);
  const who = await caller(c);
  const client = attributeRequest(c, b.client);
  const result = await correctNode(
    { ...who, client, replyClient: messageClient(client, b.client, c.get("apiKeyLabel")) },
    { thread: c.req.param("threadId"), message_id: b.message_id, node_id: b.node_id, replacement: b.replacement, note: b.note },
  );
  return c.json(result, result.existing ? 200 : 201);
});

decisionRoutes.get("/", async (c) => c.json(await listDecisions(await caller(c), { limit: c.req.query("limit"), offset: c.req.query("offset") })));

memoryChannelRoutes.get("/:name/knowledge", async (c) => c.json(await channelKnowledge(await caller(c), channelParam(c))));

memoryChannelRoutes.get("/:name/watch", async (c) => c.json(await getChannelWatch(await caller(c), channelParam(c))));

memoryChannelRoutes.put("/:name/watch", async (c) => {
  const b = await jsonObject(c);
  return c.json(await setChannelWatch(await caller(c), channelParam(c), { enabled: b.enabled, mode: b.mode, quiet_minutes: b.quiet_minutes, agent: b.agent }));
});

memoryChannelRoutes.post("/:name/watch/run", async (c) => c.json(await runChannelWatchAs(await caller(c), channelParam(c))));
