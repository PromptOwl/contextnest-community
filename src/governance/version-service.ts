/**
 * Version Service — track node versions and handle conflict detection.
 *
 * Every edit creates a new version. AI queries always get the approved version.
 * Conflict detection via X-Base-Version header (optimistic concurrency).
 */

import { createHash } from "crypto";
import { getDb } from "../db/client.js";
import type { DocumentVersion, DocumentLifecycleStatus } from "./types.js";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ─── Create Version ─────────────────────────────────────────────────────

export function createVersion(params: {
  nestId: string;
  nodeId: string;
  version: number;
  content: string;
  author: string;
  status: DocumentLifecycleStatus;
  changeNote?: string;
  tags?: string[];
}): DocumentVersion {
  const db = getDb();
  const contentHash = hashContent(params.content);

  db.prepare(
    `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status, change_note, tags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.nestId,
    params.nodeId,
    params.version,
    contentHash,
    params.author,
    params.status,
    params.changeNote || null,
    params.tags ? JSON.stringify(params.tags) : null,
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

// ─── Query Versions ─────────────────────────────────────────────────────

export function getVersions(
  nestId: string,
  nodeId: string,
): DocumentVersion[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM node_versions WHERE nest_id = ? AND node_id = ? ORDER BY version DESC",
    )
    .all(nestId, nodeId) as any[];

  return rows.map(rowToVersion);
}

export function getVersion(
  nestId: string,
  nodeId: string,
  version: number,
): DocumentVersion | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM node_versions WHERE nest_id = ? AND node_id = ? AND version = ?",
    )
    .get(nestId, nodeId, version) as any;
  return row ? rowToVersion(row) : null;
}

export function getCurrentVersion(
  nestId: string,
  nodeId: string,
): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT MAX(version) as v FROM node_versions WHERE nest_id = ? AND node_id = ?",
    )
    .get(nestId, nodeId) as { v: number | null };
  return row?.v || 0;
}

// ─── Approved Version ───────────────────────────────────────────────────

export function getApprovedVersion(
  nestId: string,
  nodeId: string,
): number | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT approved_version FROM approved_versions WHERE nest_id = ? AND node_id = ?",
    )
    .get(nestId, nodeId) as { approved_version: number } | undefined;
  return row?.approved_version ?? null;
}

export function setApprovedVersion(
  nestId: string,
  nodeId: string,
  version: number,
  approvedBy: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO approved_versions (nest_id, node_id, approved_version, approved_by)
     VALUES (?, ?, ?, ?)`,
  ).run(nestId, nodeId, version, approvedBy);
}

// ─── Conflict Detection ─────────────────────────────────────────────────

export interface ConflictCheckResult {
  conflict: boolean;
  currentVersion: number;
  currentHash: string;
  updatedBy?: string;
  updatedAt?: string;
}

export function checkConflict(
  nestId: string,
  nodeId: string,
  baseVersion: number,
): ConflictCheckResult {
  const db = getDb();
  const current = db
    .prepare(
      "SELECT version, content_hash, author, created_at FROM node_versions WHERE nest_id = ? AND node_id = ? ORDER BY version DESC LIMIT 1",
    )
    .get(nestId, nodeId) as
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

export function getNodeTags(nestId: string, nodeId: string): string[] {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT tags_json FROM node_versions WHERE nest_id = ? AND node_id = ? ORDER BY version DESC LIMIT 1",
    )
    .get(nestId, nodeId) as { tags_json: string | null } | undefined;
  if (!row?.tags_json) return [];
  try {
    return JSON.parse(row.tags_json);
  } catch {
    return [];
  }
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
