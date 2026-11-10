/**
 * Agent wake-up on @mention (PO-1181, agent team stream S3).
 *
 * There is no scheduled LLM polling, so an agent learns it was tagged from an
 * event: when a person's message @mentions an agent handle that has a webhook
 * target, this server sends that target ONE signed POST
 *
 *   { event: "agent.mention", delivery_id, nest: {id, name}, channel,
 *     node_id, thread_id, message_id, mentioned, at,
 *     author, excerpt?, read: { tool, arguments } }
 *
 * through the notify webhook path (notify/webhook.ts postWebhook — message log,
 * fire-and-forget, short timeout). `author` is the writer's label, and `read`
 * is the exact MCP call that fetches the thread (context_channel_read for a
 * channel, context_comments for a document), so a runner needs no guessing.
 * `excerpt` is the first 280 characters of the mentioning message, and rides
 * ONLY when the target is this nest's own (the admin-set map below): whoever
 * holds that runner's nest key could read the thread anyway. A target that
 * came from anywhere else (an identity-layer resolver) gets no text; the
 * agent reads the thread with its own credential, so the nest's access rules
 * decide what it sees, not this POST (PO-1190, AC-AX-07).
 *
 * A failed POST is retried up to WAKE_RETRY_BACKOFF_MS.length times with
 * backoff, the same body and the same Idempotency-Key each time (a fresh
 * signature, so the replay window holds), and how it ended is kept on the
 * delivery row for the webhooks panel (AC-AX-08). Retries live in this
 * process: a restart drops the ones in flight, and the agent still finds the
 * mention in its `context_my_work`.
 *
 * Which messages: exactly the ones the @mention index records
 * (mentions/mention-index.ts) — a person posting through the REST comment
 * routes or MCP `context_comment`. Text a model wrote (Hootie's answers, a
 * metacognition agent's comments) and server-composed replies (promote) never
 * reach here, the same rule mention-notify and My Work keep, so an agent's
 * echo can't wake another agent in someone's name. Only handles that resolved
 * to NO person are candidates (the index stores those with a NULL user).
 *
 * Guards:
 *   - Idempotency: one `agent_wake_deliveries` row per (message, handle),
 *     keyed by a hash of both, inserted before the POST. A retry (the same
 *     message dispatched again) finds the row and sends nothing; the key also
 *     rides as `Idempotency-Key` so a runner can dedupe on its side.
 *   - Loop guard: a message written by agent X (its `client.agent` label)
 *     never wakes X, so an agent quoting its own handle doesn't call itself.
 *   - Amplification fence: at most WAKE_PER_THREAD_LIMIT wakes per handle per
 *     thread per window, and WAKE_PER_HANDLE_LIMIT per handle per nest per
 *     hour — two agents tagging each other back and forth stop, they don't
 *     spin. Every message is still capped at MAX_MENTION_RECIPIENTS names by
 *     the index.
 *   - SSRF: the target must pass the connector fence (public https) at use
 *     time too, and the POST goes through the connect-time guarded fetch, so
 *     a DNS answer pointing inside is refused where the socket opens.
 *   - Signature: `X-ContextNest-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256
 *     of "<t>.<body>">` with the target's secret. A receiver checks it with
 *     `verifyAgentWakeSignature` (or the same three lines) and rejects a stale
 *     `t` to stop replays.
 *
 * Identity seam: `setAgentWebhookResolver`. Today a handle's target comes from
 * the nest-level admin-only map (agent-webhooks.ts); the agent-principal work
 * installs a resolver that reads it off the agent instead. Same shape as the
 * S2 seam (mentions/agent-mentions.ts).
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { deserializeClient } from "../shared/client-metadata.js";
import { resolveActorLabel } from "../channels/actor-label.js";
import { isChannelNode } from "../channels/channel-node.js";
import { isSafeConnectorUrl } from "../notify/dispatch.js";
import { postWebhook, resolveNestName, type WebhookFetch } from "../notify/webhook.js";
import { senderFor } from "../notify/outbound-log.js";
import { guardedFetch, isPrivateAddress } from "../metacognition/net.js";
import { isIP } from "node:net";
import { justWritten, MENTION_EXCERPT_MAX } from "../mentions/mention-index.js";
import { storedAgentWebhook } from "./agent-webhooks.js";
import { isReservedHandle } from "../agents/reserved.js";
import { displayNames, namedActor, normHandle, writerHandles } from "../channels/message-meta.js";

export const AGENT_WAKE_EVENT = "agent.mention";
/** The webhooks panel's "send test event" (PO-1189, AC-UX-16). */
export const AGENT_TEST_EVENT = "agent.test";
/** Waits before the 1st, 2nd and 3rd retry of a failed wake-up. */
export const WAKE_RETRY_BACKOFF_MS: readonly number[] = [2_000, 10_000, 30_000];
/** Wakes of one handle from one thread inside WAKE_THREAD_WINDOW_MS. */
export const WAKE_PER_THREAD_LIMIT = 10;
export const WAKE_THREAD_WINDOW_MS = 10 * 60_000;
/** Wakes of one handle across a nest inside WAKE_HANDLE_WINDOW_MS. */
export const WAKE_PER_HANDLE_LIMIT = 200;
export const WAKE_HANDLE_WINDOW_MS = 60 * 60_000;
/** How old a signature timestamp may be before a receiver should refuse it. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

// ─── Seams ──────────────────────────────────────────────────────────────

export interface AgentWebhookTarget {
  url: string;
  secret: string;
}

/** The target an @mention of `handle` in `nestId` is POSTed to, or null. */
export type AgentWebhookResolver = (nestId: string, handle: string) => Promise<AgentWebhookTarget | null>;

