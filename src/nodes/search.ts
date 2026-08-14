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

/** The wire shape both search routes return per hit. */
export function toSearchHit(node: ContextNode) {
  return {
    id: node.id,
    title: node.frontmatter.title,
    type: node.frontmatter.type || "document",
    tags: node.frontmatter.tags || [],
    snippet: (node.body || "").slice(0, 200).replace(/\n/g, " "),
  };
}
