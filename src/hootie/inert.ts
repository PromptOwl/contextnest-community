/**
 * The model's answer, made inert for posting as a comment (security r2 N1,
 * redesigned in r4). Comments render markdown with live images and links —
 * right for what people write, a zero-click exfiltration channel for model
 * text an injection steered.
 *
 * Escape, don't blacklist: a blacklist of link shapes always misses one
 * (nested brackets, shortcut references, definitions inside quotes or lists,
 * entity-encoded destinations). Instead:
 *   1. cut the answer to INERT_MAX_CHARS;
 *   2. turn URLs into "[link removed]" (autolink literals need no brackets);
 *   3. keep `[[wiki links]]` verbatim (bounded label, no brackets inside) —
 *      with no link definition possible, they render as their text;
 *   4. backslash-escape every `\ [ ] ( ) ! < > &` everywhere else, so no
 *      image, link, reference, definition, autolink, HTML or entity can
 *      form; and break email autolinks with an invisible word joiner after
 *      an `@` glued to a word (an @mention, which follows a space, is left
 *      alone).
 * Every pattern is linear and the input is bounded: no fixpoint loop.
 */

export const INERT_MAX_CHARS = 4000;

const WIKI = /\[\[[^[\]\n]{1,200}\]\]/g;

function escapeMarkdown(text: string): string {
  return noEmailLinks(text.replace(/[\\[\]()!<>&]/g, "\\$&"));
}

/** GFM auto-links an email address (mailto:) whatever is escaped around it,
 *  but only when a letter or digit follows the `@`. A word joiner (U+2060,
 *  invisible) after an `@` glued to a word breaks that. An @mention, which
 *  follows a space, is left alone. */
function noEmailLinks(text: string): string {
  return text.replace(/(?<=\S)@/g, "@\u2060");
}

export function inertAnswer(answer: string): string {
  let text = answer.length > INERT_MAX_CHARS ? `${answer.slice(0, INERT_MAX_CHARS)}…` : answer;
  text = text
    .replace(/(?:https?|ftp|mailto|data|javascript):\/*[^\s<>()[\]]*/gi, "[link removed]")
    .replace(/(^|[^\w:])\/\/[^\s<>()[\]]+/g, "$1[link removed]")
    .replace(/www\.[^\s<>()[\]]+/gi, "[link removed]");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(WIKI)) {
    out += escapeMarkdown(text.slice(last, m.index)) + noEmailLinks(m[0]);
    last = m.index! + m[0].length;
  }
  return out + escapeMarkdown(text.slice(last));
}
