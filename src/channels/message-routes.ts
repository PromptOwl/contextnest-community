/**
 * Message routes — team chat harness C1 (PO-1196), experimental, behind
 * EXPERIMENTAL_AGENT_STREAM like every channel route.
 *
 * Under /nests/:nestId/channels (channelMessageRoutes, mounted BEFORE
 * `/:name` so `search` is a route, not a channel; the name is reserved):
 *
 *   GET    /search?q=&channel=&from=&before=&after=&limit=&offset=  → { results, pagination, ceiling }
 *   GET    /:name/pins                               → { channel, pins }
 *   PATCH  /:name/messages/:id { body, client? }     → { message, mentions }          (author only)
 *   DELETE /:name/messages/:id { client? }           → { message }                    (author, or owner/admin)
 *   GET    /:name/messages/:id/history               → { message_id, edits }
 *   POST   /:name/messages/:id/reactions { emoji, client? } → { message_id, reactions }
 *   DELETE /:name/messages/:id/reactions/:emoji      → { message_id, reactions }
 *   POST   /:name/messages/:id/pin · DELETE …/pin    → { message }
 *   POST   /:name/messages/:id/save · DELETE …/save  → { message }
 *
 * `:id` is a message id, or a thread id for its opening message. The nest
 * middleware (app.ts) 404s all of these while the switch is off, licence-
 * gates them like the channel reads, and admits the writes at READ tier
 * (isChannelMessageAction): acting on a message is for every person added
 * to the nest, a read-only collaborator included (the service checks). A
 * read-only API key is refused by the capability gate before any of this.
 *
 * Under /nests/:nestId/messages (messageLookupRoutes):
 *   GET /:messageId → { channel, thread_id, reply, message }   the permalink lookup
 *
 * Under /me (meChatRoutes; a session or an unscoped key, as every /me route):
 *   GET /saved?limit=&offset=  → { saved, pagination }
 *   GET /chat/search?q=…       → { results, pagination, ceiling }   across the caller's member nests
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { listVisibleNests } from "../nests/service.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { ValidationError } from "../shared/errors.js";
import { messageClient } from "./message-meta.js";
import { RateLimitedError, locateMessage, viewOf, type ActingCaller } from "./message-access.js";
import { addReaction, removeReaction } from "./reactions.js";
import { deleteMessage, editMessage, messageHistory } from "./message-edits.js";
import { listPins, pinMessage, unpinMessage } from "./pins.js";
import { listSaved, parseSavedPaging, saveMessage, unsaveMessage } from "./saved.js";
import { searchAcrossNests, searchChannelMessages } from "./message-search.js";
import { getDb } from "../db/client.js";

export const channelMessageRoutes = new Hono<AuthEnv>();
export const messageLookupRoutes = new Hono<AuthEnv>();
export const meChatRoutes = new Hono<AuthEnv>();

/** A 429 carries Retry-After; everything else goes to the app's handler. */
for (const app of [channelMessageRoutes, messageLookupRoutes, meChatRoutes]) {
  app.onError((err, c) => {
    if (err instanceof RateLimitedError) {
      return c.json({ error: err.message }, 429, { "Retry-After": String(err.retryAfterSeconds) });
    }
    throw err;
  });
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

function decoded(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The caller with the attribution of THIS call (a declared agent only;
 *  a bare key label is not an agent — message-meta.ts messageClient). */
async function actingCaller(c: any, supplied: unknown): Promise<ActingCaller> {
  const userId = c.get("userId") as string;
  return {
    nestId: c.req.param("nestId") as string,
    userId,
    userEmail: await resolveCallerEmail(userId),
    crossNest: !c.get("nestScope"),
    client: messageClient(attributeRequest(c, supplied), supplied, c.get("apiKeyLabel")),
  };
}

const name = (c: any) => decoded(c.req.param("name") as string);
const id = (c: any) => decoded(c.req.param("id") as string);

channelMessageRoutes.get("/search", async (c) => {
  const who = await actingCaller(c, undefined);
  const nest = (await getDb().get("SELECT name FROM nests WHERE id = ?", [who.nestId])) as { name: string } | undefined;
  return c.json(
    await searchChannelMessages(who, nest?.name ?? null, {
      q: c.req.query("q"),
      channel: c.req.query("channel"),
      from: c.req.query("from"),
      before: c.req.query("before"),
      after: c.req.query("after"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    }),
  );
});

channelMessageRoutes.get("/:name/pins", async (c) => c.json(await listPins(await actingCaller(c, undefined), name(c))));

channelMessageRoutes.patch("/:name/messages/:id", async (c) => {
  const body = await jsonObject(c);
  return c.json(await editMessage(await actingCaller(c, body.client), name(c), id(c), body.body, requestBaseUrl(c.req.url)));
});

channelMessageRoutes.delete("/:name/messages/:id", async (c) => {
  const body = await jsonObject(c);
  return c.json(await deleteMessage(await actingCaller(c, body.client), name(c), id(c)));
});

channelMessageRoutes.get("/:name/messages/:id/history", async (c) =>
  c.json(await messageHistory(await actingCaller(c, undefined), name(c), id(c))),
);

channelMessageRoutes.post("/:name/messages/:id/reactions", async (c) => {
  const body = await jsonObject(c);
  return c.json(await addReaction(await actingCaller(c, body.client), name(c), id(c), body.emoji));
});

channelMessageRoutes.delete("/:name/messages/:id/reactions/:emoji", async (c) =>
  c.json(await removeReaction(await actingCaller(c, undefined), name(c), id(c), decoded(c.req.param("emoji") as string))),
);

channelMessageRoutes.post("/:name/messages/:id/pin", async (c) => {
  const body = await jsonObject(c);
  return c.json(await pinMessage(await actingCaller(c, body.client), name(c), id(c)));
});
channelMessageRoutes.delete("/:name/messages/:id/pin", async (c) =>
  c.json(await unpinMessage(await actingCaller(c, undefined), name(c), id(c))),
);

channelMessageRoutes.post("/:name/messages/:id/save", async (c) => {
  const body = await jsonObject(c);
  return c.json(await saveMessage(await actingCaller(c, body.client), name(c), id(c)));
});
channelMessageRoutes.delete("/:name/messages/:id/save", async (c) =>
  c.json(await unsaveMessage(await actingCaller(c, undefined), name(c), id(c))),
);

// ─── Permalink lookup ───────────────────────────────────────────────────

export interface MessageLookup {
  channel: Awaited<ReturnType<typeof locateMessage>>["view"];
  thread_id: string;
  reply: boolean;
  message: Awaited<ReturnType<typeof viewOf>>;
}

export async function lookupMessage(caller: ActingCaller, rawId: unknown): Promise<MessageLookup> {
  const located = await locateMessage(caller, null, rawId);
  const message = await viewOf(caller, located);
  return { channel: located.view, thread_id: located.row.thread_id, reply: located.reply, message };
}

messageLookupRoutes.get("/:messageId", async (c) =>
  c.json(await lookupMessage(await actingCaller(c, undefined), decoded(c.req.param("messageId") as string))),
);

// ─── /me ────────────────────────────────────────────────────────────────

const OFF = { error: "Not found" };

async function visibleNestNames(userId: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const n of await listVisibleNests(userId)) names.set(n.id, n.name ?? n.id);
  return names;
}

meChatRoutes.get("/saved", async (c) => {
  if (!config.EXPERIMENTAL_AGENT_STREAM) return c.json(OFF, 404);
  const userId = c.get("userId") as string;
  return c.json(
    await listSaved({
      userId,
      email: await resolveCallerEmail(userId),
      nestNames: await visibleNestNames(userId),
      ...parseSavedPaging({ limit: c.req.query("limit"), offset: c.req.query("offset") }),
    }),
  );
});

meChatRoutes.get("/chat/search", async (c) => {
  if (!config.EXPERIMENTAL_AGENT_STREAM) return c.json(OFF, 404);
  const userId = c.get("userId") as string;
  return c.json(
    await searchAcrossNests({ userId, userEmail: await resolveCallerEmail(userId) }, await visibleNestNames(userId), {
      q: c.req.query("q"),
      channel: c.req.query("channel"),
      from: c.req.query("from"),
      before: c.req.query("before"),
      after: c.req.query("after"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    }),
  );
});
