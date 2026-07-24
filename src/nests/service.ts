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
import { resolveNestPath } from "../shared/paths.js";
import { trackEvent } from "../telemetry/tracker.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { isSuperAdmin } from "../governance/access-service.js";
import { ANON_USER_ID } from "../shared/constants.js";
import { ValidationError } from "../shared/errors.js";
import type { Nest } from "../shared/types.js";

/**
 * On-disk storage root for a nest. Resolution lives in `shared/paths.ts`
 * (honours NEST_STORAGE_ROOT, default `<DATA_ROOT>/nests`); re-exported here
 * for backward compatibility with existing importers (e.g. `nodes/engine.ts`).
 */
export { resolveNestPath };

/**
 * True when the nest was imported from a folder. Imported nests use flat
 * discovery (markdown anywhere in the folder, not just nodes/) because an
 * existing user vault rarely matches the engine's structured layout.
 */
export async function isImportedNest(nestId: string): Promise<boolean> {
  const row = (await getDb().get(
    "SELECT is_imported FROM nests WHERE id = ?",
    [nestId],
  )) as { is_imported: number } | undefined;
  return !!row?.is_imported;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Append " (N)" to `baseName` until both the resulting display name and the
 * derived slug are free for this user. The DB enforces UNIQUE(user_id, slug),
 * so importing a folder whose leaf name collides with an existing nest used
 * to error out — this helper produces "abc", "abc (1)", "abc (2)", ….
 */
export async function uniqueNestName(
  userId: string,
  baseName: string,
): Promise<string> {
  const db = getDb();
  let candidate = baseName;
  let n = 0;
  // Bound the loop to keep a buggy DB / accidental rename storm from spinning
  // forever; 1000 collisions on the same name is already absurd.
  while (n < 1000) {
    const slug = toSlug(candidate);
    const hit = await db.get(
      "SELECT 1 FROM nests WHERE user_id = ? AND slug = ? LIMIT 1",
      [userId, slug],
    );
    if (!hit) return candidate;
    n++;
    candidate = `${baseName} (${n})`;
  }
  // Fallback: extreme collision count — let the caller still try; the DB
  // constraint will surface a clearer error than a silent infinite loop.
  return candidate;
}

/** Check if stewardship (draft-first + approval workflow) is enabled for a nest. */
export async function isStewardshipEnabled(nestId: string): Promise<boolean> {
  const db = getDb();
  const row = (await db.get(
    "SELECT stewardship_enabled FROM nests WHERE id = ?",
    [nestId],
  )) as { stewardship_enabled: number } | undefined;
  return !!row?.stewardship_enabled;
}

/** Toggle stewardship on/off for a nest (admin-only). */
export async function setStewardshipEnabled(
  nestId: string,
  enabled: boolean,
): Promise<void> {
  const db = getDb();
  await db.run("UPDATE nests SET stewardship_enabled = ? WHERE id = ?", [
    enabled ? 1 : 0,
    nestId,
  ]);
}

/** Whether the nest lets a submitter approve their own version (bypass SoD). */
export async function nestAllowsSelfApprove(
  nestId: string,
): Promise<boolean> {
  const db = getDb();
  const row = (await db.get(
    "SELECT allow_self_approve FROM nests WHERE id = ?",
    [nestId],
  )) as { allow_self_approve: number } | undefined;
  return !!row?.allow_self_approve;
}

/** Toggle self-approve bypass on/off for a nest (admin-only). */
export async function setAllowSelfApprove(
  nestId: string,
  allow: boolean,
): Promise<void> {
  const db = getDb();
  await db.run("UPDATE nests SET allow_self_approve = ? WHERE id = ?", [
    allow ? 1 : 0,
    nestId,
  ]);
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
export async function disableStewardshipAndWipeGovernance(
  nestId: string,
): Promise<{
  stewards: number;
  pendingReviews: number;
}> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const id = nestId;
    const stewards = (
      await tx.run("DELETE FROM stewards WHERE nest_id = ?", [id])
    ).changes;
    const pendingReviews = (
      await tx.run(
        "DELETE FROM review_requests WHERE nest_id = ? AND status = 'pending'",
        [id],
      )
    ).changes;
    await tx.run("UPDATE nests SET stewardship_enabled = 0 WHERE id = ?", [id]);
    return { stewards, pendingReviews };
  });
}