const defaultResolver: AgentWebhookResolver = (nestId, handle) => storedAgentWebhook(nestId, handle);
let resolver: AgentWebhookResolver = defaultResolver;

/** Install the identity layer's resolver; null restores the nest map. */
export function setAgentWebhookResolver(fn: AgentWebhookResolver | null): void {
  resolver = fn ?? defaultResolver;
}

// The transport. Proxy-free and checked at connect time: a public name that
// resolves to a private address never gets a socket (metacognition/net.ts).
const defaultFetch: WebhookFetch = guardedFetch({ maxBytes: 64 * 1024, timeoutMs: 3000, allowPrivate: false });
let transport: WebhookFetch = defaultFetch;

/** Replace the transport (tests); null restores the guarded fetch. */
export function setAgentWakeFetch(fn: WebhookFetch | null): void {
  transport = fn ?? defaultFetch;
}

let backoff: readonly number[] = WAKE_RETRY_BACKOFF_MS;

/** Replace the retry waits (tests); null restores WAKE_RETRY_BACKOFF_MS. */
export function setAgentWakeBackoff(ms: readonly number[] | null): void {
  backoff = ms ?? WAKE_RETRY_BACKOFF_MS;
}

/**
 * The target an @mention of `handle` would be POSTed to, after the public-URL
 * fence, or null: no target, a failing resolver, or one that is not a public
 * https address (the save-time rule again at use time, so a resolver or an
 * old row can't hand back a private target).
 */
export async function agentWakeTarget(nestId: string, handle: string): Promise<AgentWebhookTarget | null> {
  // A reserved handle (hootie, nest, …) has no runner, whatever a row from
  // before the rule says (team chat C7, src/agents/reserved.ts).
  if (isReservedHandle(handle)) return null;
  const target = await resolver(nestId, handle).catch((err) => {
    console.error("[agent-wake] resolver failed", nestId, handle, err);
    return null;
  });
  if (!target?.url || !target.secret) return null;
  if (!isSafeConnectorUrl(target.url) || privateLiteral(target.url)) return null;
  return target;
}

// ─── Signing ────────────────────────────────────────────────────────────

