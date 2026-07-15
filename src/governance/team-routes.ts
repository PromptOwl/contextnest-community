/**
 * Team CRUD + membership — a global (not nest-scoped) router mounted at
 * `/teams`. Teams are owner-managed: the service enforces ownership, and the
 * route resolves whether the caller is a server admin (license admin) so an
 * admin can manage any team. Auth is the shared flexAuthMiddleware (open or
 * key mode), applied at registration in app.ts.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { ForbiddenError } from "../shared/errors.js";
import {
  createTeam,
  listTeamsForUser,
  getTeam,
  renameTeam,
  deleteTeam,
  addMember,
  updateMemberRole,
  removeMember,
} from "./teams-service.js";

export const teamRoutes = new Hono<AuthEnv>();

// POST /teams — create a team owned by the caller
teamRoutes.post("/", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const team = await createTeam({
    name: body.name ?? "",
    ownerId: c.get("userId"),
  });
  return c.json({ team }, 201);
});

// GET /teams — teams the caller owns or is a member of
teamRoutes.get("/", async (c) => {
  const teams = await listTeamsForUser(c.get("userId"));
  return c.json({ teams });
});

// GET /teams/:teamId — owner, a member, or a server admin may view
teamRoutes.get("/:teamId", async (c) => {
  const userId = c.get("userId");
  const team = await getTeam(c.req.param("teamId")!);
  const isMember = team.members.some((m) => m.userId === userId);
  if (
    team.owner_id !== userId &&
    !isMember &&
    !(await isLicenseAdminUserId(userId))
  ) {
    throw new ForbiddenError("You don't have access to this team.");
  }
  return c.json({ team });
});

// PATCH /teams/:teamId — rename (owner/admin)
teamRoutes.patch("/:teamId", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const userId = c.get("userId");
  const team = await renameTeam({
    teamId: c.req.param("teamId")!,
    name: body.name ?? "",
    callerUserId: userId,
    allowAdmin: await isLicenseAdminUserId(userId),
  });
  return c.json({ team });
});

// DELETE /teams/:teamId — (owner/admin)
teamRoutes.delete("/:teamId", async (c) => {
  const userId = c.get("userId");
  await deleteTeam({
    teamId: c.req.param("teamId")!,
    callerUserId: userId,
    allowAdmin: await isLicenseAdminUserId(userId),
  });
  return c.json({ removed: true });
});

// POST /teams/:teamId/members — add a member with a role (owner/admin)
teamRoutes.post("/:teamId/members", async (c) => {
  const body = await c.req.json<{
    email?: string;
    user_id?: string;
    role?: string;
  }>();
  const userId = c.get("userId");
  const team = await addMember({
    teamId: c.req.param("teamId")!,
    email: body.email,
    userId: body.user_id,
    role: body.role ?? "",
    callerUserId: userId,
    allowAdmin: await isLicenseAdminUserId(userId),
  });
  return c.json({ team }, 201);
});

// PATCH /teams/:teamId/members/:userId — change a member's role (owner/admin)
teamRoutes.patch("/:teamId/members/:userId", async (c) => {
  const body = await c.req.json<{ role?: string }>();
  const userId = c.get("userId");
  const team = await updateMemberRole({
    teamId: c.req.param("teamId")!,
    userId: c.req.param("userId")!,
    role: body.role ?? "",
    callerUserId: userId,
    allowAdmin: await isLicenseAdminUserId(userId),
  });
  return c.json({ team });
});

// DELETE /teams/:teamId/members/:userId — remove a member (owner/admin)
teamRoutes.delete("/:teamId/members/:userId", async (c) => {
  const userId = c.get("userId");
  const team = await removeMember({
    teamId: c.req.param("teamId")!,
    userId: c.req.param("userId")!,
    callerUserId: userId,
    allowAdmin: await isLicenseAdminUserId(userId),
  });
  return c.json({ team });
});
