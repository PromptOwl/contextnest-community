import { Hono } from "hono";
import { getDb } from "../db/client.js";
import type { AuthEnv } from "../auth/middleware.js";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../shared/errors.js";
import {
  resolveUserRoles,
  getStewardRolesForUser,
} from "../governance/stewardship-service.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { addCollaborator } from "./sharing-service.js";
import { listNestPeople, withDirectory } from "./people-service.js";
import { setReaderMode } from "./service.js";
import {
  isServerAdminUserId,
  resolveNestAccess,
  permissionLevel,
} from "../shared/access.js";
import { config } from "../config.js";
import { requestBaseUrl } from "../shared/base-url.js";
import type { NestCollaborator } from "../shared/types.js";

export const sharingRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/collaborators
sharingRoutes.get("/collaborators", async (c) => {
  const db = getDb();
  const nestId = c.req.param("nestId")!;
  const collabs = (await db.all(
    `SELECT nc.*, u.email FROM nest_collaborators nc
       LEFT JOIN users u ON nc.user_id = u.id
       WHERE nc.nest_id = ?
       ORDER BY nc.granted_at`,
    [nestId],
  )) as Array<NestCollaborator & { email?: string }>;
  // Annotate with the user's steward roles + merged effective roles so the
  // UI shows the full picture (a collaborator may also be a reviewer steward).
  const enriched = [];
  for (const collab of collabs) {
    if (!collab.email) {
      enriched.push({ ...collab, stewardRoles: [], roles: [] });
      continue;
    }
    enriched.push({
      ...collab,
      stewardRoles: await getStewardRolesForUser(nestId, collab.email),
      roles: await resolveUserRoles(nestId, collab.email),
    });
  }
  // `collaborators` is the roster this nest's Collaborators tab manages —
  // nest_collaborators rows and nothing else. `people` is the wider question
  // the @mention picker asks: everyone who can reach this nest, including the
  // owner, shared-team members, stewards and grant holders, none of whom hold
  // a collaborator row. Same read, same write-tier gate, one round trip.
  return c.json({
    collaborators: enriched,
    people: await withDirectory(await listNestPeople(nestId)),
  });
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
    baseUrl: requestBaseUrl(c.req.url),
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
  const info = await db.run(
    "UPDATE nest_collaborators SET permission = ? WHERE id = ? AND nest_id = ?",
    [body.permission, c.req.param("collabId")!, c.req.param("nestId")!],
  );
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
  const info = await db.run(
    "DELETE FROM nest_collaborators WHERE id = ? AND nest_id = ?",
    [c.req.param("collabId")!, c.req.param("nestId")!],
  );
  if (info.changes === 0) {
    throw new NotFoundError("Collaborator not found");
  }
  return c.json({ removed: true });
});

// GET /nests/:nestId/mentionable — the roster the @mention pickers need.
//
// READ tier, unlike GET /collaborators (write tier, so a public nest's read
// tier can't enumerate member emails). Commenting is a read-tier action, and a
// read-only reviewer is the person most likely to tag someone — so the picker
// has to work for them. The property the write tier was protecting is kept by
// a narrower rule: you may see the roster if you are ON it. A caller who
// reaches this nest only through its visibility ('public' to anyone, 'org' to
// any signed-in user) is not on the roster and is refused.
sharingRoutes.get("/mentionable", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const people = await listNestPeople(nestId);
  const callerEmail = (await resolveCallerEmail(userId)).toLowerCase();
  const onRoster = people.some((p) => p.email.toLowerCase() === callerEmail);
  if (!onRoster) {
    // A server admin (and any write-tier caller, who can read the fuller
    // roster anyway) is not necessarily a listed person — don't lock them out
    // of their own nest's picker.
    const access = await resolveNestAccess(nestId, userId);
    if (permissionLevel(access.permission) < permissionLevel("write")) {
      throw new ForbiddenError("Only people on this nest can see its roster");
    }
  }
  // Name + email only: the picker shows a person and inserts their address.
  // `source` (owner/collaborator/team/steward/grant) stays out — how someone
  // got access is not the mention picker's business. Gate above is on the
  // roster; the directory widening applies only after it.
  return c.json({
    people: (await withDirectory(people)).map((p) => ({ email: p.email, name: p.name })),
  });
});

