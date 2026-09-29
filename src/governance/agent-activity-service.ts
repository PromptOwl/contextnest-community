/**
 * Agent activity — what agents did to a nest, and a governed undo for it
 * (CU-wdqcq0314v).
 *
 * "I should be able to have a place to see a stream of all the things my agent
 * did, and undo them if they are jacked."
 *
 * An agent's change is any write whose recorded `client` names an agent
 * (§9.4 attribution: the MCP handshake's clientInfo.name, the API key's label,
 * or a caller-sent `client.agent`). Two tables already hold every such change:
 * `node_versions` (create / update / restore, one row per version) and
 * `node_deletions` (the tombstone a delete leaves). This service only reads
 * them — it adds no log of its own, so the stream can't drift from history.
 *
 * Undo never rewrites history. It takes the same path a person would:
 *   - published change → restore the previous sealed version as a NEW version
 *     (restoreVersion, the code behind POST …/revert)
 *   - draft            → discard it (discardDraft; a never-published doc goes)
 *   - the create itself → delete the document (deleteNode)
 * and it refuses when the document changed since, when the change is under
 * review (that decision belongs to the review queue), and for deletions —
 * deleting purges a document's history, so there is nothing to put back.
 *
 * Owners, admins and reviewers only: undo is a steward's call, the same people
 * who approve changes. The list shows only documents the caller could undo.
 */

import { getDb } from "../db/client.js";
import { buildTitleMap } from "./title-resolver.js";
import {
  resolveNestWideRoles,
  resolveUserRoles,
  stewardCoverageForUser,
} from "./stewardship-service.js";
import { SYSTEM_AUTHOR_PREFIX } from "./version-service.js";
import {
  deserializeClient,
  type ClientMetadata,
} from "../shared/client-metadata.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import type { EffectiveRole } from "./roles.js";
import {
  deleteNodeIfUnchanged,
  discardDraft,
  restoreVersion,
} from "../nodes/service.js";
import { getVersion } from "./version-service.js";

export type AgentActivityKind = "create" | "update" | "restore" | "delete";
export type UndoEffect = "restore" | "discard" | "delete";

export interface UndoVerdict {
  available: boolean;
  /** What clicking Undo does, when available. */
  effect?: UndoEffect;
  /** The version a restore puts back. */
  restoreTo?: number;
  /** Why it isn't available — shown next to the disabled button. */
  reason?: string;
}

export interface AgentActivityItem {
  /** Stable row key: `<nodeId>@v<version>` or `<nodeId>@deleted`. */
  id: string;
  kind: AgentActivityKind;
  nodeId: string;
  /** Current title; undefined for a deleted document. */
  title?: string;
  version?: number;
  /** Governance status of that version (draft, pending_review, published…). */
  status?: string;
  /** The account the change was made under. */
  actor: string;
  /** The agent named in the change's `client`, if any. */
  agent?: string;
  client?: ClientMetadata;
  changeNote?: string;
  at: string;
  undo: UndoVerdict;
}

export interface AgentActivityPage {
  items: AgentActivityItem[];
  limit: number;
  offset: number;
  /** True when older items exist past this page. */
  hasMore: boolean;
}

const STEWARD_ROLES: readonly EffectiveRole[] = ["owner", "admin", "reviewer"];
const SEALED = ["published", "approved"];
const SYSTEM_LIKE = `${SYSTEM_AUTHOR_PREFIX}%`;

const isSteward = (roles: EffectiveRole[]) => roles.some((r) => STEWARD_ROLES.includes(r));

/** Owners, admins and reviewers may undo; editors and viewers may not. */
export async function canUndo(nestId: string, nodeId: string, userEmail: string): Promise<boolean> {
  return isSteward(await resolveUserRoles(nestId, userEmail, { nodeId }));
}

/** LIKE pattern matching a stored client_json that names `agent` (or any
 *  agent). client_json is written by JSON.stringify, so `"agent":"x"` has no
 *  spaces; the value is JSON-encoded here the same way, then LIKE-escaped. */
function agentPattern(agent?: string): string {
  const esc = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return agent ? `%${esc(`"agent":${JSON.stringify(agent)}`)}%` : `%${esc(`"agent":`)}%`;
}

/** SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" (UTC, no zone); ISO
 *  elsewhere. One shape, so versions and deletions sort together. */
