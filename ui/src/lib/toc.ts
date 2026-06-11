/**
 * Outline/TOC — pure markdown heading extraction, framework-free so it's
 * unit-testable in the node test env.
 *
 * Headings are matched by ORDER, not by slug: DocumentViewer assigns each
 * rendered h1–h3 a sequential `doc-h-<i>` id in the same document order, so
 * the outline's i-th entry always points at the i-th rendered heading. This
 * sidesteps slug drift when headings contain inline markdown.
 */

export interface TocHeading {
  level: 1 | 2 | 3;
  text: string;
  id: string;
}

/** Strip the inline-markdown syntax that commonly appears in headings. */
function plainText(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, alias) => alias ?? t)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

/** True when `line` could be a setext heading's text (a plain paragraph line). */
function isSetextText(line: string): boolean {
  if (!line.trim()) return false;
  // remark only treats a preceding *paragraph* as setext text — not a list
  // item, blockquote, ATX heading, table row, or fence.
  return !/^\s*([#>|]|[-*+]\s|\d+[.)]\s|```|~~~)/.test(line);
}

/**
 * h1–h3 headings in document order, skipping fenced code blocks. Must stay in
 * lock-step with DocumentViewer's `doc-h-<i>` assignment, so it counts every
 * construct react-markdown renders as a heading: ATX (`#`), blockquote-prefixed
 * ATX (`> #`), and setext (text underlined by `===`/`---`). h4–h6 are excluded
 * in both places.
 */
export function extractHeadings(markdown: string): TocHeading[] {
  const out: TocHeading[] = [];
  let inFence = false;
  let i = 0;
  const push = (level: 1 | 2 | 3, text: string) =>
    out.push({ level, text: plainText(text), id: `doc-h-${i++}` });

  const lines = (markdown ?? "").split("\n");
  let prev = "";
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      prev = line;
      continue;
    }
    if (inFence) {
      prev = line;
      continue;
    }
    // Setext: an `=`/`-` underline directly under a paragraph line → h1/h2.
    const setext = line.match(/^\s{0,3}(=+|-+)\s*$/);
    if (setext && isSetextText(prev)) {
      push(setext[1][0] === "=" ? 1 : 2, prev);
      prev = "";
      continue;
    }
    // ATX, optionally inside a blockquote (`> #`, `>> ##`).
    const atx = line.replace(/^(\s*>+\s?)+/, "").match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (atx) {
      push(atx[1].length as 1 | 2 | 3, atx[2]);
    }
    prev = line;
  }
  return out;
}
