/**
 * Import teams from PromptOwl (PO) into this server.
 *
 * The user approves the existing PO device flow, and the resulting token is
 * handed to us for the length of one request: we read their PO teams with it
 * and drop it. Nothing PromptOwl is ever persisted — a self-hosted server
 * holding a long-lived PO credential is a much bigger liability than making the
 * user re-approve, so the trade is deliberate (the cost is that a re-sync after
 * a page reload needs a fresh approval).
 *
 * PO returns every team the caller owns OR belongs to, each carrying their role
 * on it. Only teams where they're an Owner or Editor upstream may be imported
 * (see IMPORTABLE_PROMPTOWL_ROLES) — the local copy is owned by the importer,
 * so copying a team you're view-only on would hand you a reach over it you
 * don't have in PromptOwl.
 *
 * PO is the source of truth on every import: the local roster is reconciled to
 * match, including removing members who are no longer in the PO team. Anyone
 * added to an imported team by hand here is therefore transient. The UI warns
 * before it happens.
 */
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { normalizeEmail } from "../shared/email.js";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../shared/errors.js";
import type { TeamMember, TeamMemberRole } from "../shared/types.js";
import {
  createTeam,
  findTeamByExternalId,
  renameTeam,
  replaceTeamRoster,
  resolveMemberIdentity,
} from "./teams-service.js";

/** Value stored in `teams.source` for a team imported from PromptOwl. */
export const PROMPTOWL_SOURCE = "promptowl";

/** A team as PromptOwl's /api/user/teams reports it. */
export interface PromptowlTeam {
  id: string;
  name: string;
  /** True when the caller owns the team in PromptOwl. */
  owned: boolean;
  /** The caller's own role on the team in PromptOwl. */
  your_role: string;
  source: string | null;
  enterprise: { id: string; name: string } | null;
  updated_at: string | null;
  members: Array<{ email: string; role: string }>;
}

/**
 * PromptOwl roles that may be imported.
 *
 * Importing makes you the OWNER of the local copy — full control, including
 * sharing the whole roster onto a nest. That's a reach a view-only member of
 * the upstream team doesn't have and shouldn't gain by copying it here: it's
 * the same escalation shareTeamWithNest already refuses (a viewer can't project
 * a team onto a nest they happen to own, leaving the real owner unable to undo
 * it). So an import needs real authority upstream — Owner or Editor.
 *
 * PromptOwl's 'User' (its default membership) and 'Viewer' both mean no such
 * authority, and so does any role we don't recognize.
 */
const IMPORTABLE_PROMPTOWL_ROLES = ["owner", "editor"];

/** Whether the caller may import this team — see IMPORTABLE_PROMPTOWL_ROLES. */
export function canImportPromptowlTeam(team: PromptowlTeam): boolean {
  return IMPORTABLE_PROMPTOWL_ROLES.includes(
    (team.your_role || "").toLowerCase(),
  );
}

