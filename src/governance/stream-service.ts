/**
 * Experimental cross-nest document stream (CU-wdqcq02crv) — GET /me/stream.
 *
 * One item per node version across every nest the caller can read, newest
 * first. Source: node_versions joined to the node_index mirror (title, type,
 * and the existence check: a deleted document leaves version rows behind but
 * no index row) and node_tag_index (the document's current tags).
 *
 * Access is resolved ONCE PER NEST, never per item, with the same guard the
 * governance feed and node listing use (filterAccessible):
 *   - a nest-wide reader sees every document in the nest;
 *   - a scoped reader (steward rows, share grants) sees only the documents
 *     those cover — pushed into SQL as a node-id list for that nest;
 *   - a public reader (reads the nest through its visibility, not
 *     membership) sees approved/published versions only — never a draft —
 *     and never who wrote them: the author is withheld, and the author facet
 *     and filter skip those nests, so an email can't be probed for.
 * A nest the caller can't read is not in the scope at all, so nothing about
 * it reaches items, `total` or `counts`.
 *
 * `counts` are the per-facet totals over the caller's whole readable stream
 * (since-window applied, facet filters NOT applied) — so the chips show what
 * each choice would hold, independent of the page and of the other chips.
 *
 * Bounded work per call: a handful of SQL statements (page, total, four facet
 * counts, tags + comment counts for the page) plus one body read per item on
 * the page for its summary.
 */

import { getDb } from "../db/client.js";
import type { SqlParam } from "../db/adapter.js";
import { filterAccessible } from "./access-guard.js";
import { isPublicReader } from "../shared/access.js";
import { ensureNodeIndex } from "../nodes/node-index.js";
import { normalizeTag } from "./tag-index-service.js";

export type StreamKind = "created" | "updated" | "published" | "approved" | "rejected";

export interface StreamItem {
  /** Stable key: `${nestId}:${nodeId}@${version}`. */
  id: string;
  nestId: string;
  nestName: string;
  nodeId: string;
  title: string;
  type: string;
  /** The document's current tags (normalized: no `#`, lowercase). */
  tags: string[];
  version: number;
  status: string;
  /** Author email; null where the caller reads the nest only publicly. */
  author: string | null;
  at: string;
  /** First ~200 characters of this version's body, flattened. */
  summary: string;
  /** Comments on the document's open annotation threads. */
  commentCount: number;
  kind: StreamKind;
}

export interface StreamFacetCount {
  value: string;
  count: number;
}

export interface StreamCounts {
  nest: Array<{ id: string; name: string; count: number }>;
  tag: StreamFacetCount[];
  type: StreamFacetCount[];
  author: StreamFacetCount[];
}

