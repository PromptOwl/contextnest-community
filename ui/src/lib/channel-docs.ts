/**
 * Channel nodes and the document surfaces (PO-1189).
 *
 * A channel is an ordinary node (`nodes/channels/<name>`, tagged `#channel`),
 * so every listing of documents returns it: the sidebar tree, the nest
 * overview, the board, the graph, search. While channels are on, a person on
 * the nest meets a channel on the Channels page, and these helpers take it
 * out of the places that list documents. The rule is the server's
 * (`isChannelDoc` in src/channels/channel-node.ts): a direct child of
 * `nodes/channels/` that carries the `#channel` tag. A plain document filed
 * under `channels/` stays a document.
 *
 * Pure: the read layer (queries.ts) decides when they apply.
 */
import type { NestCensus } from "./api";

const CHANNEL_ID = /^nodes\/channels\/([a-z0-9][a-z0-9-]{0,62})$/;
const CHANNEL_FOLDER = "channels";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Tagged = { id: string; tags?: unknown };
const tagsOf = (node: { tags?: unknown }): string[] =>
  Array.isArray(node.tags) ? node.tags.filter((t): t is string => typeof t === "string") : [];
const normalizeTag = (tag: string) => tag.trim().replace(/^#/, "").toLowerCase();

/** "nodes/channels/ops" → "ops"; null for any other id. */
export function channelNameOfDoc(nodeId: string): string | null {
  return CHANNEL_ID.exec(nodeId)?.[1] ?? null;
}

export function isChannelDoc(node: Tagged): boolean {
  return CHANNEL_ID.test(node.id) && tagsOf(node).some((t) => normalizeTag(t) === "channel");
}

/** A `{ count, nodes }` listing without its channel nodes (the same object when it has none). */
export function withoutChannelDocs<T extends { nodes: Tagged[]; count?: number }>(listing: T): T {
  const nodes = listing.nodes.filter((n) => !isChannelDoc(n));
  if (nodes.length === listing.nodes.length) return listing;
  const removed = listing.nodes.length - nodes.length;
  return { ...listing, nodes, ...(typeof listing.count === "number" ? { count: Math.max(0, listing.count - removed) } : {}) };
}

/** `counts` with each key lowered by how often it occurs in `keys`; a key that reaches zero is dropped. */
function lowered(counts: Record<string, number> | undefined, keys: string[], match: (a: string, b: string) => boolean = (a, b) => a === b) {
  if (!counts) return counts;
  const out = { ...counts };
  for (const key of keys) {
    const hit = Object.keys(out).find((k) => match(k, key));
    if (!hit) continue;
    out[hit] -= 1;
    if (out[hit] <= 0) delete out[hit];
  }
  return out;
}
const sameTag = (a: string, b: string) => normalizeTag(a) === normalizeTag(b);

type ChannelDocRow = Tagged & { type?: string; status?: string; updated_at?: string };

/**
 * The nest census as if its channel nodes were not documents. `channels` are
 * the channel nodes themselves (the `channels/` folder listing), so every
 * number is lowered by what those nodes actually contribute.
 */
export function withoutChannelsInCensus<C extends NestCensus>(census: C, channels: ChannelDocRow[], now = Date.now()): C {
  const n = channels.length;
  if (n === 0) return census;
  const ids = new Set(channels.map((c) => c.id));
  const live = channels.filter((c) => c.status === "published" || c.status === "approved").length;
  const editedThisWeek = channels.filter((c) => {
    const at = c.updated_at ? Date.parse(c.updated_at) : NaN;
    return !Number.isNaN(at) && now - at <= WEEK_MS;
  }).length;
  return {
    ...census,
    total: Math.max(0, census.total - n),
    folders: census.folders
      .map((f) => (f.path === CHANNEL_FOLDER ? { ...f, count: f.count - n, total: f.total - n } : f))
      .filter((f) => f.path !== CHANNEL_FOLDER || f.total > 0),
    tags: lowered(census.tags, channels.flatMap(tagsOf), sameTag) ?? census.tags,
    types: lowered(census.types, channels.map((c) => c.type ?? "document")) ?? census.types,
    statuses: lowered(census.statuses, channels.map((c) => c.status ?? "")) ?? census.statuses,
    ...(typeof census.aiReady === "number" ? { aiReady: Math.max(0, census.aiReady - live) } : {}),
    editedLast7d: Math.max(0, census.editedLast7d - editedThisWeek),
    recent: census.recent.filter((r) => !ids.has(r.id)),
  };
}

/** GET /overview without channel nodes: the list, the total, and the type and tag counts. */
export function withoutChannelsInOverview<O extends { nodes?: Array<Tagged & { type?: string }>; total?: number; types?: Record<string, number>; tags?: Record<string, number> }>(
  overview: O,
): O {
  const channels = (overview.nodes ?? []).filter(isChannelDoc);
  if (channels.length === 0) return overview;
  return {
    ...overview,
    nodes: (overview.nodes ?? []).filter((n) => !isChannelDoc(n)),
    ...(typeof overview.total === "number" ? { total: Math.max(0, overview.total - channels.length) } : {}),
    ...(overview.types ? { types: lowered(overview.types, channels.map((c) => c.type ?? "document")) } : {}),
    ...(overview.tags ? { tags: lowered(overview.tags, channels.flatMap(tagsOf), sameTag) } : {}),
  };
}

/** The nest graph without channel nodes and without the links that touch them. */
export function withoutChannelsInGraph<G extends { nodes?: Tagged[]; links?: Array<{ source: unknown; target: unknown }>; totalNodes?: number }>(graph: G): G {
  const gone = new Set((graph.nodes ?? []).filter(isChannelDoc).map((n) => n.id));
  if (gone.size === 0) return graph;
  const end = (v: unknown) => (typeof v === "string" ? v : String((v as { id?: unknown } | null)?.id ?? ""));
  return {
    ...graph,
    nodes: (graph.nodes ?? []).filter((n) => !gone.has(n.id)),
    links: (graph.links ?? []).filter((l) => !gone.has(end(l.source)) && !gone.has(end(l.target))),
    ...(typeof graph.totalNodes === "number" ? { totalNodes: Math.max(0, graph.totalNodes - gone.size) } : {}),
  };
}
