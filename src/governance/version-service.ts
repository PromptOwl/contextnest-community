/**
 * Version Service — track node versions and handle conflict detection.
 *
 * Every edit creates a new version. AI queries always get the approved version.
 * Conflict detection via X-Base-Version header (optimistic concurrency).
 */

import { createHash } from "crypto";
import { getDb } from "../db/client.js";
import { insertOrReplace, nowExpr } from "../db/sql.js";
import { buildTitleMap } from "./title-resolver.js";
import {
  serializeClient,
  deserializeClient,
  type ClientMetadata,
} from "../shared/client-metadata.js";
import type { DocumentVersion, DocumentLifecycleStatus } from "./types.js";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Author prefix for version rows minted by the auto-publish bump (engine
 * `publishDocument` side-effect, not a user-driven edit). Used to exclude
 * those rows from current-version + conflict-detection queries so the UI's
 * X-Base-Version stays aligned with the user's last saved version even
 * after publish bumps the engine version on disk.
 */
export const SYSTEM_AUTHOR_PREFIX = "system:auto-publish:";

/** Wrap a real user email as a system-author marker. */
export function systemAuthor(email: string): string {
  return `${SYSTEM_AUTHOR_PREFIX}${email}`;
}

// ─── Create Version ─────────────────────────────────────────────────────

export async function createVersion(params: {
  nestId: string;
  nodeId: string;
  version: number;
  content: string;
  author: string;
  status: DocumentLifecycleStatus;
  changeNote?: string;
  tags?: string[];
  /** Caller attribution for the write that sealed this version (§9.4).
   *  A label on the row, never hashed and never read by an access check. */
  client?: ClientMetadata;
}): Promise<DocumentVersion> {
  const db = getDb();
  const contentHash = hashContent(params.content);

  await db.run(
    `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status, change_note, tags_json, client_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.nestId,
      params.nodeId,
      params.version,
      contentHash,
      params.author,
      params.status,
      params.changeNote || null,
      params.tags ? JSON.stringify(params.tags) : null,
      serializeClient(params.client),
    ],
  );

  return {
    version: params.version,
    content: params.content,
    editedBy: params.author,
    editedAt: new Date().toISOString(),
    changeNote: params.changeNote,
    status: params.status,
    client: params.client,
  };
}

/**
 * Insert a version row, or update it in place if one already exists at
 * (nest, node, version).
 *
 * Needed because publishing a DRAFT through the engine transitions it to
 * published WITHOUT bumping the version number (draft N → published N). The
 * governance row that import (or a prior save) created at version N must then
 * be UPDATED, not re-INSERTed — a plain createVersion() hit
 * `UNIQUE(nest_id, node_id, version)` when a user edited an imported draft.
 */
export async function upsertVersion(params: {
  nestId: string;
  nodeId: string;
  version: number;
  content: string;
  author: string;
  status: DocumentLifecycleStatus;
  changeNote?: string;
  tags?: string[];
  /** See createVersion. */
  client?: ClientMetadata;
}): Promise<DocumentVersion> {
  const db = getDb();
  const contentHash = hashContent(params.content);
  const sql = insertOrReplace(
    db,
    `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status, change_note, tags_json, client_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["nest_id", "node_id", "version"],
    // Reset created_at on conflict too: SQLite's INSERT OR REPLACE deletes+
    // reinserts (created_at → now), so mirror that on Postgres — otherwise a
    // draft edited in place would keep its original (import-time) "edited at".
    `content_hash = excluded.content_hash, author = excluded.author, status = excluded.status, change_note = excluded.change_note, tags_json = excluded.tags_json, client_json = excluded.client_json, created_at = ${nowExpr(db)}`,
  );
  await db.run(sql, [
    params.nestId,
    params.nodeId,
    params.version,
    contentHash,
    params.author,
    params.status,
    params.changeNote || null,
    params.tags ? JSON.stringify(params.tags) : null,
    serializeClient(params.client),
  ]);

  return {
    version: params.version,
    content: params.content,
    editedBy: params.author,
    editedAt: new Date().toISOString(),
    changeNote: params.changeNote,
    status: params.status,
    client: params.client,
  };
}

// ─── Query Versions ─────────────────────────────────────────────────────

export async function getVersions(
  nestId: string,
  nodeId: string,
): Promise<DocumentVersion[]> {
  const db = getDb();
  const rows = (await db.all(
    "SELECT * FROM node_versions WHERE nest_id = ? AND node_id = ? ORDER BY version DESC",
    [nestId, nodeId],
  )) as any[];

  return rows.map(rowToVersion);
}

