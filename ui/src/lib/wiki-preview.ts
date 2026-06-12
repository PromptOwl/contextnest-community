/**
 * Hover-preview helpers for wiki links — pure, framework-free, unit-testable
 * in the node test env. Resolution mirrors WikiLink.checkExists and
 * lib/backlinks: a `[[target]]` matches a node by id, title, or bare slug,
 * case-insensitive.
 */

export interface PreviewNode {
  id: string;
  title: string;
  content?: string;
}

function bareSlug(s: string): string {
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/** The node a wiki-link target resolves to, or null. */
export function resolveWikiTarget(
  nodes: PreviewNode[],
  target: string,
): PreviewNode | null {
  const lower = target.trim().toLowerCase();
  if (!lower) return null;
  const slug = bareSlug(lower);
  return (
    nodes.find(
      (n) =>
        n.id.toLowerCase() === lower ||
        n.title.toLowerCase() === lower ||
        bareSlug(n.id).toLowerCase() === slug,
    ) ?? null
  );
}

/** A short plain-text snippet of a markdown body for the preview card. */
export function previewSnippet(content: string, maxLen = 280): string {
  const plain = (content ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => a ?? t)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLen ? plain.slice(0, maxLen).trimEnd() + "…" : plain;
}
