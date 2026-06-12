/**
 * Document-list filtering — pure, framework-free so it's unit-testable in
 * the node test env. Preserves the existing NestView semantics (search hits
 * title OR any tag substring; status "all" passes everything) and adds
 * multi-tag AND filtering: every selected tag must be present on the node
 * (exact match, case-insensitive, leading "#" ignored).
 */

export interface FilterableNode {
  title?: string;
  status?: string;
  tags?: string[];
  author?: string;
  updated_at?: string;
}

export interface NodeFilters {
  search?: string;
  status?: string;
  tags?: string[];
  /** Exact author match (case-insensitive); "all"/empty passes everything. */
  author?: string;
  /** Epoch ms threshold; node passes when updated_at >= this. Caller derives
   *  it from a preset so this module stays free of the wall clock. */
  updatedAfter?: number;
}

function normTag(t: string): string {
  return t.replace(/^#/, "").toLowerCase();
}

export function matchesFilters(
  node: FilterableNode,
  filters: NodeFilters,
): boolean {
  const { search, status, tags, author, updatedAfter } = filters;

  if (status && status !== "all" && node.status !== status) return false;

  if (author && author !== "all") {
    if ((node.author ?? "").toLowerCase() !== author.toLowerCase()) return false;
  }

  if (updatedAfter != null) {
    const t = node.updated_at ? Date.parse(node.updated_at) : NaN;
    if (Number.isNaN(t) || t < updatedAfter) return false;
  }

  if (search) {
    const needle = search.toLowerCase();
    const inTitle = node.title?.toLowerCase().includes(needle) ?? false;
    const inTags = Array.isArray(node.tags)
      ? node.tags.some((t) => t.toLowerCase().includes(needle))
      : false;
    if (!inTitle && !inTags) return false;
  }

  if (tags && tags.length > 0) {
    const nodeTags = new Set((node.tags ?? []).map(normTag));
    if (!tags.every((t) => nodeTags.has(normTag(t)))) return false;
  }

  return true;
}
