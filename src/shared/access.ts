import { getDb } from "../db/client.js";

export type NestPermission = "none" | "read" | "write" | "admin" | "owner";

const PERMISSION_LEVELS: Record<NestPermission, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
  owner: 4,
};

/**
 * Resolve a user's effective permission on a nest.
 *
 * Resolution order:
 * 1. Nest owner -> 'owner'
 * 2. Direct user grant in nest_collaborators -> that permission
 * 3. Nest visibility = 'public' -> 'read'
 * 4. Otherwise -> 'none'
 */
export function resolveNestPermission(
  nestId: string,
  userId: string,
): NestPermission {
  const db = getDb();

  const nest = db
    .prepare("SELECT user_id, visibility FROM nests WHERE id = ?")
    .get(nestId) as { user_id: string; visibility: string } | undefined;

  if (!nest) return "none";
  if (nest.user_id === userId) return "owner";

  const directGrant = db
    .prepare(
      "SELECT permission FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
    )
    .get(nestId, userId) as { permission: NestPermission } | undefined;

  if (directGrant) return directGrant.permission;

  if (nest.visibility === "public") return "read";

  return "none";
}

export function permissionLevel(p: NestPermission): number {
  return PERMISSION_LEVELS[p] ?? 0;
}
