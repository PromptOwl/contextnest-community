/**
 * Nest team-share routes — mounted at `/nests/:nestId/teams`. A "share" is a
 * {teamId, teamName} ref appended to `nests.shared_teams` (no join table); the
 * member roles that grant access live on the team, not the share. The nest
 * access middleware (app.ts) gates these: listing needs 'write' (member emails
 * are exposed, same as the collaborator roster), share/unshare need 'admin'.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { ValidationError } from "../shared/errors.js";
import { requestBaseUrl } from "../shared/base-url.js";
import {
  listNestTeams,
  shareTeamWithNest,
  unshareTeamFromNest,
  getTeam,
} from "../governance/teams-service.js";

export const nestTeamRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/teams — shared teams, enriched with their members so the
// roster UI can show who each share brings in and at what role.
nestTeamRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const refs = await listNestTeams(nestId);
  const teams = [];
  for (const ref of refs) {
    const team = await getTeam(ref.teamId).catch(() => null);
    teams.push({
      teamId: ref.teamId,
      teamName: team?.name ?? ref.teamName,
      members: team?.members ?? [],
    });
  }
  return c.json({ teams });
});

// POST /nests/:nestId/teams — share a team onto the nest
nestTeamRoutes.post("/", async (c) => {
  const body = await c.req.json<{ team_id?: string }>();
  if (!body.team_id) {
    throw new ValidationError("team_id is required");
  }
  const userId = c.get("userId");
  // A sealed personal nest can't be shared with a team (re-review R3-L1): a
  // license admin can edit any team's roster, which would reopen it to them.
  const { sealedNest } = await import("../surfaces/sealed.js");
  if (await sealedNest(c.req.param("nestId")!)) {
    return c.json({ error: "Private nests can't be shared with a team" }, 403);
  }
  const teams = await shareTeamWithNest({
    nestId: c.req.param("nestId")!,
    teamId: body.team_id,
    callerUserId: userId,
    allowAdmin: await isLicenseAdminUserId(userId),
    baseUrl: requestBaseUrl(c.req.url),
  });
  return c.json({ teams }, 201);
});

// DELETE /nests/:nestId/teams/:teamId — unshare a team
nestTeamRoutes.delete("/:teamId", async (c) => {
  const teams = await unshareTeamFromNest({
    nestId: c.req.param("nestId")!,
    teamId: c.req.param("teamId")!,
  });
  return c.json({ teams });
});