/**
 * Update the human-facing fields of a nest (name + description). The slug is
 * recomputed from the new name so collaborators see it in the URL-friendly
 * form too, and we reject the change if it would collide with another nest
 * the same user already owns (UNIQUE(user_id, slug) would throw anyway —
 * surfacing a clean error keeps the autosave UX sane).
 *
 * On-disk state is untouched. The folder stays at its `resolveNestPath(id)`
 * location (see shared/paths.ts — `<NEST_STORAGE_ROOT>/<id>`, default
 * `<DATA_ROOT>/nests/<id>`); renaming a nest never relocates its files.
 */
export async function renameNest(
  nestId: string,
  patch: { name?: string; description?: string | null },
): Promise<Nest> {
  const db = getDb();
  const existing = (await db.get("SELECT * FROM nests WHERE id = ?", [
    nestId,
  ])) as Nest | undefined;
  if (!existing) {
    throw new ValidationError("Nest not found");
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new ValidationError("Name cannot be empty");
    const slug = toSlug(trimmed);
    if (!slug) throw new ValidationError("Name must contain at least one alphanumeric character");
    const conflict = (await db.get(
      "SELECT id FROM nests WHERE user_id = ? AND slug = ? AND id != ? LIMIT 1",
      [existing.user_id, slug, nestId],
    )) as { id: string } | undefined;
    if (conflict) {
      throw new ValidationError(
        `Another nest already uses this name. Pick a different one.`,
      );
    }
    updates.push("name = ?", "slug = ?");
    params.push(trimmed, slug);
  }

  if (patch.description !== undefined) {
    updates.push("description = ?");
    params.push(patch.description || null);
  }

  if (updates.length === 0) {
    return existing;
  }

  params.push(nestId);
  await db.run(
    `UPDATE nests SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );

  return (await db.get("SELECT * FROM nests WHERE id = ?", [nestId])) as Nest;
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

  await db.run(
    "INSERT INTO nests (id, user_id, name, slug, description, visibility) VALUES (?, ?, ?, ?, ?, ?)",
    [id, userId, name, slug, description || null, visibility],
  );

  const path = resolveNestPath(id);
  mkdirSync(path, { recursive: true });
  const storage = new NestStorage(path);
  await storage.init(name);

  trackEvent("nest.create", { nestId: id, userId });

  return (await db.get("SELECT * FROM nests WHERE id = ?", [id])) as Nest;
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

  await db.run(
    "INSERT INTO nests (id, user_id, name, slug, description, visibility, is_imported) VALUES (?, ?, ?, ?, ?, ?, 1)",
    [id, userId, nm, slug, null, visibility],
  );

  trackEvent("nest.import", { nestId: id, userId });

  return (await db.get("SELECT * FROM nests WHERE id = ?", [id])) as Nest;
}

export async function listNests(userId: string): Promise<Nest[]> {
  const db = getDb();
  // Own rows + (for admin/open) all anon-owned. Public discovery is
  // listPublicNests; route layer dedupes by id.
  if (userId === ANON_USER_ID) {
    return (await db.all(
      "SELECT * FROM nests WHERE user_id = ? ORDER BY created_at DESC",
      [ANON_USER_ID],
    )) as Nest[];
  }
  const includeAnon =
    config.AUTH_MODE === "open" || (await isLicenseAdminUserId(userId));
  if (!includeAnon) {
    return (await db.all(
      "SELECT * FROM nests WHERE user_id = ? ORDER BY created_at DESC",
      [userId],
    )) as Nest[];
  }
  return (await db.all(
    "SELECT * FROM nests WHERE user_id = ? OR user_id = ? ORDER BY created_at DESC",
    [userId, ANON_USER_ID],
  )) as Nest[];
}

export function isAnonymousNest(nest: Pick<Nest, "user_id">): boolean {
  return nest.user_id === ANON_USER_ID;
}

/**
 * Nests reachable because the user is a member of a team shared onto them.
 * Read-only listing helper — access + role for every action still resolve
 * through resolveNestPermission/resolveUserRoles (which already fold in teams),
 * so this only makes those nests visible on the dashboard. Pure JS filtering so
 * it works identically on SQLite and Postgres (shared_teams/members are TEXT
 * JSON on both).
 */
async function nestsSharedViaTeams(userId: string): Promise<Nest[]> {
  const db = getDb();
  // Narrow in SQL first — this runs on every dashboard load, so it must never
  // pull every team (or every team-shared nest) in the deployment into memory.
  // The LIKE prefilter can't false-negative (a member id always appears
  // verbatim in the JSON); the JS pass below confirms real membership.
  const teams = (await db.all(
    "SELECT id, members FROM teams WHERE members LIKE ?",
    [`%${userId}%`],
  )) as Array<{ id: string; members: string }>;
  const myTeamIds = new Set<string>();
  for (const t of teams) {
    try {
      const members = JSON.parse(t.members || "[]");
      if (Array.isArray(members) && members.some((m: any) => m?.userId === userId)) {
        myTeamIds.add(t.id);
      }
    } catch {
      /* skip malformed roster */
    }
  }
  if (myTeamIds.size === 0) return [];
  const ids = [...myTeamIds];
  const candidates = (await db.all(
    `SELECT * FROM nests
       WHERE user_id != ?
         AND (${ids.map(() => "shared_teams LIKE ?").join(" OR ")})`,
    [userId, ...ids.map((id) => `%${id}%`)],
  )) as Array<Nest & { shared_teams?: string }>;
  return candidates.filter((n) => {
    try {
      const refs = JSON.parse(n.shared_teams || "[]");
      return Array.isArray(refs) && refs.some((r: any) => myTeamIds.has(r?.teamId));
    } catch {
      return false;
    }
  });
}

export async function listSharedNests(userId: string): Promise<Nest[]> {
  const db = getDb();
  // Server admin (license admin or access.yaml super_admin) administers every
  // nest (resolveNestPermission grants 'admin'), so surface every non-owned
  // nest in the shared list — otherwise private nests they govern aren't
  // reachable from the dashboard.
  const caller = (await db.get("SELECT email FROM users WHERE id = ?", [
    userId,
  ])) as { email?: string } | undefined;
  const isServerAdmin =
    (await isLicenseAdminUserId(userId)) ||
    (caller?.email ? isSuperAdmin(caller.email) : false);
  if (isServerAdmin) {
    return (await db.all(
      "SELECT * FROM nests WHERE user_id != ? ORDER BY created_at DESC",
      [userId],
    )) as Nest[];
  }
  // Shared = collaborator grant OR active steward assignment (matched by
  // email, since steward rows may predate the account) OR membership of a team
  // shared onto the nest. Independent paths to a nest the user doesn't own.
  const direct = (await db.all(
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
    [userId, userId, userId],
  )) as Nest[];

  // Fold in team-shared nests, deduped by id. Re-sort newest-first so the
  // merged list keeps the same ordering as the direct query.
  const seen = new Set(direct.map((n) => n.id));
  for (const n of await nestsSharedViaTeams(userId)) {
    if (!seen.has(n.id)) {
      direct.push(n);
      seen.add(n.id);
    }
  }
  direct.sort((a, b) =>
    a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? 1 : -1,
  );
  return direct;
}

/**
 * Every nest the caller can see — owned + shared — in ONE query instead of
 * listNests + listSharedNests' separate round trips. This is the union of
 * those two, so it stays faithful to their access rules:
 *   - owned                → n.user_id = caller (or anon-owned in open mode)
 *   - collaborator grant   → nest_collaborators row
 *   - active steward       → stewards row matched by email
 *   - server admin         → every nest (short-circuit)
 *   - team-shared          → folded in from nestsSharedViaTeams (JSON, not SQL)
 *
 * Callers that stitched owned+shared themselves (/me/work inbox, /stats) should
 * use this — it also dedupes, which the naive concat did not (a server admin's
 * owned anon nests appeared in both lists).
 */
export async function listVisibleNests(userId: string): Promise<Nest[]> {
  const db = getDb();

  // Server admin administers every nest, so owned ∪ all-others = all nests.
  // Mirrors the admin branches in listNests + listSharedNests. One query.
  const caller = (await db.get("SELECT email FROM users WHERE id = ?", [
    userId,
  ])) as { email?: string } | undefined;
  const isServerAdmin =
    (await isLicenseAdminUserId(userId)) ||
    (caller?.email ? isSuperAdmin(caller.email) : false);
  if (isServerAdmin) {
    return (await db.all(
      "SELECT * FROM nests ORDER BY created_at DESC",
    )) as Nest[];
  }

  // Owned OR collaborator OR active-steward — the same join listSharedNests
  // uses, but with `n.user_id = ?` folded into the WHERE so owned rows come
  // back in the same pass. Anon-owned nests join in under open mode (the
  // ungoverned commons, matching listNests' includeAnon branch).
  const includeAnon = config.AUTH_MODE === "open";
  const params = includeAnon
    ? [userId, userId, userId, ANON_USER_ID]
    : [userId, userId, userId];
  const rows = (await db.all(
    `SELECT DISTINCT n.* FROM nests n
       LEFT JOIN nest_collaborators nc
         ON nc.nest_id = n.id AND nc.user_id = ?
       LEFT JOIN users u ON u.id = ?
       LEFT JOIN stewards s
         ON s.nest_id = n.id AND s.is_active = 1
        AND LOWER(s.user_email) = LOWER(u.email)
      WHERE n.user_id = ?
         OR nc.user_id IS NOT NULL
         OR s.id IS NOT NULL
         ${includeAnon ? "OR n.user_id = ?" : ""}
      ORDER BY n.created_at DESC`,
    params,
  )) as Nest[];

  // Team-shared nests live as JSON (team roster + share refs), so they can't
  // join in SQL — fold them in separately, deduped by id.
  const seen = new Set(rows.map((n) => n.id));
  for (const n of await nestsSharedViaTeams(userId)) {
    if (!seen.has(n.id)) {
      rows.push(n);
      seen.add(n.id);
    }
  }
  return rows;
}

/** Public nests not owned/shared by caller. Route dedupes vs listNests. */
export async function listPublicNests(userId: string): Promise<Nest[]> {
  const db = getDb();
  return (await db.all(
    `SELECT n.* FROM nests n
       WHERE n.visibility = 'public'
         AND n.user_id != ?
         AND NOT EXISTS (
           SELECT 1 FROM nest_collaborators nc
           WHERE nc.nest_id = n.id AND nc.user_id = ?
         )
       ORDER BY n.created_at DESC`,
    [userId, userId],
  )) as Nest[];
}

export async function getNest(nestId: string): Promise<Nest | null> {
  const db = getDb();
  return (
    ((await db.get("SELECT * FROM nests WHERE id = ?", [nestId])) as Nest) ||
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
  await db.transaction(async (tx) => {
    const id = nestId;
    await tx.run("DELETE FROM approved_versions WHERE nest_id = ?", [id]);
    await tx.run("DELETE FROM node_versions WHERE nest_id = ?", [id]);
    await tx.run("DELETE FROM review_requests WHERE nest_id = ?", [id]);
    await tx.run("DELETE FROM stewards WHERE nest_id = ?", [id]);
    await tx.run("DELETE FROM nest_collaborators WHERE nest_id = ?", [id]);
    // node_tag_index is FK-cascaded too, but explicit keeps the contract
    // visible. Wrapped in try/catch because the table is only created by
    // the tag-index migration — older DBs predate it.
    try {
      await tx.run("DELETE FROM node_tag_index WHERE nest_id = ?", [id]);
    } catch {
      // Table not present on legacy DBs — fine, nothing to clean.
    }
    await tx.run("DELETE FROM api_keys WHERE nest_id = ?", [id]);
    await tx.run("DELETE FROM nests WHERE id = ?", [id]);
  });

  // Reclaim the on-disk folder at its resolved location (see shared/paths.ts —
  // `<NEST_STORAGE_ROOT>/<id>`, default `<DATA_ROOT>/nests/<id>`). Every nest
  // (default or imported) lives there — imported nests copied their files in,
  // so removing the folder never touches the user's original (untouched)
  // source. Failure here is non-fatal: the DB rows are already gone, so the
  // nest is unreachable from the app either way; an orphaned directory is
  // harmless.
  const path = resolveNestPath(nestId);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[nests] failed to remove nest directory ${path}:`, err);
  }

  trackEvent("nest.delete", { nestId });
}
