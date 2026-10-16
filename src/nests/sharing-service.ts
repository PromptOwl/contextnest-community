/**
 * Sharing service — collaborator management shared by the REST route
 * (sharing-routes.ts) and the MCP tool, so the add logic (placeholder-user
 * creation, duplicate guard, granter resolution) lives in one place.
 *
 * Permission gating lives at the call sites: the REST middleware requires
 * nest 'write' to invite (escalation-capped here); the MCP tool checks the
 * caller's effective roles.
 */
import { isSystemUser } from "../auth/systems.js";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { notifyNestEvent } from "../notify/notify.js";
import { sendEmailToRecipient } from "../notify/email.js";
import { findOrCreateInvitedUser } from "../auth/invited-user.js";
import { notifyNestInvite } from "../governance/notify-service.js";
import { nestName, docLink } from "../governance/title-resolver.js";
import { ValidationError, ConflictError, ForbiddenError } from "../shared/errors.js";
import { isEmailish } from "../config.js";
import { permissionLevel, type NestPermission } from "../shared/access.js";
import type { NestCollaborator } from "../shared/types.js";
import { assertCanGrant, permissionClass } from "../auth/seats.js";

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

  // Plan limit, also before any placeholder user exists.
  const existing =
    params.userId ??
    ((params.email
      ? await db.get("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", [params.email])
      : undefined) as { id: string } | undefined)?.id;
  await assertCanGrant([{ userId: existing, next: permissionClass(params.permission) }]);

  // Resolve the target user, creating a placeholder for an unregistered email
  // (they claim it by registering with the same address — see auth claim flow).
  let userId = params.userId;
  if (!userId && params.email) {
    // Reject a malformed address BEFORE it becomes a placeholder user — the
    // client validates too, but a direct API call must not slip junk in.
    if (!isEmailish(params.email)) {
      throw new ValidationError("Enter a valid email address.");
    }
    // A new address gets an account + the sign-in email (temp password).
    userId = (
      await findOrCreateInvitedUser(params.email, {
        invitedBy: params.grantedByEmail,
        baseUrl: params.baseUrl,
      })
    ).id;
  }
  if (!userId) {
    throw new ValidationError("user_id or email is required");
  }
  // Systems join nests only through /systems (CU-wdqcq0538g), which checks the
  // granting admin manages the system. A plain invite would let anyone who
  // learns a system's identity adopt it.
  if (await isSystemUser(userId)) {
    throw new ValidationError(
      "That is a system, not a person. Add it to this nest from its system settings (POST /systems/:id/nests).",
    );
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
  const invitee = (await db.get(
    "SELECT email, is_invited FROM users WHERE id = ?",
    [userId],
  )) as { email?: string; is_invited?: number } | undefined;
  const inviteeEmail = params.email || invitee?.email;
  if (inviteeEmail) {
    // Never signed in yet → ?invite= so the login page prefills and guides them.
    const nestLink = docLink(nestId, undefined, params.baseUrl);
    void sendEmailToRecipient(inviteeEmail, {
      status: "shared",
      docTitle: shareNestName,
      path: shareNestName,
      link:
        nestLink && invitee?.is_invited === 1
          ? `${nestLink}&invite=${encodeURIComponent(inviteeEmail)}`
          : nestLink,
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
