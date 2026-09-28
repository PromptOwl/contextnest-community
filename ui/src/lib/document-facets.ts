/**
 * Tag counts + "recently edited" for the Documents tab facet bar — pure, so
 * it's testable without a browser.
 *
 * Both facets must describe the same document set the list below them is
 * showing. They're derived here from whatever node list the caller passes
 * in (typically `visibleDocuments`'s filtered result) rather than from the
 * nest-wide census, so an active filter narrows the facets exactly like it
 * narrows the list — including down to nothing when nothing matches.
 */

export interface FacetableNode {
  id: string;
  title?: string;
  type?: string;
  tags?: string[];
  updated_at?: string;
}

export interface DocumentFacets {
  tags: Array<{ tag: string; count: number }>;
  recent: Array<{ id: string; title: string; type: string; updated_at?: string }>;
}

const DEFAULT_RECENT_LIMIT = 3;

export function documentFacets(
  nodes: FacetableNode[],
  recentLimit = DEFAULT_RECENT_LIMIT,
): DocumentFacets {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    for (const t of new Set(n.tags ?? [])) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));

  const recent = nodes
    .filter((n) => n.updated_at)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, recentLimit)
    .map((n) => ({
      id: n.id,
      title: n.title ?? n.id,
      type: n.type || "document",
      updated_at: n.updated_at,
    }));

  return { tags, recent };
}
