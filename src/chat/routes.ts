/**
 * Team chat harness C2 routes (PO-1197).
 *
 *   /nests/:nestId/conversations            conversationRoutes
 *     GET  /                                → { conversations }               (mine, latest activity first)
 *     POST /            { members }         → 201 { conversation, created: true } | 200 { …, created: false }
 *     GET  /:cid[?thread=|since=|limit=|offset=] → { conversation, posts | thread | messages, … }
 *     POST /:cid/read                       → { conversation }
 *     POST /:cid/leave                      → { left: true, conversation }     (group only)
 *     POST /:cid/members { member }         → { conversation }                 (group only)
 *
 *   /nests/:nestId/channels                 channelMembershipRoutes (beside channels/routes.ts)
 *     GET  /:name/members                   → { channel, private, members }
 *     POST /:name/members { member }        → { channel, private, members }    (writers or channel members)
 *     POST /:name/join                      → { channel }                      (public channels)
 *     POST /:name/leave                     → { left: true, channel }
 *     POST /:name/private { private }       → { channel }                      (owner/admin)
 *
 *   /nests/:nestId/chat                     chatRoutes (beside Hootie's POST /chat)
 *     GET   /settings                       → { chat, updated_by, updated_at }
 *     PATCH /settings { chat }              → the same                         (owner/admin)
 *     GET   /presence                       → { active: [...] }
 *     POST  /presence { status?, client? }  → { ok, expires_in }
 *     POST  /typing { conversation }        → { ok }
 *     GET   /events                         → text/event-stream
 *
 *   /me/chat                                meChatRoutes
 *     GET /preferences                      → { default, nests }
 *     PUT /preferences { nest_id, conversation?, level } → { preference }
 *     GET /unread                           → { total, mentions, nests }
 *
 * The nest middleware (app.ts) answers 404 for all of these while the server
 * switch or the nest's chat setting is off (except GET/PATCH /chat/settings,
 * gated by the server switch only, so chat can be turned back on), admits
 * the POSTs at read tier (a read collaborator may message; the capability
 * gate still refuses read-only keys), and license-gates them like channels.
 * Each handler checks its own rule through the service, as MCP does.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { isNestMember } from "../channels/channel-service.js";
import { messageClient, displayNames } from "../channels/message-meta.js";
import {
  addConversationMember,
  findOrCreateConversation,
  leaveConversation,
  listConversations,
  markConversationRead,
  readConversation,
} from "./conversations.js";
import { inviteChannelMember, joinChannel, leaveChannel, listChannelMembers, setChannelPrivate } from "./members.js";
import { getNestChatSettings, nestChatEnabled, setNestChat } from "./settings.js";
import { activePresence, heartbeat, parseStatus, PRESENCE_TTL_MS, typing } from "./presence.js";
import { canReadContainer, getPreferences, setPreference } from "./preferences.js";
import { chatUnreadSummary } from "./unread.js";
import { containerReadVerdict } from "./containers.js";
import { heartbeatMs, latestEventId, mayOpenStream, replaySince, subscribeChat, type StoredChatEvent } from "./events.js";
import { tryConsume } from "../shared/rate-limit.js";

/** Unread summaries one person may ask for per minute. */
const UNREAD_BUDGET = { max: 60, windowMs: 60_000 };

export const conversationRoutes = new Hono<AuthEnv>();
export const channelMembershipRoutes = new Hono<AuthEnv>();
export const chatRoutes = new Hono<AuthEnv>();
export const meChatRoutes = new Hono<AuthEnv>();

