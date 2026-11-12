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
 *     and nothing of the document's CURRENT state, which may be an
 *     unreviewed draft: title, type and tags come from the version itself,
 *     no author, no comment activity. The tag, type and author facets and
 *     filters run over member nests only (node_index / node_tag_index hold
 *     current values), so neither a draft's metadata nor an email can be
 *     probed for through them.
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
import { filterAccessible, readsWholeNest } from "./access-guard.js";
import { jsonTextValues } from "../db/sql.js";
import { isPublicReader } from "../shared/access.js";
import { ensureNodeIndex } from "../nodes/node-index.js";
import { normalizeTag } from "./tag-index-service.js";
import { canUserApproveMany } from "./stewardship-service.js";
import { deserializeClient } from "../shared/client-metadata.js";
import type { ClientMetadata } from "../shared/client-metadata.js";

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
  /** The author's display name (the account's name, or a system account's
   *  name); null when there is none, and for public readers (po-1214). */
  authorName: string | null;
  /** The write's caller attribution (spec §9.4) — `client.agent` is the agent
   *  the person wrote through. null when the write named none, and for public
   *  readers. */
  client: ClientMetadata | null;
  /** The version's change note; null when none, and for public readers. */
  changeNote: string | null;
  /** On a version in review: whether the caller may approve or request
   *  changes on it (the same verdict as GET …/can-approve). null otherwise,
   *  and for public readers. */
  review: { canReview: boolean } | null;
  at: string;
  /** First ~200 characters of this version's body, flattened. */
  summary: string;
  /** Comments on the document's open annotation threads; null where the
   *  caller reads the nest only publicly. */
  commentCount: number | null;
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
  /** First page (offset 0) only; null on later pages — the facets don't
   *  depend on the page, so "load more" keeps the ones it has. */
  counts: StreamCounts | null;
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
  /** "agent": versions whose write named an agent (`client.agent`);
   *  "human": versions that named none (po-1214). */
  source?: "agent" | "human";
}

const SUMMARY_CHARS = 200;
const SUMMARY_CONCURRENCY = 8;

/** `Promise.all(items.map(fn))` with at most `limit` in flight; order kept. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
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

/** Flatten a body to a one-line preview. A leading heading that only
 *  repeats the title is dropped: the post already shows the title (po-1214). */
