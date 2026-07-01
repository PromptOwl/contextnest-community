/**
 * Slack connector — optional team notifications via an admin-configured
 * incoming webhook (Settings → Slack webhook URL; empty = off).
 *
 * Deliberately minimal: plain fetch to the webhook, no SDK, no new
 * dependencies. Fire-and-forget with a short timeout — a Slack outage or a
 * bad URL must never slow down or fail the governance action that triggered
 * the message. Failures warn once, then go quiet (an unreachable webhook
 * would otherwise spam the log on every event).
 */
import { config } from "../config.js";
import { getDb } from "../db/client.js";

let warnedOnce = false;

/** Prefix the message with the nest's human name (best-effort). */
export async function notifySlackForNest(
  nestId: string,
  message: string,
): Promise<void> {
  if (!config.SLACK_WEBHOOK_URL) return;
  let nestName = nestId;
  try {
    const row = (await getDb().get("SELECT name FROM nests WHERE id = ?", [
      nestId,
    ])) as { name?: string } | undefined;
    if (row?.name) nestName = row.name;
  } catch {
    /* name lookup is cosmetic */
  }
  return notifySlack(`*[${nestName}]* ${message}`);
}

/**
 * Slack's mrkdwn treats <...> as control sequences: <!channel> mass-pings,
 * <url|label> renders deceptive links. Message text carries user-controlled
 * fragments (notes, emails, nest names), so escape &, <, > per Slack's own
 * escaping rules before sending. Our * and ` formatting is unaffected.
 */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function notifySlack(text: string): Promise<void> {
  const url = config.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: escapeMrkdwn(text) }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[slack] notification failed (suppressing further warnings):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