export async function getVersion(
  nestId: string,
  nodeId: string,
  version: number,
): Promise<DocumentVersion | null> {
  const db = getDb();
  const row = (await db.get(
    "SELECT * FROM node_versions WHERE nest_id = ? AND node_id = ? AND version = ?",
    [nestId, nodeId, version],
  )) as any;
  return row ? rowToVersion(row) : null;
}

export async function getCurrentVersion(
  nestId: string,
  nodeId: string,
): Promise<number> {
  const db = getDb();
  const row = (await db.get(
    `SELECT MAX(version) as v FROM node_versions
        WHERE nest_id = ? AND node_id = ?
          AND author NOT LIKE ?`,
    [nestId, nodeId, `${SYSTEM_AUTHOR_PREFIX}%`],
  )) as { v: number | null };
  return row?.v || 0;
}

/**
 * Every node in a nest that already carries a real (non-system) version row.
 *
 * Import only needs the yes/no that getCurrentVersion answers, but asked it per
 * document — one round trip each before any work began. One scan answers it for
 * the whole nest, mirroring getApprovedVersions.
 */
export async function getTrackedNodeIds(nestId: string): Promise<Set<string>> {
  const db = getDb();
  const rows = (await db.all(
    `SELECT DISTINCT node_id FROM node_versions
        WHERE nest_id = ? AND author NOT LIKE ?`,
    [nestId, `${SYSTEM_AUTHOR_PREFIX}%`],
  )) as Array<{ node_id: string }>;
  return new Set(rows.map((r) => r.node_id));
}

// ─── Approved Version ───────────────────────────────────────────────────

export async function getApprovedVersion(
  nestId: string,
  nodeId: string,
): Promise<number | null> {
  const db = getDb();
  const row = (await db.get(
    "SELECT approved_version FROM approved_versions WHERE nest_id = ? AND node_id = ?",
    [nestId, nodeId],
  )) as { approved_version: number } | undefined;
  return row?.approved_version ?? null;
}

/**
 * Every node's approved version in one nest, keyed by node id.
 *
 * The per-node lookup above run in a loop is what listing a public nest used to
 * do — once to decide which nodes are visible at all, then again to fetch each
 * one's body — so a 500-node nest paid 1000 sequential round trips. Scanning the
 * nest once mirrors resolveAuthorship, and avoids an IN list long enough to hit
 * SQLite's bound-parameter ceiling.
 */
export async function getApprovedVersions(
  nestId: string,
): Promise<Map<string, number>> {
  const db = getDb();
  const rows = (await db.all(
    "SELECT node_id, approved_version FROM approved_versions WHERE nest_id = ?",
    [nestId],
  )) as Array<{ node_id: string; approved_version: number }>;
  return new Map(rows.map((r) => [r.node_id, r.approved_version]));
}

export async function setApprovedVersion(
  nestId: string,
  nodeId: string,
  version: number,
  approvedBy: string,
): Promise<void> {
  const db = getDb();
  // SQLite OR REPLACE resets approved_at to its default (now); mirror that on
  // Postgres by setting approved_at in the conflict update.
  const sql = insertOrReplace(
    db,
    `INSERT INTO approved_versions (nest_id, node_id, approved_version, approved_by)
     VALUES (?, ?, ?, ?)`,
    ["nest_id", "node_id"],
    `approved_version = excluded.approved_version, approved_by = excluded.approved_by, approved_at = ${nowExpr(db)}`,
  );
  await db.run(sql, [nestId, nodeId, version, approvedBy]);
}

/**
 * The newest version this node has SEALED — the approved pin, else the newest
 * published/approved row. Drafts never seal (they no longer reach the engine's
 * hash chain), so this is the version a discard restores to. Null means the
 * node has never been published: there is nothing to fall back to.
 */
export async function getSealedVersion(
  nestId: string,
  nodeId: string,
): Promise<number | null> {
  const approved = await getApprovedVersion(nestId, nodeId);
  if (approved != null) return approved;
  const db = getDb();
  const row = (await db.get(
    `SELECT MAX(version) as v FROM node_versions
      WHERE nest_id = ? AND node_id = ? AND status IN ('published', 'approved')`,
    [nestId, nodeId],
  )) as { v: number | null } | undefined;
  return row?.v ?? null;
}