/** What one team's import changed locally. */
export interface PromptowlSyncResult {
  team_id: string;
  external_id: string;
  name: string;
  created: boolean;
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * PO member role → local team role.
 *
 * 'User' is PO's default membership and carries no implied write intent, so it
 * lands on the least-privilege role rather than inheriting editor by accident.
 * Anything unrecognized (a role added upstream later) does the same: an unknown
 * role must never widen access.
 */
export function mapPromptowlRole(role: string | undefined): TeamMemberRole {
  switch ((role || "").toLowerCase()) {
    case "owner":
      return "admin";
    case "editor":
      return "editor";
    default:
      return "viewer";
  }
}

/** Read the caller's owned PO teams. The token is used here and discarded. */
export async function fetchOwnedPromptowlTeams(
  token: string,
): Promise<PromptowlTeam[]> {
  if (!token?.trim()) throw new ValidationError("token is required");
  const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");

  let res: Response;
  try {
    res = await fetch(`${promptowlUrl}/api/user/teams`, {
      headers: {
        ...config.PROMPTOWL_FETCH_HEADERS,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    // Network-level failure: a self-hosted server may simply have no route to
    // PromptOwl. Say so plainly instead of surfacing a raw fetch error.
    throw new ValidationError("Could not reach PromptOwl. Check this server's network access.");
  }

  if (res.status === 401) {
    throw new UnauthorizedError(
      "PromptOwl rejected this approval. Approve again and retry.",
    );
  }
  if (!res.ok) {
    throw new ValidationError(
      `PromptOwl could not list your teams (HTTP ${res.status}).`,
    );
  }

  const data = (await res.json()) as { teams?: PromptowlTeam[] };
  return Array.isArray(data.teams) ? data.teams : [];
}

/**
 * Import the selected PO teams for `callerUserId`, creating or updating one
 * local team each. `teamIds` are PO team ids; anything the caller doesn't own
 * upstream simply isn't in the fetched set and is rejected.
 */
export async function syncPromptowlTeams(params: {
  callerUserId: string;
  token: string;
  teamIds: string[];
}): Promise<PromptowlSyncResult[]> {
  if (!params.teamIds?.length) {
    throw new ValidationError("team_ids is required");
  }

  const owned = await fetchOwnedPromptowlTeams(params.token);
  const byId = new Map(owned.map((t) => [t.id, t]));

  const selected: PromptowlTeam[] = [];
  for (const id of params.teamIds) {
    const team = byId.get(id);
    // Not in the caller's set → either it doesn't exist or they have nothing to
    // do with it. Don't distinguish: that difference is only useful for probing
    // which team ids exist in PromptOwl.
    if (!team) {
      throw new ValidationError(
        "One of the selected teams isn't available to import. Refresh the list and try again.",
      );
    }
    // The UI greys these out, but that's cosmetic — this is the gate.
    if (!canImportPromptowlTeam(team)) {
      throw new ForbiddenError(
        `You're view-only on "${team.name}" in PromptOwl, so you can't import it. Ask an owner or editor of that team to import it.`,
      );
    }
    selected.push(team);
  }

  const db = getDb();
  const caller = (await db.get("SELECT email FROM users WHERE id = ?", [
    params.callerUserId,
  ])) as { email?: string } | undefined;
  // The caller is authenticated, so their row exists (the anon user of open
  // mode included). Assert it rather than falling back to a blank address:
  // a blank one silently matches no PromptOwl member, which would write the
  // importer into the roster of the team they already own.
  if (!caller?.email) {
    throw new ValidationError("Could not resolve your account.");
  }

  const results: PromptowlSyncResult[] = [];
  for (const poTeam of selected) {
    results.push(await syncOne(poTeam, params.callerUserId, caller.email));
  }
  return results;
}

async function syncOne(
  poTeam: PromptowlTeam,
  callerUserId: string,
  callerEmail: string,
): Promise<PromptowlSyncResult> {
  const existing = await findTeamByExternalId({
    ownerId: callerUserId,
    source: PROMPTOWL_SOURCE,
    externalId: poTeam.id,
  });

  const team =
    existing ??
    (await createTeam({
      name: poTeam.name,
      ownerId: callerUserId,
      source: PROMPTOWL_SOURCE,
      externalId: poTeam.id,
    }));

  // Renamed upstream → follow it. Via renameTeam, not a raw UPDATE, so the
  // cached team name on every nest this team is shared to is refreshed too.
  if (existing && existing.name !== poTeam.name) {
    await renameTeam({
      teamId: team.id,
      name: poTeam.name,
      callerUserId,
      allowAdmin: false,
    });
  }

  const desired = await desiredRoster(poTeam, callerEmail);
  const before = new Map(team.members.map((m) => [m.email, m.role]));
  const after = new Map(desired.map((m) => [m.email, m.role]));

  const added = [...after.keys()].filter((e) => !before.has(e));
  const removed = [...before.keys()].filter((e) => !after.has(e));
  const updated = [...after.keys()].filter(
    (e) => before.has(e) && before.get(e) !== after.get(e),
  );

  if (added.length || removed.length || updated.length) {
    await replaceTeamRoster({
      teamId: team.id,
      members: desired,
      callerUserId,
      allowAdmin: false,
    });
  }

  return {
    team_id: team.id,
    external_id: poTeam.id,
    name: poTeam.name,
    created: !existing,
    added,
    removed,
    updated,
  };
}

/**
 * The local roster this PO team should have: every PO member resolved to a real
 * or placeholder account, at their mapped role.
 *
 * The importer themself is skipped — they're the team's owner here, which
 * already outranks any member role, and a team's owner is not carried in the
 * roster locally.
 */
async function desiredRoster(
  poTeam: PromptowlTeam,
  callerEmail: string,
): Promise<TeamMember[]> {
  const caller = normalizeEmail(callerEmail);
  const roster: TeamMember[] = [];
  const seen = new Set<string>();

  for (const poMember of poTeam.members || []) {
    if (!poMember?.email) continue;
    const email = normalizeEmail(poMember.email);
    // PO allows one address once per team, but a duplicate here would write a
    // roster the rest of the code assumes is unique per user.
    if (email === caller || seen.has(email)) continue;
    seen.add(email);

    const identity = await resolveMemberIdentity({ email });
    roster.push({
      userId: identity.userId,
      email: identity.email,
      role: mapPromptowlRole(poMember.role),
    });
  }
  return roster;
}
