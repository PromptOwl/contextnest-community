/**
 * /nests/:nestId/channels — agent team stream channels (PO-1179; S4: PO-1189
 * / PO-1190), experimental.
 *
 *   GET  /channels                     → { channels, most_recent, can_manage }   (?archived=1 adds archived ones)
 *   POST /channels        { name, purpose? } → 201 { channel }
 *   GET  /channels/:name               → { channel, posts, pagination, next_since }  (?limit=&offset=; latest activity first)
 *   GET  /channels/:name?thread=<id>   → { channel, thread: { post, replies } }
 *   GET  /channels/:name?since=<cursor> → { channel, messages, has_more, next_since }  (only what is new, oldest first)
 *   POST /channels/:name/read          → { channel }             (mark it read for the caller)
 *   POST /channels/:name/archive { archived? = true } → { channel }   (archived: false restores)
 *
 *   GET  /nests/:nestId/agent-handles  → { agents: [{ handle, wakeable }] }  (agentHandleRoutes; people added to the nest)
 *
 * `:name` takes the channel's name, "#name" or its node id (URL-encoded).
 *
 * Posting and replying are NOT here: they are the node's comment routes
 * (POST /nodes/<channel id>/annotations, …/annotations/:threadId/comments) and
 * MCP context_comment, which already carry the @mention fan-out. Those
 * handlers apply the channel posting rule (channel-service channelAccess):
 * people added to the nest post; the public and share-only callers don't.
 *
 * The nest middleware (app.ts) 404s every route here while
 * EXPERIMENTAL_AGENT_STREAM is off, license-gates them like the governance
 * views (GET included), 404s a caller with no access to the nest, and bumps
 * the POSTs to the write tier — except /read, which is the caller's own mark.
 * Each handler still checks its own rule through the service, so MCP and REST
 * share one gate.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { ValidationError } from "../shared/errors.js";
import {
  createChannel,
  listChannels,
  listKnownAgents,
  markChannelRead,
  readChannel,
  setChannelArchived,
} from "./channel-service.js";

export const channelRoutes = new Hono<AuthEnv>();
export const agentHandleRoutes = new Hono<AuthEnv>();

agentHandleRoutes.get("/", async (c) => c.json(await listKnownAgents(await caller(c))));

async function caller(c: any) {
  const userId = c.get("userId") as string;
  return {
    nestId: c.req.param("nestId") as string,
    userId,
    userEmail: await resolveCallerEmail(userId),
    // Artifact cards (PO-1181) may resolve links into other nests only for a
    // credential that isn't fenced to this one.
    crossNest: !c.get("nestScope"),
  };
}

async function jsonObject(c: any): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

channelRoutes.get("/", async (c) => {
  const archived = c.req.query("archived");
  return c.json(await listChannels(await caller(c), { includeArchived: archived === "1" || archived === "true" }));
});

channelRoutes.post("/", async (c) => {
  const body = await jsonObject(c);
  const who = await caller(c);
  const result = await createChannel(
    { ...who, client: attributeRequest(c, body.client) },
    { name: body.name, purpose: body.purpose },
  );
  return c.json(result, 201);
});

/** `:name` may be a node id, so it arrives URL-encoded. */
function channelParam(c: any): string {
  const raw = c.req.param("name") as string;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

channelRoutes.get("/:name", async (c) => {
  return c.json(
    await readChannel(await caller(c), {
      channel: channelParam(c),
      thread: c.req.query("thread"),
      since: c.req.query("since"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    }),
  );
});

channelRoutes.post("/:name/read", async (c) => c.json(await markChannelRead(await caller(c), channelParam(c))));

channelRoutes.post("/:name/archive", async (c) => {
  const body = await jsonObject(c);
  if (body.archived !== undefined && typeof body.archived !== "boolean") {
    throw new ValidationError("archived must be a boolean");
  }
  const who = await caller(c);
  return c.json(
    await setChannelArchived({ ...who, client: attributeRequest(c, body.client) }, channelParam(c), body.archived !== false),
  );
});
