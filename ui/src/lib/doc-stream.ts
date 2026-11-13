/**
 * Experimental cross-nest document stream — the filter state and query
 * building the Stream page shares with its per-nest tab. Pure, so it is
 * unit-tested without a DOM.
 */
import type { StreamItem } from "./api";
import { versionAgent } from "./version-author";
import { parseServerDate } from "./dates";

export type StreamFacetKey = "nest" | "tag" | "type" | "author";

export interface StreamFilters {
  nest: string[];
  tag: string[];
  type: string[];
  author: string[];
}

/** The one "from agents / from people" toggle (po-1214); undefined = both. */
export type StreamSource = "agent" | "human";

export interface StreamQuery extends Partial<StreamFilters> {
  since?: string;
  limit?: number;
  offset?: number;
  source?: StreamSource;
  /** false: skip the facet counts (the new-posts poll). */
  facets?: boolean;
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
  if (q.source) p.set("source", q.source);
  if (q.facets === false) p.set("facets", "0");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** "Load more": append the next page, skipping anything already shown (a
 *  version landing between two fetches shifts the page by one). */
export function mergeStreamPages(shown: StreamItem[], next: StreamItem[]): StreamItem[] {
  const seen = new Set(shown.map((i) => i.id));
  return [...shown, ...next.filter((i) => !seen.has(i.id))];
}

// ── po-1214: a post in the feed ─────────────────────────────────────────────

/** How many facet values are switched on — the badge on the Filter button. */
export function activeFilterCount(f: StreamFilters): number {
  return f.nest.length + f.tag.length + f.type.length + f.author.length;
}

/** Who the post is by: the person's display name (never the email when a
 *  name exists) and the agent the write named, if any. The person always
 *  comes first; the agent never stands in for them (po-1184). */
export function postIdentity(item: Pick<StreamItem, "author" | "authorName" | "client">): {
  name: string;
  agent: string | null;
} {
  const name = item.authorName || item.author?.split("@")[0] || "Someone";
  return { name, agent: versionAgent(item) };
}

/** What happened, as the verb before the title. */
export function postAction(item: Pick<StreamItem, "kind" | "status">): string {
  if (item.status === "pending_review") return "submitted for review";
  switch (item.kind) {
    case "approved":
      return "got approval on";
    case "rejected":
      return "got changes requested on";
    case "updated":
      return "edited";
    default:
      return item.kind;
  }
}

/** Up to two initials for the avatar. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** "now", "5m", "3h", "2d", then "Oct 1" — the feed's compact time. */
export function compactTime(raw: string, now = Date.now()): string {
  const d = parseServerDate(raw);
  if (!d) return "";
  const secs = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The "N new posts" pill. The poll asks for `since` = the newest shown post's
 * time, and `since` is inclusive, so `total` also counts the shown posts at
 * or after it. What is left is new.
 */
export function newPostCount(shown: StreamItem[], since: string | undefined, total: number): number {
  if (!since) return 0;
  const already = shown.filter((i) => i.at >= since).length;
  return Math.max(0, total - already);
}
