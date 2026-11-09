/**
 * Team CRUD + membership — a global (not nest-scoped) router mounted at
 * `/teams`. Teams are owner-managed: the service enforces ownership, and the
 * route resolves whether the caller is a server admin (license admin) so an
 * admin can manage any team. Auth is the shared flexAuthMiddleware (open or
 * key mode), applied at registration in app.ts.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import {
  buildPromptowlTokenCookie,
  getPromptowlTokenFromRequest,
  isSecureRequest,
} from "../auth/sessions.js";
// NOTE: /teams/promptowl must be registered before /teams/:teamId below.
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";
import { config } from "../config.js";
import { tryConsume } from "../shared/rate-limit.js";
import { clientIp } from "../shared/request-ip.js";
import {
  fetchOwnedPromptowlTeams,
  syncPromptowlTeams,
} from "./promptowl-teams.js";
import {
  createTeam,
  listVisibleTeams,
  teamsAreServerWide,
  getTeam,
  renameTeam,
  deleteTeam,
  addMember,
  updateMemberRole,
  removeMember,
} from "./teams-service.js";

export const teamRoutes = new Hono<AuthEnv>();

// Each attempt spends a PromptOwl round-trip on someone else's infrastructure,
// so it's capped per IP the same way the device-auth routes are.
const PROMPTOWL_LIMIT = { max: 10, windowMs: 15 * 60_000 };

// ─── PromptOwl team import ──────────────────────────────────────────────
//
// Registered before the /:teamId routes so "promptowl" can never be read as a
// team id.
//
// IMPORTING REQUIRES SIGNING IN WITH PROMPTOWL. The token comes from the
// httpOnly cookie set at PromptOwl sign-in (see PROMPTOWL_TOKEN_COOKIE) and
// from nowhere else — a caller cannot supply one in the request. Users who
// signed in another way (SSO, OIDC, password) simply have no PromptOwl identity
// here, and the UI hides the feature for them; this is the server-side half of
// that rule, so hiding the tab isn't the only thing enforcing it.
//
// Nothing PromptOwl is stored server-side.

/** Machine-readable marker: sign in with PromptOwl to use these routes. */
const CONNECT_REQUIRED = "promptowl_connect_required";

/**
 * 428 Precondition Required, NOT 401. The caller IS authenticated here — what's
 * missing is a PromptOwl connection. A 401 would be read by the SPA's fetch
 * wrapper as "your session died" and bounce the user to the login screen, which
 * is both wrong and hostile: needing to approve PromptOwl must never look like
 * being logged out of this server.
 */
const CONNECT_REQUIRED_STATUS = 428;

/**
 * Run a PromptOwl-backed handler, resolving the caller's token first.
 *
 * Errors are handled here rather than thrown to the global handler because the
 * revoked-token path needs to clear a cookie on the way out, and a response
 * built by the error handler wouldn't carry it. A 401 from PromptOwl means the
 * user revoked the token (or it's stale), so the cookie is dropped: without
 * that, every later attempt would replay a token PromptOwl already rejected.
 */
async function withPromptowlToken<T>(
  c: Context,
  run: (token: string) => Promise<T>,
) {
  // Feature gate: when PromptOwl team import is disabled, the surface doesn't
  // exist — 404 so the UI and API agree (the panel is hidden the same way).
  if (!config.PROMPTOWL_TEAMS_ENABLED) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!tryConsume(`po-teams:ip:${clientIp(c)}`, PROMPTOWL_LIMIT)) {
    return c.json({ error: "Too many PromptOwl requests, try again later" }, 429);
  }
  const token = getPromptowlTokenFromRequest(c);
  if (!token) {
    return c.json(
      {
        error: "Sign in with PromptOwl to import teams.",
        code: CONNECT_REQUIRED,
      },
      CONNECT_REQUIRED_STATUS,
    );
  }
  try {
    return c.json((await run(token)) as any);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      c.header(
        "Set-Cookie",
        buildPromptowlTokenCookie("", { secure: isSecureRequest(c), clear: true }),
        { append: true },
      );
      return c.json(
        { error: err.message, code: CONNECT_REQUIRED },
        CONNECT_REQUIRED_STATUS,
      );
    }
    throw err;
  }
}

// GET /teams/promptowl — the caller's owned PromptOwl teams. Read-only, and a
// GET because it reads: nothing about listing them changes state here.
teamRoutes.get("/promptowl", async (c) =>
  withPromptowlToken(c, async (token) => ({
    teams: await fetchOwnedPromptowlTeams(token),
  })),
);

// POST /teams/promptowl/sync — import the selected PromptOwl teams.
teamRoutes.post("/promptowl/sync", async (c) => {
  const body = await c.req
    .json<{ team_ids?: string[] }>()
    .catch(() => ({}) as { team_ids?: string[] });
  return withPromptowlToken(c, async (token) => ({
    results: await syncPromptowlTeams({
      callerUserId: c.get("userId"),
      token,
      teamIds: body.team_ids ?? [],
    }),
  }));
});

// POST /teams — create a team owned by the caller
teamRoutes.post("/", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const team = await createTeam({
    name: body.name ?? "",
    ownerId: c.get("userId"),
  });
  return c.json({ team }, 201);
});

// GET /teams — the teams the caller can see: owned or member on a shared
// deployment, every team on a single-organization server (listVisibleTeams).
teamRoutes.get("/", async (c) => {
  const teams = await listVisibleTeams(c.get("userId"));
  return c.json({ teams });
});

// GET /teams/:teamId — owner, a member, or a server admin may view; on a
// single-organization server, any signed-in user (every team is listed there).
teamRoutes.get("/:teamId", async (c) => {
  const userId = c.get("userId");
  const team = await getTeam(c.req.param("teamId")!);
  const isMember = team.members.some((m) => m.userId === userId);
  if (
    !teamsAreServerWide() &&
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
