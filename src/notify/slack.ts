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
import { postWebhook, resolveNestName } from "./webhook.js";

/** Prefix the message with the nest's human name (best-effort). */
export async function notifySlackForNest(
  nestId: string,
  message: string,
): Promise<void> {
  if (!config.SLACK_WEBHOOK_URL) return;
  const nestName = await resolveNestName(nestId);
  return notifySlack(`*[${nestName}]* ${message}`);
}

/**
 * Slack's mrkdwn treats <...> as control sequences: <!channel> mass-pings,
 * <url|label> renders deceptive links. Message text carries user-controlled
 * fragments (notes, emails, nest names), so escape &, <, > per Slack's own
 * escaping rules before sending. Our * and ` formatting is unaffected. Shared
 * with dispatch.ts's per-nest slack connector — one definition, no drift.
 */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function notifySlack(text: string): Promise<void> {
  const url = config.SLACK_WEBHOOK_URL;
  if (!url) return;
  await postWebhook(url, { text: escapeMrkdwn(text) }, "slack");
}
