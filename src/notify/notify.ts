/**
 * Notification dispatcher — one call site per governance event, fanned out
 * to every configured connector (Slack webhook, Microsoft Teams webhook,
 * SMTP email).
 *
 * Bursts are debounced per nest so bulk actions don't spam the channel:
 * sharing a nest with a 12-person team or clearing a review queue collapses
 * into ONE digest message instead of one message per event. A lone event
 * still sends as its own line (after the same short delay — the latency is
 * the price of never having to recall a flood).
 *
 * Everything stays fire-and-forget; the flush timer is unref'd so a pending
 * digest never holds the process open.
 */
import { config } from "../config.js";
import { notifySlackForNest } from "./slack.js";
import { notifyMsTeamsForNest } from "./msteams.js";
import { notifyEmailForNest } from "./email.js";
import type { EmailEventDetails } from "./email-render.js";

const DIGEST_LINE_CAP = 10;

// Per-nest buffer. Each buffered event keeps BOTH its Slack line and the
// structured details the email connector renders — so a lone event still
// produces a rich, single-event email while a burst collapses into a digest.
const buffers = new Map<
  string,
  {
    events: Array<{ line: string; details?: EmailEventDetails; skipEmail?: boolean }>;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function buildText(lines: string[]): string {
  if (lines.length === 1) return lines[0];
  const shown = lines
    .slice(0, DIGEST_LINE_CAP)
    .map((l) => `• ${l}`)
    .join("\n");
  const more =
    lines.length > DIGEST_LINE_CAP
      ? `\n…and ${lines.length - DIGEST_LINE_CAP} more`
      : "";
  return `${lines.length} updates:\n${shown}${more}`;
}

async function flush(nestId: string): Promise<void> {
  const buf = buffers.get(nestId);
  if (!buf) return;
  buffers.delete(nestId);
  const text = buildText(buf.events.map((e) => e.line));
  // A lone event carries its structured details for a rich per-event email; a
  // multi-event digest has no single event to describe, so email falls back to
  // the digest text (the connector's generic renderHtml/renderText path).
  const details =
    buf.events.length === 1 ? buf.events[0].details : undefined;
  // The team-channel email is suppressed only when EVERY buffered event opted
  // out (skipEmail) — e.g. a nest invite, which emails the invitee directly at
  // their own address instead of the shared NOTIFY_EMAIL_TO inbox. Slack/Teams
  // still get every event; the opt-out is email-only.
  const emailAllowed = buf.events.some((e) => !e.skipEmail);
  await Promise.allSettled([
    notifySlackForNest(nestId, text),
    notifyMsTeamsForNest(nestId, text),
    emailAllowed ? notifyEmailForNest(nestId, text, details) : Promise.resolve(),
  ]);
}

/**
 * `message` is the Slack-flavored one-liner (mrkdwn); `details`, when present,
 * is the structured event the email connector renders into a rich per-event
 * email. Slack always uses `message`; email uses `details` when the event
 * flushes on its own (un-batched) and falls back to `message` otherwise.
 */
export async function notifyNestEvent(
  nestId: string,
  message: string,
  details?: EmailEventDetails,
  opts?: { skipEmail?: boolean },
): Promise<void> {
  // Nothing configured → don't even buffer.
  if (
    !config.SLACK_WEBHOOK_URL &&
    !config.MSTEAMS_WEBHOOK_URL &&
    !config.SMTP_URL
  )
    return;

  const buf = buffers.get(nestId);
  if (buf) {
    // Fixed batching window, not a trailing-edge debounce: a later event in the
    // burst joins the buffer but does NOT reset the timer, so a steady stream
    // can't delay the digest indefinitely.
    buf.events.push({ line: message, details, skipEmail: opts?.skipEmail });
    return;
  }
  const timer = setTimeout(() => void flush(nestId), config.NOTIFY_DEBOUNCE_MS);
  timer.unref?.();
  buffers.set(nestId, {
    events: [{ line: message, details, skipEmail: opts?.skipEmail }],
    timer,
  });
}
