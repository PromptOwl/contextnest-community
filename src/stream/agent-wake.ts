/**
 * Agent wake-up on @mention (PO-1181, agent team stream S3).
 *
 * There is no scheduled LLM polling, so an agent learns it was tagged from an
 * event: when a person's message @mentions an agent handle that has a webhook
 * target, this server sends that target ONE signed POST
 *
 *   { event: "agent.mention", delivery_id, nest: {id, name}, channel,
 *     node_id, thread_id, message_id, mentioned, at }
 *
 * through the notify webhook path (notify/webhook.ts postWebhook — message log,
 * fire-and-forget, short timeout). The message text is NOT in the payload: the
 * agent reads the thread with its own credential, so the nest's access rules
 * decide what it sees, not this POST.
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
import { isChannelNode } from "../channels/channel-service.js";
import { isSafeConnectorUrl } from "../notify/dispatch.js";
import { postWebhook, resolveNestName, type WebhookFetch } from "../notify/webhook.js";
import { senderFor } from "../notify/outbound-log.js";
import { guardedFetch, isPrivateAddress } from "../metacognition/net.js";
import { isIP } from "node:net";
import { justWritten } from "../mentions/mention-index.js";
import { storedAgentWebhook } from "./agent-webhooks.js";

export const AGENT_WAKE_EVENT = "agent.mention";
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

function normHandle(h: string | null | undefined): string {
  return String(h ?? "").trim().replace(/^@/, "").toLowerCase();
}

async function overLimit(nestId: string, threadId: string, handle: string): Promise<boolean> {
  const db = getDb();
  const now = Date.now();
  const perThread = (await db.get(
    "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM agent_wake_deliveries WHERE thread_id = ? AND handle = ? AND created_at >= ?",
    [threadId, handle, new Date(now - WAKE_THREAD_WINDOW_MS).toISOString()],
  )) as { n: number | string } | undefined;
  if (Number(perThread?.n ?? 0) >= WAKE_PER_THREAD_LIMIT) return true;
  const perHandle = (await db.get(
    "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM agent_wake_deliveries WHERE nest_id = ? AND handle = ? AND created_at >= ?",
    [nestId, handle, new Date(now - WAKE_HANDLE_WINDOW_MS).toISOString()],
  )) as { n: number | string } | undefined;
  return Number(perHandle?.n ?? 0) >= WAKE_PER_HANDLE_LIMIT;
}

/**
 * Wake every agent the message `commentId` @mentions that has a target.
 * Resolves once each delivery is reserved; the POSTs themselves run in the
 * background (fire-and-forget, like every notify delivery). Never throws: a
 * wake-up failure must never fail the post that caused it.
 */
export async function wakeMentionedAgents(params: {
  nestId: string;
  nodeId: string;
  threadId: string;
  commentId: string;
}): Promise<void> {
  const { nestId, nodeId, threadId, commentId } = params;
  try {
    // A sealed personal nest sends nothing anywhere (dispatch.ts, R3-H1b).
    const { sealedNest } = await import("../surfaces/sealed.js");
    if (await sealedNest(nestId)) return;

    const db = getDb();
    // The message must be the one named, in this thread, on this node, in
    // this nest — a mismatched call wakes nobody.
    const msg = (await db.get(
      `SELECT c.author, c.client_json
         FROM annotation_comments c
         JOIN annotation_threads t ON t.id = c.thread_id
        WHERE c.id = ? AND c.thread_id = ? AND t.nest_id = ? AND t.node_id = ?`,
      [commentId, threadId, nestId, nodeId],
    )) as { author: string; client_json: string | null } | undefined;
    if (!msg) return;

    const rows = (await db.all(
      "SELECT DISTINCT handle FROM comment_mentions WHERE comment_id = ? AND nest_id = ? AND mentioned_user_id IS NULL",
      [commentId, nestId],
    )) as Array<{ handle: string }>;
    if (rows.length === 0) return;

    // Loop guard: the agent that wrote the message is not woken by it.
    const actor = await resolveActorLabel({ email: msg.author, client: deserializeClient(msg.client_json) });
    const self = normHandle(actor.agent);

    let channel: string | null | undefined;
    let nestName: string | undefined;
    for (const { handle: raw } of rows) {
      const handle = normHandle(raw);
      if (!handle || handle === self) continue;
      const target = await resolver(nestId, handle).catch((err) => {
        console.error("[agent-wake] resolver failed", nestId, handle, err);
        return null;
      });
      if (!target?.url || !target.secret) continue;
      // The save-time fence, again at use time: a resolver (or an old row)
      // can't hand back a private target.
      if (!isSafeConnectorUrl(target.url) || privateLiteral(target.url)) {
        console.warn(`[agent-wake] refusing a non-public target for @${handle} in ${nestId}`);
        continue;
      }
      if (await overLimit(nestId, threadId, handle)) {
        console.warn(`[agent-wake] rate limit: @${handle} in thread ${threadId}`);
        continue;
      }
      const key = wakeIdempotencyKey(nestId, commentId, handle);
      const reserved = await db.run(
        `INSERT INTO agent_wake_deliveries
           (idempotency_key, nest_id, handle, node_id, thread_id, comment_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [key, nestId, handle, nodeId, threadId, commentId, new Date().toISOString()],
      );
      if (!reserved.changes) continue; // already sent (or being sent): a retry

      if (channel === undefined) {
        channel = config.EXPERIMENTAL_AGENT_STREAM && (await isChannelNode(nestId, nodeId)) ? nodeId.split("/").pop()! : null;
      }
      nestName ??= await resolveNestName(nestId);
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
      });
      const headers = {
        "User-Agent": "ContextNest-AgentWake/1",
        "X-ContextNest-Event": AGENT_WAKE_EVENT,
        "X-ContextNest-Delivery": deliveryId,
        "Idempotency-Key": key,
        "X-ContextNest-Signature": signAgentWake(target.secret, body),
      };
      void postWebhook(
        target.url,
        null,
        `agent-wake:${handle}`,
        { nestId, nodeId, channel: "webhook", ...senderFor(msg.author) },
        { rawBody: body, headers, fetchImpl: (u, init) => transport(u, init) },
      )
        .then((r) =>
          db.run("UPDATE agent_wake_deliveries SET status = ?, error = ? WHERE idempotency_key = ?", [
            r.ok ? "sent" : "failed",
            r.ok ? null : (r.error ?? "failed").slice(0, 500),
            key,
          ]),
        )
        .catch(() => {});
    }
  } catch (err) {
    console.error("[agent-wake] dispatch failed", nestId, nodeId, threadId, err);
  }
}

/** Wake for the message a post or reply just wrote (see indexPostedMessage). */
export async function wakeForPostedMessage(params: {
  nestId: string;
  nodeId: string;
  thread: { id: string; comments: Array<{ id: string; author: string }> };
  authorEmail: string;
}): Promise<void> {
  const commentId = justWritten(params.thread, params.authorEmail);
  if (!commentId) return;
  await wakeMentionedAgents({ nestId: params.nestId, nodeId: params.nodeId, threadId: params.thread.id, commentId });
}
