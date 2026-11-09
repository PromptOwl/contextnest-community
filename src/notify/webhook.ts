/**
 * Shared webhook plumbing for the notify connectors. One copy of the two
 * things Slack, Microsoft Teams, and the dispatch engine all did identically:
 * resolve a nest's human name (best-effort) and POST a JSON body
 * fire-and-forget with a short timeout, warning once per target on failure.
 */
import { getDb } from "../db/client.js";
import {
  recordOutbound,
  viaProxy,
  webhookTarget,
  type OutboundChannel,
  type OutboundContext,
} from "./outbound-log.js";

/**
 * Nest's human name for message prefixes; falls back to the id. Cosmetic — a
 * lookup failure never blocks a notification.
 */
export async function resolveNestName(nestId: string): Promise<string> {
  try {
    const row = (await getDb().get("SELECT name FROM nests WHERE id = ?", [
      nestId,
    ])) as { name?: string } | undefined;
    if (row?.name) return row.name;
  } catch {
    /* name lookup is cosmetic */
  }
  return nestId;
}

/** A fetch-shaped function — the global one, or the SSRF-guarded one
 *  (metacognition/net.ts guardedFetch) for targets a nest admin typed. */
export type WebhookFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Extras for a POST that must go out byte-exact and signed (agent wake-up,
 *  PO-1181). Absent, a POST is exactly what it always was. */
export interface WebhookPostOptions {
  /** Extra request headers (a signature, an idempotency key). */
  headers?: Record<string, string>;
  /** The already-serialized JSON body — sent as-is, so a signature computed
   *  over these bytes matches what the receiver reads. */
  rawBody?: string;
  /** Send through this instead of the global fetch. */
  fetchImpl?: WebhookFetch;
}

/** One POST, one abort timeout. Rejects on network error / timeout; an HTTP
 *  error status resolves (the caller decides whether a 4xx/5xx matters). */
async function rawPost(
  url: string,
  body: unknown,
  timeoutMs: number,
  opts: WebhookPostOptions = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await (opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: opts.rawBody ?? JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const warned = new Set<string>();

/** Which log channel a `who` label belongs to (slack, server-slack, connector:…). */
function channelFor(who: string): OutboundChannel {
  if (who.includes("slack")) return "slack";
  if (who.includes("msteams") || who.includes("teams")) return "msteams";
  return "webhook";
}

/**
 * Fire-and-forget POST of a JSON body. Short abort timeout so a webhook outage
 * or a bad URL never slows the governance action that triggered it; failures
 * warn once per `who`, then go quiet. The caller never sees an HTTP error
 * status (same fire-and-forget contract as before), but the message log
 * records it — a 4xx/5xx is a failed delivery there.
 */
export async function postWebhook(
  url: string,
  body: unknown,
  who: string,
  ctx: OutboundContext & { channel?: OutboundChannel } = {},
  opts: WebhookPostOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const log = (status: "sent" | "failed", error?: string) =>
    recordOutbound({
      channel: ctx.channel ?? channelFor(who),
      ...ctx,
      // The URL is the credential: log host + hash, never the path.
      recipients: [webhookTarget(url)],
      subject: who,
      body: opts.rawBody ?? (typeof body === "string" ? body : JSON.stringify(body)),
      status,
      error,
      viaProxy: viaProxy(url),
    });
  try {
    const res = await rawPost(url, body, 3000, opts);
    const error = res.ok ? undefined : `Webhook responded ${res.status} ${res.statusText}`.trim();
    await log(res.ok ? "sent" : "failed", error);
    return res.ok ? { ok: true } : { ok: false, error };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await log("failed", error);
    if (!warned.has(who)) {
      warned.add(who);
      console.warn(
        `[notify] delivery failed for ${who} (muting further warnings):`,
        err instanceof Error ? err.message : err,
      );
    }
    return { ok: false, error };
  }
}

/**
 * Send a one-shot test POST and REPORT the outcome (unlike postWebhook, which
 * swallows everything). Powers the "send test" button — the admin needs to
 * see whether their webhook actually accepted the message, including an HTTP
 * error status the fire-and-forget path would ignore.
 */
export async function testWebhook(
  url: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await rawPost(url, body, 5000);
    return res.ok
      ? { ok: true }
      : { ok: false, error: `Webhook responded ${res.status} ${res.statusText}.` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Request failed.",
    };
  }
}
