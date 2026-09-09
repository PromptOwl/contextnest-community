import { getDb } from "../db/client.js";
import { isLicenseAdminUserId, isLicenseAdminEmail } from "../auth/license.js";
import { isSuperAdmin } from "../governance/access-service.js";
import {
  resolveTeamRolesFromShared,
  parseSharedTeams,
} from "../governance/teams-service.js";
import { teamRoleToPermission } from "../governance/roles.js";
import { ANON_USER_ID } from "./constants.js";

export type NestPermission = "none" | "read" | "write" | "admin" | "owner";

/**
 * Canonical server-admin check by user id: the license admin OR a superadmin
 * (access.yaml `super_admins` ∪ the DB-granted set). Use this for operator
 * surfaces (teammates, unsynced folders, /admin/*) so every gate resolves
 * the same way.
 */
export async function isServerAdminUserId(userId: string): Promise<boolean> {
  if (await isLicenseAdminUserId(userId)) return true;
  const row = (await getDb().get(
    "SELECT email FROM users WHERE id = ?",
    [userId],
  )) as { email?: string } | undefined;
  return !!row?.email && isSuperAdmin(row.email);
}

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
/**
 * Every fact a permission decision needs about (nest, caller), plus the two
 * answers derived from them.
 *
 * `resolveNestPermission` and `isPublicReader` used to re-fetch the same rows
 * one query at a time — and both are called on the hot path (every node read,
 * every MCP tool call, every dashboard card). Between them they cost 6+T
 * queries twice over, where three of those were the SAME `SELECT email FROM
 * users` (the license-admin check does its own). One row now answers both.
 *
 * Teams stay out of the join: membership lives as JSON in `teams.members`, not
 * a table this can join to. `shared_teams` rides along on the nest row, so when
 * teams ARE shared onto the nest it costs one further query for all of them —
 * and only when the answer isn't already settled at admin/owner.
 */
export interface NestAccess {
  exists: boolean;
  ownerId: string | null;
  visibility: string | null;
  callerEmail: string | null;
  /** Raw `nest_collaborators.permission`, before any merge. */
  collaboratorPermission: NestPermission | null;
  /** An active steward row matches the caller's email. */
  isSteward: boolean;
  /** The caller holds at least one document/folder share grant here. */
  hasGrant: boolean;
  /** Merged, highest-wins nest permission — what routes gate on. Already
   *  capped at 'read' when the nest is archived. */
  permission: NestPermission;
  /** The same merge BEFORE the archived cap — i.e. what this caller would hold
   *  if the nest were live. Owner-only actions that must survive archiving
   *  (restore, delete, honouring an archive request) gate on this. */
  rawPermission: NestPermission;
  /** The nest is archived: readable, but nothing may be written to it. */
  archived: boolean;
  /** Reaches the nest ONLY because it is public (approved content only). */
  isPublicReader: boolean;
}

const higher = (
  a: NestPermission,
  b: NestPermission | null | undefined,
): NestPermission => (b && PERMISSION_LEVELS[b] > PERMISSION_LEVELS[a] ? b : a);

/** One round trip for the whole picture. See NestAccess. */
/**
 * Archiving caps what anyone may do here at 'read' — the owner included.
 * Enforcing it in this one wrapper is the whole read-only story: every REST
 * route, MCP tool and workflow gate resolves through resolveNestAccess or
 * resolveNestPermission, so none of them needs its own archived check.
 *
 * `ownerId` is deliberately left raw, so the routes that must still work on an
 * archived nest — restore, delete, honouring an archive request — gate on
 * ownership rather than on the capped permission (see nests/routes.ts).
 */
export async function resolveNestAccess(
  nestId: string,
  userId: string,
): Promise<NestAccess> {
  const access = await resolveNestAccessRaw(nestId, userId);
  return {
    ...access,
    rawPermission: access.permission,
    permission: capForArchive(access.permission, access.archived),
  };
}

/** Archived nests are readable and nothing more, whoever is asking. */
export function capForArchive(
  permission: NestPermission,
  archived: boolean,
): NestPermission {
  if (!archived) return permission;
  return PERMISSION_LEVELS[permission] > PERMISSION_LEVELS.read
    ? "read"
    : permission;
}

