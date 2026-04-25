import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import type { AuthEnv } from "../auth/middleware.js";
import { ValidationError } from "../shared/errors.js";
import type { NestCollaborator, NestCollaboratorPermission } from "../shared/types.js";

export const sharingRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/collaborators
sharingRoutes.get("/collaborators", async (c) => {
  const db = getDb();
  const collabs = db
    .prepare(
      `SELECT nc.*, u.email FROM nest_collaborators nc
       LEFT JOIN users u ON nc.user_id = u.id
       WHERE nc.nest_id = ?
       ORDER BY nc.granted_at`,
    )
    .all(c.req.param("nestId")!) as Array<NestCollaborator & { email?: string }>;
  return c.json({ collaborators: collabs });
});

// POST /nests/:nestId/collaborators — share by email
sharingRoutes.post("/collaborators", async (c) => {
  const body = await c.req.json<{
    user_id?: string;
    email?: string;
    permission?: string;
  }>();

  if (!body.permission || !["read", "write", "admin"].includes(body.permission)) {
    throw new ValidationError("permission must be read, write, or admin");
  }

  const db = getDb();
  let userId = body.user_id;

  // Allow sharing by email — look up or create placeholder user
  if (!userId && body.email) {
    let user = db.prepare("SELECT id FROM users WHERE email = ?").get(body.email) as
      | { id: string }
      | undefined;

    if (!user) {
      // Create a placeholder user (they'll claim the account via PromptOwl login)
      const { hashPassword } = await import("../auth/keys.js");
      userId = uuid();
      db.prepare(
        "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
      ).run(userId, body.email, null, await hashPassword(uuid()));
    } else {
      userId = user.id;
    }
  }

  if (!userId) {
    throw new ValidationError("user_id or email is required");
  }

  const collabId = uuid();
  db.prepare(
    "INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, ?, ?)",
  ).run(
    collabId,
    c.req.param("nestId")!,
    userId,
    body.permission,
    c.get("userId"),
  );

  const collab = db
    .prepare("SELECT * FROM nest_collaborators WHERE id = ?")
    .get(collabId) as NestCollaborator;
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
  db.prepare("UPDATE nests SET visibility = ? WHERE id = ?").run(
    body.visibility,
    c.req.param("nestId")!,
  );
  return c.json({ visibility: body.visibility });
});