/**
 * Drop the draft rows a newer draft supersedes.
 *
 * A draft revision is not a release: it is never appended to the engine's hash
 * chain, so the only place its bytes exist is the live file, and the row left
 * behind describes content nothing can reconstruct. Keeping one row per node
 * (the current one) is what stops a drafting session from filling the version
 * panel with entries that render "(no content)".
 *
 * Status is the whole guard — a published/approved/pending_review row is sealed
 * or under review and is never touched, whatever its version number.
 */
export async function deleteSupersededDrafts(
  nestId: string,
  nodeId: string,
  belowVersion: number,
): Promise<void> {
  const db = getDb();
  await db.run(
    `DELETE FROM node_versions
      WHERE nest_id = ? AND node_id = ? AND status = 'draft' AND version < ?`,
    [nestId, nodeId, belowVersion],
  );
}

/** Every unsealed row above `sealedVersion` — what discarding a draft throws
 *  away. Sealed rows at or below the pin are left alone. */
export async function deleteUnsealedVersions(
  nestId: string,
  nodeId: string,
  sealedVersion: number,
): Promise<void> {
  const db = getDb();
  await db.run(
    `DELETE FROM node_versions
      WHERE nest_id = ? AND node_id = ? AND version > ?
        AND status IN ('draft', 'rejected', 'pending_review')`,
    [nestId, nodeId, sealedVersion],
  );
}

/** True when the node's newest row is an unsealed revision — i.e. the live file
 *  is somebody's working copy, not the last published bytes. */
export async function hasUnsealedDraft(
  nestId: string,
  nodeId: string,
): Promise<boolean> {
  const db = getDb();
  const row = (await db.get(
    `SELECT status FROM node_versions
      WHERE nest_id = ? AND node_id = ?
      ORDER BY version DESC LIMIT 1`,
    [nestId, nodeId],
  )) as { status: string } | undefined;
  return (
    row?.status === "draft" ||
    row?.status === "rejected" ||
    row?.status === "pending_review"
  );
}

// ─── Conflict Detection ─────────────────────────────────────────────────

export interface ConflictCheckResult {
  conflict: boolean;
  currentVersion: number;
  currentHash: string;
  updatedBy?: string;
  updatedAt?: string;
}

export async function checkConflict(
  nestId: string,
  nodeId: string,
  baseVersion: number,
): Promise<ConflictCheckResult> {
  const db = getDb();
  const current = (await db.get(
    `SELECT version, content_hash, author, created_at
         FROM node_versions
        WHERE nest_id = ? AND node_id = ?
          AND author NOT LIKE ?
        ORDER BY version DESC
        LIMIT 1`,
    [nestId, nodeId, `${SYSTEM_AUTHOR_PREFIX}%`],
  )) as
    | {
        version: number;
        content_hash: string;
        author: string;
        created_at: string;
      }
    | undefined;

  if (!current) {
    return { conflict: false, currentVersion: 0, currentHash: "" };
  }

  if (current.version !== baseVersion) {
    return {
      conflict: true,
      currentVersion: current.version,
      currentHash: current.content_hash,
      updatedBy: current.author,
      updatedAt: current.created_at,
    };
  }

  return {
    conflict: false,
    currentVersion: current.version,
    currentHash: current.content_hash,
  };
}

// ─── Get Tags ───────────────────────────────────────────────────────────

export async function getNodeTags(
  nestId: string,
  nodeId: string,
): Promise<string[]> {
  const db = getDb();
  const row = (await db.get(
    "SELECT tags_json FROM node_versions WHERE nest_id = ? AND node_id = ? ORDER BY version DESC LIMIT 1",
    [nestId, nodeId],
  )) as { tags_json: string | null } | undefined;
  if (!row?.tags_json) return [];
  try {
    return JSON.parse(row.tags_json);
  } catch {
    return [];
  }
}

// ─── Display Status ─────────────────────────────────────────────────────
//
// Single source of truth for the workflow state shown in the UI. The .md
// frontmatter `status:` field is intentionally NOT consulted — it would
// get rewritten on every workflow transition, churning the on-disk file
// and bloating git diffs. Compute from DB instead so the file stays
// stable across draft → pending → approved cycles.

export type DisplayStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "published"
  | "rejected";

/**
 * The decision itself, given the three facts it needs. Shared by the
 * single-node and whole-nest resolvers so the two can never disagree.
 */
