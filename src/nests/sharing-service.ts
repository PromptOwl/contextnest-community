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
import { ValidationError, ConflictError, ForbiddenError } from "../shared/errors.js";
import { normalizeEmail } from "../shared/email.js";
import { permissionLevel, type NestPermission } from "../shared/access.js";
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
    const email = normalizeEmail(params.email);
    const existing = db
      .prepare("SELECT id FROM users WHERE LOWER(email) = ?")
      .get(email) as { id: string } | undefined;
    if (existing) {
      userId = existing.id;
    } else {
      const { hashPassword } = await import("../auth/keys.js");
      userId = uuid();
      db.prepare(
        "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
      ).run(userId, email, null, await hashPassword(uuid()));
    }
  }
  if (!userId) {
    throw new ValidationError("user_id or email is required");
  }

  // The nest owner already has full access — never add them as a collaborator
  // (a redundant grant whose role would just shadow ownership). And whoever is
  // granting access can't add themselves. Both keep the roster to delegated users.
  const ownerRow = db
    .prepare("SELECT user_id FROM nests WHERE id = ?")
    .get(nestId) as { user_id: string } | undefined;
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
  const dupe = db
    .prepare("SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?")
    .get(nestId, userId) as { id: string } | undefined;
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
          db
            .prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)")
            .get(params.grantedByEmail) as { id: string } | undefined
        )?.id
      : undefined;
  const granterId =
    params.grantedByUserId || granterByEmail || ownerRow.user_id;

  const collabId = uuid();
  db.prepare(
    "INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, ?, ?)",
  ).run(collabId, nestId, userId, params.permission, granterId);

  return db
    .prepare("SELECT * FROM nest_collaborators WHERE id = ?")
    .get(collabId) as NestCollaborator;
}
