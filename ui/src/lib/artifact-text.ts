/**
 * Artifact text extraction + anchor building for the annotation layer.
 *
 * Annotations are anchored over the artifact's *extracted text* (the same
 * plain text the nest indexes), NOT the raw HTML — see the W3C TextQuote
 * pattern. These helpers are pure so they're trivially unit-testable.
 */

/** Mirrors the server's clamp (src/annotations/projection.ts). */
export const MAX_CONTEXT_CHARS = 250;

const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "LI", "TR",
  "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TABLE",
  "UL", "OL", "BR", "HR",
]);

/**
 * Reduce artifact HTML to readable plain text with block-level newlines.
 * Scripts/styles are dropped. Deterministic so a quote captured in the
 * annotation panel maps to stable before/after context.
 */
export function extractText(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    // Non-DOM env (tests/SSR): strip tags, collapse runs of whitespace.
    // Final [<>] pass is belt-and-suspenders: even if the tag regexes leave a
    // partial "<script" from nested/malformed input, no angle bracket survives
    // (clears CodeQL js/incomplete-multi-character-sanitization). The result is
    // only ever rendered as escaped text, never as HTML.
    return html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/[<>]/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,template").forEach((n) => n.remove());

  // No markup at all — a markdown or plain-text file stored as an artifact.
  // Its line breaks ARE its structure; collapsing them turns a document into
  // one paragraph. Same treatment as <pre> below.
  if (!doc.body.querySelector("*")) {
    return (doc.body.textContent || "")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  let out = "";
  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      out += pre ? text : text.replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    const block = BLOCK_TAGS.has(tag);
    if (block && out && !out.endsWith("\n")) out += "\n";
    node.childNodes.forEach((child) => walk(child, pre || tag === "PRE"));
    if (block && !out.endsWith("\n")) out += "\n";
  };
  walk(doc.body, false);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface BuiltAnchor {
  line: number;
  quote: string;
  before: string;
  after: string;
}

/**
 * Build a W3C-style anchor from a character range over the extracted text.
 * `before`/`after` are clamped to MAX_CONTEXT_CHARS; `line` is a 1-based hint.
 * Returns null when the range is empty/whitespace.
 */
export function buildAnchor(
  text: string,
  start: number,
  end: number,
): BuiltAnchor | null {
  if (start < 0 || end > text.length || start >= end) return null;
  const quote = text.slice(start, end).trim();
  if (!quote) return null;
  return {
    quote,
    before: text.slice(Math.max(0, start - MAX_CONTEXT_CHARS), start),
    after: text.slice(end, end + MAX_CONTEXT_CHARS),
    line: text.slice(0, start).split("\n").length,
  };
}
