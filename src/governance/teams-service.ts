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
import type { Querier } from "../db/adapter.js";
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
  // Rename + cached-name refresh land together, so the roster can't be left
  // advertising the old name on some nests and the new one on others.
  await db.transaction(async (tx) => {
    await tx.run("UPDATE teams SET name = ?, updated_at = ? WHERE id = ?", [
      name,
      new Date().toISOString(),
      params.teamId,
    ]);
    // Keep the cached teamName in every nest's shared_teams consistent.
    await refreshTeamNameRefs(tx, params.teamId, name);
  });
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
  // Delete + ref cleanup are one unit: shared_teams is a JSON blob with no FK,
  // so a crash between them would strand a {teamId, teamName} ref pointing at a
  // row that no longer exists, with nothing left to self-heal from.
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM teams WHERE id = ?", [params.teamId]);
    await removeTeamRefs(tx, params.teamId);
  });
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
  //
  // The stored email ALWAYS comes from the resolved account, never from the
  // request: when a user_id is supplied, a caller-provided email is ignored
  // entirely. Trusting it would let anyone who knows a user's id pin an
  // arbitrary address onto that membership, which then renders as their
  // identity across the roster UIs.
  let userId = params.userId;
  let email: string | undefined;
  if (!userId) {
    const requested = params.email ? normalizeEmail(params.email) : undefined;
    if (!requested) {
      throw new ValidationError("user_id or email is required");
    }
    const existing = (await db.get(
      "SELECT id, email FROM users WHERE LOWER(email) = ?",
      [requested],
    )) as { id: string; email?: string } | undefined;
    if (existing) {
      userId = existing.id;
      email = normalizeEmail(existing.email ?? requested);
    } else {
      const { hashPassword } = await import("../auth/keys.js");
      userId = uuid();
      await db.run(
        "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
        [userId, requested, null, await hashPassword(uuid())],
      );
      email = requested;
    }
  } else {
    const u = (await db.get("SELECT email FROM users WHERE id = ?", [
      userId,
    ])) as { email?: string } | undefined;
    if (!u) throw new ValidationError("User not found");
    email = normalizeEmail(u.email ?? "");
  }

  const resolvedId = userId;
  const resolvedEmail = email;
  await mutateMembers(params.teamId, (members) => {
    if (members.some((m) => m.userId === resolvedId)) {
      throw new ConflictError(
        `${resolvedEmail || "This user"} is already a member of this team. Change their role instead of adding them again.`,
      );
    }
    return [
      ...members,
      { userId: resolvedId, email: resolvedEmail, role: params.role as TeamMemberRole },
    ];
  });
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
  await mutateMembers(params.teamId, (members) => {
    const member = members.find((m) => m.userId === params.userId);
    if (!member) throw new NotFoundError("Team member not found");
    member.role = params.role as TeamMemberRole;
    return members;
  });
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
  await mutateMembers(params.teamId, (members) => {
    const next = members.filter((m) => m.userId !== params.userId);
    if (next.length === members.length) {
      throw new NotFoundError("Team member not found");
    }
    return next;
  });
  return enrichTeam(rowToTeam(await loadTeamRow(params.teamId)));
}

/**
 * Atomically read-modify-write a team's inline member roster.
 *
 * The roster is a single JSON cell per team, not one row per member, so two
 * concurrent membership writes would otherwise clobber each other (a genuine
 * lost update on a pooled Postgres backend; SQLite's single writer largely
 * hides it). Re-reading inside the transaction means `mutate` always sees
 * committed state, and a throw from `mutate` rolls the whole thing back.
 */
async function mutateMembers(
  teamId: string,
  mutate: (members: TeamMember[]) => TeamMember[],
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const row = (await tx.get("SELECT members FROM teams WHERE id = ?", [
      teamId,
    ])) as { members?: string } | undefined;
    if (!row) throw new NotFoundError("Team not found");
    const next = mutate(parseMembers(row.members));
    await tx.run("UPDATE teams SET members = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(next),
      new Date().toISOString(),
      teamId,
    ]);
  });
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

/**
 * Share a team onto a nest — append a {teamId, teamName} ref.
 *
 * Two authorization checks apply, and both matter: the route gates `admin` on
 * the NEST, and this gates the caller's relationship to the TEAM — editor+ on
 * the team (see below). Without the team-side gate, anyone who learned a team's
 * id could attach it to a nest they administer — pulling in that team's members
 * without their owner's say, and reading the full roster back out of
 * GET /nests/:id/teams, which the ACL on GET /teams/:teamId otherwise denies to
 * non-members. A view-only bar there is not enough: a viewer who owns a nest
 * clears the nest-side `admin` gate on their own nest, so the team gate is the
 * only thing standing between "view-only member" and "projected the whole team."
 *
 * The whole thing runs in one transaction: shared_teams is a single JSON cell
 * per nest (so a concurrent share/unshare would otherwise lose a write), and
 * the stewardship flip below must land with the share or not at all — a
 * half-applied share would leave governance-role members on a nest that isn't
 * actually gated.
 */
