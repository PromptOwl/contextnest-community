/**
 * Microsoft Teams connector — optional team notifications via an
 * admin-configured incoming webhook (Settings → Microsoft Teams webhook URL;
 * empty = off). First-class parity with the Slack connector (slack.ts).
 *
 * Teams incoming webhooks are created with the Workflows app ("Post to a
 * channel when a webhook request is received"), which expects the Bot
 * Framework message envelope carrying an Adaptive Card:
 *   { type: "message", attachments: [{ contentType:
 *     "application/vnd.microsoft.card.adaptive", content: {…card…} }] }
 * The card body is the notification text; `fallbackText` carries a plain
 * rendering for clients that can't display the card.
 *
 * Deliberately minimal, like slack.ts: plain fetch to the webhook, no SDK, no
 * new dependencies. Fire-and-forget with a short timeout — a Teams outage or
 * a bad URL must never slow down or fail the governance action that triggered
 * the message. Failures warn once, then go quiet.
 */
import { config } from "../config.js";
import { getDb } from "../db/client.js";

let warnedOnce = false;

/**
 * The notification one-liners are composed in Slack mrkdwn (":memo: *Doc*
 * approved…") because Slack was the first connector. Translate that flavor
 * for Teams instead of forking every call site: emoji shortcodes become
 * unicode, and *bold* becomes **bold** (the markdown subset Adaptive Card
 * TextBlocks render).
 */
const EMOJI: Record<string, string> = {
  ":memo:": "📝",
  ":white_check_mark:": "✅",
  ":x:": "❌",
  ":rotating_light:": "🚨",
};

function slackEmojiToUnicode(s: string): string {
  return s.replace(/:[a-z0-9_+-]+:/g, (m) => EMOJI[m] ?? m);
}

/**
 * Neutralize the markdown Adaptive Card TextBlocks render before any
 * user-controlled fragment (review notes, nest names, emails) reaches a
 * card. The subset includes [label](url) links — without this, a
 * collaborator's note like "[check this](https://evil.example)" renders as
 * a live, trusted-looking link in the Teams channel. Backslash first (so a
 * crafted "\[" can't un-escape our work), then both brackets; that kills
 * link syntax at the root. This is the Teams sibling of slack.ts's
 * escapeMrkdwn (also duplicated in dispatch.ts) — same intent, different
 * metacharacters; consolidating the Slack copies is deliberately out of
 * scope here.
 */
export function escapeAdaptiveText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/**
 * Slack mrkdwn one-liner → Adaptive Card TextBlock markdown. Escapes FIRST
 * (raw input is where injection lives), then translates emoji shortcodes and
 * *bold* → **bold**. ALL card text — title and message alike — must go
 * through this; nothing user-controlled may reach a TextBlock raw.
 */
export function toAdaptiveText(s: string): string {
  // *bold* → **bold** (don't touch already-doubled asterisks or mid-word *).
  return slackEmojiToUnicode(escapeAdaptiveText(s)).replace(
    /(^|\s)\*([^*\n]+)\*(?=\s|[.,;:!?)]|$)/g,
    "$1**$2**",
  );
}

/** Slack mrkdwn one-liner → plain text (for fallbackText). No markdown
 *  renderer touches fallbackText, so no escaping — just de-mrkdwn it. */
export function toPlainText(s: string): string {
  return slackEmojiToUnicode(s).replace(
    /(^|\s)\*([^*\n]+)\*(?=\s|[.,;:!?)]|$)/g,
    "$1$2",
  );
}

/**
 * Build the Teams webhook wire payload: a Bot Framework message wrapping one
 * Adaptive Card. `title` is the bolded first line (e.g. the nest name);
 * `message` is the Slack-flavored notification text (may be a multi-line
 * digest — TextBlocks wrap and honor \n via the markdown renderer).
 */
export function msTeamsPayload(title: string, message: string): unknown {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          fallbackText: `[${title}] ${toPlainText(message)}`,
          body: [
            {
              // Same pipeline as the message: the nest name is user-
              // controlled text too and must not carry link syntax.
              type: "TextBlock",
              text: toAdaptiveText(title),
              weight: "Bolder",
              size: "Medium",
              wrap: true,
            },
            {
              type: "TextBlock",
              text: toAdaptiveText(message),
              wrap: true,
            },
          ],
        },
      },
    ],
  };
}

/** Prefix the card with the nest's human name (best-effort). */
export async function notifyMsTeamsForNest(
  nestId: string,
  message: string,
): Promise<void> {
  if (!config.MSTEAMS_WEBHOOK_URL) return;
  let nestName = nestId;
  try {
    const row = (await getDb().get("SELECT name FROM nests WHERE id = ?", [
      nestId,
    ])) as { name?: string } | undefined;
    if (row?.name) nestName = row.name;
  } catch {
    /* name lookup is cosmetic */
  }
  return notifyMsTeams(nestName, message);
}

async function notifyMsTeams(title: string, message: string): Promise<void> {
  const url = config.MSTEAMS_WEBHOOK_URL;
  if (!url) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msTeamsPayload(title, message)),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[msteams] notification failed (suppressing further warnings):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
