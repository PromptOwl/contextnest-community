/**
 * The deterministic gate (PRD §4.2): rules evaluated in order, first match
 * wins. Pure — the ingest service resolves the binding, the author's status
 * (G4: external / guest, fetched; unknown fails closed) and the opt-out, and
 * hands the facts in. No text is kept for a dropped message.
 *
 * G0 (auth) is the route's signature check; it never reaches here.
 */
export type DropReason = "auth_failed" | "duplicate" | "not_enabled" | "paused" | "bot_or_system" | "external_or_guest" | "opted_out" | "too_short";

/** Slack subtypes that are a person talking (G3); everything else is system. */
export const SUBTYPE_ALLOWLIST: ReadonlySet<string> = new Set(["thread_broadcast", "file_share", "me_message"]);
/** G7: longer text is truncated (not dropped). */
export const MAX_TEXT_CHARS = 4000;
/** Explicit ask by mention (§4.2). */
export const REMEMBER_RE = /\bremember( this)?\b/i;
/** Opt-out by mention (§4.2). */
export const SKIP_ME_RE = /\bskip me\b/i;

/** What the service learned about the author (G3/G4). `unknown` = the
 *  profile couldn't be read: dropped, fail closed. */
export type AuthorStatus = "member" | "bot" | "guest_or_external" | "unknown";

export interface GateInput {
  duplicate: boolean;
  binding: { status: string; capture_ok: boolean; conversation_kind?: string } | null;
  message: { subtype: string | null; bot_id: string | null; author_id: string | null; text: string };
  ourBotUserId: string | null;
  author: AuthorStatus;
  optedOut: boolean;
  minMeaningfulChars: number;
  /** Explicit asks bypass G6 (they still apply G0–G5). */
  explicitAsk?: boolean;
}

export type GateResult = { keep: true; text: string; truncated: boolean; meaningful: number } | { keep: false; reason: DropReason };

const SHORTCODE = /:[a-z0-9_+'-]+:/gi;
// Pictographs, their modifiers, ZWJ, variation selectors, keycaps, flags.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍︎️⃣]/gu;
const SLACK_TOKEN = /<[@#!][^>]*>/g;
const SLACK_LINK = /<(?:https?|mailto|tel):[^>]*>/gi;
const BARE_URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const PUNCT_OR_SPACE = /[\p{P}\p{Z}\s]/gu;

/** Characters left after removing emoji (shortcode and Unicode), Slack
 *  mention/channel/special tokens, URLs, whitespace and punctuation (G6). */
export function meaningfulChars(text: string): number {
  const stripped = text
    .replace(SLACK_TOKEN, " ")
    .replace(SLACK_LINK, " ")
    .replace(BARE_URL, " ")
    .replace(SHORTCODE, " ")
    .replace(EMOJI, " ")
    .replace(PUNCT_OR_SPACE, "");
  return [...stripped].length;
}

export function gate(input: GateInput): GateResult {
  const { message: m } = input;
  // G1
  if (input.duplicate) return { keep: false, reason: "duplicate" };
  // G2
  if (!input.binding) return { keep: false, reason: "not_enabled" };
  if (input.binding.status !== "active" || !input.binding.capture_ok) return { keep: false, reason: "paused" };
  // G3
  if (m.bot_id || input.author === "bot") return { keep: false, reason: "bot_or_system" };
  if (input.ourBotUserId && m.author_id === input.ourBotUserId) return { keep: false, reason: "bot_or_system" };
  if (m.subtype && !SUBTYPE_ALLOWLIST.has(m.subtype)) return { keep: false, reason: "bot_or_system" };
  if (!m.author_id) return { keep: false, reason: "bot_or_system" };
  // G4 (unknown fails closed)
  if (input.author !== "member") return { keep: false, reason: "external_or_guest" };
  // G5
  if (input.optedOut) return { keep: false, reason: "opted_out" };
  // G6
  const meaningful = meaningfulChars(m.text);
  if (!input.explicitAsk && meaningful < input.minMeaningfulChars) return { keep: false, reason: "too_short" };
  // G7
  const truncated = m.text.length > MAX_TEXT_CHARS;
  return { keep: true, text: truncated ? m.text.slice(0, MAX_TEXT_CHARS) : m.text, truncated, meaningful };
}
