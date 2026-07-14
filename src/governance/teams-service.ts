/**
 * Teams service — a reusable, owner-managed group primitive. A team is one row
 * with an INLINE member roster (JSON), each member carrying a role that applies
 * on every nest the team is shared to. Sharing is recorded on
 * `nests.shared_teams` (see shareTeamWithNest / listNestTeams), not a join
 * table. The access resolvers (resolveNestPermission / resolveUserRoles) read
 * both sides to grant each member their role on shared nests.
 *
 * Ownership is enforced here: management ops take the caller and require
 * team ownership (server admins are allowed through by the route layer, which
 * passes `allowAdmin`). Placeholder-user minting for unregistered member emails
 * mirrors the collaborator/steward invite flow.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { normalizeEmail } from "../shared/email.js";
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from "../shared/errors.js";
import type {
  Team,
  TeamMember,
  TeamMemberRole,
  SharedTeamRef,
} from "../shared/types.js";

const VALID_TEAM_ROLES: TeamMemberRole[] = ["admin", "editor", "viewer"];

interface TeamRow {
  id: string;
  name: string;
  owner_id: string;
  members: string;
  created_at: string;
  updated_at: string;
}

function parseMembers(json: string | null | undefined): TeamMember[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as TeamMember[]) : [];
  } catch {
    return [];
  }
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    members: parseMembers(row.members),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Enrich a team for the client: resolve the owner's email and flag each member
 * as `registered` (real account) vs an invited placeholder. One batched user
 * lookup for the members plus one for the owner.
 */
