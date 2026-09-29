/**
 * Document + folder access grants — sharing, distinct from stewardship.
 *
 * Stewardship is REVIEW governance (who approves changes). Grants are ACCESS:
 * "user U may read/write this document" or "…everything under this folder".
 * A grant lets an owner/admin share a single doc or a folder with someone who
 * is NOT a nest-wide collaborator — the recipient can reach exactly the
 * granted node(s) and nothing else.
 *
 * Resolution: a grant covers a node when the node's id equals the target
 * (exact) OR sits under it (`target + "/"` prefix). The same prefix test
 * serves both types — a document grant `nodes/foo` also covers its
 * sub-resources (`nodes/foo/versions`), and a folder grant `nodes/gtm`
 * covers `nodes/gtm/deals/x`. `write` outranks `read`.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { ValidationError } from "../shared/errors.js";
import { assertCanGrant, permissionClass } from "../auth/seats.js";

export type GrantRole = "read" | "write";
export type GrantTargetType = "document" | "folder";

export interface GrantRow {
  id: string;
  nest_id: string;
  target_type: GrantTargetType;
  target: string;
  user_id: string;
  role: GrantRole;
  granted_by: string;
  created_at: string;
  updated_at: string;
}

const rank = (r: GrantRole): number => (r === "write" ? 2 : 1);

/** Highest grant role the user holds over `nodeId` in this nest, or null.
 *  An archived nest is read-only for everyone, so a `write` grant reads back
 *  as `read` there — the same cap resolveNestAccess puts on nest permission.
 *  It has to land here: a grantee has no collaborator row for that cap to
 *  clamp, and every grant path (middleware, canRequestDeletion, myGrant)
 *  routes through this one resolver. */
export async function resolveNodeGrant(
  nestId: string,
  userId: string,
  nodeId: string,
): Promise<GrantRole | null> {
  if (!userId || !nodeId) return null;
  const rows = (await getDb().all(
    `SELECT g.target, g.role, n.archived_at
       FROM grants g
       JOIN nests n ON n.id = g.nest_id
      WHERE g.nest_id = ? AND g.user_id = ?`,
    [nestId, userId],
  )) as Array<{
    target: string;
    role: GrantRole;
    archived_at: string | null;
  }>;
  let best: GrantRole | null = null;
  for (const r of rows) {
    if (nodeId === r.target || nodeId.startsWith(r.target + "/")) {
      if (!best || rank(r.role) > rank(best)) best = r.role;
    }
  }
  if (best === "write" && rows[0]?.archived_at) return "read";
  return best;
}

// "Does this user hold ANY grant here?" — the question that gates nest-shell
// visibility — is answered by `hasGrant` on resolveNestAccess (shared/access.ts),
// which folds it into the permission fetch rather than paying a query of its own.

/** The user's grants in this nest — used to filter the node list to what they
 *  can see when they have no nest-wide permission. */
export async function listUserGrants(
  nestId: string,
  userId: string,
): Promise<Array<{ target: string; role: GrantRole }>> {
  if (!userId) return [];
  return (await getDb().all(
    "SELECT target, role FROM grants WHERE nest_id = ? AND user_id = ?",
    [nestId, userId],
  )) as Array<{ target: string; role: GrantRole }>;
}

/** True if any of the user's grants covers this node id. */
export function grantCoversNode(
  grants: Array<{ target: string }>,
  nodeId: string,
): boolean {
  return grants.some(
    (g) => nodeId === g.target || nodeId.startsWith(g.target + "/"),
  );
}

/** Highest role among the already-loaded grants covering this node, or null.
 *  The in-memory twin of resolveNodeGrant, for lists that hold the whole set. */
export function grantRoleForNode(
  grants: Array<{ target: string; role: GrantRole }>,
  nodeId: string,
): GrantRole | null {
  let best: GrantRole | null = null;
  for (const g of grants) {
    if (nodeId === g.target || nodeId.startsWith(g.target + "/")) {
      if (!best || rank(g.role) > rank(best)) best = g.role;
    }
  }
  return best;
}

// ─── Management (owner/admin only — gated at the route) ──────────────────

export async function createGrant(params: {
  nestId: string;
  targetType: GrantTargetType;
  target: string;
  userId: string;
  role: GrantRole;
  grantedBy: string;
}): Promise<GrantRow> {
  const { nestId, targetType, target, userId, role, grantedBy } = params;
  if (!["document", "folder"].includes(targetType)) {
    throw new ValidationError("target_type must be document | folder");
  }
  if (!["read", "write"].includes(role)) {
    throw new ValidationError("role must be read | write");
  }
  if (!target.trim()) throw new ValidationError("target is required");
  // A folder target must name a subfolder, not the `nodes` root: every node id
  // is `nodes/…`, so a bare `nodes` prefix would match ALL of them and silently
  // share the whole nest. Require at least one segment past the root.
  if (targetType === "folder") {
    const t = target.trim().replace(/\/+$/, "");
    if (t === "nodes" || t === "") {
      throw new ValidationError("folder target must name a subfolder, not the nest root");
    }
  }
  await assertCanGrant([{ userId, next: permissionClass(role) }]);
  const db = getDb();
  const now = new Date().toISOString();
  // Never shadow the nest owner (they already have everything) — but that's a
  // route-level concern; here we just upsert by (nest, type, target, user).
  const existing = (await db.get(
    "SELECT id FROM grants WHERE nest_id = ? AND target_type = ? AND target = ? AND user_id = ?",
    [nestId, targetType, target, userId],
  )) as { id: string } | undefined;
  if (existing) {
    await db.run(
      "UPDATE grants SET role = ?, granted_by = ?, updated_at = ? WHERE id = ?",
      [role, grantedBy, now, existing.id],
    );
    return (await db.get("SELECT * FROM grants WHERE id = ?", [existing.id])) as GrantRow;
  }
  const id = uuid();
  await db.run(
    `INSERT INTO grants (id, nest_id, target_type, target, user_id, role, granted_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, nestId, targetType, target, userId, role, grantedBy, now, now],
  );
  return (await db.get("SELECT * FROM grants WHERE id = ?", [id])) as GrantRow;
}

export async function listGrants(nestId: string): Promise<GrantRow[]> {
  return (await getDb().all(
    "SELECT * FROM grants WHERE nest_id = ? ORDER BY target_type, target",
    [nestId],
  )) as GrantRow[];
}

export async function deleteGrant(nestId: string, id: string): Promise<boolean> {
  const db = getDb();
  const row = await db.get("SELECT id FROM grants WHERE id = ? AND nest_id = ?", [id, nestId]);
  if (!row) return false;
  await db.run("DELETE FROM grants WHERE id = ?", [id]);
  return true;
}
