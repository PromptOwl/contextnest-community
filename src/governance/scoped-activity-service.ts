/**
 * Admin activity log for one document, one folder, or the whole nest
 * (CU-wdqcq03aw2).
 *
 * "…see activities … only admins … a log filtered to that specific document,
 * so they can see who / which user changed, used, pulled etc."
 *
 * One merged, newest-first stream over what the server already records —
 *   node_versions      created / edited / restored (with the agent, §9.4)
 *   review_requests    review_requested / approved / rejected / review_cancelled
 *   comments           commented / comment_resolved
 *   node_deletions     deleted
 * plus document access, which seals no version and is recorded separately in
 * node_access_events (access-log.ts):
 *   read / retrieved / exported  (a whole-nest export has no node and shows
 *                                 in every document's and folder's log)
 *
 * Read-only. Authorization (owner / nest admin / server admin) is the route's
 * job; nothing here narrows by caller.
 */
import { getDb } from "../db/client.js";
import { buildTitleMap } from "./title-resolver.js";
import { SYSTEM_AUTHOR_PREFIX } from "./version-service.js";
import { deserializeClient, type ClientMetadata } from "../shared/client-metadata.js";

export const ACTIVITY_TYPES = [
  "created",
  "edited",
  "restored",
  "review_requested",
  "approved",
  "rejected",
  "review_cancelled",
  "commented",
  "comment_resolved",
  "deleted",
  "read",
  "retrieved",
  "exported",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface ActivityLogItem {
  /** Stable row key within one response. */
  id: string;
  type: ActivityType;
  /** null for a whole-nest event (a full export). */
  nodeId: string | null;
  title?: string;
  /** The account it happened under (email where known). */
  actor: string;
  /** The agent named in the caller's attribution, if any. */
  agent?: string;
  client?: ClientMetadata;
  at: string;
  version?: number;
  detail?: string;
  /** How an access came in: the REST API / web app, or MCP (ctx, agents). */
  surface?: "api" | "mcp";
}

export interface ActivityLogPage {
  items: ActivityLogItem[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface ActivityScope {
  nodeId?: string;
  /** Folder path as the UI shows it ("sales/deals"), without the nodes/ root. */
  folder?: string;
}

/** Deepest page the merge will assemble — past this, narrow the filter. */
const MAX_WINDOW = 5000;
const SOURCE_TYPES: Record<string, ActivityType[]> = {
  versions: ["created", "edited", "restored"],
  reviews: ["review_requested", "approved", "rejected", "review_cancelled"],
  comments: ["commented", "comment_resolved"],
  deletions: ["deleted"],
  access: ["read", "retrieved", "exported"],
};

const escLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" (UTC, no zone). */
function toIso(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

const agentOf = (client?: ClientMetadata): string | undefined =>
  typeof client?.agent === "string" && client.agent ? client.agent : undefined;

/** WHERE fragment + args selecting rows in scope, for a table's node column. */
function scopeSql(scope: ActivityScope, col = "node_id", nestWide = false): { sql: string; args: string[] } {
  if (scope.nodeId) {
    return {
      sql: nestWide ? ` AND (${col} = ? OR ${col} IS NULL)` : ` AND ${col} = ?`,
      args: [scope.nodeId],
    };
  }
  if (scope.folder) {
    // Ids are stored with the nodes/ root; an imported vault's ids carry a
    // "<prefix>/nodes/" in front, and a few legacy ids have no root at all.
    const f = escLike(scope.folder);
    const inFolder = `(${col} LIKE ? ESCAPE '\\' OR ${col} LIKE ? ESCAPE '\\' OR ${col} LIKE ? ESCAPE '\\')`;
    return {
      sql: nestWide ? ` AND (${inFolder} OR ${col} IS NULL)` : ` AND ${inFolder}`,
      args: [`nodes/${f}/%`, `%/nodes/${f}/%`, `${f}/%`],
    };
  }
  return { sql: "", args: [] };
}

/** Actor filter over one or two columns (case-insensitive exact email). */
function actorSql(actor: string | undefined, cols: string[]): { sql: string; args: string[] } {
  if (!actor) return { sql: "", args: [] };
  return {
    sql: ` AND (${cols.map((c) => `LOWER(${c}) = ?`).join(" OR ")})`,
    args: cols.map(() => actor.toLowerCase()),
  };
}

export function normalizeFolder(raw: string): string {
  let f = raw.trim().replace(/^\/+|\/+$/g, "");
  if (f === "nodes") return "";
  if (f.startsWith("nodes/")) f = f.slice(6);
  return f;
}

export async function getScopedActivity(params: {
  nestId: string;
  scope: ActivityScope;
  types?: ActivityType[];
  actor?: string;
  limit: number;
  offset: number;
}): Promise<ActivityLogPage> {
  const { nestId, scope } = params;
  const limit = Math.min(Math.max(Math.floor(params.limit) || 50, 1), 200);
  const offset = Math.min(Math.max(Math.floor(params.offset) || 0, 0), MAX_WINDOW);
  const window = Math.min(offset + limit + 1, MAX_WINDOW + limit + 1);
  const wanted = new Set<ActivityType>(params.types?.length ? params.types : ACTIVITY_TYPES);
  const want = (source: string) => SOURCE_TYPES[source].some((t) => wanted.has(t));
  const actor = params.actor?.trim() || undefined;
  const db = getDb();
  const items: ActivityLogItem[] = [];
  const push = (it: ActivityLogItem) => {
    if (!wanted.has(it.type)) return;
    if (actor && it.actor.toLowerCase() !== actor.toLowerCase()) return;
    items.push(it);
  };

  if (want("versions")) {
    const s = scopeSql(scope, "nv.node_id");
    const a = actorSql(actor, ["nv.author"]);
    const rows = (await db.all(
      `SELECT nv.node_id, nv.version, nv.author, nv.status, nv.change_note, nv.created_at, nv.client_json,
              (SELECT MIN(f.version) FROM node_versions f
                WHERE f.nest_id = nv.nest_id AND f.node_id = nv.node_id) AS first_version
         FROM node_versions nv
        WHERE nv.nest_id = ? AND nv.author NOT LIKE ?${s.sql}${a.sql}
        ORDER BY nv.created_at DESC, nv.id DESC
        LIMIT ?`,
      [nestId, `${SYSTEM_AUTHOR_PREFIX}%`, ...s.args, ...a.args, window],
    )) as Array<{
      node_id: string;
      version: number;
      author: string;
      status: string;
      change_note: string | null;
      created_at: string;
      client_json: string | null;
      first_version: number | null;
    }>;
    for (const r of rows) {
      const client = deserializeClient(r.client_json);
      const restored = !!r.change_note && /^(Restored from version|Undo of v)/.test(r.change_note);
      const created = r.first_version != null && Number(r.version) <= Number(r.first_version);
      push({
        id: `v:${r.node_id}@${r.version}`,
        type: restored ? "restored" : created ? "created" : "edited",
        nodeId: r.node_id,
        actor: r.author,
        agent: agentOf(client),
        ...(client ? { client } : {}),
        at: toIso(r.created_at),
        version: Number(r.version),
        detail: r.change_note || r.status,
      });
    }
  }

  if (want("reviews")) {
    const s = scopeSql(scope);
    const a = actorSql(actor, ["requested_by", "resolved_by"]);
    const rows = (await db.all(
      `SELECT id, node_id, version, requested_by, requested_at, status, resolved_by, resolved_at, resolution_note
         FROM review_requests
        WHERE nest_id = ?${s.sql}${a.sql}
        ORDER BY COALESCE(resolved_at, requested_at) DESC
        LIMIT ?`,
      [nestId, ...s.args, ...a.args, window],
    )) as any[];
    for (const r of rows) {
      push({
        id: `rq:${r.id}`,
        type: "review_requested",
        nodeId: r.node_id,
        actor: r.requested_by,
        at: toIso(r.requested_at),
        version: Number(r.version),
      });
      if (r.resolved_by && r.resolved_at && r.status !== "pending") {
        push({
          id: `rr:${r.id}`,
          type: r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "review_cancelled",
          nodeId: r.node_id,
          actor: r.resolved_by,
          at: toIso(r.resolved_at),
          version: Number(r.version),
          ...(r.resolution_note ? { detail: r.resolution_note } : {}),
        });
      }
    }
  }

  if (want("comments")) {
    const s = scopeSql(scope);
    const a = actorSql(actor, ["author", "resolved_by"]);
    const rows = (await db.all(
      `SELECT id, node_id, author, body, status, created_at, resolved_by, resolved_at
         FROM comments
        WHERE nest_id = ?${s.sql}${a.sql}
        ORDER BY COALESCE(resolved_at, created_at) DESC
        LIMIT ?`,
      [nestId, ...s.args, ...a.args, window],
    )) as any[];
    const excerpt = (b: string) => (b.length > 120 ? `${b.slice(0, 117)}…` : b);
    for (const r of rows) {
      push({
        id: `c:${r.id}`,
        type: "commented",
        nodeId: r.node_id,
        actor: r.author,
        at: toIso(r.created_at),
        detail: excerpt(String(r.body || "")),
      });
      if (r.status === "resolved" && r.resolved_by && r.resolved_at) {
        push({
          id: `cr:${r.id}`,
          type: "comment_resolved",
          nodeId: r.node_id,
          actor: r.resolved_by,
          at: toIso(r.resolved_at),
        });
      }
    }
  }

  if (want("deletions")) {
    const s = scopeSql(scope);
    const a = actorSql(actor, ["deleted_by"]);
    const rows = (await db.all(
      `SELECT node_id, deleted_by, deleted_at, client_json
         FROM node_deletions
        WHERE nest_id = ?${s.sql}${a.sql}
        ORDER BY deleted_at DESC
        LIMIT ?`,
      [nestId, ...s.args, ...a.args, window],
    )) as any[];
    for (const r of rows) {
      const client = deserializeClient(r.client_json);
      push({
        id: `d:${r.node_id}@${r.deleted_at}`,
        type: "deleted",
        nodeId: r.node_id,
        actor: r.deleted_by || "unknown",
        agent: agentOf(client),
        ...(client ? { client } : {}),
        at: toIso(r.deleted_at),
      });
    }
  }

  if (want("access")) {
    const s = scopeSql(scope, "e.node_id", true);
    // A whole-nest export (node_id NULL) is only this document's history if
    // the document existed then — not for one created afterwards.
    const since = scope.nodeId
      ? ((await db.get(
          `SELECT MIN(created_at) AS t FROM node_versions WHERE nest_id = ? AND node_id = ?`,
          [nestId, scope.nodeId],
        )) as { t: string | null } | undefined)?.t
      : null;
    const sinceIso = since ? toIso(since) : null;
    const a = actorSql(actor, ["COALESCE(e.user_email, u.email)"]);
    const actions = (["read", "retrieved", "exported"] as const)
      .filter((t) => wanted.has(t))
      .map((t) => (t === "retrieved" ? "retrieve" : t === "exported" ? "export" : "read"));
    try {
      const rows = (await db.all(
        `SELECT e.id, e.ts, e.node_id, e.action, e.surface, e.client_json, e.detail,
                COALESCE(e.user_email, u.email, e.user_id) AS actor
           FROM node_access_events e LEFT JOIN users u ON u.id = e.user_id
          WHERE e.nest_id = ? AND e.action IN (${actions.map(() => "?").join(", ")})${s.sql}${a.sql}
          ORDER BY e.id DESC
          LIMIT ?`,
        [nestId, ...actions, ...s.args, ...a.args, window],
      )) as any[];
      for (const r of rows) {
        if (sinceIso && r.node_id == null && toIso(r.ts) < sinceIso.slice(0, 19)) continue;
        const client = deserializeClient(r.client_json);
        push({
          id: `a:${r.id}`,
          type: r.action === "retrieve" ? "retrieved" : r.action === "export" ? "exported" : "read",
          nodeId: r.node_id ?? null,
          actor: r.actor || "unknown",
          agent: agentOf(client),
          ...(client ? { client } : {}),
          at: toIso(r.ts),
          surface: r.surface,
          ...(r.detail ? { detail: r.detail } : {}),
        });
      }
    } catch {
      /* a database without migration 047 has no access rows to show */
    }
  }

  const ms = (at: string) => {
    const t = Date.parse(at);
    return Number.isNaN(t) ? 0 : t;
  };
  items.sort((x, y) => ms(y.at) - ms(x.at));
  const page = items.slice(offset, offset + limit);

  const titles = page.some((i) => i.nodeId) ? await buildTitleMap(nestId) : new Map<string, string>();
  for (const it of page) {
    if (it.nodeId) {
      const t = titles.get(it.nodeId);
      if (t) it.title = t;
    }
  }
  return { items: page, limit, offset, hasMore: items.length > offset + limit };
}
