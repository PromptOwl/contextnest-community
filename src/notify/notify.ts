/**
 * Notification dispatcher — one call site per governance event, fanned out
 * to every configured connector (Slack webhook, SMTP email).
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
import { notifyEmailForNest } from "./email.js";

const DIGEST_LINE_CAP = 10;

function debounceMs(): number {
  const n = Number(process.env.NOTIFY_DEBOUNCE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
}

const buffers = new Map<
  string,
  { lines: string[]; timer: ReturnType<typeof setTimeout> }
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
  const text = buildText(buf.lines);
  await Promise.allSettled([
    notifySlackForNest(nestId, text),
    notifyEmailForNest(nestId, text),
  ]);
}

export async function notifyNestEvent(
  nestId: string,
  message: string,
): Promise<void> {
  // Nothing configured → don't even buffer.
  if (!config.SLACK_WEBHOOK_URL && !config.SMTP_URL) return;

  const buf = buffers.get(nestId);
  if (buf) {
    buf.lines.push(message);
    return;
  }
  const timer = setTimeout(() => void flush(nestId), debounceMs());
  timer.unref?.();
  buffers.set(nestId, { lines: [message], timer });
}
