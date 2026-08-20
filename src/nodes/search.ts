import type { ContextNode } from "@promptowl/contextnest-engine";

/** Free-text match over title, body, type and tags. Every whitespace-separated
 *  term must appear somewhere (AND), case-insensitive substring — the same rule
 *  the per-nest and cross-nest search routes both run on. */
export function matchDocuments<T extends ContextNode>(
  documents: T[],
  query: string,
): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return documents.filter((node) => {
    const haystack = [
      node.frontmatter.title,
      node.body || "",
      node.frontmatter.type || "",
      ...(node.frontmatter.tags || []),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** A ~200 char window of the body around the first matching term, so the
 *  caller can see *why* a body-text hit came back. Falls back to the head of
 *  the body when no term is in the body (title/tag-only match). */
function bodySnippet(body: string, query?: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const terms = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const at = terms
    .map((t) => flat.toLowerCase().indexOf(t))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (at === undefined || at < 80) return flat.slice(0, 200);
  const start = Math.max(0, at - 60);
  return `…${flat.slice(start, start + 200)}`;
}

/** The wire shape both search routes return per hit. */
export function toSearchHit(node: ContextNode, query?: string) {
  return {
    id: node.id,
    title: node.frontmatter.title,
    type: node.frontmatter.type || "document",
    tags: node.frontmatter.tags || [],
    snippet: bodySnippet(node.body || "", query),
  };
}
