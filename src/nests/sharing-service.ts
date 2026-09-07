/**
 * Sharing service — collaborator management shared by the REST route
 * (sharing-routes.ts) and the MCP tool, so the add logic (placeholder-user
 * creation, duplicate guard, granter resolution) lives in one place.
 *
 * Permission gating lives at the call sites: the REST middleware requires
 * nest 'write' to invite (escalation-capped here); the MCP tool checks the
 * caller's effective roles.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { notifyNestEvent } from "../notify/notify.js";
import { sendEmailToRecipient } from "../notify/email.js";
import { notifyNestInvite } from "../governance/notify-service.js";
import { nestName, docLink } from "../governance/title-resolver.js";
import { ValidationError, ConflictError, ForbiddenError } from "../shared/errors.js";
import { normalizeEmail } from "../shared/email.js";
import { isEmailish } from "../config.js";
import { permissionLevel, type NestPermission } from "../shared/access.js";
import {
  parseSharedTeams,
  listSharedTeamMembers,
} from "../governance/teams-service.js";
import type { NestCollaborator } from "../shared/types.js";

const VALID_PERMISSIONS = ["read", "write", "admin"] as const;

export async function addCollaborator(params: {
  nestId: string;
  email?: string;
  userId?: string;
  permission: string;
  /** Caller's user id for the granted_by FK; falls back to the nest owner. */
  grantedByUserId?: string | null;
  /** Caller's email — resolved to a user id when grantedByUserId is absent. */
  grantedByEmail?: string | null;
  /**
   * Caller's effective permission on this nest. When provided, enforces the
   * escalation cap: you can't grant access above your own level (a write
   * collaborator can invite read/write, but only an admin/owner grants admin).
   * Omitted by callers that gate admin themselves (e.g. the MCP tool).
   */
  callerPermission?: NestPermission;
  /** Request origin, for building the notification's nest link. */
  baseUrl?: string;
}): Promise<NestCollaborator> {
  const { nestId } = params;
  if (
    !params.permission ||
    !VALID_PERMISSIONS.includes(params.permission as any)
  ) {
    throw new ValidationError("permission must be read, write, or admin");
  }

  // Escalation cap — no granting above your own level. Checked before any
  // placeholder user is created, so a forbidden invite leaves no side effects.
  if (
    params.callerPermission &&
    permissionLevel(params.permission as NestPermission) >
      permissionLevel(params.callerPermission)
  ) {
    throw new ForbiddenError(
      `You can only grant access up to your own level ('${params.callerPermission}'). Ask a nest admin to grant '${params.permission}'.`,
    );
  }

  const db = getDb();

  // Resolve the target user, creating a placeholder for an unregistered email
  // (they claim it by registering with the same address — see auth claim flow).
  let userId = params.userId;
  if (!userId && params.email) {
    // Reject a malformed address BEFORE it becomes a placeholder user — the
    // client validates too, but a direct API call must not slip junk in.
    if (!isEmailish(params.email)) {
      throw new ValidationError("Enter a valid email address.");
    }
    const email = normalizeEmail(params.email);
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

  // The nest owner already has full access — never add them as a collaborator
  // (a redundant grant whose role would just shadow ownership). And whoever is
  // granting access can't add themselves. Both keep the roster to delegated users.
  const ownerRow = (await db.get(
    "SELECT user_id FROM nests WHERE id = ?",
    [nestId],
  )) as { user_id: string } | undefined;
  if (!ownerRow) {
    throw new ValidationError("Nest not found");
  }
  if (ownerRow.user_id === userId) {
    throw new ValidationError(
      "The nest owner already has full access and can't be added as a collaborator.",
    );
  }
  const selfByEmail =
    !!params.email &&
    !!params.grantedByEmail &&
    params.email.trim().toLowerCase() === params.grantedByEmail.trim().toLowerCase();
  const selfById = !!params.grantedByUserId && params.grantedByUserId === userId;
  if (selfByEmail || selfById) {
    throw new ValidationError("You can't add yourself as a collaborator.");
  }

  // One row per (nest, user) — block duplicates. To change someone's level,
  // update their permission instead of adding a second row.
  const dupe = (await db.get(
    "SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
    [nestId, userId],
  )) as { id: string } | undefined;
  if (dupe) {
    throw new ConflictError(
      `${params.email || "This user"} already has access to this nest. Change their permission instead of adding them again.`,
    );
  }

  // granted_by is NOT NULL → resolve the granter from id, then email, then
  // fall back to the nest owner (e.g. open-mode "admin@localhost" has no row).
  const granterByEmail =
    !params.grantedByUserId && params.grantedByEmail
      ? (
          (await db.get(
            "SELECT id FROM users WHERE LOWER(email) = LOWER(?)",
            [params.grantedByEmail],
          )) as { id: string } | undefined
        )?.id
      : undefined;
  const granterId =
    params.grantedByUserId || granterByEmail || ownerRow.user_id;

  const collabId = uuid();
  await db.run(
    "INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, ?, ?)",
    [collabId, nestId, userId, params.permission, granterId],
  );

  const shareNestName = await nestName(nestId);
  void notifyNestEvent(
    nestId,
    `:key: ${params.email || userId} added as *${params.permission}*${params.grantedByEmail ? ` by ${params.grantedByEmail}` : ""}`,
    {
      status: "shared",
      docTitle: shareNestName,
      path: shareNestName,
      link: docLink(nestId, undefined, params.baseUrl),
      actor: params.email || userId,
      permission: params.permission,
      by: params.grantedByEmail || undefined,
    },
    // Invite email goes to the invitee directly (below), NOT the shared
    // NOTIFY_EMAIL_TO team inbox — so skip the team-channel email for this
    // event. Slack/Teams still fire.
    { skipEmail: true },
  );

  // Direct-to-invitee surfaces, independent of the team-channel notifyNestEvent
  // above: a rich email at the invitee's OWN address + a Hootie inbox row, so
  // the person added actually hears about it (not just a shared team inbox).
  // Both best-effort — a delivery failure must never fail the invite.
  const inviteeEmail =
    params.email ||
    (
      (await db.get("SELECT email FROM users WHERE id = ?", [userId])) as
        | { email?: string }
        | undefined
    )?.email;
  if (inviteeEmail) {
    void sendEmailToRecipient(inviteeEmail, {
      status: "shared",
      docTitle: shareNestName,
      path: shareNestName,
      link: docLink(nestId, undefined, params.baseUrl),
      actor: inviteeEmail,
      permission: params.permission,
      by: params.grantedByEmail || undefined,
    });
    void notifyNestInvite({
      nestId,
      inviteeEmail,
      permission: params.permission,
      nestName: shareNestName,
    });
  }

  return (await db.get(
    "SELECT * FROM nest_collaborators WHERE id = ?",
    [collabId],
  )) as NestCollaborator;
}

/** Someone who can reach a nest, and the path that lets them. */
export interface NestPerson {
  email: string;
  name: string | null;
  /** Highest-precedence path this person has in: owner beats grant. */
  source: "owner" | "collaborator" | "team" | "steward" | "grant";
}

// Precedence, lowest wins. Also the rank column of the union query below —
// ordering the query IS the precedence rule, so the dedupe just keeps firsts.
const PERSON_SOURCES: NestPerson["source"][] = [
  "owner", // 0
  "collaborator", // 1
  "team", // 2 — not in the union; team rosters are JSON on the team row
  "steward", // 3
  "grant", // 4
];

/**
 * Everyone who can reach a nest — the union of the five access paths
 * `resolveNestAccess` honours. The collaborator roster alone answers only one
 * of them, so the @mention picker (and anything else asking "who is on this
 * nest") would silently miss the owner, a shared team, a steward and a grant
 * holder. Deduped by email, highest-precedence source kept.
 *
 * Four of the five paths are ordinary tables, so they resolve in ONE union
 * query rather than a query apiece. Shared teams can't join in — a team's
 * roster is a JSON array on the team row, and the JSON operators differ
 * between SQLite and Postgres — so they cost the nest read (which runs
 * alongside the union) plus one lookup, and only when teams are actually
 * shared onto the nest.
 */
export async function listNestPeople(nestId: string): Promise<NestPerson[]> {
  const db = getDb();
  const [nest, rows] = await Promise.all([
    db.get("SELECT shared_teams FROM nests WHERE id = ?", [nestId]) as Promise<
      { shared_teams: string | null } | undefined
    >,
    db.all(
      `SELECT 0 AS rank, u.email AS email, u.name AS name
         FROM nests n JOIN users u ON u.id = n.user_id
        WHERE n.id = ?
       UNION ALL
       SELECT 1, u.email, u.name
         FROM nest_collaborators nc JOIN users u ON u.id = nc.user_id
        WHERE nc.nest_id = ?
       UNION ALL
       SELECT 3, s.user_email, u.name
         FROM stewards s
         LEFT JOIN users u ON LOWER(u.email) = LOWER(s.user_email)
        WHERE s.nest_id = ? AND s.is_active = 1
       UNION ALL
       SELECT 4, u.email, u.name
         FROM grants g JOIN users u ON u.id = g.user_id
        WHERE g.nest_id = ?
       ORDER BY rank`,
      [nestId, nestId, nestId, nestId],
    ) as Promise<Array<{ rank: number; email: string; name: string | null }>>,
  ]);
  if (!nest) return [];

  const teamRefs = parseSharedTeams(nest.shared_teams);
  const teamRows = teamRefs.length
    ? (await listSharedTeamMembers(teamRefs)).map((m) => ({ ...m, rank: 2 }))
    : [];

  const people: NestPerson[] = [];
  const seen = new Set<string>();
  // Stable sort by rank so a person on several paths keeps their strongest.
  for (const row of [...rows, ...teamRows].sort((a, b) => a.rank - b.rank)) {
    const email = (row.email || "").trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    people.push({
      email,
      name: row.name ?? null,
      source: PERSON_SOURCES[row.rank],
    });
  }
  return people;
}
