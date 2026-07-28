import type { ImportedFile } from "./api";

/**
 * Split a single markdown file that is a whole-nest export (Connect →
 * "Export as markdown": every doc as `---\n<frontmatter>\n---\n<body>`, blocks
 * joined by `\n\n---\n\n`) back into one ImportedFile per document, so that
 * file can be re-imported through the normal folder importer.
 *
 * This must stay in lockstep with the SERVER serialization in
 * `src/nodes/markdown-export.ts` (`nodeToMarkdown`/`nodesToMarkdown`) — it is
 * the inverse of that format. If the export shape changes, update both; the
 * unit tests here mirror that server format so a drift shows up as a failure.
 *
 * A normal single-doc markdown file (one frontmatter block, no separator)
 * passes through unchanged as `[{ path: fallbackName, content }]`.
 *
 * Each doc's path comes from its exported `id:` (falls back to `title:`, then a
 * positional `document-N`); colliding names are de-duped so two docs never map
 * to the same path. A body that itself contains a blank-line-wrapped horizontal
 * rule (`\n\n---\n\n`) is re-joined to its block rather than mis-split — the one
 * ambiguity the export's own separator carries.
 */
export function splitExportedMarkdown(
  text: string,
  fallbackName: string,
): ImportedFile[] {
  const norm = text.replace(/\r\n/g, "\n");
  const isBlockStart = (s: string) => /^---\n[\s\S]*?\n---\n/.test(s);
  if (!norm.startsWith("---") || !norm.includes("\n\n---\n\n")) {
    return [{ path: fallbackName, content: text }];
  }

  const blocks: string[] = [];
  for (const part of norm.split("\n\n---\n\n")) {
    if (isBlockStart(part) || blocks.length === 0) blocks.push(part);
    else blocks[blocks.length - 1] += `\n\n---\n\n${part}`; // hr inside a body
  }
  if (blocks.length < 2) return [{ path: fallbackName, content: text }];

  // Read a frontmatter scalar, stripping surrounding quotes; "" when absent.
  const field = (fm: string, key: string): string => {
    const raw = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
    return raw.replace(/^"(.*)"$/, "$1").trim();
  };

  const seen = new Map<string, number>();
  return blocks.map((block, i) => {
    const fm = block.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    let base = (field(fm, "id") || field(fm, "title") || `document-${i + 1}`).trim();
    base = base.replace(/\.md$/i, "");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const path = `${n > 1 ? `${base}-${n}` : base}.md`;
    return { path, content: block };
  });
}
