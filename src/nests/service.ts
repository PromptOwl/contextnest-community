import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { v4 as uuid } from "uuid";
import { NestStorage } from "@promptowl/contextnest-engine";
import {
  writeImportedFiles,
  discardImportDir,
  type ImportedFile,
} from "../fs/vault-import.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { trackEvent } from "../telemetry/tracker.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { ANON_USER_ID } from "../shared/constants.js";
import { ValidationError } from "../shared/errors.js";
import type { Nest } from "../shared/types.js";

/**
 * On-disk storage root for a nest — always <DATA_ROOT>/nests/<id>. Imported
 * nests copy their files here on import (rather than linking an external host
 * path), so every nest lives under DATA_ROOT. Single source of truth for every
 * disk read/write (engineCache + create/delete).
 */
export function resolveNestPath(nestId: string): string {
  return join(config.DATA_ROOT, "nests", nestId);
}

/**
 * True when the nest was imported from a folder. Imported nests use flat
 * discovery (markdown anywhere in the folder, not just nodes/) because an
 * existing user vault rarely matches the engine's structured layout.
 */
export function isImportedNest(nestId: string): boolean {
  const row = getDb()
    .prepare("SELECT is_imported FROM nests WHERE id = ?")
    .get(nestId) as { is_imported: number } | undefined;
  return !!row?.is_imported;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Check if stewardship (draft-first + approval workflow) is enabled for a nest. */
export function isStewardshipEnabled(nestId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT stewardship_enabled FROM nests WHERE id = ?")
    .get(nestId) as { stewardship_enabled: number } | undefined;
  return !!row?.stewardship_enabled;
}

/** Toggle stewardship on/off for a nest (admin-only). */
export function setStewardshipEnabled(nestId: string, enabled: boolean): void {
  const db = getDb();
  db.prepare("UPDATE nests SET stewardship_enabled = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    nestId,
  );
}

/** Whether the nest lets a submitter approve their own version (bypass SoD). */
export function nestAllowsSelfApprove(nestId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT allow_self_approve FROM nests WHERE id = ?")
    .get(nestId) as { allow_self_approve: number } | undefined;
  return !!row?.allow_self_approve;
}

/** Toggle self-approve bypass on/off for a nest (admin-only). */
export function setAllowSelfApprove(nestId: string, allow: boolean): void {
  const db = getDb();
  db.prepare("UPDATE nests SET allow_self_approve = ? WHERE id = ?").run(
    allow ? 1 : 0,
    nestId,
  );
}

/**
 * Disable stewardship and tear down the governance state tied to it:
 * steward assignments and any pending review requests.
 *
 * Collaborator access is NOT touched — sharing is independent of governance
 * (a nest can be shared with or without stewardship). Removing a share is a
 * separate, explicit action via the Share UI.
 *
 * Only pending review_requests are removed — approved/rejected/cancelled
 * rows are historical audit data and stay.
 */
export function disableStewardshipAndWipeGovernance(nestId: string): {
  stewards: number;
  pendingReviews: number;
} {
  const db = getDb();
  const wipe = db.transaction((id: string) => {
    const stewards = db
      .prepare("DELETE FROM stewards WHERE nest_id = ?")
      .run(id).changes;
    const pendingReviews = db
      .prepare(
        "DELETE FROM review_requests WHERE nest_id = ? AND status = 'pending'",
      )
      .run(id).changes;
    db.prepare("UPDATE nests SET stewardship_enabled = 0 WHERE id = ?").run(id);
    return { stewards, pendingReviews };
  });
  return wipe(nestId);
}

export async function createNest(
  userId: string,
  name: string,
  description?: string,
): Promise<Nest> {
  const id = uuid();
  const slug = toSlug(name);
  const db = getDb();

  // Ungoverned (anon-owned) nests default to public so the shared commons
  // stays visible to everyone in both open and key modes. Admin can flip
  // an individual nest to private later via PATCH /nests/:id/visibility.
  const visibility = userId === ANON_USER_ID ? "public" : "private";

  db.prepare(
    "INSERT INTO nests (id, user_id, name, slug, description, visibility) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, userId, name, slug, description || null, visibility);

  const path = resolveNestPath(id);
  mkdirSync(path, { recursive: true });
  const storage = new NestStorage(path);
  await storage.init(name);

  trackEvent("nest.create", { nestId: id, userId });

  return db.prepare("SELECT * FROM nests WHERE id = ?").get(id) as Nest;
}

/**
 * Import a folder the user picked in their browser as a nest. The browser
 * walks the chosen directory (System folder dialog → showDirectoryPicker /
 * webkitdirectory) and uploads each file's relative path + content; we write
 * them into the nest's own storage under DATA_ROOT. The server never browses
 * its own filesystem, so this works whether or not the server is colocated
 * with the user. The nest is flagged is_imported=1 so it discovers its docs
 * via the flat layout (markdown anywhere, not just nodes/). Governance metadata
 * is seeded on import (registerImportedDocuments) and extended lazily on
 * edit/review, exactly like a default nest.
 */
export async function importNest(
  userId: string,
  name: string,
  files: ImportedFile[],
): Promise<Nest> {
  const nm = (name || "").trim();
  if (!nm) {
    throw new ValidationError("name is required");
  }
  if (!Array.isArray(files)) {
    throw new ValidationError("files are required");
  }

  const db = getDb();
  const id = uuid();
  const slug = toSlug(nm);
  const visibility = userId === ANON_USER_ID ? "public" : "private";
  const dest = resolveNestPath(id);

  // Write the uploaded files before the row exists, so a failed write leaves
  // no orphan nest.
  mkdirSync(dest, { recursive: true });
  try {
    writeImportedFiles(dest, files);
  } catch (err) {
    console.error("[nests] import write failed", dest, err);
    discardImportDir(dest);
    throw new ValidationError("Failed to import folder");
  }

  db.prepare(
    "INSERT INTO nests (id, user_id, name, slug, description, visibility, is_imported) VALUES (?, ?, ?, ?, ?, ?, 1)",
  ).run(id, userId, nm, slug, null, visibility);

  trackEvent("nest.import", { nestId: id, userId });

  return db.prepare("SELECT * FROM nests WHERE id = ?").get(id) as Nest;
}

export function listNests(userId: string): Nest[] {
  const db = getDb();
  // Own rows + (for admin/open) all anon-owned. Public discovery is
  // listPublicNests; route layer dedupes by id.
  if (userId === ANON_USER_ID) {
    return db
      .prepare("SELECT * FROM nests WHERE user_id = ? ORDER BY created_at DESC")
      .all(ANON_USER_ID) as Nest[];
  }
  const includeAnon =
    config.AUTH_MODE === "open" || isLicenseAdminUserId(userId);
  if (!includeAnon) {
    return db
      .prepare("SELECT * FROM nests WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as Nest[];
  }
  return db
    .prepare(
      "SELECT * FROM nests WHERE user_id = ? OR user_id = ? ORDER BY created_at DESC",
    )
    .all(userId, ANON_USER_ID) as Nest[];
}

export function isAnonymousNest(nest: Pick<Nest, "user_id">): boolean {
  return nest.user_id === ANON_USER_ID;
}

export function listSharedNests(userId: string): Nest[] {
  const db = getDb();
  // Shared = collaborator grant OR active steward assignment (matched by
  // email, since steward rows may predate the account). Both are
  // independent paths to a nest the user doesn't own.
  return db
    .prepare(
      `SELECT DISTINCT n.* FROM nests n
       LEFT JOIN nest_collaborators nc
         ON nc.nest_id = n.id AND nc.user_id = ?
       LEFT JOIN users u ON u.id = ?
       LEFT JOIN stewards s
         ON s.nest_id = n.id AND s.is_active = 1
        AND LOWER(s.user_email) = LOWER(u.email)
       WHERE n.user_id != ?
         AND (nc.user_id IS NOT NULL OR s.id IS NOT NULL)
       ORDER BY n.created_at DESC`,
    )
    .all(userId, userId, userId) as Nest[];
}

/** Public nests not owned/shared by caller. Route dedupes vs listNests. */
export function listPublicNests(userId: string): Nest[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT n.* FROM nests n
       WHERE n.visibility = 'public'
         AND n.user_id != ?
         AND NOT EXISTS (
           SELECT 1 FROM nest_collaborators nc
           WHERE nc.nest_id = n.id AND nc.user_id = ?
         )
       ORDER BY n.created_at DESC`,
    )
    .all(userId, userId) as Nest[];
}

export function getNest(nestId: string): Nest | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM nests WHERE id = ?").get(nestId) as Nest) ||
    null
  );
}

export async function deleteNest(nestId: string): Promise<void> {
  const db = getDb();

  // Foreign-key CASCADE handles most of this (see migrations.ts) but the
  // explicit deletes inside a single transaction give us two guarantees:
  //   1. Behaviour stays correct even if a future migration drops a CASCADE
  //      clause or a connection forgets to enable `foreign_keys = ON`.
  //   2. The whole wipe is atomic — a crash mid-delete can't leave dangling
  //      stewards / versions / review rows pointing at a removed nest.
  const wipe = db.transaction((id: string) => {
    db.prepare("DELETE FROM approved_versions WHERE nest_id = ?").run(id);
    db.prepare("DELETE FROM node_versions WHERE nest_id = ?").run(id);
    db.prepare("DELETE FROM review_requests WHERE nest_id = ?").run(id);
    db.prepare("DELETE FROM stewards WHERE nest_id = ?").run(id);
    db.prepare("DELETE FROM nest_collaborators WHERE nest_id = ?").run(id);
    // node_tag_index is FK-cascaded too, but explicit keeps the contract
    // visible. Wrapped in try/catch because the table is only created by
    // the tag-index migration — older DBs predate it.
    try {
      db.prepare("DELETE FROM node_tag_index WHERE nest_id = ?").run(id);
    } catch {
      // Table not present on legacy DBs — fine, nothing to clean.
    }
    db.prepare("DELETE FROM api_keys WHERE nest_id = ?").run(id);
    db.prepare("DELETE FROM nests WHERE id = ?").run(id);
  });
  wipe(nestId);

  // Reclaim the on-disk folder. Every nest (default or imported) lives under
  // DATA_ROOT — imported nests copied their files in, so removing the folder
  // never touches the user's original (untouched) source. Failure here is
  // non-fatal: the DB rows are already gone, so the nest is unreachable from
  // the app either way; an orphaned directory is harmless.
  const path = resolveNestPath(nestId);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[nests] failed to remove nest directory ${path}:`, err);
  }

  trackEvent("nest.delete", { nestId });
}
