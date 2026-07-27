/**
 * Shared webhook plumbing for the notify connectors. One copy of the two
 * things Slack, Microsoft Teams, and the dispatch engine all did identically:
 * resolve a nest's human name (best-effort) and POST a JSON body
 * fire-and-forget with a short timeout, warning once per target on failure.
 */
import { getDb } from "../db/client.js";

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

/** One POST, one abort timeout. Rejects on network error / timeout; an HTTP
 *  error status resolves (the caller decides whether a 4xx/5xx matters). */
async function rawPost(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const warned = new Set<string>();

/**
 * Fire-and-forget POST of a JSON body. Short abort timeout so a webhook outage
 * or a bad URL never slows the governance action that triggered it; failures
 * warn once per `who`, then go quiet. An HTTP error status is deliberately
 * ignored here — same fire-and-forget contract as before.
 */
export async function postWebhook(
  url: string,
  body: unknown,
  who: string,
): Promise<void> {
  try {
    await rawPost(url, body, 3000);
  } catch (err) {
    if (!warned.has(who)) {
      warned.add(who);
      console.warn(
        `[notify] delivery failed for ${who} (muting further warnings):`,
        err instanceof Error ? err.message : err,
      );
    }
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