// PATCH /nests/:nestId/visibility
sharingRoutes.patch("/visibility", async (c) => {
  const body = await c.req.json<{
    visibility?: string;
    acknowledge_public?: boolean;
  }>();
  if (
    !body.visibility ||
    !["private", "org", "public"].includes(body.visibility)
  ) {
    throw new ValidationError("visibility must be private, org or public");
  }

  // Outside-org publish guardrail: flipping a nest to public makes it readable
  // by anyone on the internet, outside your organization. Require an explicit
  // acknowledgement so this can never happen on a stray click. Going back to
  // private needs no acknowledgement — and neither does 'org', which stays
  // inside the deployment and so crosses no organizational boundary.
  if (body.visibility === "public" && body.acknowledge_public !== true) {
    return c.json(
      {
        error: "Publishing this nest requires acknowledgement.",
        requires_acknowledgement: true,
        warning:
          "This makes the nest readable by anyone on the internet, outside your organization.",
      },
      409,
    );
  }

  const db = getDb();
  const nestId = c.req.param("nestId")!;
  const result = await db.run("UPDATE nests SET visibility = ? WHERE id = ?", [
    body.visibility,
    nestId,
  ]);
  // A zero-row update means the nest id didn't resolve — report it instead of
  // echoing success, which previously let the UI flip to a state the DB never
  // took (the "made it private but it still shows public" symptom).
  if (result.changes === 0) {
    throw new NotFoundError("Nest not found");
  }
  // Re-read the persisted value so the client reconciles against the DB truth,
  // not the value it sent.
  const row = (await db.get("SELECT visibility FROM nests WHERE id = ?", [
    nestId,
  ])) as { visibility: string };
  return c.json({ visibility: row.visibility });
});

// PATCH /nests/:nestId/reader-mode — configure Public Docs Reader Mode.
//
// The server admin can configure reader mode on ANY nest (same gate as
// /nests/unsynced and /admin/*), and — same rule as the steward roster above
// — so can the nest's own owner/admin: the access middleware already
// requires the "admin" tier for this resource, so this just stops short of
// widening past what that tier already grants instead of hard-gating past it
// to superadmin-only.
sharingRoutes.patch("/reader-mode", async (c) => {
  const userId = c.get("userId");
  const nestId = c.req.param("nestId")!;
  if (config.AUTH_MODE !== "open" && !(await isServerAdminUserId(userId))) {
    const access = await resolveNestAccess(nestId, userId);
    if (permissionLevel(access.permission) < permissionLevel("admin")) {
      throw new ForbiddenError(
        "Only the nest owner, a nest admin, or the server admin can configure reader mode",
      );
    }
  }

  const body = await c.req.json<{
    enabled?: boolean;
    home_node?: string | null;
  }>();

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new ValidationError("enabled must be a boolean");
  }

  // home_node is a soft pointer to the landing/hub node; null (or an empty /
  // whitespace string) clears it so resolution falls back to convention. Any
  // other non-string is rejected rather than silently coerced.
  let homeNode: string | null | undefined;
  if (body.home_node !== undefined) {
    if (body.home_node === null) {
      homeNode = null;
    } else if (typeof body.home_node === "string") {
      const trimmed = body.home_node.trim();
      homeNode = trimmed === "" ? null : trimmed;
    } else {
      throw new ValidationError("home_node must be a string or null");
    }
  }

  if (body.enabled === undefined && homeNode === undefined) {
    throw new ValidationError(
      "provide enabled and/or home_node to update",
    );
  }

  const db = getDb();
  const exists = (await db.get("SELECT id FROM nests WHERE id = ?", [
    nestId,
  ])) as { id: string } | undefined;
  if (!exists) {
    throw new NotFoundError("Nest not found");
  }

  await setReaderMode(nestId, { enabled: body.enabled, homeNode });

  const saved = (await db.get(
    "SELECT reader_mode, reader_home_node FROM nests WHERE id = ?",
    [nestId],
  )) as { reader_mode: number; reader_home_node: string | null };
  return c.json({
    reader_mode: saved.reader_mode,
    reader_home_node: saved.reader_home_node,
  });
});
