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
import { canManageStewards } from "../governance/stewardship-service.js";
import {
  createGrant,
  listGrants,
  deleteGrant,
  type GrantRole,
  type GrantTargetType,
} from "../governance/grants-service.js";

export const grantRoutes = new Hono<AuthEnv>();

async function requireManage(c: any, nestId: string): Promise<void> {
  if (!(await canManageStewards(nestId, c.get("userId")))) {
    throw new ForbiddenError(
      "Only a nest admin, the nest owner, or the server admin can manage sharing.",
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
  const userId = await resolveGrantee(body.email);
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
  await requireManage(c, nestId);
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
