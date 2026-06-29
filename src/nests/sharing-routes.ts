import { Hono } from "hono";
import { getDb } from "../db/client.js";
import type { AuthEnv } from "../auth/middleware.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
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
  });
  return c.json({ collaborator: collab }, 201);
});

// PATCH /nests/:nestId/collaborators/:collabId
sharingRoutes.patch("/collaborators/:collabId", async (c) => {
  const body = await c.req.json<{ permission?: string }>();
  if (!body.permission || !["read", "write", "admin"].includes(body.permission)) {
    throw new ValidationError("permission must be read, write, or admin");
  }

  const db = getDb();
  db.prepare("UPDATE nest_collaborators SET permission = ? WHERE id = ?").run(
    body.permission,
    c.req.param("collabId")!,
  );
  return c.json({ updated: true });
});

// DELETE /nests/:nestId/collaborators/:collabId
sharingRoutes.delete("/collaborators/:collabId", async (c) => {
  const db = getDb();
  db.prepare("DELETE FROM nest_collaborators WHERE id = ?").run(
    c.req.param("collabId")!,
  );
  return c.json({ removed: true });
});

// PATCH /nests/:nestId/visibility
sharingRoutes.patch("/visibility", async (c) => {
  const body = await c.req.json<{ visibility?: string }>();
  if (!body.visibility || !["private", "public"].includes(body.visibility)) {
    throw new ValidationError("visibility must be private or public");
  }

  const db = getDb();
  const nestId = c.req.param("nestId")!;
  const result = db
    .prepare("UPDATE nests SET visibility = ? WHERE id = ?")
    .run(body.visibility, nestId);
  // A zero-row update means the nest id didn't resolve — report it instead of
  // echoing success, which previously let the UI flip to a state the DB never
  // took (the "made it private but it still shows public" symptom).
  if (result.changes === 0) {
    throw new NotFoundError("Nest not found");
  }
  // Re-read the persisted value so the client reconciles against the DB truth,
  // not the value it sent.
  const row = db
    .prepare("SELECT visibility FROM nests WHERE id = ?")
    .get(nestId) as { visibility: string };
  return c.json({ visibility: row.visibility });
});
