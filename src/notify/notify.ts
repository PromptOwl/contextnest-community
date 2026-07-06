/**
 * Notification dispatcher — one call site per governance event, fanned out
 * to every configured connector (Slack webhook, SMTP email). Both are
 * fire-and-forget internally; this never throws.
 */
import { notifySlackForNest } from "./slack.js";
import { notifyEmailForNest } from "./email.js";
import type { EmailEventDetails } from "./email-render.js";

/**
 * `message` is the Slack-flavored one-liner (mrkdwn); `details`, when present,
 * is the structured event the email connector renders into a rich per-event
 * email. Slack always uses `message`; email uses `details` when given and
 * falls back to `message` otherwise.
 */
export async function notifyNestEvent(
  nestId: string,
  message: string,
  details?: EmailEventDetails,
): Promise<void> {
  await Promise.allSettled([
    notifySlackForNest(nestId, message),
    notifyEmailForNest(nestId, message, details),
  ]);
}
