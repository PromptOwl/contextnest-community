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
import { notifyEmailForNest, transportSettings } from "./email.js";
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
  // Slack/Teams get every buffered event.
  const text = buildText(buf.events.map((e) => e.line));
  // The team-channel email is opt-out PER EVENT: an event that set skipEmail
  // (a nest invite, an approve/reject verdict) emails the person directly and
  // must never reach the shared NOTIFY_EMAIL_TO inbox — not even folded into a
  // digest when it happens to share a debounce window with a non-skipped event.
  // So the email text/details are built from the non-skipped events ONLY.
  const emailEvents = buf.events.filter((e) => !e.skipEmail);
  const emailText = buildText(emailEvents.map((e) => e.line));
  // A lone event carries its structured details for a rich per-event email; a
  // multi-event digest has no single event to describe, so email falls back to
  // the digest text (the connector's generic renderHtml/renderText path).
  const emailDetails =
    emailEvents.length === 1 ? emailEvents[0].details : undefined;
  await Promise.allSettled([
    notifySlackForNest(nestId, text),
    notifyMsTeamsForNest(nestId, text),
    emailEvents.length > 0
      ? notifyEmailForNest(nestId, emailText, emailDetails)
      : Promise.resolve(),
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
    !transportSettings()
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
