/**
 * Notification dispatcher — one call site per governance event, fanned out
 * to every configured connector (Slack webhook, SMTP email). Both are
 * fire-and-forget internally; this never throws.
 */
import { notifySlackForNest } from "./slack.js";
import { notifyEmailForNest } from "./email.js";

export async function notifyNestEvent(
  nestId: string,
  message: string,
): Promise<void> {
  await Promise.allSettled([
    notifySlackForNest(nestId, message),
    notifyEmailForNest(nestId, message),
  ]);
}
