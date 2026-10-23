/**
 * Experimental cross-nest document stream — the filter state and query
 * building the Stream page shares with its per-nest tab. Pure, so it is
 * unit-tested without a DOM.
 */
import type { StreamItem } from "./api";

export type StreamFacetKey = "nest" | "tag" | "type" | "author";

export interface StreamFilters {
  nest: string[];
  tag: string[];
  type: string[];
  author: string[];
}

export interface StreamQuery extends Partial<StreamFilters> {
  since?: string;
  limit?: number;
  offset?: number;
}

export const EMPTY_STREAM_FILTERS: StreamFilters = Object.freeze({
  nest: [],
  tag: [],
  type: [],
  author: [],
}) as StreamFilters;

/** Add a chip's value to its facet, or take it out. OR within a facet. */
export function toggleFacet(f: StreamFilters, key: StreamFacetKey, value: string): StreamFilters {
  const cur = f[key];
  return {
    ...f,
    [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value],
  };
}

/**
 * Query string for GET /me/stream — multi-select facets as repeated params.
 * `pinnedNest` (the per-nest tab) replaces any nest chips.
 */
export function streamQueryString(q: StreamQuery, pinnedNest?: string): string {
  const p = new URLSearchParams();
  const nests = pinnedNest ? [pinnedNest] : (q.nest ?? []);
  for (const v of nests) p.append("nest", v);
  for (const key of ["tag", "type", "author"] as const) {
    for (const v of q[key] ?? []) p.append(key, v);
  }
  if (q.since) p.set("since", q.since);
  if (q.limit != null) p.set("limit", String(q.limit));
  if (q.offset != null && q.offset > 0) p.set("offset", String(q.offset));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** "Load more": append the next page, skipping anything already shown (a
 *  version landing between two fetches shifts the page by one). */
export function mergeStreamPages(shown: StreamItem[], next: StreamItem[]): StreamItem[] {
  const seen = new Set(shown.map((i) => i.id));
  return [...shown, ...next.filter((i) => !seen.has(i.id))];
}
