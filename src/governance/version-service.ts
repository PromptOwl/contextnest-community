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
}): Promise<DocumentVersion> {
  const db = getDb();
  const contentHash = hashContent(params.content);

  await db.run(
    `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status, change_note, tags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.nestId,
      params.nodeId,
      params.version,
      contentHash,
      params.author,
      params.status,
      params.changeNote || null,
      params.tags ? JSON.stringify(params.tags) : null,
    ],
  );

  return {
    version: params.version,
    content: params.content,
    editedBy: params.author,
    editedAt: new Date().toISOString(),
    changeNote: params.changeNote,
    status: params.status,
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
}): Promise<DocumentVersion> {
  const db = getDb();
  const contentHash = hashContent(params.content);
  const sql = insertOrReplace(
    db,
    `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status, change_note, tags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["nest_id", "node_id", "version"],
    // Reset created_at on conflict too: SQLite's INSERT OR REPLACE deletes+
    // reinserts (created_at → now), so mirror that on Postgres — otherwise a
    // draft edited in place would keep its original (import-time) "edited at".
    `content_hash = excluded.content_hash, author = excluded.author, status = excluded.status, change_note = excluded.change_note, tags_json = excluded.tags_json, created_at = ${nowExpr(db)}`,
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
  ]);

  return {
    version: params.version,
    content: params.content,
    editedBy: params.author,
    editedAt: new Date().toISOString(),
    changeNote: params.changeNote,
    status: params.status,
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

export async function getDisplayStatus(
  nestId: string,
  nodeId: string,
): Promise<"draft" | "pending_review" | "approved" | "published" | "rejected"> {
  const db = getDb();

  // 1. Any pending review wins — even if the current version row says
  // something else, an open review request is the live workflow state.
  const pending = (await db.get(
    "SELECT 1 FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' LIMIT 1",
    [nestId, nodeId],
  )) as { 1: number } | undefined;
  if (pending) return "pending_review";

  // 2. Otherwise look at the current (latest) version's recorded status.
  const current = (await db.get(
    `SELECT version, status FROM node_versions
       WHERE nest_id = ? AND node_id = ?
       ORDER BY version DESC LIMIT 1`,
    [nestId, nodeId],
  )) as { version: number; status: string } | undefined;
  if (!current) return "draft";

  // 3. Terminal "published" / "approved" only when the latest version is
  // the one pinned in approved_versions. After an author edits past it,
  // the new (latest) version is a draft even though an older row is
  // still serving LLM traffic — display reflects the latest row.
  if (current.status === "published" || current.status === "approved") {
    const approved = (await db.get(
      "SELECT approved_version FROM approved_versions WHERE nest_id = ? AND node_id = ?",
      [nestId, nodeId],
    )) as { approved_version: number } | undefined;
    if (approved?.approved_version === current.version) {
      return current.status === "published" ? "published" : "approved";
    }
    return "draft";
  }
  if (current.status === "rejected") return "rejected";
  return "draft";
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
 * Paginated at the SQL level — `total` counts every matching row, the returned
 * page is `limit`/`offset` of them.
 */
export async function listMyDrafts(params: {
  authorEmail: string;
  nestIds: string[];
  limit?: number;
  offset?: number;
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

  // Number(): Postgres returns COUNT(*) as a bigint string.
  // Counted before the existence filter below, so a draft deleted outside the
  // app (leaving orphan version rows) can inflate this by a row — the page it
  // sits on is simply one shorter. Not worth a second pass over every row.
  const total = Number(
    (
      (await db.get(
        `SELECT COUNT(*) as c FROM node_versions v ${where}`,
        args,
      )) as { c: number }
    ).c,
  );

  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const rows = (await db.all(
    `SELECT v.nest_id, v.node_id, v.status, v.version, v.created_at
       FROM node_versions v ${where}
      ORDER BY v.created_at DESC
      LIMIT ? OFFSET ?`,
    [...args, limit, offset],
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

  const drafts = rows
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

  return { drafts, total };
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
  };
}