export function summarize(body: string, title?: string): string {
  let text = body.replace(/<[^>]+>/g, " ");
  const t = title?.trim().toLowerCase();
  if (t) {
    text = text.replace(/^\s*#{1,6}\s+(.*)\n?/, (line, heading: string) =>
      heading.trim().toLowerCase() === t ? "" : line,
    );
  }
  const flat = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS)}…` : flat;
}

/**
 * SQL for "this version's write named an agent". `client_json` is
 * JSON.stringify output (serializeClient) of a FLAT block: the engine's
 * clientMetadataSchema allows only scalar values, so there is no nested
 * object to carry an inner `"agent":` key, and no null to store. A top-level
 * `agent` key is therefore the literal `"agent":`; a key or value that merely
 * contains the word is prefixed or escaped and does not match (tested). Text
 * matching keeps it one predicate on both drivers (no json_extract / ->>).
 */
const AGENT_SQL = `(v.client_json LIKE '%"agent":%' AND v.client_json NOT LIKE '%"agent":""%')`;

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
  // The common case — a member who reads the whole nest — needs no document
  // list at all: the version rows' join to node_index already limits the
  // stream to documents that exist.
  if (await readsWholeNest(nestId, userId, userEmail)) {
    return { nestId, nodeIds: null, publicOnly: false };
  }
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

/**
 * The OR of every nest scope, as one SQL predicate over `v`. A narrowed
 * nest's document ids ride in ONE bound JSON array, never one `?` apiece: a
 * folder grant can cover tens of thousands of documents, past either driver's
 * bound-variable cap.
 */
function scopeClause(scopes: NestScope[]): { sql: string; params: SqlParam[] } {
  const db = getDb();
  const parts: string[] = [];
  const params: SqlParam[] = [];
  for (const s of scopes) {
    let p = "v.nest_id = ?";
    params.push(s.nestId);
    if (s.nodeIds) {
      p += ` AND v.node_id IN (${jsonTextValues(db)})`;
      params.push(JSON.stringify(s.nodeIds));
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
  /** false: skip the facet counts even on the first page — the new-posts
   *  poll (po-1214) only needs `total`. Default true. */
  facets?: boolean;
  /** One version's body and frontmatter (null when it can't be read). The
   *  body feeds the summary; a public reader's title/type/tags come from the
   *  frontmatter. */
  readVersion?: (
    nestId: string,
    nodeId: string,
    version: number,
  ) => Promise<{ body: string; frontmatter?: Record<string, unknown> } | null>;
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

  // Public-only nests expose neither authors nor the document's current
  // metadata (node_index title/type, node_tag_index tags may be an
  // unreviewed draft's). So the tag, type and author facets — and any query
  // filtered on one of them — run over the member scopes only; a filter
  // there would otherwise be an oracle for a draft's tag or an email.
  const memberScopes = scopes.filter((s) => !s.publicOnly);
  const authors = (f.author ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  const tags = (f.tag ?? []).map(normalizeTag).filter(Boolean);
  const types = (f.type ?? []).map((t) => t.trim()).filter(Boolean);

  // What the caller may see over `scopeList`, inside the since-window.
  const visible = (scopeList: NestScope[]) => {
    const scope = scopeClause(scopeList);
    const where = [scope.sql];
    const params: SqlParam[] = [...scope.params];
    if (f.since) {
      where.push("v.created_at >= ?");
      params.push(f.since);
    }
    return { where, params };
  };
  // Facet counts run over exactly this; the page and total add the filters.
  const base = visible(scopes);

  // `source` reads the write's attribution, which a public reader never sees
  // (no author, no client) — so, like the author facet, it runs over member
  // scopes only and is never an oracle for an agent's name.
  const memberFacetFiltered = authors.length > 0 || tags.length > 0 || types.length > 0 || !!f.source;
  const { where, params: whereParams } = visible(memberFacetFiltered ? memberScopes : scopes);
  if (f.nest?.length) {
    where.push(`v.nest_id IN (${f.nest.map(() => "?").join(",")})`);
    whereParams.push(...f.nest);
  }
  if (types.length) {
    where.push(`ni.type IN (${types.map(() => "?").join(",")})`);
    whereParams.push(...types);
  }
  if (authors.length) {
    // Emails are stored lowercased; LOWER() keeps a legacy mixed-case row
    // matching the (lowercased) chip it is counted under.
    where.push(`LOWER(v.author) IN (${authors.map(() => "?").join(",")})`);
    whereParams.push(...authors);
  }
  if (f.source === "agent") where.push(AGENT_SQL);
  else if (f.source === "human") where.push(`(v.client_json IS NULL OR NOT ${AGENT_SQL})`);
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
              v.tags_json, v.client_json, v.change_note, ni.title, ni.type,
              u.name AS author_name, sa.name AS system_name
         ${FROM}
         -- The same join getVersionAttribution uses: users.email is UNIQUE and
         -- stored lowercased, as is node_versions.author; system_accounts is
         -- keyed by user_id. At most one row each, so paging is unchanged.
         LEFT JOIN users u ON u.email = v.author
         LEFT JOIN system_accounts sa ON sa.user_id = u.id
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
        tags_json: string | null;
        client_json: string | null;
        change_note: string | null;
        title: string;
        type: string;
        author_name: string | null;
        system_name: string | null;
      }>
    >,
  ]);
  const total = Number(totalRow?.c ?? 0);

  const memberBase = memberScopes.length ? visible(memberScopes) : null;
  const counts =
    offset === 0 && params.facets !== false
      ? await facetCounts(
          { sql: base.where.join(" AND "), params: base.params },
          memberBase ? { sql: memberBase.where.join(" AND "), params: memberBase.params } : null,
          params.nests,
        )
      : null;

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

  // Review in place (po-1214): for the page's in-review versions, may the
  // caller approve? One batched verdict per nest — the same decideApproval
  // GET …/can-approve answers with, separation of duties included.
  const reviewable = new Map<string, boolean>();
  const pendingByNest = new Map<string, string[]>();
  for (const r of rows) {
    if (r.status !== "pending_review" || publicNests.has(r.nest_id)) continue;
    pendingByNest.set(r.nest_id, [...(pendingByNest.get(r.nest_id) ?? []), r.node_id]);
  }
  await Promise.all(
    [...pendingByNest].map(async ([nestId, nodeIds]) => {
      const verdicts = await canUserApproveMany(nestId, nodeIds, params.userEmail);
      for (const id of nodeIds) reviewable.set(`${nestId}\u0000${id}`, verdicts.get(id)?.allowed === true);
    }),
  );
  // One version read (a chain replay) per item, a few at a time rather than
  // the whole page at once.
  const versionsRead = await mapLimit(rows, SUMMARY_CONCURRENCY, async (r) => {
    if (!params.readVersion) return null;
    try {
      return await params.readVersion(r.nest_id, r.node_id, Number(r.version));
    } catch {
      return null;
    }
  });
  const items: StreamItem[] = rows.map((r, idx) => {
    const version = Number(r.version);
    const k = `${r.nest_id}\u0000${r.node_id}`;
    const read = versionsRead[idx];
    const isPublic = publicNests.has(r.nest_id);
    // A public reader sees this version's own metadata, never the current
    // (possibly draft) state the index mirrors.
    const fm = read?.frontmatter ?? {};
    const title = isPublic
      ? typeof fm.title === "string" && fm.title ? fm.title : r.node_id
      : r.title || r.node_id;
    const type = isPublic
      ? typeof fm.type === "string" && fm.type ? fm.type : "document"
      : r.type || "document";
    const tags = isPublic ? versionTags(fm.tags, r.tags_json) : tagMap.get(k) ?? [];
    return {
      id: `${r.nest_id}:${r.node_id}@${version}`,
      nestId: r.nest_id,
      nestName: params.nests.get(r.nest_id) ?? r.nest_id,
      nodeId: r.node_id,
      title,
      type,
      tags,
      version,
      status: r.status,
      author: isPublic ? null : r.author,
      authorName: isPublic ? null : r.system_name || r.author_name || null,
      client: isPublic ? null : deserializeClient(r.client_json) ?? null,
      changeNote: isPublic ? null : personNote(r.change_note),
      review:
        isPublic || r.status !== "pending_review"
          ? null
          : { canReview: reviewable.get(k) === true },
      at: r.created_at,
      summary: summarize(read?.body ?? "", title),
      commentCount: isPublic ? null : commentMap.get(k) ?? 0,
      kind: kindOf(version, r.status, approved.has(`${k}@${version}`)),
    };
  });

  return {
    items,
    total,
    counts,
    limit,
    offset,
    has_more: offset + items.length < total,
  };
}

/** A change note a person (or their agent) wrote. The server's own
 *  "Auto-published on create/edit (<reason>)" stamp (nodes/service.ts) says
 *  nothing about the change, so a post shows no note for it. */
function personNote(raw: string | null): string | null {
  const note = raw?.trim();
  if (!note || /^Auto-published on (create|edit) \(/.test(note)) return null;
  return note;
}

/** A public item's tags: the version's own frontmatter, else the tags the
 *  version row recorded at write time. Normalized like node_tag_index. */
function versionTags(fmTags: unknown, tagsJson: string | null): string[] {
  let raw: unknown = fmTags;
  if (!Array.isArray(raw) && tagsJson) {
    try {
      raw = JSON.parse(tagsJson);
    } catch {
      raw = [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((t): t is string => typeof t === "string").map(normalizeTag).filter(Boolean))].sort();
}

type Rows = Array<{ value: string; n: number | string }>;

/**
 * `all` = every readable scope (the nest facet); `member` = member scopes
 * only (the tag, type and author facets — see getDocStream).
 */
async function facetCounts(
  all: { sql: string; params: SqlParam[] },
  member: { sql: string; params: SqlParam[] } | null,
  nests: Map<string, string>,
): Promise<StreamCounts> {
  const db = getDb();
  const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  const none = Promise.resolve([] as Rows);
  const [nestRows, typeRows, tagRows, authorRows] = await Promise.all([
    db.all(
      `SELECT v.nest_id AS value, COUNT(*) AS n ${FROM} WHERE ${all.sql} GROUP BY v.nest_id`,
      all.params,
    ) as Promise<Rows>,
    member
      ? (db.all(
          `SELECT ni.type AS value, COUNT(*) AS n ${FROM} WHERE ${member.sql} GROUP BY ni.type`,
          member.params,
        ) as Promise<Rows>)
      : none,
    member
      ? (db.all(
          `SELECT t.tag_name AS value, COUNT(*) AS n ${FROM}
             JOIN node_tag_index t ON t.nest_id = v.nest_id AND t.node_id = v.node_id
            WHERE ${member.sql} GROUP BY t.tag_name`,
          member.params,
        ) as Promise<Rows>)
      : none,
    member
      ? (db.all(
          `SELECT LOWER(v.author) AS value, COUNT(*) AS n ${FROM} WHERE ${member.sql} GROUP BY LOWER(v.author)`,
          member.params,
        ) as Promise<Rows>)
      : none,
  ]);
  const facet = (rows: Rows) =>
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