function hmac(secret: string, t: string, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

/** The `X-ContextNest-Signature` value for this body. */
export function signAgentWake(secret: string, body: string, nowMs = Date.now()): string {
  const t = String(Math.floor(nowMs / 1000));
  return `t=${t},v1=${hmac(secret, t, body)}`;
}

/**
 * Check a wake-up POST: the HMAC matches and its timestamp is within
 * `toleranceSeconds` of now (replay window). Constant-time compare. The
 * reference a runner can copy.
 */
export function verifyAgentWakeSignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  opts: { nowMs?: number; toleranceSeconds?: number } = {},
): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(header ?? "").trim());
  if (!m || !secret) return false;
  const age = Math.abs((opts.nowMs ?? Date.now()) / 1000 - Number(m[1]));
  if (age > (opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const want = Buffer.from(hmac(secret, m[1], body), "hex");
  const got = Buffer.from(m[2], "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

// ─── Dispatch ───────────────────────────────────────────────────────────

/** Stable per (message, handle): the same message dispatched twice maps to
 *  the same key, so the second insert finds the first. */
export function wakeIdempotencyKey(nestId: string, commentId: string, handle: string): string {
  return createHash("sha256").update(`agent-wake:v1:${nestId}:${commentId}:${handle}`).digest("hex").slice(0, 40);
}

function privateLiteral(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return isIP(host) !== 0 && isPrivateAddress(host);
  } catch {
    return true;
  }
}

async function overLimit(nestId: string, threadId: string, handle: string): Promise<boolean> {
  const db = getDb();
  const now = Date.now();
  // Wake-ups only: the panel's test events have their own limit and must not
  // use up an agent's allowance.
  const perThread = (await db.get(
    "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM agent_wake_deliveries WHERE thread_id = ? AND handle = ? AND created_at >= ? AND event = 'agent.mention'",
    [threadId, handle, new Date(now - WAKE_THREAD_WINDOW_MS).toISOString()],
  )) as { n: number | string } | undefined;
  if (Number(perThread?.n ?? 0) >= WAKE_PER_THREAD_LIMIT) return true;
  const perHandle = (await db.get(
    "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM agent_wake_deliveries WHERE nest_id = ? AND handle = ? AND created_at >= ? AND event = 'agent.mention'",
    [nestId, handle, new Date(now - WAKE_HANDLE_WINDOW_MS).toISOString()],
  )) as { n: number | string } | undefined;
  return Number(perHandle?.n ?? 0) >= WAKE_PER_HANDLE_LIMIT;
}

// ─── Delivery ───────────────────────────────────────────────────────────

const SEALED_REASON = "this nest sends nothing outside";
const NOT_PUBLIC_REASON = "not a public address";

/** What a delivery ended as, in the words the webhooks panel shows. */
export interface DeliveryView {
  /** When it reached this status (ISO 8601). */
  at: string;
  status: "ok" | "failed" | "pending";
  /** Why it failed, short and free of anything the target said. */
  reason: string | null;
  attempts: number;
  event: string;
}

/**
 * A failure in a few fixed words. The raw error can carry what a resolver or
 * the network said about the target; the panel only needs the category, and
 * a fixed vocabulary keeps the test endpoint from being a probe of the
 * network behind this server.
 */
export function deliveryReason(error: string | null | undefined): string | null {
  if (!error) return null;
  const http = /responded (\d{3})/.exec(error);
  if (http) return `HTTP ${http[1]}`;
  // The two reasons this module sets itself, from the URL as saved and before
  // any lookup. What a NAME resolves to is never reported: "resolves to a
  // private address" and "did not resolve" both read "could not connect", or
  // the test button would map the network behind this server.
  if (error === SEALED_REASON || error === NOT_PUBLIC_REASON) return error;
  if (/timed out|abort/i.test(error)) return "timed out";
  return "could not connect";
}

function toDeliveryView(r: { status: string; error: string | null; attempts: number | string | null; finished_at: string | null; created_at: string; event: string | null }): DeliveryView {
  return {
    at: r.finished_at ?? r.created_at,
    status: r.status === "sent" ? "ok" : r.status === "failed" ? "failed" : "pending",
    reason: r.status === "failed" ? deliveryReason(r.error ?? "failed") : null,
    attempts: Number(r.attempts ?? 1),
    event: r.event ?? AGENT_WAKE_EVENT,
  };
}

/** Each handle's most recent delivery in this nest (wake-ups and tests). */
export async function lastDeliveries(nestId: string): Promise<Map<string, DeliveryView>> {
  const rows = (await getDb().all(
    `SELECT d.handle, d.status, d.error, d.attempts, d.finished_at, d.created_at, d.event
       FROM agent_wake_deliveries d
      WHERE d.nest_id = ?
        AND d.created_at = (SELECT MAX(x.created_at) FROM agent_wake_deliveries x WHERE x.nest_id = d.nest_id AND x.handle = d.handle)`,
    [nestId],
  )) as Array<{ handle: string; status: string; error: string | null; attempts: number; finished_at: string | null; created_at: string; event: string | null }>;
  return new Map(rows.map((r) => [r.handle, toDeliveryView(r)]));
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    // A pending retry must not keep the process (or a test run) alive.
    (t as { unref?: () => void }).unref?.();
  });

/**
 * POST one reserved delivery and record how it ended. `retries` are the waits
 * before each further attempt; every attempt sends the same body under the
 * same Idempotency-Key, signed afresh.
 */
async function deliver(params: {
  key: string;
  nestId: string;
  nodeId: string | null;
  handle: string;
  target: AgentWebhookTarget;
  event: string;
  deliveryId: string;
  body: string;
  sender: string;
  retries: readonly number[];
}): Promise<DeliveryView> {
  const { key, nestId, nodeId, handle, target, event, deliveryId, body, retries } = params;
  const db = getDb();
  let attempts = 0;
  let last: { ok: boolean; error?: string } = { ok: false, error: "failed" };
  for (;;) {
    attempts++;
    const headers = {
      "User-Agent": "ContextNest-AgentWake/1",
      "X-ContextNest-Event": event,
      "X-ContextNest-Delivery": deliveryId,
      "Idempotency-Key": key,
      "X-ContextNest-Signature": signAgentWake(target.secret, body),
    };
    last = await postWebhook(
      target.url,
      null,
      `agent-wake:${handle}`,
      { nestId, ...(nodeId ? { nodeId } : {}), channel: "webhook", ...senderFor(params.sender) },
      { rawBody: body, headers, fetchImpl: (u, init) => transport(u, init) },
    ).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (last.ok || attempts > retries.length) break;
    await db
      .run("UPDATE agent_wake_deliveries SET attempts = ?, error = ? WHERE idempotency_key = ?", [attempts, (last.error ?? "failed").slice(0, 500), key])
      .catch(() => {});
    await sleep(retries[attempts - 1]);
  }
  const finishedAt = new Date().toISOString();
  const error = last.ok ? null : (last.error ?? "failed").slice(0, 500);
  await db
    .run("UPDATE agent_wake_deliveries SET status = ?, error = ?, attempts = ?, finished_at = ? WHERE idempotency_key = ?", [
      last.ok ? "sent" : "failed",
      error,
      attempts,
      finishedAt,
      key,
    ])
    .catch(() => {});
  return { at: finishedAt, status: last.ok ? "ok" : "failed", reason: deliveryReason(error), attempts, event };
}

function excerptOf(body: string): string {
  const flat = String(body ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MENTION_EXCERPT_MAX ? `${flat.slice(0, MENTION_EXCERPT_MAX)}…` : flat;
}

/** What happened for one tagged handle: a POST went out, it has no target
 *  (it reads its mentions from context_my_work), or nothing was sent (the
 *  writer itself, a duplicate, or the rate fence). */
export type WakeOutcome = "sent" | "no_webhook" | "skipped";

/**
 * Wake every agent the message `commentId` @mentions that has a target.
 * Resolves once each delivery is reserved; the POSTs themselves run in the
 * background (fire-and-forget, like every notify delivery). Never throws: a
 * wake-up failure must never fail the post that caused it. Returns, per
 * tagged handle that named no person, what was done about it.
 */
export async function wakeMentionedAgents(params: {
  nestId: string;
  nodeId: string;
  threadId: string;
  commentId: string;
}): Promise<Map<string, WakeOutcome>> {
  const { nestId, nodeId, threadId, commentId } = params;
  const outcomes = new Map<string, WakeOutcome>();
  try {
    const db = getDb();
    // The message must be the one named, in this thread, on this node, in
    // this nest — a mismatched call wakes nobody.
    const msg = (await db.get(
      `SELECT c.author, c.body, c.client_json
         FROM annotation_comments c
         JOIN annotation_threads t ON t.id = c.thread_id
        WHERE c.id = ? AND c.thread_id = ? AND t.nest_id = ? AND t.node_id = ?`,
      [commentId, threadId, nestId, nodeId],
    )) as { author: string; body: string; client_json: string | null } | undefined;
    if (!msg) return outcomes;

    const rows = (await db.all(
      "SELECT DISTINCT handle FROM comment_mentions WHERE comment_id = ? AND nest_id = ? AND mentioned_user_id IS NULL",
      [commentId, nestId],
    )) as Array<{ handle: string }>;
    if (rows.length === 0) return outcomes;

    // A sealed personal nest sends nothing anywhere (dispatch.ts, R3-H1b).
    const { sealedNest } = await import("../surfaces/sealed.js");
    const sealed = await sealedNest(nestId);
    // Only a person added to the nest wakes an agent. Commenting is read-tier,
    // so a visitor to a public nest can write "@grok do this" on a published
    // page; that must not put instructions in front of the nest's runner.
    const writer = (await db.get("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", [msg.author])) as { id: string } | undefined;
    const { isNestMember } = await import("../channels/channel-service.js");
    const trusted = !!writer && (await isNestMember(nestId, writer.id));

    // Loop guard: the agent that wrote the message is not woken by it —
    // whether it declared itself (resolveActorLabel) or only its key's label
    // names it.
    const client = deserializeClient(msg.client_json);
    const actor = await resolveActorLabel({ email: msg.author, client });
    const self = new Set([normHandle(actor.agent), ...writerHandles(client)].filter(Boolean));

    let channel: string | null | undefined;
    let nestName: string | undefined;
    let author: string | undefined;
    for (const { handle: raw } of rows) {
      const handle = normHandle(raw);
      if (!handle) continue;
      if (sealed || !trusted || self.has(handle)) {
        outcomes.set(handle, "skipped");
        continue;
      }
      const target = await agentWakeTarget(nestId, handle);
      if (!target) {
        outcomes.set(handle, "no_webhook");
        continue;
      }
      if (await overLimit(nestId, threadId, handle)) {
        console.warn(`[agent-wake] rate limit: @${handle} in thread ${threadId}`);
        outcomes.set(handle, "skipped");
        continue;
      }
      const key = wakeIdempotencyKey(nestId, commentId, handle);
      const reserved = await db.run(
        `INSERT INTO agent_wake_deliveries
           (idempotency_key, nest_id, handle, node_id, thread_id, comment_id, status, created_at, attempts, event)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [key, nestId, handle, nodeId, threadId, commentId, new Date().toISOString(), AGENT_WAKE_EVENT],
      );
      if (!reserved.changes) {
        outcomes.set(handle, "skipped"); // already sent (or being sent): a retry
        continue;
      }

      if (channel === undefined) {
        channel = config.EXPERIMENTAL_AGENT_STREAM && (await isChannelNode(nestId, nodeId)) ? nodeId.split("/").pop()! : null;
      }
      nestName ??= await resolveNestName(nestId);
      author ??= (await namedActor(msg.author, client, await displayNames([msg.author]))).actor.label;
      // Text only to this nest's own target (see the header).
      const own = await storedAgentWebhook(nestId, handle).catch(() => null);
      const sameNest = !!own && own.url === target.url;
      const deliveryId = randomUUID();
      const body = JSON.stringify({
        event: AGENT_WAKE_EVENT,
        delivery_id: deliveryId,
        nest: { id: nestId, name: nestName },
        channel,
        node_id: nodeId,
        thread_id: threadId,
        message_id: commentId,
        mentioned: handle,
        at: new Date().toISOString(),
        author,
        // The label is a display name plus a self-declared agent; the login
        // behind it is what a runner can rely on. With the excerpt, to this
        // nest's own target only.
        ...(sameNest ? { author_email: msg.author, excerpt: excerptOf(msg.body) } : {}),
        read: channel
          ? { tool: "context_channel_read", arguments: { channel, thread: threadId } }
          : { tool: "context_comments", arguments: { id: nodeId, thread: threadId } },
      });
      outcomes.set(handle, "sent");
      void deliver({
        key,
        nestId,
        nodeId,
        handle,
        target,
        event: AGENT_WAKE_EVENT,
        deliveryId,
        body,
        sender: msg.author,
        retries: backoff,
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[agent-wake] dispatch failed", nestId, nodeId, threadId, err);
  }
  return outcomes;
}

/**
 * The panel's "send test event": ONE signed POST of `{ event: "agent.test",
 * … }` to the handle's target, awaited, never retried, and recorded like any
 * delivery so the row shows it. The response body is never read back to the
 * caller. Null when the handle has no target at all. The caller has already
 * been checked as a nest admin and rate limited (agent-webhook-routes.ts).
 */
export async function sendAgentTestEvent(nestId: string, handle: string, actorEmail: string): Promise<DeliveryView | null> {
  const raw = await resolver(nestId, handle).catch(() => null);
  if (!raw?.url || !raw.secret) return null;
  const db = getDb();
  const deliveryId = randomUUID();
  const key = createHash("sha256").update(`agent-test:v1:${nestId}:${handle}:${deliveryId}`).digest("hex").slice(0, 40);
  const now = new Date().toISOString();
  const record = (status: "pending" | "failed", error: string | null) =>
    db.run(
      `INSERT INTO agent_wake_deliveries
         (idempotency_key, nest_id, handle, node_id, thread_id, comment_id, status, error, created_at, attempts, finished_at, event)
       VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?, ?, ?)`,
      [key, nestId, handle, status, error, now, status === "failed" ? 1 : 0, status === "failed" ? now : null, AGENT_TEST_EVENT],
    );
  const { sealedNest } = await import("../surfaces/sealed.js");
  // The same fences a real wake-up passes: nothing leaves a sealed nest, and
  // nothing goes to an address that is not public.
  const refused = (await sealedNest(nestId))
    ? SEALED_REASON
    : !isSafeConnectorUrl(raw.url) || privateLiteral(raw.url)
      ? NOT_PUBLIC_REASON
      : null;
  if (refused) {
    await record("failed", refused);
    return { at: now, status: "failed", reason: refused, attempts: 1, event: AGENT_TEST_EVENT };
  }
  await record("pending", null);
  const body = JSON.stringify({
    event: AGENT_TEST_EVENT,
    delivery_id: deliveryId,
    nest: { id: nestId, name: await resolveNestName(nestId) },
    mentioned: handle,
    at: now,
  });
  return deliver({ key, nestId, nodeId: null, handle, target: raw, event: AGENT_TEST_EVENT, deliveryId, body, sender: actorEmail, retries: [] });
}

/** Wake for the message a post or reply just wrote (see indexPostedMessage). */
export async function wakeForPostedMessage(params: {
  nestId: string;
  nodeId: string;
  thread: { id: string; comments: Array<{ id: string; author: string }> };
  authorEmail: string;
}): Promise<Map<string, WakeOutcome>> {
  const commentId = justWritten(params.thread, params.authorEmail);
  if (!commentId) return new Map();
  return wakeMentionedAgents({ nestId: params.nestId, nodeId: params.nodeId, threadId: params.thread.id, commentId });
}