export async function shareTeamWithNest(params: {
  nestId: string;
  teamId: string;
  callerUserId: string;
  allowAdmin?: boolean;
}): Promise<SharedTeamRef[]> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const team = (await tx.get(
      "SELECT id, name, owner_id, members FROM teams WHERE id = ?",
      [params.teamId],
    )) as TeamRow | undefined;
    if (!team) throw new NotFoundError("Team not found");
    // Sharing a team projects EVERY member onto the nest at their team role, so
    // it takes real authority over the team: editor+ (editor, admin, or the
    // owner / server admin). A view-only member must not be able to pull the
    // whole roster — including its admins — onto a nest they happen to own, make
    // it look like an official internal share, and leave the team owner unable
    // to reverse it. This mirrors the escalation cap on addMember (you can't
    // project a reach you don't yourself hold on the team).
    if (
      managementRank(team, params.callerUserId, !!params.allowAdmin) <
      ROLE_RANK.editor
    ) {
      throw new ForbiddenError(
        "You need to be an editor, admin, or owner of a team to share it. View-only members can't.",
      );
    }
    const nest = (await tx.get("SELECT shared_teams FROM nests WHERE id = ?", [
      params.nestId,
    ])) as { shared_teams?: string } | undefined;
    if (!nest) throw new NotFoundError("Nest not found");

    const refs = parseSharedTeams(nest.shared_teams);
    if (refs.some((r) => r.teamId === params.teamId)) {
      throw new ConflictError("This team is already shared with the nest.");
    }
    refs.push({ teamId: team.id, teamName: team.name });
    await tx.run("UPDATE nests SET shared_teams = ? WHERE id = ?", [
      JSON.stringify(refs),
      params.nestId,
    ]);

    // Sharing a team whose members carry a governance role (viewer/editor) turns
    // stewardship on for the nest — mirrors assigning an individual steward.
    // Without this, an editor-via-team would gate nothing (stewardship-disabled
    // nests are open read/write). An admin-only team is collaborator-style and
    // does not force stewardship.
    const hasGovernanceRole = parseMembers(team.members).some(
      (m) => m.role === "viewer" || m.role === "editor",
    );
    if (hasGovernanceRole) {
      await tx.run("UPDATE nests SET stewardship_enabled = 1 WHERE id = ?", [
        params.nestId,
      ]);
    }
    return refs;
  });
}

/** Remove a team's share from a nest. */
export async function unshareTeamFromNest(params: {
  nestId: string;
  teamId: string;
}): Promise<SharedTeamRef[]> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const nest = (await tx.get("SELECT shared_teams FROM nests WHERE id = ?", [
      params.nestId,
    ])) as { shared_teams?: string } | undefined;
    if (!nest) throw new NotFoundError("Nest not found");
    const refs = parseSharedTeams(nest.shared_teams);
    const next = refs.filter((r) => r.teamId !== params.teamId);
    if (next.length === refs.length) {
      throw new NotFoundError("Team is not shared with this nest.");
    }
    await tx.run("UPDATE nests SET shared_teams = ? WHERE id = ?", [
      JSON.stringify(next),
      params.nestId,
    ]);
    return next;
  });
}

/** Refresh the cached teamName in every nest that shares this team. */
async function refreshTeamNameRefs(
  tx: Querier,
  teamId: string,
  newName: string,
): Promise<void> {
  const nests = (await tx.all(
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
      await tx.run("UPDATE nests SET shared_teams = ? WHERE id = ?", [
        JSON.stringify(refs),
        n.id,
      ]);
    }
  }
}

/** Strip a team's ref from every nest that shares it (used on delete). */
async function removeTeamRefs(tx: Querier, teamId: string): Promise<void> {
  const nests = (await tx.all(
    "SELECT id, shared_teams FROM nests WHERE shared_teams LIKE ?",
    [`%${teamId}%`],
  )) as Array<{ id: string; shared_teams?: string }>;
  for (const n of nests) {
    const refs = parseSharedTeams(n.shared_teams);
    const next = refs.filter((r) => r.teamId !== teamId);
    if (next.length !== refs.length) {
      await tx.run("UPDATE nests SET shared_teams = ? WHERE id = ?", [
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