function toIso(raw: string): string {
  const s = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

const agentOf = (client?: ClientMetadata): string | undefined =>
  typeof client?.agent === "string" && client.agent ? client.agent : undefined;

function kindOf(version: number, firstVersion: number | undefined, changeNote: string | null): AgentActivityKind {
  if (changeNote && /^(Restored from version|Undo of v)/.test(changeNote)) return "restore";
  return firstVersion !== undefined && version <= firstVersion ? "create" : "update";
}

interface Head {
  version: number;
  author: string;
  at: string;
  status: string;
  first: number;
}

/** Newest (non-system) row and first version per node, in one query. */
async function headsOf(nestId: string, nodeIds: string[]): Promise<Map<string, Head>> {
  const heads = new Map<string, Head>();
  if (!nodeIds.length) return heads;
  const ph = nodeIds.map(() => "?").join(", ");
  const rows = (await getDb().all(
    `SELECT nv.node_id, nv.version, nv.author, nv.created_at, nv.status, m.minv
       FROM node_versions nv
       JOIN (SELECT node_id, MAX(version) AS maxv, MIN(version) AS minv
               FROM node_versions
              WHERE nest_id = ? AND node_id IN (${ph}) AND author NOT LIKE ?
              GROUP BY node_id) m
         ON m.node_id = nv.node_id AND m.maxv = nv.version
      WHERE nv.nest_id = ?`,
    [nestId, ...nodeIds, SYSTEM_LIKE, nestId],
  )) as Array<{ node_id: string; version: number; author: string; created_at: string; status: string; minv: number }>;
  for (const r of rows) {
    heads.set(r.node_id, {
      version: Number(r.version),
      author: r.author,
      at: toIso(r.created_at),
      status: r.status,
      first: Number(r.minv),
    });
  }
  return heads;
}

/** For each (node, version), the newest SEALED version below it — what a
 *  restore puts back. One grouped query over the given pairs. */
async function previousSealed(
  nestId: string,
  pairs: Array<{ nodeId: string; version: number }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!pairs.length) return out;
  const cond = pairs.map(() => "(node_id = ? AND version < ?)").join(" OR ");
  const rows = (await getDb().all(
    `SELECT node_id, MAX(version) AS v FROM node_versions
      WHERE nest_id = ? AND status IN (${SEALED.map(() => "?").join(", ")}) AND (${cond})
      GROUP BY node_id`,
    [nestId, ...SEALED, ...pairs.flatMap((p) => [p.nodeId, p.version])],
  )) as Array<{ node_id: string; v: number | null }>;
  for (const r of rows) if (r.v != null) out.set(r.node_id, Number(r.v));
  return out;
}

function verdict(version: number, status: string, head: Head | undefined, prev: number | undefined): UndoVerdict {
  if (!head) {
    return { available: false, reason: "This document no longer exists." };
  }
  if (head.version !== version) {
    return {
      available: false,
      reason: `Changed since — v${head.version} by ${head.author} (${head.at}). Undo the newer change first.`,
    };
  }
  if (status === "pending_review") {
    return {
      available: false,
      reason: "This change is awaiting review — reject it from the review queue instead.",
    };
  }
  if (status === "draft" || status === "rejected") return { available: true, effect: "discard" };
  if (prev === undefined) return { available: true, effect: "delete" };
  return { available: true, effect: "restore", restoreTo: prev };
}

const DELETE_VERDICT: UndoVerdict = {
  available: false,
  reason: "Deletions can't be undone here — deleting a document purges its history.",
};

/** Checks run this many at a time — enough to overlap the queries without
 *  flooding the pool on a long page. */
const CHECK_BATCH = 25;

/**
 * Who may undo what, resolved once per request and memoized per document.
 * A nest-wide owner/admin/reviewer covers everything (deletions included);
 * otherwise only documents their steward rows cover, each checked for an
 * approve-capable role.
 */
async function undoAccess(nestId: string, userEmail: string) {
  if (isSteward(await resolveNestWideRoles(nestId, userEmail))) {
    return { all: true, allowed: async (_ids: string[]) => new Set(_ids) };
  }
  const coverage = await stewardCoverageForUser(nestId, userEmail);
  const memo = new Map<string, boolean>();
  return {
    all: false,
    allowed: async (ids: string[]) => {
      const todo = ids.filter(
        (id) => !memo.has(id) && (coverage.nestWide || coverage.nodeIds.has(id)),
      );
      for (let i = 0; i < todo.length; i += CHECK_BATCH) {
        const batch = todo.slice(i, i + CHECK_BATCH);
        const verdicts = await Promise.all(batch.map((id) => canUndo(nestId, id, userEmail)));
        batch.forEach((id, j) => memo.set(id, verdicts[j]));
      }
      return new Set(ids.filter((id) => memo.get(id) === true));
    },
  };
}

/** Largest window the stream will scan to fill one page. A document-scoped
 *  steward on a busy nest may see few rows; past this they page on. */
const MAX_SCAN = 20_000;

