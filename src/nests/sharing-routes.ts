import { Hono } from "hono";
import { getDb } from "../db/client.js";
import type { AuthEnv } from "../auth/middleware.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import {
  resolveUserRoles,
  getStewardRolesForUser,
} from "../governance/stewardship-service.js";
import { addCollaborator } from "./sharing-service.js";
import type { NestCollaborator } from "../shared/types.js";

export const sharingRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/collaborators
sharingRoutes.get("/collaborators", async (c) => {
  const db = getDb();
  const nestId = c.req.param("nestId")!;
  const collabs = db
    .prepare(
      `SELECT nc.*, u.email FROM nest_collaborators nc
       LEFT JOIN users u ON nc.user_id = u.id
       WHERE nc.nest_id = ?
       ORDER BY nc.granted_at`,
    )
    .all(nestId) as Array<NestCollaborator & { email?: string }>;
  // Annotate with the user's steward roles + merged effective roles so the
  // UI shows the full picture (a collaborator may also be a reviewer steward).
  const enriched = collabs.map((collab) => {
    if (!collab.email) return { ...collab, stewardRoles: [], roles: [] };
    return {
      ...collab,
      stewardRoles: getStewardRolesForUser(nestId, collab.email),
      roles: resolveUserRoles(nestId, collab.email),
    };
  });
  return c.json({ collaborators: enriched });
});

// POST /nests/:nestId/collaborators — share by email
sharingRoutes.post("/collaborators", async (c) => {
  const body = await c.req.json<{
    user_id?: string;
    email?: string;
    permission?: string;
  }>();

  const collab = await addCollaborator({
    nestId: c.req.param("nestId")!,
    email: body.email,
    userId: body.user_id,
    permission: body.permission ?? "",
    grantedByUserId: c.get("userId"),
    // Enforce the escalation cap against the caller's own nest permission
    // (set by the access guard) — a write collaborator can't grant admin.
    callerPermission: c.get("nestPermission"),
  });
  return c.json({ collaborator: collab }, 201);
});

// PATCH /nests/:nestId/collaborators/:collabId — admin-only (access guard).
// Changing an existing collaborator's level stays an admin-tier action.
sharingRoutes.patch("/collaborators/:collabId", async (c) => {
  const body = await c.req.json<{ permission?: string }>();
  if (!body.permission || !["read", "write", "admin"].includes(body.permission)) {
    throw new ValidationError("permission must be read, write, or admin");
  }

  const db = getDb();
  // Scope to the nest in the URL — the guard authorised the caller against
  // THIS nest, so the row we touch must belong to it (a bare `id =` match
  // would let an admin of nest A mutate a collaborator row from nest B).
  const info = db.prepare(
    "UPDATE nest_collaborators SET permission = ? WHERE id = ? AND nest_id = ?",
  ).run(body.permission, c.req.param("collabId")!, c.req.param("nestId")!);
  // No row matched → the collabId is unknown or belongs to another nest. Don't
  // claim success for a no-op.
  if (info.changes === 0) {
    throw new NotFoundError("Collaborator not found");
  }
  return c.json({ updated: true });
});

// DELETE /nests/:nestId/collaborators/:collabId — admin-only (access guard).
// Removing a collaborator stays an admin-tier action.
sharingRoutes.delete("/collaborators/:collabId", async (c) => {
  const db = getDb();
  // Scope to the nest in the URL (see PATCH above) — never delete a row that
  // belongs to a different nest just because the UUID matches.
  const info = db.prepare(
    "DELETE FROM nest_collaborators WHERE id = ? AND nest_id = ?",
  ).run(c.req.param("collabId")!, c.req.param("nestId")!);
  if (info.changes === 0) {
    throw new NotFoundError("Collaborator not found");
  }
  return c.json({ removed: true });
});

// PATCH /nests/:nestId/visibility
sharingRoutes.patch("/visibility", async (c) => {
  const body = await c.req.json<{ visibility?: string }>();
  if (!body.visibility || !["private", "public"].includes(body.visibility)) {
    throw new ValidationError("visibility must be private or public");
  }

  const db = getDb();
  db.prepare("UPDATE nests SET visibility = ? WHERE id = ?").run(
    body.visibility,
    c.req.param("nestId")!,
  );
  return c.json({ visibility: body.visibility });
});
