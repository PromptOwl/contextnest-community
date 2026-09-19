/**
 * Share grants API — grant a person read/write on a single document or a
 * folder. Managing grants is owner/admin (same authority as the steward
 * roster, via canManageStewards). The access effect is wired in the nest
 * middleware + listNodesForCaller (see grants-service.ts).
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { ValidationError, ForbiddenError, NotFoundError } from "../shared/errors.js";
import { normalizeEmail } from "../shared/email.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import {
  resolveStewardsForNode,
} from "../governance/stewardship-service.js";
import { resolveTeamRolesForUser } from "../governance/teams-service.js";
import { resolveNestAccess } from "../shared/access.js";
import { config } from "../config.js";
import {
  canEditWith,
  collabPermToRole,
  primaryRole,
  type EffectiveRole,
} from "../governance/roles.js";
import {
  createGrant,
  listGrants,
  deleteGrant,
  resolveNodeGrant,
  type GrantRole,
  type GrantTargetType,
} from "../governance/grants-service.js";

export const grantRoutes = new Hono<AuthEnv>();

/**
 * Owner / nest admin / server admin may manage sharing. Archiving caps every
 * caller at 'read', which would lock the owner out of even SEEING who a
 * document is shared with — so the roster (readOnly) gates on the standing
 * the caller would have if the nest were live, and only changes are refused,
 * with the archive named as the reason.
 */
async function requireManage(
  c: any,
  nestId: string,
  opts: { readOnly?: boolean } = {},
): Promise<void> {
  if (config.AUTH_MODE === "open") return;
  const access = await resolveNestAccess(nestId, c.get("userId"));
  if (access.rawPermission !== "owner" && access.rawPermission !== "admin") {
    throw new ForbiddenError(
      "Only a nest admin, the nest owner, or the server admin can manage sharing.",
    );
  }
  if (access.archived && !opts.readOnly) {
    throw new ForbiddenError(
      "This nest is archived, so it is read-only. Restore it to change sharing.",
    );
  }
}

/** Resolve an email to a user id, minting a placeholder invited user for an
 *  unknown address (they claim it by registering — same as collaborator
 *  invites). */
async function resolveGrantee(email: string): Promise<string> {
  const db = getDb();
  const e = normalizeEmail(email);
  const existing = (await db.get("SELECT id FROM users WHERE LOWER(email) = ?", [e])) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const { hashPassword } = await import("../auth/keys.js");
  const id = uuid();
  await db.run(
    "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
    [id, e, null, await hashPassword(uuid())],
  );
  return id;
}

/**
 * Refuse a share that would grant nothing. The recipient may already reach the
 * target as the nest owner, a collaborator, a member of a team the nest is
 * shared with, a steward assigned to it, or through a grant that already
 * covers it — re-sharing then reads as a silent no-op.
 *
 * Scope matters: for a document, steward rows are resolved AGAINST THAT
 * DOCUMENT (resolveUserRoles with nodeId), so a steward of some other document
 * is not treated as already having access. A folder target has no document to
 * resolve stewards against, so only the nest-wide roles (owner, collaborator,
 * team) count there.
 *
 * Level matters too: viewer-tier access blocks a `read` share but not a
 * `write` one.
 */
async function assertGrantAddsAccess(params: {
  nestId: string;
  email: string;
  userId: string | null;
  targetType: GrantTargetType;
  target: string;
  role: GrantRole;
}): Promise<void> {
  const { nestId, email, userId, targetType, target, role } = params;
  const roles: EffectiveRole[] = [];
  if (userId) {
    const access = await resolveNestAccess(nestId, userId);
    // Only real membership counts. resolveNestAccess also folds in the
    // nest-shell read a steward or a public nest confers, and neither means
    // this document is already reachable — a steward of some OTHER document
    // sees the nest, not this node, and a public reader sees approved
    // versions only, never the drafts a grant opens up.
    if (access.ownerId === userId) roles.push("owner");
    const collab = collabPermToRole(access.collaboratorPermission);
    if (collab) roles.push(collab);
    for (const teamRole of await resolveTeamRolesForUser(nestId, userId)) {
      roles.push(teamRole as EffectiveRole);
    }
  }
  // Steward rows are matched by email (they can be assigned before the person
  // registers) and only when they cover THIS document. A folder has no node to
  // resolve them against, so folder shares consider membership only.
  if (targetType === "document") {
    const stewards = await resolveStewardsForNode(nestId, target);
    for (const s of stewards) {
      if (s.steward.userEmail.toLowerCase() === email.toLowerCase()) {
        roles.push(s.steward.role as EffectiveRole);
      }
    }
  }
  const covered = role === "write" ? canEditWith(roles) : roles.length > 0;
  if (covered) {
    const held = primaryRole(roles) ?? "existing";
    throw new ValidationError(
      `${email} already has ${held} access here, so this ${targetType} is already ${role === "write" ? "editable by" : "visible to"} them.`,
    );
  }
  if (!userId) return;
  const existing = await resolveNodeGrant(nestId, userId, target);
  if (existing && (role === "read" || existing === "write")) {
    throw new ValidationError(
      `${email} has already been shared this ${targetType} (${existing === "write" ? "can edit" : "can view"}).`,
    );
  }
}

// POST /nests/:nestId/grants — share a document or folder with a person.
grantRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const body = await c.req.json<{
    target_type?: string;
    target?: string;
    email?: string;
    role?: string;
  }>();
  const targetType = body.target_type as GrantTargetType;
  const target = (body.target || "").trim();
  const role = (body.role || "read") as GrantRole;
  if (!["document", "folder"].includes(targetType)) {
    throw new ValidationError("target_type must be document | folder");
  }
  if (!target) throw new ValidationError("target is required");
  if (!body.email?.trim()) throw new ValidationError("email is required");
  if (!["read", "write"].includes(role)) {
    throw new ValidationError("role must be read | write");
  }
  // Check before minting an invited user for an unknown address, so a refused
  // share leaves no placeholder row behind.
  const email = normalizeEmail(body.email);
  const known = (await getDb().get("SELECT id FROM users WHERE LOWER(email) = ?", [
    email,
  ])) as { id: string } | undefined;
  await assertGrantAddsAccess({
    nestId,
    email,
    userId: known?.id ?? null,
    targetType,
    target,
    role,
  });
  const userId = known?.id ?? (await resolveGrantee(body.email));
  const grant = await createGrant({
    nestId,
    targetType,
    target,
    userId,
    role,
    grantedBy: await resolveCallerEmail(c.get("userId")),
  });
  return c.json({ grant }, 201);
});

// GET /nests/:nestId/grants — the sharing roster.
grantRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId, { readOnly: true });
  const grants = await listGrants(nestId);
  // Annotate with the grantee email so the UI shows who, not a uuid.
  const db = getDb();
  const withEmail = await Promise.all(
    grants.map(async (g) => {
      const u = (await db.get("SELECT email FROM users WHERE id = ?", [g.user_id])) as
        | { email: string }
        | undefined;
      return { ...g, email: u?.email ?? null };
    }),
  );
  return c.json({ count: withEmail.length, grants: withEmail });
});

// DELETE /nests/:nestId/grants/:id — unshare.
grantRoutes.delete("/:id", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const ok = await deleteGrant(nestId, c.req.param("id")!);
  if (!ok) throw new NotFoundError("Grant not found");
  return c.json({ deleted: true });
});