async function caller(c: any) {
  const userId = c.get("userId") as string;
  return { nestId: c.req.param("nestId") as string, userId, userEmail: await resolveCallerEmail(userId), crossNest: !c.get("nestScope") };
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

function param(c: any, name: string): string {
  const raw = c.req.param(name) as string;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ─── conversations ──────────────────────────────────────────────────────

conversationRoutes.get("/", async (c) => c.json(await listConversations(await caller(c))));

conversationRoutes.post("/", async (c) => {
  const body = await jsonObject(c);
  const result = await findOrCreateConversation(await caller(c), body.members);
  return c.json(result, result.created ? 201 : 200);
});

conversationRoutes.get("/:cid", async (c) =>
  c.json(
    await readConversation(await caller(c), {
      conversation: param(c, "cid"),
      thread: c.req.query("thread"),
      since: c.req.query("since"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    }),
  ),
);

conversationRoutes.post("/:cid/read", async (c) => c.json(await markConversationRead(await caller(c), param(c, "cid"))));
conversationRoutes.post("/:cid/leave", async (c) => c.json(await leaveConversation(await caller(c), param(c, "cid"))));
conversationRoutes.post("/:cid/members", async (c) => {
  const body = await jsonObject(c);
  return c.json(await addConversationMember(await caller(c), param(c, "cid"), body.member));
});

// ─── channel membership ─────────────────────────────────────────────────

channelMembershipRoutes.get("/:name/members", async (c) => c.json(await listChannelMembers(await caller(c), param(c, "name"))));
channelMembershipRoutes.post("/:name/members", async (c) => {
  const body = await jsonObject(c);
  return c.json(await inviteChannelMember(await caller(c), param(c, "name"), body.member));
});
channelMembershipRoutes.post("/:name/join", async (c) => c.json(await joinChannel(await caller(c), param(c, "name"))));
channelMembershipRoutes.post("/:name/leave", async (c) => c.json(await leaveChannel(await caller(c), param(c, "name"))));
channelMembershipRoutes.post("/:name/private", async (c) => {
  const body = await jsonObject(c);
  return c.json(await setChannelPrivate(await caller(c), param(c, "name"), body.private));
});

// ─── chat: settings, presence, typing, events ───────────────────────────

chatRoutes.get("/settings", async (c) => {
  const who = await caller(c);
  if (!(await isNestMember(who.nestId, who.userId))) throw new NotFoundError("Not found");
  return c.json(await getNestChatSettings(who.nestId));
});

chatRoutes.patch("/settings", async (c) => {
  const body = await jsonObject(c);
  const who = await caller(c);
  return c.json(await setNestChat(who.nestId, who.userId, { chat: body.chat }));
});

/** Members only; the same 404 as for a nest the caller can't see. */
async function member(c: any) {
  const who = await caller(c);
  if (!(await isNestMember(who.nestId, who.userId))) throw new NotFoundError("Not found");
  return who;
}

chatRoutes.get("/presence", async (c) => {
  const who = await member(c);
  return c.json({ active: await activePresence(who.nestId), expires_in: PRESENCE_TTL_MS / 1000 });
});

chatRoutes.post("/presence", async (c) => {
  const body = await jsonObject(c);
  const who = await member(c);
  const status = parseStatus(body.status);
  // Shown as the agent only when the caller DECLARED one (message-meta.ts).
  const client = messageClient(attributeRequest(c, body.client), body.client, c.get("apiKeyLabel"));
  if (!heartbeat(who.nestId, { userId: who.userId, email: who.userEmail, agent: client?.agent ?? null }, status)) {
    return c.json({ error: "Too many heartbeats — one every few seconds is plenty." }, 429, { "Retry-After": "10" });
  }
  return c.json({ ok: true, expires_in: PRESENCE_TTL_MS / 1000 });
});

chatRoutes.post("/typing", async (c) => {
  const body = await jsonObject(c);
  const who = await member(c);
  const container = typeof body.conversation === "string" ? body.conversation.trim() : "";
  if (!container) throw new ValidationError("conversation is required — a channel node id or a conversation id.");
  if (!(await canReadContainer(who.nestId, container, who.userId, who.userEmail))) throw new NotFoundError("Conversation not found");
  const client = messageClient(attributeRequest(c, body.client), body.client, c.get("apiKeyLabel"));
  const name = (await displayNames([who.userEmail])).get(who.userEmail.toLowerCase()) ?? who.userEmail;
  if (!typing(who.nestId, container, { userId: who.userId, email: who.userEmail, name, agent: client?.agent ?? null })) {
    return c.json({ error: "Too many typing signals." }, 429, { "Retry-After": "5" });
  }
  return c.json({ ok: true });
});

/** How long a per-stream "may this user see this container" answer is kept. */
const VISIBILITY_CACHE_MS = 5_000;

chatRoutes.get("/events", async (c) => {
  const who = await member(c);
  const verdict = mayOpenStream(who.nestId, who.userId);
  if (verdict !== "ok") {
    return c.json(
      { error: verdict === "too_many" ? "Too many open event streams for this nest. Close one first." : "Too many stream connections in a short time." },
      429,
      { "Retry-After": "5" },
    );
  }
  const lastEventId = c.req.header("Last-Event-ID") ?? c.req.query("last_event_id") ?? undefined;
  const replay = replaySince(who.nestId, lastEventId);
  // A buffered event meant for one person (their own read mark) is replayed
  // to that person only, as it was delivered live.
  const missed = replay.events.filter((ev) => !ev.only || ev.only === who.userId);
  const tooOld = replay.tooOld;

  // May this subscriber see an event about this container? Public channels
  // and nest-wide events: yes. A conversation or a private channel: members
  // only, answered once per container per few seconds, and forgotten the
  // moment the membership of that container changes.
  const seen = new Map<string, { ok: boolean; exp: number }>();
  const canSee = async (ev: StoredChatEvent): Promise<boolean> => {
    const container = typeof ev.event.conversation === "string" ? ev.event.conversation : null;
    if (!container) return true;
    if (ev.event.type === "membership.changed") seen.delete(container);
    const hit = seen.get(container);
    const now = Date.now();
    if (hit && hit.exp > now) return hit.ok;
    const v = await containerReadVerdict(who.nestId, container, who.userId).catch(() => false);
    const ok = v !== false;
    seen.set(container, { ok, exp: now + VISIBILITY_CACHE_MS });
    return ok;
  };

  return streamSSE(c, async (stream) => {
    // Both hang-up signals (the stream's own abort and the request's) end
    // the subscription, as Hootie's chat does.
    const cancel = new AbortController();
    const hangUp = () => cancel.abort();
    stream.onAbort(hangUp);
    c.req.raw.signal.addEventListener("abort", hangUp, { once: true });

    // Events are written in order, one at a time: a queue drained by one
    // writer, so a burst can't interleave frames.
    const queue: StoredChatEvent[] = [];
    let draining = false;
    let wake: (() => void) | null = null;
    const push = (ev: StoredChatEvent) => {
      queue.push(ev);
      wake?.();
    };
    const unsubscribe = subscribeChat(who.nestId, { userId: who.userId, deliver: push });
    const write = async (ev: StoredChatEvent) => {
      if (!(await canSee(ev))) return;
      await stream.writeSSE({ id: String(ev.id), event: String(ev.event.type), data: JSON.stringify(ev.event) });
    };
    // Every heartbeat also re-asks whether the person is still added to the
    // nest with chat on: someone removed from the nest stops hearing it.
    const heartbeat = setInterval(() => {
      void (async () => {
        if (!(await isNestMember(who.nestId, who.userId)) || !(await nestChatEnabled(who.nestId))) return hangUp();
        await stream.write(": ping\n\n");
      })().catch(hangUp);
    }, heartbeatMs());
    try {
      await stream.writeSSE({ id: String(latestEventId()), event: "hello", data: JSON.stringify({ nest_id: who.nestId, resume: !tooOld }) });
      if (tooOld) await stream.writeSSE({ event: "reset", data: JSON.stringify({ reason: "Last-Event-ID is older than the buffer; re-read with ?since=." }) });
      for (const ev of missed) await write(ev);
      while (!cancel.signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            cancel.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          wake = null;
          continue;
        }
        if (draining) continue;
        draining = true;
        try {
          while (queue.length && !cancel.signal.aborted) await write(queue.shift()!);
        } finally {
          draining = false;
        }
      }
    } catch {
      /* the client went away */
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
      c.req.raw.signal.removeEventListener("abort", hangUp);
    }
  });
});

// ─── /me/chat ───────────────────────────────────────────────────────────

meChatRoutes.use("*", async (c, next) => {
  if (!config.TEAM_CHAT_ENABLED) return c.json({ error: "Not found" }, 404);
  await next();
});

meChatRoutes.get("/preferences", async (c) => c.json(await getPreferences(c.get("userId"))));

meChatRoutes.put("/preferences", async (c) => {
  const body = await jsonObject(c);
  const userId = c.get("userId");
  return c.json(await setPreference({ userId, userEmail: await resolveCallerEmail(userId) }, { nest_id: body.nest_id, conversation: body.conversation, level: body.level }));
});

meChatRoutes.get("/unread", async (c) => {
  const userId = c.get("userId");
  if (!tryConsume(`chat-unread:${userId}`, UNREAD_BUDGET)) {
    return c.json({ error: "Too many unread reads — every 30 s is plenty." }, 429, { "Retry-After": "10" });
  }
  return c.json(await chatUnreadSummary({ userId, email: await resolveCallerEmail(userId) }));
});