function decideDisplayStatus(
  hasPendingReview: boolean,
  current: { version: number; status: string } | undefined,
  approvedVersion: number | undefined,
): DisplayStatus {
  // 1. Any pending review wins — even if the current version row says
  // something else, an open review request is the live workflow state.
  if (hasPendingReview) return "pending_review";
  if (!current) return "draft";

  // 2. Terminal "published" / "approved" only when the latest version is
  // the one pinned in approved_versions. After an author edits past it,
  // the new (latest) version is a draft even though an older row is
  // still serving LLM traffic — display reflects the latest row.
  if (current.status === "published" || current.status === "approved") {
    if (approvedVersion === current.version) {
      return current.status === "published" ? "published" : "approved";
    }
    return "draft";
  }
  if (current.status === "rejected") return "rejected";
  return "draft";
}

export async function getDisplayStatus(
  nestId: string,
  nodeId: string,
): Promise<DisplayStatus> {
  const db = getDb();

  const pending = (await db.get(
    "SELECT 1 FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' LIMIT 1",
    [nestId, nodeId],
  )) as { 1: number } | undefined;

  const current = (await db.get(
    `SELECT version, status FROM node_versions
       WHERE nest_id = ? AND node_id = ?
       ORDER BY version DESC LIMIT 1`,
    [nestId, nodeId],
  )) as { version: number; status: string } | undefined;

  const approved =
    current && (current.status === "published" || current.status === "approved")
      ? ((await db.get(
          "SELECT approved_version FROM approved_versions WHERE nest_id = ? AND node_id = ?",
          [nestId, nodeId],
        )) as { approved_version: number } | undefined)
      : undefined;

  return decideDisplayStatus(!!pending, current, approved?.approved_version);
}

/**
 * Display status for EVERY document in a nest, in three queries instead of
 * two or three per node — a 400-document listing was paying ~1000 of them.
 * Nodes with no version row are absent; callers default those to "draft".
 */
export async function getDisplayStatuses(
  nestId: string,
): Promise<Map<string, DisplayStatus>> {
  const db = getDb();
  const [pendingRows, currentRows, approvedRows] = await Promise.all([
    db.all(
      "SELECT DISTINCT node_id FROM review_requests WHERE nest_id = ? AND status = 'pending'",
      [nestId],
    ) as Promise<Array<{ node_id: string }>>,
    // The latest version per node, via a grouped self-join — portable across
    // the SQLite and Postgres adapters (no window functions, no row values).
    db.all(
      `SELECT nv.node_id, nv.version, nv.status
         FROM node_versions nv
         JOIN (SELECT node_id, MAX(version) AS max_version
                 FROM node_versions WHERE nest_id = ? GROUP BY node_id) latest
           ON latest.node_id = nv.node_id AND latest.max_version = nv.version
        WHERE nv.nest_id = ?`,
      [nestId, nestId],
    ) as Promise<Array<{ node_id: string; version: number; status: string }>>,
    db.all(
      "SELECT node_id, approved_version FROM approved_versions WHERE nest_id = ?",
      [nestId],
    ) as Promise<Array<{ node_id: string; approved_version: number }>>,
  ]);

  const pending = new Set(pendingRows.map((r) => r.node_id));
  const approved = new Map(
    approvedRows.map((r) => [r.node_id, r.approved_version]),
  );
  const current = new Map(currentRows.map((r) => [r.node_id, r]));
  const statuses = new Map<string, DisplayStatus>();
  for (const nodeId of new Set([...pending, ...current.keys()])) {
    statuses.set(
      nodeId,
      decideDisplayStatus(
        pending.has(nodeId),
        current.get(nodeId),
        approved.get(nodeId),
      ),
    );
  }
  return statuses;
}

// ─── My Drafts ──────────────────────────────────────────────────────────

export interface MyDraft {
  nestId: string;
  nodeId: string;
  title: string;
  status: "draft" | "rejected";
  /** The version that would go to review — what the submit dialog names. */
  version: number;
  updatedAt: string;
}

/**
 * Every unsubmitted (or rejected) document this person left behind, across
 * the nests they can see.
 *
 * The gap this closes: a draft that was never submitted has no
 * review_requests row, so it shows up in no queue and no inbox — the author
 * had no way to find it again short of remembering its title.
 *
 * Mirrors getDisplayStatus: the LATEST version row decides, and an open
 * review request means pending (that belongs in /me/work), not a draft.
 *
 * A draft's title lives on disk, not in SQL (buildTitleMap resolves it), so
 * neither a title search nor a title sort can be expressed in the query. Rather
 * than keep a SQL-paged path beside an in-memory one and have the two disagree
 * on how many drafts there are, every mode reads the whole matching set —
 * capped, and a person's own drafts are a bounded list — then filters, sorts
 * and slices the page in memory. `total` is therefore always the number of
 * drafts whose document still exists, which is what the list shows.
 */
