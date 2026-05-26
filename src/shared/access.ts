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

/**
 * True when the caller's only access path is "nest is public" — i.e. not
 * the owner, not a direct collaborator, but reaches the nest because
 * visibility='public'. These callers see approved content only; drafts
 * and pending versions stay private to collaborators/stewards.
 */
export function isPublicReader(nestId: string, userId: string): boolean {
  const db = getDb();
  const nest = db
    .prepare("SELECT user_id, visibility FROM nests WHERE id = ?")
    .get(nestId) as { user_id: string; visibility: string } | undefined;
  if (!nest) return false;
  if (nest.visibility !== "public") return false;
  if (nest.user_id === userId) return false;
  const directGrant = db
    .prepare(
      "SELECT 1 FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
    )
    .get(nestId, userId);
  if (directGrant) return false;
  return true;
}
