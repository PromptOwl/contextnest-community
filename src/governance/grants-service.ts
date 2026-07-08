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

/** Highest grant role the user holds over `nodeId` in this nest, or null. */
export async function resolveNodeGrant(
  nestId: string,
  userId: string,
  nodeId: string,
): Promise<GrantRole | null> {
  if (!userId || !nodeId) return null;
  const rows = (await getDb().all(
    "SELECT target, role FROM grants WHERE nest_id = ? AND user_id = ?",
    [nestId, userId],
  )) as Array<{ target: string; role: GrantRole }>;
  let best: GrantRole | null = null;
  for (const r of rows) {
    if (nodeId === r.target || nodeId.startsWith(r.target + "/")) {
      if (!best || rank(r.role) > rank(best)) best = r.role;
    }
  }
  return best;
}

/** Does the user hold ANY grant in this nest? (gates nest-shell visibility) */
export async function hasAnyGrant(nestId: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  const row = (await getDb().get(
    "SELECT 1 AS x FROM grants WHERE nest_id = ? AND user_id = ? LIMIT 1",
    [nestId, userId],
  )) as { x: number } | undefined;
  return !!row;
}

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