export interface StreamPage {
  items: StreamItem[];
  total: number;
  counts: StreamCounts;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface StreamFilters {
  nest?: string[];
  tag?: string[];
  type?: string[];
  author?: string[];
  /** Lower bound on the version's timestamp, "YYYY-MM-DD HH:MM:SS" (UTC). */
  since?: string;
}

const SUMMARY_CHARS = 200;
/** Facet lists are chips, not reports. */
const FACET_CAP = 50;
export const STREAM_MAX_LIMIT = 100;
export const STREAM_MAX_OFFSET = 10_000;

/** What the caller may see in one nest. */
interface NestScope {
  nestId: string;
  /** null = every document in the nest. */
  nodeIds: string[] | null;
  /** Public reader: approved/published versions only, no authors. */
  publicOnly: boolean;
}

/** Flatten a body to a one-line preview. */
export function summarize(body: string): string {
  const flat = body
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS)}…` : flat;
}

/**
 * What this version was, as an event. Approving a review writes status
 * 'published' (review-service), the same status an ungoverned edit goes live
 * with — so "approved" is decided by the review row, not the status:
 *   rejected  → the review turned it down
 *   approved  → a review approved this version
 *   created   → version 1 (draft or live)
 *   published → a later edit that went live without a review
 *   updated   → a later edit still in draft / pending review
 */
export function kindOf(version: number, status: string, reviewedApproved: boolean): StreamKind {
  if (status === "rejected") return "rejected";
  if (reviewedApproved) return "approved";
  if (version <= 1) return "created";
  if (status === "published" || status === "approved") return "published";
  return "updated";
}

async function scopeFor(
  nestId: string,
  userId: string,
  userEmail: string,
): Promise<NestScope | null> {
  await ensureNodeIndex(nestId);
  const rows = (await getDb().all(
    "SELECT node_id AS id FROM node_index WHERE nest_id = ?",
    [nestId],
  )) as Array<{ id: string }>;
  if (rows.length === 0) return null;
  const [accessible, publicOnly] = await Promise.all([
    filterAccessible(nestId, userId, userEmail, rows),
    isPublicReader(nestId, userId),
  ]);
  if (accessible.length === 0) return null;
  return {
    nestId,
    nodeIds: accessible.length === rows.length ? null : accessible.map((n) => n.id),
    publicOnly,
  };
}

/** The OR of every nest scope, as one SQL predicate over `v`. */
function scopeClause(scopes: NestScope[]): { sql: string; params: SqlParam[] } {
  const parts: string[] = [];
  const params: SqlParam[] = [];
  for (const s of scopes) {
    let p = "v.nest_id = ?";
    params.push(s.nestId);
    if (s.nodeIds) {
      p += ` AND v.node_id IN (${s.nodeIds.map(() => "?").join(",")})`;
      params.push(...s.nodeIds);
    }
    if (s.publicOnly) p += " AND v.status IN ('approved', 'published')";
    parts.push(`(${p})`);
  }
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "1 = 0", params };
}

const FROM = `FROM node_versions v
  JOIN node_index ni ON ni.nest_id = v.nest_id AND ni.node_id = v.node_id`;

export async function getDocStream(params: {
  userId: string;
  userEmail: string;
  /** Every nest the caller can read: id → display name. */
  nests: Map<string, string>;
  filters?: StreamFilters;
  limit?: number;
  offset?: number;
  /** Body of one version, for its summary (null when it can't be read). */
  readBody?: (nestId: string, nodeId: string, version: number) => Promise<string | null>;
}): Promise<StreamPage> {
  const db = getDb();
  const f = params.filters ?? {};
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50) || 50, 1), STREAM_MAX_LIMIT);
  const offset = Math.min(Math.max(Math.trunc(params.offset ?? 0) || 0, 0), STREAM_MAX_OFFSET);

  const scopes = (
    await Promise.all(
      [...params.nests.keys()].map((id) => scopeFor(id, params.userId, params.userEmail)),
    )
  ).filter((s): s is NestScope => s !== null);

  const empty: StreamPage = {
    items: [],
    total: 0,
    counts: { nest: [], tag: [], type: [], author: [] },
    limit,
    offset,
    has_more: false,
  };
  if (scopes.length === 0) return empty;

  // Base: what the caller may see, inside the since-window. Facet counts are
  // computed over exactly this; the page and total add the facet filters.
  const base = scopeClause(scopes);
  const baseWhere = [base.sql];
  const baseParams: SqlParam[] = [...base.params];
  if (f.since) {
    baseWhere.push("v.created_at >= ?");
    baseParams.push(f.since);
  }
  // Authors are never exposed for public-only nests: neither counted nor
  // filterable (a filter would turn the stream into an "did X write here"
  // oracle).
  const authorScopes = scopes.filter((s) => !s.publicOnly);
  const authorBase = scopeClause(authorScopes);

  const where = [...baseWhere];
  const whereParams = [...baseParams];
  if (f.nest?.length) {
    where.push(`v.nest_id IN (${f.nest.map(() => "?").join(",")})`);
    whereParams.push(...f.nest);
  }
  if (f.type?.length) {
    where.push(`ni.type IN (${f.type.map(() => "?").join(",")})`);
    whereParams.push(...f.type);
  }
  if (f.author?.length) {
    where[0] = authorBase.sql;
    whereParams.splice(0, base.params.length, ...authorBase.params);
    where.push(`v.author IN (${f.author.map(() => "?").join(",")})`);
    whereParams.push(...f.author.map((a) => a.trim().toLowerCase()));
  }
  const tags = (f.tag ?? []).map(normalizeTag).filter(Boolean);
  if (tags.length) {
    where.push(
      `EXISTS (SELECT 1 FROM node_tag_index t
                WHERE t.nest_id = v.nest_id AND t.node_id = v.node_id
                  AND t.tag_name IN (${tags.map(() => "?").join(",")}))`,
    );
    whereParams.push(...tags);
  }
  const whereSql = where.join(" AND ");

  const [totalRow, rows] = await Promise.all([
    db.get(`SELECT COUNT(*) AS c ${FROM} WHERE ${whereSql}`, whereParams) as Promise<{
      c: number | string;
    }>,
    db.all(
      `SELECT v.id, v.nest_id, v.node_id, v.version, v.status, v.author, v.created_at,
              ni.title, ni.type
         ${FROM}
        WHERE ${whereSql}
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT ? OFFSET ?`,
      [...whereParams, limit, offset],
    ) as Promise<
      Array<{
        id: number | string;
        nest_id: string;
        node_id: string;
        version: number | string;
        status: string;
        author: string;
        created_at: string;
        title: string;
        type: string;
      }>
    >,
  ]);
  const total = Number(totalRow?.c ?? 0);

  const counts = await facetCounts(
    baseWhere.join(" AND "),
    baseParams,
    authorScopes.length
      ? {
          sql: [authorBase.sql, ...baseWhere.slice(1)].join(" AND "),
          params: [...authorBase.params, ...baseParams.slice(base.params.length)],
        }
      : null,
    params.nests,
  );

  // Page decorations: tags and open-thread comment counts, one query each
  // over the page's documents.
  const pageDocs = [...new Map(rows.map((r) => [`${r.nest_id}\u0000${r.node_id}`, r])).values()];
  const tagMap = new Map<string, string[]>();
  const commentMap = new Map<string, number>();
  const approved = new Set<string>();
  if (pageDocs.length) {
    const pairSql = pageDocs.map(() => "(nest_id = ? AND node_id = ?)").join(" OR ");
    const pairParams = pageDocs.flatMap((r) => [r.nest_id, r.node_id]);
    const [tagRows, commentRows, approvedRows] = await Promise.all([
      db.all(
        `SELECT nest_id, node_id, tag_name FROM node_tag_index WHERE ${pairSql} ORDER BY tag_name`,
        pairParams,
      ) as Promise<Array<{ nest_id: string; node_id: string; tag_name: string }>>,
      db.all(
        `SELECT t.nest_id, t.node_id, COUNT(c.id) AS n
           FROM annotation_threads t
           JOIN annotation_comments c ON c.thread_id = t.id
          WHERE t.status = 'open' AND (${pageDocs
            .map(() => "(t.nest_id = ? AND t.node_id = ?)")
            .join(" OR ")})
          GROUP BY t.nest_id, t.node_id`,
        pairParams,
      ) as Promise<Array<{ nest_id: string; node_id: string; n: number | string }>>,
      db.all(
        `SELECT nest_id, node_id, version FROM review_requests
          WHERE status = 'approved' AND (${pairSql})`,
        pairParams,
      ) as Promise<Array<{ nest_id: string; node_id: string; version: number | string }>>,
    ]);
    for (const a of approvedRows) approved.add(`${a.nest_id}\u0000${a.node_id}@${Number(a.version)}`);
    for (const t of tagRows) {
      const k = `${t.nest_id}\u0000${t.node_id}`;
      tagMap.set(k, [...(tagMap.get(k) ?? []), t.tag_name]);
    }
    for (const c of commentRows) commentMap.set(`${c.nest_id}\u0000${c.node_id}`, Number(c.n));
  }

  const publicNests = new Set(scopes.filter((s) => s.publicOnly).map((s) => s.nestId));
  const items: StreamItem[] = await Promise.all(
    rows.map(async (r) => {
      const version = Number(r.version);
      const k = `${r.nest_id}\u0000${r.node_id}`;
      let summary = "";
      if (params.readBody) {
        try {
          summary = summarize((await params.readBody(r.nest_id, r.node_id, version)) ?? "");
        } catch {
          summary = "";
        }
      }
      return {
        id: `${r.nest_id}:${r.node_id}@${version}`,
        nestId: r.nest_id,
        nestName: params.nests.get(r.nest_id) ?? r.nest_id,
        nodeId: r.node_id,
        title: r.title || r.node_id,
        type: r.type || "document",
        tags: tagMap.get(k) ?? [],
        version,
        status: r.status,
        author: publicNests.has(r.nest_id) ? null : r.author,
        at: r.created_at,
        summary,
        commentCount: commentMap.get(k) ?? 0,
        kind: kindOf(version, r.status, approved.has(`${k}@${version}`)),
      };
    }),
  );

  return {
    items,
    total,
    counts,
    limit,
    offset,
    has_more: offset + items.length < total,
  };
}

async function facetCounts(
  whereSql: string,
  whereParams: SqlParam[],
  author: { sql: string; params: SqlParam[] } | null,
  nests: Map<string, string>,
): Promise<StreamCounts> {
  const db = getDb();
  const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  const [nestRows, typeRows, tagRows, authorRows] = await Promise.all([
    db.all(
      `SELECT v.nest_id AS value, COUNT(*) AS n ${FROM} WHERE ${whereSql} GROUP BY v.nest_id`,
      whereParams,
    ) as Promise<Array<{ value: string; n: number | string }>>,
    db.all(
      `SELECT ni.type AS value, COUNT(*) AS n ${FROM} WHERE ${whereSql} GROUP BY ni.type`,
      whereParams,
    ) as Promise<Array<{ value: string; n: number | string }>>,
    db.all(
      `SELECT t.tag_name AS value, COUNT(*) AS n ${FROM}
         JOIN node_tag_index t ON t.nest_id = v.nest_id AND t.node_id = v.node_id
        WHERE ${whereSql} GROUP BY t.tag_name`,
      whereParams,
    ) as Promise<Array<{ value: string; n: number | string }>>,
    author
      ? (db.all(
          `SELECT v.author AS value, COUNT(*) AS n ${FROM} WHERE ${author.sql} GROUP BY v.author`,
          author.params,
        ) as Promise<Array<{ value: string; n: number | string }>>)
      : Promise.resolve([] as Array<{ value: string; n: number | string }>),
  ]);
  const facet = (rows: Array<{ value: string; n: number | string }>) =>
    rows
      .map((r) => ({ value: r.value, count: Number(r.n) }))
      .sort((a, b) => byCount(a, b) || a.value.localeCompare(b.value))
      .slice(0, FACET_CAP);
  return {
    nest: nestRows
      .map((r) => ({ id: r.value, name: nests.get(r.value) ?? r.value, count: Number(r.n) }))
      .sort((a, b) => byCount(a, b) || a.name.localeCompare(b.name)),
    tag: facet(tagRows),
    type: facet(typeRows),
    author: facet(authorRows),
  };
}