export async function listMyDrafts(params: {
  authorEmail: string;
  nestIds: string[];
  limit?: number;
  offset?: number;
  /** Free text matched against title, nest name and node id (case-insensitive). */
  q?: string;
  sort?: "updated" | "title";
  /** Nest id → display name, so `q` can match the nest a draft lives in. */
  nestNames?: Map<string, string>;
}): Promise<{ drafts: MyDraft[]; total: number }> {
  if (params.nestIds.length === 0) return { drafts: [], total: 0 };
  const db = getDb();
  const nestPlaceholders = params.nestIds.map(() => "?").join(",");
  // author + status leads the WHERE so idx_versions_author_status (migration
  // 034) carries it — that pair is far more selective than nest_id, and it
  // keeps this off a full scan of every version row on the server. Compared
  // with plain `=`: every email-storing column is written lowercased
  // (normalizeEmail on registration, migration 009 for legacy rows), and
  // LOWER() on the column would defeat the index.
  const where = `
      WHERE v.author = ?
        AND v.status IN ('draft', 'rejected')
        AND v.nest_id IN (${nestPlaceholders})
        AND v.version = (
          SELECT MAX(v2.version) FROM node_versions v2
           WHERE v2.nest_id = v.nest_id AND v2.node_id = v.node_id)
        AND NOT EXISTS (
          SELECT 1 FROM review_requests r
           WHERE r.nest_id = v.nest_id AND r.node_id = v.node_id
             AND r.status = 'pending')`;
  const args = [params.authorEmail.toLowerCase(), ...params.nestIds];

  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const q = params.q?.trim().toLowerCase() || "";
  // Ceiling on the scan: one person's own unsubmitted drafts, not a nest's
  // documents. A list past this is already telling them to clean up.
  const SCAN_CAP = 500;

  // ONE path for every sort and search. There used to be two — a SQL-paged one
  // for the default view and an in-memory one for title search/sort — and they
  // disagreed on `total`: SQL counted rows, the in-memory path counted rows
  // whose document still exists on disk. A single draft deleted outside the app
  // leaves its version row behind, so the same list reported 104 sorted by date
  // and 103 sorted by title (CU-wdqcq01cb3). The count a person reads has to be
  // the count of what they can actually see, so the existence filter now decides
  // it in every mode, and the SQL COUNT is gone rather than made to agree.
  const rows = (await db.all(
    `SELECT v.nest_id, v.node_id, v.status, v.version, v.created_at
       FROM node_versions v ${where}
      ORDER BY v.created_at DESC
      LIMIT ?`,
    [...args, SCAN_CAP],
  )) as Array<{
    nest_id: string;
    node_id: string;
    status: "draft" | "rejected";
    version: number;
    created_at: string;
  }>;

  // One title map per nest that actually has draft rows — never per node, and
  // never for a nest with nothing in the list (buildTitleMap scans the vault
  // directory). In parallel: the scans are independent I/O.
  const titlesByNest = new Map(
    await Promise.all(
      [...new Set(rows.map((r) => r.nest_id))].map(
        async (nestId): Promise<[string, Map<string, string>]> => [
          nestId,
          await buildTitleMap(nestId),
        ],
      ),
    ),
  );

  let drafts = rows
    // Deleting a document leaves its version rows behind (only nest deletion
    // clears the table), so the title map doubles as the existence check —
    // without it the list fills with ghosts of deleted drafts.
    .filter((r) => titlesByNest.get(r.nest_id)?.has(r.node_id))
    .map((r) => ({
      nestId: r.nest_id,
      nodeId: r.node_id,
      title: titlesByNest.get(r.nest_id)!.get(r.node_id) || r.node_id,
      status: r.status,
      // Number(): Postgres returns INTEGER columns fine, but stay explicit —
      // the modal renders this straight into copy.
      version: Number(r.version),
      updatedAt: r.created_at,
    }));

  if (q) {
    drafts = drafts.filter((d) =>
      [d.title, params.nestNames?.get(d.nestId) ?? "", d.nodeId].some((s) =>
        s.toLowerCase().includes(q),
      ),
    );
  }
  if (params.sort === "title") {
    drafts.sort((a, b) => a.title.localeCompare(b.title));
  }
  return { drafts: drafts.slice(offset, offset + limit), total: drafts.length };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function rowToVersion(row: any): DocumentVersion {
  return {
    version: row.version,
    content: "", // Content lives on disk, not in the versions table
    editedBy: row.author,
    editedAt: row.created_at,
    changeNote: row.change_note || undefined,
    status: row.status,
    client: deserializeClient(row.client_json),
  };
}