async function resolveNestAccessRaw(
  nestId: string,
  userId: string,
): Promise<NestAccess> {
  const row = (await getDb().get(
    `SELECT n.user_id      AS owner_id,
            n.visibility   AS visibility,
            n.archived_at  AS archived_at,
            n.shared_teams AS shared_teams,
            u.email        AS caller_email,
            nc.permission  AS collab_permission,
            (SELECT 1 FROM stewards s
               WHERE s.nest_id = n.id AND s.is_active = 1
                 AND LOWER(s.user_email) = LOWER(u.email)
               LIMIT 1) AS steward_hit,
            (SELECT 1 FROM grants g
               WHERE g.nest_id = n.id AND g.user_id = ?
               LIMIT 1) AS grant_hit
       FROM nests n
       LEFT JOIN users u ON u.id = ?
       LEFT JOIN nest_collaborators nc
         ON nc.nest_id = n.id AND nc.user_id = ?
      WHERE n.id = ?`,
    [userId, userId, userId, nestId],
  )) as
    | {
        owner_id: string;
        visibility: string | null;
        archived_at: string | null;
        shared_teams: string | null;
        caller_email: string | null;
        collab_permission: NestPermission | null;
        steward_hit: number | boolean | null;
        grant_hit: number | boolean | null;
      }
    | undefined;

  const absent: NestAccess = {
    exists: false,
    ownerId: null,
    visibility: null,
    callerEmail: null,
    collaboratorPermission: null,
    isSteward: false,
    hasGrant: false,
    permission: "none",
    rawPermission: "none",
    isPublicReader: false,
    archived: false,
  };
  if (!row) return absent;

  const base = {
    exists: true,
    ownerId: row.owner_id,
    visibility: row.visibility,
    callerEmail: row.caller_email ?? null,
    collaboratorPermission: row.collab_permission ?? null,
    // Postgres returns integer 1, SQLite returns 1 — both truthy, neither a
    // boolean, so normalize rather than leaking the driver's shape.
    isSteward: !!row.steward_hit,
    hasGrant: !!row.grant_hit,
    archived: !!row.archived_at,
    // Filled in by the resolveNestAccess wrapper, which owns the cap.
    rawPermission: "none" as NestPermission,
  };

  // 1. The owner.
  if (row.owner_id === userId) {
    return { ...base, permission: "owner", isPublicReader: false };
  }

  // The caller's email answers BOTH admin checks with no further queries —
  // isLicenseAdminEmail and isSuperAdmin are pure. The old code paid a users
  // lookup for each.
  const email = row.caller_email ?? null;
  const licenseAdmin = isLicenseAdminEmail(email);

  // 2. The ungoverned commons: the license admin keeps full control of an
  //    anon-owned nest even once it is private — anon has no login path.
  if (row.owner_id === ANON_USER_ID && licenseAdmin) {
    return { ...base, permission: "owner", isPublicReader: false };
  }

  // 3. Server admins administer every nest, but stay below the owner tier so
  //    delete/transfer remain the real owner's.
  if (licenseAdmin || (email && isSuperAdmin(email))) {
    return { ...base, permission: "admin", isPublicReader: false };
  }

  // 4. Below owner/admin several sources can grant access at once (direct
  //    collaborator, team membership, steward, public visibility). They
  //    combine highest-wins, not first-match: a 'read' collaborator who is
  //    also an 'admin'-role member of a shared team resolves to 'admin'.
  let best: NestPermission = higher("none", row.collab_permission);

  // 'admin' is the ceiling below owner, so nothing left can raise it — skip
  // the team query entirely.
  if (best !== "admin") {
    const teamRoles = await resolveTeamRolesFromShared(
      parseSharedTeams(row.shared_teams),
      userId,
    );
    for (const role of teamRoles) {
      best = higher(best, teamRoleToPermission(role) as NestPermission);
    }
    // Reaching the nest through a team is a membership path, not public
    // visibility — such a caller sees drafts like any collaborator.
    if (teamRoles.length > 0) {
      return { ...base, permission: best, isPublicReader: false };
    }
  }
  if (best === "admin") {
    return { ...base, permission: best, isPublicReader: false };
  }

  // Stewards get nest-level read so they can reach what they govern without a
  // collaborator row. Edit/approve is still enforced per node.
  if (base.isSteward) best = higher(best, "read");
  if (row.visibility === "public") best = higher(best, "read");

  // Public reader = the nest is public and NOTHING else let them in. A share
  // grant is deliberately not in this list: it scopes which nodes they reach,
  // it doesn't change that their nest-level standing is public-only.
  const isPublicReader =
    row.visibility === "public" &&
    !row.collab_permission &&
    !base.isSteward;

  return { ...base, permission: best, isPublicReader };
}

export async function resolveNestPermission(
  nestId: string,
  userId: string,
): Promise<NestPermission> {
  return (await resolveNestAccess(nestId, userId)).permission;
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
  return (await resolveNestAccess(nestId, userId)).isPublicReader;
}