async function enrichTeam(team: Team): Promise<Team> {
  const db = getDb();
  const ids = team.members.map((m) => m.userId);
  const invited = new Map<string, number>();
  if (ids.length) {
    const rows = (await db.all(
      `SELECT id, is_invited FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    )) as Array<{ id: string; is_invited: number }>;
    for (const r of rows) invited.set(r.id, r.is_invited);
  }
  const owner = (await db.get("SELECT email FROM users WHERE id = ?", [
    team.owner_id,
  ])) as { email?: string } | undefined;
  return {
    ...team,
    owner_email: owner?.email,
    // Unknown id (deleted user) → treat as not registered.
    members: team.members.map((m) => ({
      ...m,
      registered: (invited.get(m.userId) ?? 1) === 0,
    })),
  };
}

function assertValidRole(role: string): asserts role is TeamMemberRole {
  if (!VALID_TEAM_ROLES.includes(role as TeamMemberRole)) {
    throw new ValidationError(
      "role must be admin, editor, or viewer",
    );
  }
}

/** Load a team row, or throw NotFound. */
async function loadTeamRow(teamId: string): Promise<TeamRow> {
  const db = getDb();
  const row = (await db.get("SELECT * FROM teams WHERE id = ?", [
    teamId,
  ])) as TeamRow | undefined;
  if (!row) throw new NotFoundError("Team not found");
  return row;
}

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};
// Owner / server admin outrank every member role.
const OWNER_RANK = 4;

/**
 * The caller's management rank on a team. The owner and a server admin
 * (route-resolved `allowAdmin`) outrank every member; otherwise it's the
 * caller's own member-role rank, or 0 when they aren't on the team. Drives who
 * can add people (editor+), manage the roster/rename (admin+), and delete
 * (owner only). Members can never grant a role above their own (escalation cap).
 */
function managementRank(
  row: TeamRow,
  callerUserId: string,
  allowAdmin: boolean,
): number {
  if (row.owner_id === callerUserId || allowAdmin) return OWNER_RANK;
  const m = parseMembers(row.members).find((x) => x.userId === callerUserId);
  return m ? ROLE_RANK[m.role] ?? 0 : 0;
}

export async function createTeam(params: {
  name: string;
  ownerId: string;
}): Promise<Team> {
  const name = params.name?.trim();
  if (!name) throw new ValidationError("Team name is required");
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuid();
  await db.run(
    "INSERT INTO teams (id, name, owner_id, members, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, name, params.ownerId, "[]", now, now],
  );
  return enrichTeam(rowToTeam(await loadTeamRow(id)));
}

/**
 * Teams the caller can see: ones they own OR are a member of, so a member sees
 * where they've been added and can act per their role. The `members LIKE`
 * prefilter is a cheap index-free narrow (member ids are uuids, no false
 * collisions in practice); the JS check confirms actual membership.
 */
export async function listTeamsForUser(userId: string): Promise<Team[]> {
  const db = getDb();
  const rows = (await db.all(
    "SELECT * FROM teams WHERE owner_id = ? OR members LIKE ? ORDER BY created_at",
    [userId, `%${userId}%`],
  )) as TeamRow[];
  const mine = rows.filter(
    (r) =>
      r.owner_id === userId ||
      parseMembers(r.members).some((m) => m.userId === userId),
  );
  return Promise.all(mine.map((r) => enrichTeam(rowToTeam(r))));
}

export async function getTeam(teamId: string): Promise<Team> {
  return enrichTeam(rowToTeam(await loadTeamRow(teamId)));
}

export async function renameTeam(params: {
  teamId: string;
  name: string;
  callerUserId: string;
  allowAdmin?: boolean;
}): Promise<Team> {
  const name = params.name?.trim();
  if (!name) throw new ValidationError("Team name is required");
  const row = await loadTeamRow(params.teamId);
  if (managementRank(row, params.callerUserId, !!params.allowAdmin) < ROLE_RANK.admin) {
    throw new ForbiddenError("Only a team admin or the owner can rename this team.");
  }

  const db = getDb();
  await db.run("UPDATE teams SET name = ?, updated_at = ? WHERE id = ?", [
    name,
    new Date().toISOString(),
    params.teamId,
  ]);
  // Keep the cached teamName in every nest's shared_teams consistent.
  await refreshTeamNameRefs(params.teamId, name);
  return enrichTeam(rowToTeam(await loadTeamRow(params.teamId)));
}

export async function deleteTeam(params: {
  teamId: string;
  callerUserId: string;
  allowAdmin?: boolean;
}): Promise<void> {
  const row = await loadTeamRow(params.teamId);
  if (managementRank(row, params.callerUserId, !!params.allowAdmin) < OWNER_RANK) {
    throw new ForbiddenError("Only the team owner can delete this team.");
  }
  const db = getDb();
  await db.run("DELETE FROM teams WHERE id = ?", [params.teamId]);
  // shared_teams is a JSON blob with no FK — strip the dangling refs so the
  // nest rosters stay clean (resolution ignores unknown teamIds regardless).
  await removeTeamRefs(params.teamId);
}

export async function addMember(params: {
  teamId: string;
  email?: string;
  userId?: string;
  role: string;
  callerUserId: string;
  allowAdmin?: boolean;
}): Promise<Team> {
  assertValidRole(params.role);
  const row = await loadTeamRow(params.teamId);
  const rank = managementRank(row, params.callerUserId, !!params.allowAdmin);
  if (rank < ROLE_RANK.editor) {
    throw new ForbiddenError(
      "Only an editor or admin member (or the owner) can add people to this team.",
    );
  }
  if (rank < OWNER_RANK && ROLE_RANK[params.role] > rank) {
    throw new ForbiddenError("You can't give a member a higher role than your own.");
  }
  const db = getDb();

  // Resolve the target user, minting a placeholder for an unregistered email
  // (claimed by registering the same address — same flow as collaborators).
  let userId = params.userId;
  let email = params.email ? normalizeEmail(params.email) : undefined;
  if (!userId && email) {
    const existing = (await db.get(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      [email],
    )) as { id: string } | undefined;
    if (existing) {
      userId = existing.id;
    } else {
      const { hashPassword } = await import("../auth/keys.js");
      userId = uuid();
      await db.run(
        "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
        [userId, email, null, await hashPassword(uuid())],
      );
    }
  }
  if (!userId) {
    throw new ValidationError("user_id or email is required");
  }
  if (!email) {
    const u = (await db.get("SELECT email FROM users WHERE id = ?", [
      userId,
    ])) as { email?: string } | undefined;
    if (!u) throw new ValidationError("User not found");
    email = normalizeEmail(u.email ?? "");
  }

  const members = parseMembers(row.members);
  if (members.some((m) => m.userId === userId)) {
    throw new ConflictError(
      `${email || "This user"} is already a member of this team. Change their role instead of adding them again.`,
    );
  }
  members.push({ userId, email, role: params.role });
  await persistMembers(params.teamId, members);
  return enrichTeam(rowToTeam(await loadTeamRow(params.teamId)));
}

export async function updateMemberRole(params: {
  teamId: string;
  userId: string;
  role: string;
  callerUserId: string;
  allowAdmin?: boolean;
}): Promise<Team> {
  assertValidRole(params.role);
  const row = await loadTeamRow(params.teamId);
  const rank = managementRank(row, params.callerUserId, !!params.allowAdmin);
  if (rank < ROLE_RANK.admin) {
    throw new ForbiddenError("Only a team admin or the owner can change roles.");
  }
  if (rank < OWNER_RANK && ROLE_RANK[params.role] > rank) {
    throw new ForbiddenError("You can't set a role higher than your own.");
  }
  const members = parseMembers(row.members);
  const member = members.find((m) => m.userId === params.userId);
  if (!member) throw new NotFoundError("Team member not found");
  member.role = params.role;
  await persistMembers(params.teamId, members);
  return enrichTeam(rowToTeam(await loadTeamRow(params.teamId)));
}

export async function removeMember(params: {
  teamId: string;
  userId: string;
  callerUserId: string;
  allowAdmin?: boolean;
}): Promise<Team> {
  const row = await loadTeamRow(params.teamId);
  if (managementRank(row, params.callerUserId, !!params.allowAdmin) < ROLE_RANK.admin) {
    throw new ForbiddenError("Only a team admin or the owner can remove members.");
  }
  const members = parseMembers(row.members);
  const next = members.filter((m) => m.userId !== params.userId);
  if (next.length === members.length) {
    throw new NotFoundError("Team member not found");
  }
  await persistMembers(params.teamId, next);
  return enrichTeam(rowToTeam(await loadTeamRow(params.teamId)));
}

async function persistMembers(
  teamId: string,
  members: TeamMember[],
): Promise<void> {
  const db = getDb();
  await db.run("UPDATE teams SET members = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(members),
    new Date().toISOString(),
    teamId,
  ]);
}

// ─── Nest share side (nests.shared_teams) ───

function parseSharedTeams(json: string | null | undefined): SharedTeamRef[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as SharedTeamRef[]) : [];
  } catch {
    return [];
  }
}

/** Teams shared onto a nest (from nests.shared_teams). */
export async function listNestTeams(nestId: string): Promise<SharedTeamRef[]> {
  const db = getDb();
  const row = (await db.get("SELECT shared_teams FROM nests WHERE id = ?", [
    nestId,
  ])) as { shared_teams?: string } | undefined;
  if (!row) throw new NotFoundError("Nest not found");
  return parseSharedTeams(row.shared_teams);
}

/** Share a team onto a nest — append a {teamId, teamName} ref (idempotent). */
export async function shareTeamWithNest(params: {
  nestId: string;
  teamId: string;
}): Promise<SharedTeamRef[]> {
  const db = getDb();
  const team = (await db.get("SELECT id, name FROM teams WHERE id = ?", [
    params.teamId,
  ])) as { id: string; name: string } | undefined;
  if (!team) throw new NotFoundError("Team not found");
  const nest = (await db.get("SELECT shared_teams FROM nests WHERE id = ?", [
    params.nestId,
  ])) as { shared_teams?: string } | undefined;
  if (!nest) throw new NotFoundError("Nest not found");

  const refs = parseSharedTeams(nest.shared_teams);
  if (refs.some((r) => r.teamId === params.teamId)) {
    throw new ConflictError("This team is already shared with the nest.");
  }
  refs.push({ teamId: team.id, teamName: team.name });
  await db.run("UPDATE nests SET shared_teams = ? WHERE id = ?", [
    JSON.stringify(refs),
    params.nestId,
  ]);

  // Sharing a team whose members carry a governance role (viewer/editor) turns
  // stewardship on for the nest — mirrors assigning an individual steward.
  // Without this, an editor-via-team would gate nothing (stewardship-disabled
  // nests are open read/write). An admin-only team is collaborator-style and
  // does not force stewardship.
  const memberRow = (await db.get("SELECT members FROM teams WHERE id = ?", [
    params.teamId,
  ])) as { members?: string } | undefined;
  const hasGovernanceRole = parseMembers(memberRow?.members).some(
    (m) => m.role === "viewer" || m.role === "editor",
  );
  if (hasGovernanceRole) {
    await db.run(
      "UPDATE nests SET stewardship_enabled = 1 WHERE id = ?",
      [params.nestId],
    );
  }
  return refs;
}

/** Remove a team's share from a nest. */
export async function unshareTeamFromNest(params: {
  nestId: string;
  teamId: string;
}): Promise<SharedTeamRef[]> {
  const db = getDb();
  const nest = (await db.get("SELECT shared_teams FROM nests WHERE id = ?", [
    params.nestId,
  ])) as { shared_teams?: string } | undefined;
  if (!nest) throw new NotFoundError("Nest not found");
  const refs = parseSharedTeams(nest.shared_teams);
  const next = refs.filter((r) => r.teamId !== params.teamId);
  if (next.length === refs.length) {
    throw new NotFoundError("Team is not shared with this nest.");
  }
  await db.run("UPDATE nests SET shared_teams = ? WHERE id = ?", [
    JSON.stringify(next),
    params.nestId,
  ]);
  return next;
}

/** Refresh the cached teamName in every nest that shares this team. */
async function refreshTeamNameRefs(
  teamId: string,
  newName: string,
): Promise<void> {
  const db = getDb();
  const nests = (await db.all(
    "SELECT id, shared_teams FROM nests WHERE shared_teams LIKE ?",
    [`%${teamId}%`],
  )) as Array<{ id: string; shared_teams?: string }>;
  for (const n of nests) {
    const refs = parseSharedTeams(n.shared_teams);
    let changed = false;
    for (const r of refs) {
      if (r.teamId === teamId && r.teamName !== newName) {
        r.teamName = newName;
        changed = true;
      }
    }
    if (changed) {
      await db.run("UPDATE nests SET shared_teams = ? WHERE id = ?", [
        JSON.stringify(refs),
        n.id,
      ]);
    }
  }
}

/** Strip a team's ref from every nest that shares it (used on delete). */
async function removeTeamRefs(teamId: string): Promise<void> {
  const db = getDb();
  const nests = (await db.all(
    "SELECT id, shared_teams FROM nests WHERE shared_teams LIKE ?",
    [`%${teamId}%`],
  )) as Array<{ id: string; shared_teams?: string }>;
  for (const n of nests) {
    const refs = parseSharedTeams(n.shared_teams);
    const next = refs.filter((r) => r.teamId !== teamId);
    if (next.length !== refs.length) {
      await db.run("UPDATE nests SET shared_teams = ? WHERE id = ?", [
        JSON.stringify(next),
        n.id,
      ]);
    }
  }
}

/**
 * Every distinct team-member role the user holds on a nest, across all teams
 * shared onto it. Returns [] when the user is in none of the nest's shared
 * teams. resolveUserRoles adds each role to the effective set; resolveNestPermission
 * takes the max permission over them for nest-level gating.
 */
export async function resolveTeamRolesForUser(
  nestId: string,
  userId: string,
): Promise<TeamMemberRole[]> {
  const refs = await listNestTeams(nestId).catch(() => []);
  if (refs.length === 0) return [];
  const db = getDb();
  const roles = new Set<TeamMemberRole>();
  for (const ref of refs) {
    const row = (await db.get("SELECT members FROM teams WHERE id = ?", [
      ref.teamId,
    ])) as { members?: string } | undefined;
    if (!row) continue;
    const member = parseMembers(row.members).find((m) => m.userId === userId);
    if (member) roles.add(member.role);
  }
  return [...roles];
}
