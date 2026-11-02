/**
 * An HTML artifact as the text a person sees on the page (pure).
 *
 * Artifact bodies are whole HTML pages — dashboards, decks — and most of
 * their bytes are script, style and markup. Handed to the model raw they
 * crowd out the words that answer the question (a 36 KB dashboard is ~9k
 * tokens of mostly JS), so Hootie reduces them first: script, style,
 * template and noscript are dropped with their content, comments too, tags
 * go, entities are decoded once, and whitespace collapses to one line per
 * block. A text extractor for prompting, not a sanitizer: its output only
 * ever goes to the model as plain text, never back to a browser.
 */
import { approxTokens } from "../nodes/context-service.js";

/** What the publish/render path treats as an HTML page (same heuristic). */
export function isHtmlBody(type: string | undefined, body: string): boolean {
  return type === "artifact" || /^\s*<(?:!doctype|html)\b/i.test(body);
}

/** Elements whose content is never shown as text. An unclosed one runs to
 *  the end, as it does in the browser. */
const HIDDEN = /<!--[\s\S]*?(?:-->|$)|<(script|style|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
/** Tags whose boundaries are line breaks in the rendered page. */
const BLOCK =
  /^(?:address|article|aside|blockquote|br|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|thead|tfoot|tr|ul|title|head|body|html|caption|option|label|button|canvas|svg|text)$/i;
/** Cells sit side by side. */
const CELL = /^(?:td|th)$/i;
/** A start/end tag or doctype; quoted attribute values may contain `>`. */
const TAG = /<\/?([a-zA-Z][^\s/<>]*)(?:\s|"[^"]*"|'[^']*'|[^\s"'<>])*>|<![^>]*>/g;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•",
  middot: "·", copy: "©", reg: "®", trade: "™", times: "×",
  divide: "÷", deg: "°", plusmn: "±", larr: "←", rarr: "→",
  uarr: "↑", darr: "↓", harr: "↔", check: "✓", euro: "€",
  pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", ensp: " ", emsp: " ", thinsp: " ",
};

function decodeEntities(s: string): string {
  // One pass: "&amp;lt;" is the text "&lt;", never "<".
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const cp = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

export function artifactText(html: string): string {
  const text = html
    .replace(HIDDEN, " ")
    .replace(TAG, (_tag, name: string | undefined) =>
      !name ? " " : BLOCK.test(name) ? "\n" : CELL.test(name) ? " " : "",
    );
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Marker left where a document was cut to fit. */
export const TRIMMED_MARKER = "[trimmed — the rest of this document did not fit]";

/**
 * Cut `text` to about `maxTokens` (the same 4-chars-per-token estimate the
 * retrieval budget uses), at a word boundary, and say so — a document over
 * budget is shortened, never dropped.
 */
export function trimToTokens(text: string, maxTokens: number): { text: string; trimmed: boolean } {
  if (approxTokens(text) <= maxTokens) return { text, trimmed: false };
  const room = Math.max(0, maxTokens * 4 - TRIMMED_MARKER.length - 2);
  let cut = text.slice(0, room);
  const space = cut.search(/\s\S*$/);
  if (space > room * 0.8) cut = cut.slice(0, space);
  return { text: `${cut.trimEnd()}\n\n${TRIMMED_MARKER}`, trimmed: true };
}