export async function getAgentActivity(params: {
  nestId: string;
  userEmail: string;
  /** "agents" (default): only changes that name an agent. "all": every change. */
  scope?: "agents" | "all";
  /** Only this agent's changes. */
  agent?: string;
  limit: number;
  offset: number;
}): Promise<AgentActivityPage> {
  const { nestId, userEmail, limit, offset } = params;
  const onlyAgents = params.scope !== "all" || !!params.agent;
  const db = getDb();

  // SQL narrows to rows that mention an agent; the exact check (a top-level
  // `agent`, equal to the one asked for) runs on the parsed client below.
  const agentFilter = onlyAgents ? ` AND client_json LIKE ? ESCAPE '\\'` : "";
  const agentArgs = onlyAgents ? [agentPattern(params.agent)] : [];
  const keep = (clientJson: string | null) => {
    if (!onlyAgents) return true;
    const a = agentOf(deserializeClient(clientJson));
    return !!a && (!params.agent || a === params.agent);
  };

  type VersionRow = {
    node_id: string;
    version: number;
    author: string;
    status: string;
    change_note: string | null;
    client_json: string | null;
    created_at: string;
  };
  type DeletionRow = { node_id: string; deleted_by: string | null; deleted_at: string; client_json: string | null };
  type Raw =
    | { src: "version"; at: string; row: VersionRow }
    | { src: "deletion"; at: string; row: DeletionRow };

  const access = await undoAccess(nestId, userEmail);
  const need = offset + limit + 1;
  // Access filtering drops rows AFTER the SQL window, so a document-scoped
  // steward could get a short page (and a wrong hasMore) from one fixed
  // window. Widen the window until the page fills or both sources run dry.
  let window = need;
  let visible: Raw[] = [];
  for (;;) {
    const versionRows = (await db.all(
      `SELECT node_id, version, author, status, change_note, client_json, created_at
         FROM node_versions
        WHERE nest_id = ? AND author NOT LIKE ?${agentFilter}
        ORDER BY created_at DESC, version DESC
        LIMIT ?`,
      [nestId, SYSTEM_LIKE, ...agentArgs, window],
    )) as VersionRow[];
    const deletionRows = (await db.all(
      `SELECT node_id, deleted_by, deleted_at, client_json
         FROM node_deletions
        WHERE nest_id = ?${agentFilter}
        ORDER BY deleted_at DESC
        LIMIT ?`,
      [nestId, ...agentArgs, window],
    )) as DeletionRow[];

    const merged: Raw[] = [
      ...versionRows
        .filter((row) => keep(row.client_json))
        .map((row) => ({ src: "version" as const, at: toIso(row.created_at), row })),
      ...(access.all ? deletionRows : [])
        .filter((row) => keep(row.client_json))
        .map((row) => ({ src: "deletion" as const, at: toIso(row.deleted_at), row })),
    ].sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? 1 : -1;
      // Same instant, same document: the higher version is the later change.
      const va = a.src === "version" ? Number(a.row.version) : Number.MAX_SAFE_INTEGER;
      const vb = b.src === "version" ? Number(b.row.version) : Number.MAX_SAFE_INTEGER;
      return vb - va;
    });

    const allowed = await access.allowed([
      ...new Set(merged.filter((m) => m.src === "version").map((m) => m.row.node_id)),
    ]);
    visible = merged.filter((m) => m.src === "deletion" || allowed.has(m.row.node_id));

    const exhausted = versionRows.length < window && deletionRows.length < window;
    if (visible.length >= need || exhausted || window >= MAX_SCAN) break;
    window = Math.min(window * 4, MAX_SCAN);
  }
  const page = visible.slice(offset, offset + limit);

  const liveIds = [...new Set(page.filter((m) => m.src === "version").map((m) => m.row.node_id))];
  const heads = await headsOf(nestId, liveIds);
  const prev = await previousSealed(
    nestId,
    page
      .filter((m): m is Extract<Raw, { src: "version" }> => m.src === "version")
      .filter((m) => heads.get(m.row.node_id)?.version === Number(m.row.version))
      .map((m) => ({ nodeId: m.row.node_id, version: Number(m.row.version) })),
  );
  const titles = liveIds.length ? await buildTitleMap(nestId) : new Map<string, string>();

  const items: AgentActivityItem[] = page.map((m) => {
    const client = deserializeClient(m.row.client_json);
    const agent = agentOf(client);
    if (m.src === "deletion") {
      return {
        id: `${m.row.node_id}@deleted`,
        kind: "delete",
        nodeId: m.row.node_id,
        actor: m.row.deleted_by ?? "",
        ...(agent ? { agent } : {}),
        ...(client ? { client } : {}),
        at: m.at,
        undo: DELETE_VERDICT,
      };
    }
    const r = m.row;
    const version = Number(r.version);
    const head = heads.get(r.node_id);
    const title = titles.get(r.node_id);
    return {
      id: `${r.node_id}@v${version}`,
      kind: kindOf(version, head?.first, r.change_note),
      nodeId: r.node_id,
      ...(title ? { title } : {}),
      version,
      status: r.status,
      actor: r.author,
      ...(agent ? { agent } : {}),
      ...(client ? { client } : {}),
      ...(r.change_note ? { changeNote: r.change_note } : {}),
      at: m.at,
      undo: verdict(version, r.status, head, prev.get(r.node_id)),
    };
  });

  return { items, limit, offset, hasMore: visible.length > offset + limit };
}

