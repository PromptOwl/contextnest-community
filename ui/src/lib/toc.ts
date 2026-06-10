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

/** h1–h3 headings in document order, skipping fenced code blocks. */
export function extractHeadings(markdown: string): TocHeading[] {
  const out: TocHeading[] = [];
  let inFence = false;
  let i = 0;
  for (const line of (markdown ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    out.push({
      level: m[1].length as 1 | 2 | 3,
      text: plainText(m[2]),
      id: `doc-h-${i++}`,
    });
  }
  return out;
}
