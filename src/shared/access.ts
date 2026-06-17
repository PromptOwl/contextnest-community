import { getDb } from "../db/client.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { isSuperAdmin } from "../governance/access-service.js";
import { ANON_USER_ID } from "./constants.js";

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
 * 2. Anon-owned nest + caller is license-admin -> 'owner'
 *    (admin keeps full control over the ungoverned commons even after the
 *    nest is flipped to private — otherwise only the anon user could
 *    manage it and there's no login path for anon.)
 * 3. Server super-admin (access.yaml super_admins) -> 'admin' on EVERY nest
 *    (visibility + collaborators), matching the documented "always allowed on
 *    every nest". Not 'owner': owner-only actions (delete/transfer) stay with
 *    the real owner.
 * 4. Direct user grant in nest_collaborators -> that permission
 * 5. Nest visibility = 'public' -> 'read'
 * 6. Otherwise -> 'none'
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

  if (nest.user_id === ANON_USER_ID && isLicenseAdminUserId(userId)) {
    return "owner";
  }

  // Server super-admins administer every nest (visibility + collaborators).
  // Mirrors the governance layer, which already grants super-admins the
  // 'admin' steward role; here it covers nest-level admin actions too.
  const caller = db
    .prepare("SELECT email FROM users WHERE id = ?")
    .get(userId) as { email?: string } | undefined;
  if (caller?.email && isSuperAdmin(caller.email)) {
    return "admin";
  }

  const directGrant = db
    .prepare(
      "SELECT permission FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
    )
    .get(nestId, userId) as { permission: NestPermission } | undefined;

  if (directGrant) return directGrant.permission;

  // Stewards get nest-level read so they can reach the documents/context they
  // govern, even without a collaborator grant. Matched by email because a
  // steward row may predate the user registering an account. Edit/approve is
  // still enforced per node by the governance handlers (resolveUserRoles).
  const stewardGrant = db
    .prepare(
      `SELECT 1 FROM stewards s
         JOIN users u ON u.id = ?
        WHERE s.nest_id = ? AND s.is_active = 1
          AND LOWER(s.user_email) = LOWER(u.email)
        LIMIT 1`,
    )
    .get(userId, nestId);
  if (stewardGrant) return "read";

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
  // A steward is not a mere public reader — they govern (and may see drafts
  // of) the documents in their scope. Matched by email like resolveNestPermission.
  const stewardGrant = db
    .prepare(
      `SELECT 1 FROM stewards s
         JOIN users u ON u.id = ?
        WHERE s.nest_id = ? AND s.is_active = 1
          AND LOWER(s.user_email) = LOWER(u.email)
        LIMIT 1`,
    )
    .get(userId, nestId);
  if (stewardGrant) return false;
  return true;
}