export interface UndoPlan {
  effect: UndoEffect;
  restoreTo?: number;
  /** The change being undone — for the restore's change note. */
  version: number;
  agent?: string;
}

/**
 * Decide what undoing (nodeId, version) does right now, or throw why it can't.
 * The route applies the plan through the existing write paths.
 */
export async function planUndo(params: {
  nestId: string;
  nodeId: string;
  version: number;
  userEmail: string;
}): Promise<UndoPlan> {
  const { nestId, nodeId, version, userEmail } = params;
  if (!nodeId || !Number.isInteger(version) || version < 1) {
    throw new ValidationError("nodeId and version (a positive integer) are required");
  }
  if (!(await canUndo(nestId, nodeId, userEmail))) {
    throw new ForbiddenError(
      "Only the nest owner, an admin, or a reviewer on this document can undo changes.",
    );
  }
  const head = (await headsOf(nestId, [nodeId])).get(nodeId);
  if (!head) throw new NotFoundError(`Node not found: ${nodeId}`);

  const row = (await getDb().get(
    `SELECT status, client_json FROM node_versions
      WHERE nest_id = ? AND node_id = ? AND version = ? AND author NOT LIKE ?`,
    [nestId, nodeId, version, SYSTEM_LIKE],
  )) as { status: string; client_json: string | null } | undefined;
  if (!row) {
    throw new ConflictError(
      `Version ${version} of this document isn't in its history (current: v${head.version}).`,
    );
  }
  const prev = (await previousSealed(nestId, [{ nodeId, version }])).get(nodeId);
  const v = verdict(version, row.status, head, prev);
  if (!v.available || !v.effect) throw new ConflictError(v.reason ?? "This change can't be undone.");
  const agent = agentOf(deserializeClient(row.client_json));
  return { effect: v.effect, restoreTo: v.restoreTo, version, ...(agent ? { agent } : {}) };
}

/** Change note on the version an undo writes — "Undo of v…" is also how the
 *  stream labels it a restore. */
export function undoChangeNote(plan: UndoPlan): string {
  return `Undo of v${plan.version}${plan.agent ? ` by ${plan.agent}` : ""} — restored version ${plan.restoreTo}`;
}

export interface UndoResult {
  effect: UndoEffect;
  /** The version the undo wrote (restore), fell back to (discard), or null. */
  version: number | null;
  /** Status of the version a restore wrote — "draft" in a governed nest
   *  where the undoer doesn't auto-publish. */
  status?: string;
  restoredVersion?: number;
}

/**
 * Carry out a plan through the normal write paths. Each is told the head the
 * plan was made against (`expectHead`) and re-checks it inside the node's
 * write lock, so an edit that lands between planUndo and here is refused with
 * a 409, never overwritten — and a delete never purges a change nobody saw.
 */
export async function applyUndo(params: {
  nestId: string;
  nodeId: string;
  userEmail: string;
  plan: UndoPlan;
  client?: ClientMetadata;
}): Promise<UndoResult> {
  const { nestId, nodeId, userEmail, plan, client } = params;
  if (plan.effect === "restore") {
    const restored = await restoreVersion(nestId, nodeId, plan.restoreTo!, userEmail, {
      client,
      changeNote: undoChangeNote(plan),
      expectHead: plan.version,
    });
    const row = await getVersion(nestId, nodeId, restored.version);
    return {
      effect: "restore",
      version: restored.version,
      restoredVersion: plan.restoreTo,
      ...(row?.status ? { status: row.status } : {}),
    };
  }
  if (plan.effect === "discard") {
    const discarded = await discardDraft(nestId, nodeId, userEmail, { expectHead: plan.version });
    return { effect: discarded.deleted ? "delete" : "discard", version: discarded.version };
  }
  await deleteNodeIfUnchanged(nestId, nodeId, userEmail, plan.version, { client });
  return { effect: "delete", version: null };
}

/** Plan and apply in one call — what the undo route runs. */
export async function undoChange(params: {
  nestId: string;
  nodeId: string;
  version: number;
  userEmail: string;
  client?: ClientMetadata;
}): Promise<UndoResult> {
  const plan = await planUndo(params);
  return applyUndo({ ...params, plan });
}
