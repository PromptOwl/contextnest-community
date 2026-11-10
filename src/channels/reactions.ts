/**
 * Reactions on a channel message (PO-1196, team chat C1): one row per
 * (message, emoji, person); an agent that reacts is recorded with the
 * message-row attribution (`client_json`) and shown under its label.
 *
 * What counts as an emoji: a single emoji — one pictographic character with
 * an optional presentation selector or skin tone, a ZWJ sequence of those, a
 * flag (two regional indicators) or a keycap — or one of a short list of
 * shortcodes (`:+1:`, `thumbsup`, …) which is stored as its emoji. Anything
 * else is refused: a reaction is rendered next to every message a channel
 * shows, so it is never free text.
 */
import { getDb } from "../db/client.js";
import { nowMsExpr } from "../db/sql.js";
import { serializeClient } from "../shared/client-metadata.js";
import { ValidationError } from "../shared/errors.js";
import { REACTION_LIMIT, assertMayAct, assertNotDeleted, locateMessage, takeOrRefuse, type ActingCaller } from "./message-access.js";
import { reactionsFor, type ReactionView } from "./message-extras.js";

/** Shortcodes a client (or an agent) may send instead of the character. */
export const EMOJI_SHORTCODES: Record<string, string> = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  heart: "❤️",
  eyes: "👀",
  tada: "🎉",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  rocket: "🚀",
  fire: "🔥",
  joy: "😂",
  smile: "😄",
  thinking: "🤔",
  thinking_face: "🤔",
  pray: "🙏",
  clap: "👏",
  "100": "💯",
  wave: "👋",
  raised_hands: "🙌",
  ok_hand: "👌",
  warning: "⚠️",
  question: "❓",
  point_up: "☝️",
  bulb: "💡",
  memo: "📝",
  bug: "🐛",
  sparkles: "✨",
  star: "⭐",
  hourglass: "⏳",
  ship: "🚢",
};

const PICTO = "\\p{Extended_Pictographic}";
const MOD = "(?:\\uFE0F|\\p{Emoji_Modifier})?";
/** One emoji: picto (+selector/tone) joined by ZWJ to more of the same; a
 *  two-letter flag; or a keycap sequence. */
const SINGLE_EMOJI = new RegExp(
  `^(?:${PICTO}${MOD}(?:\\u200D${PICTO}${MOD})*|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3)$`,
  "u",
);

/** The stored form of a reaction, or a ValidationError. */
export function parseEmoji(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("emoji is required — one emoji, or a shortcode such as :+1:.");
  const text = raw.trim();
  if (!text || text.length > 32) throw new ValidationError("emoji must be one emoji, or a shortcode such as :+1:.");
  const code = text.replace(/^:|:$/g, "").toLowerCase();
  if (Object.hasOwn(EMOJI_SHORTCODES, code)) return EMOJI_SHORTCODES[code];
  if (SINGLE_EMOJI.test(text)) return text;
  throw new ValidationError("emoji must be one emoji, or a shortcode such as :+1:.");
}

export interface ReactionResult {
  message_id: string;
  reactions: ReactionView[];
}

async function after(caller: ActingCaller, messageId: string): Promise<ReactionResult> {
  return { message_id: messageId, reactions: (await reactionsFor(caller.userId, [messageId])).get(messageId) ?? [] };
}

/** Add the caller's reaction (idempotent). */
export async function addReaction(caller: ActingCaller, channel: unknown | null, rawId: unknown, rawEmoji: unknown): Promise<ReactionResult> {
  const emoji = parseEmoji(rawEmoji);
  const located = await locateMessage(caller, channel, rawId);
  await assertMayAct(caller, located);
  assertNotDeleted(located);
  takeOrRefuse(`chat-react:${caller.userId}`, REACTION_LIMIT, "reactions");
  const db = getDb();
  await db.run(
    `INSERT INTO message_reactions (nest_id, node_id, thread_id, comment_id, emoji, user_id, author, client_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowMsExpr(db)})
     ON CONFLICT (comment_id, emoji, user_id) DO NOTHING`,
    [caller.nestId, located.node.id, located.row.thread_id, located.row.id, emoji, caller.userId, caller.userEmail, serializeClient(caller.client)],
  );
  return after(caller, located.row.id);
}

/** Remove the caller's reaction (a no-op when there is none). */
export async function removeReaction(caller: ActingCaller, channel: unknown | null, rawId: unknown, rawEmoji: unknown): Promise<ReactionResult> {
  const emoji = parseEmoji(rawEmoji);
  const located = await locateMessage(caller, channel, rawId);
  await assertMayAct(caller, located);
  takeOrRefuse(`chat-react:${caller.userId}`, REACTION_LIMIT, "reactions");
  await getDb().run("DELETE FROM message_reactions WHERE comment_id = ? AND emoji = ? AND user_id = ?", [located.row.id, emoji, caller.userId]);
  return after(caller, located.row.id);
}
