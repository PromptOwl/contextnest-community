import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { v4 as uuid } from "uuid";
import { NestStorage } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { trackEvent } from "../telemetry/tracker.js";
import type { Nest } from "../shared/types.js";

function nestPath(nestId: string): string {
  return join(config.DATA_ROOT, "nests", nestId);
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

/**
 * Disable stewardship AND wipe every access record tied to it.
 *
 * Disabling governance is destructive by design: stewards/collaborators were
 * granted on the assumption the approval workflow gated their writes. Once
 * that workflow is off, leaving collaborator rows in place means everyone
 * silently gains ungoverned access. Wipe them in the same transaction as
 * the flag flip so the two states can't drift.
 *
 * Only pending review_requests are removed — approved/rejected/cancelled
 * rows are historical audit data and stay.
 */
export function disableStewardshipAndWipeAccess(nestId: string): {
  stewards: number;
  collaborators: number;
  pendingReviews: number;
} {
  const db = getDb();
  const wipe = db.transaction((id: string) => {
    const stewards = db
      .prepare("DELETE FROM stewards WHERE nest_id = ?")
      .run(id).changes;
    const collaborators = db
      .prepare("DELETE FROM nest_collaborators WHERE nest_id = ?")
      .run(id).changes;
    const pendingReviews = db
      .prepare(
        "DELETE FROM review_requests WHERE nest_id = ? AND status = 'pending'",
      )
      .run(id).changes;
    db.prepare("UPDATE nests SET stewardship_enabled = 0 WHERE id = ?").run(id);
    return { stewards, collaborators, pendingReviews };
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

  db.prepare(
    "INSERT INTO nests (id, user_id, name, slug, description) VALUES (?, ?, ?, ?, ?)",
  ).run(id, userId, name, slug, description || null);

  const path = nestPath(id);
  mkdirSync(path, { recursive: true });
  const storage = new NestStorage(path);
  await storage.init(name);

  trackEvent("nest.create", { nestId: id, userId });

  return db.prepare("SELECT * FROM nests WHERE id = ?").get(id) as Nest;
}

const ANON_USER_ID = "00000000-0000-0000-0000-000000000000";

export function listNests(userId: string): Nest[] {
  const db = getDb();
  // The "ungoverned commons" (anon-owned nests) is an open-mode concept —
  // every visitor effectively co-owns it. In key mode (closed/single) we
  // only surface anon nests to the caretaker (license-admin); regular
  // signed-in users should not see nests they have no real claim to.
  // De-dupe when caller IS the anonymous user.
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
  return db
    .prepare(
      `SELECT DISTINCT n.* FROM nests n
       JOIN nest_collaborators nc ON nc.nest_id = n.id
       WHERE n.user_id != ? AND nc.user_id = ?
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

  // Best-effort filesystem cleanup — the engine's NestStorage writes
  // YAML/markdown into <DATA_ROOT>/nests/<nestId>. Removing this folder
  // is the on-disk counterpart to the DB wipe above. Failure here is
  // non-fatal: the DB rows are already gone, so the nest is unreachable
  // from the app either way; an orphaned directory is harmless.
  const path = nestPath(nestId);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[nests] failed to remove nest directory ${path}:`, err);
  }

  trackEvent("nest.delete", { nestId });
}
