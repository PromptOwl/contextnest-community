import { getDb } from "../db/client.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { isSuperAdmin } from "../governance/access-service.js";
import { resolveTeamRolesForUser } from "../governance/teams-service.js";
import { teamRoleToPermission } from "../governance/roles.js";
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
 * 3. Server admin (license admin OR access.yaml super_admins) -> 'admin'
 *    on EVERY nest (visibility + collaborators), matching the documented
 *    "always allowed on every nest". Not 'owner': owner-only actions
 *    (delete/transfer) stay with the real owner.
 * 4. Direct user grant in nest_collaborators -> that permission
 * 5. Nest visibility = 'public' -> 'read'
 * 6. Otherwise -> 'none'
 */
export async function resolveNestPermission(
  nestId: string,
  userId: string,
): Promise<NestPermission> {
  const db = getDb();

  const nest = await db
    .get("SELECT user_id, visibility FROM nests WHERE id = ?", [nestId]) as { user_id: string; visibility: string } | undefined;

  if (!nest) return "none";
  if (nest.user_id === userId) return "owner";

  if (nest.user_id === ANON_USER_ID && (await isLicenseAdminUserId(userId))) {
    return "owner";
  }

  // Server admins (license admin + access.yaml super_admins) administer every
  // nest (visibility + collaborators). License admin is the default install's
  // admin identity; super_admins is the access.yaml extension for multi-admin
  // setups. Both get the same nest-level 'admin' — owner-only delete/transfer
  // still stays with the real owner.
  if (await isLicenseAdminUserId(userId)) return "admin";
  const caller = await db
    .get("SELECT email FROM users WHERE id = ?", [userId]) as { email?: string } | undefined;
  if (caller?.email && isSuperAdmin(caller.email)) {
    return "admin";
  }

  // Below owner/admin, several sources can grant access at once (direct
  // collaborator, team membership, steward, public visibility). They combine
  // by highest-wins rather than first-match, so e.g. a 'read' collaborator who
  // is also an 'admin'-role member of a shared team resolves to 'admin'.
  const higher = (
    a: NestPermission,
    b: NestPermission | null | undefined,
  ): NestPermission => (b && PERMISSION_LEVELS[b] > PERMISSION_LEVELS[a] ? b : a);

  let best: NestPermission = "none";

  const directGrant = await db
    .get(
      "SELECT permission FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
      [nestId, userId],
    ) as { permission: NestPermission } | undefined;
  if (directGrant) best = higher(best, directGrant.permission);

  // 'admin' is the ceiling below the owner tier, so nothing left to check can
  // raise it. Bail out here — this function is on hot paths (every node
  // read/write check, every MCP tool call), and the team lookup below costs a
  // query per team shared onto the nest.
  if (best === "admin") return best;

  // Team membership: the highest permission across the roles the user holds in
  // any team shared onto this nest (editor maps to 'write', admin to 'admin').
  for (const role of await resolveTeamRolesForUser(nestId, userId)) {
    best = higher(best, teamRoleToPermission(role) as NestPermission);
  }
  if (best === "admin") return best;

  // Stewards get nest-level read so they can reach the documents/context they
  // govern, even without a collaborator grant. Matched by email because a
  // steward row may predate the user registering an account. Edit/approve is
  // still enforced per node by the governance handlers (resolveUserRoles).
  const stewardGrant = await db
    .get(
      `SELECT 1 FROM stewards s
         JOIN users u ON u.id = ?
        WHERE s.nest_id = ? AND s.is_active = 1
          AND LOWER(s.user_email) = LOWER(u.email)
        LIMIT 1`,
      [userId, nestId],
    );
  if (stewardGrant) best = higher(best, "read");

  if (nest.visibility === "public") best = higher(best, "read");

  return best;
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
export async function isPublicReader(nestId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const nest = await db
    .get("SELECT user_id, visibility FROM nests WHERE id = ?", [nestId]) as { user_id: string; visibility: string } | undefined;
  if (!nest) return false;
  if (nest.visibility !== "public") return false;
  if (nest.user_id === userId) return false;
  const directGrant = await db
    .get(
      "SELECT 1 FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
      [nestId, userId],
    );
  if (directGrant) return false;
  // Server admin (license admin or access.yaml super_admin) holds 'admin' via
  // resolveNestPermission; they should see drafts/pending like any admin, not
  // be downgraded to approved-only.
  if (await isLicenseAdminUserId(userId)) return false;
  const caller = await db
    .get("SELECT email FROM users WHERE id = ?", [userId]) as { email?: string } | undefined;
  if (caller?.email && isSuperAdmin(caller.email)) return false;
  // A steward is not a mere public reader — they govern (and may see drafts
  // of) the documents in their scope. Matched by email like resolveNestPermission.
  const stewardGrant = await db
    .get(
      `SELECT 1 FROM stewards s
         JOIN users u ON u.id = ?
        WHERE s.nest_id = ? AND s.is_active = 1
          AND LOWER(s.user_email) = LOWER(u.email)
        LIMIT 1`,
      [userId, nestId],
    );
  if (stewardGrant) return false;
  // A member of a team shared onto this nest reaches it via that membership,
  // not public visibility — they see drafts/pending like any collaborator.
  if ((await resolveTeamRolesForUser(nestId, userId)).length > 0) return false;
  return true;
}
