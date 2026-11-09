/**
 * First-run onboarding REST (PO-1185). Mounted at /onboarding behind
 * flexAuthMiddleware. Every route acts on the caller only; nest routes check
 * the caller's access to that nest. The MCP twins are in
 * src/mcp/onboarding-tools.ts and call the same service functions.
 *
 *   GET  /onboarding                          state for the welcome screen
 *   POST /onboarding/dismiss                  Skip / Done
 *   POST /onboarding/reopen                   "Getting started" on Home
 *   POST /onboarding/nest      {name?}        "Create my nest" (idempotent)
 *   GET  /onboarding/connection?nest_id=&since=   the connect proof
 *   POST /onboarding/distill   {nest_id, url} start a distill
 *   GET  /onboarding/distill/:jobId           its progress
 *   GET  /onboarding/slack/start?nest_id=     self-serve Slack (browser redirect)
 */
import { Hono, type Context } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { AppError } from "../shared/errors.js";
import { getDb } from "../db/client.js";
import { writesAllowed } from "../auth/free-tier.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { credentialMayContribute } from "../governance/org-contribution.js";
import {
  assertCanReadNest,
  connectionEvidence,
  createMyNest,
  dismissOnboarding,
  getOnboardingState,
  reopenOnboarding,
} from "./service.js";
import { getDistillJob, startDistill, TooManyRequestsError } from "./distill.js";

type C = Context<AuthEnv>;

async function callerEmail(c: C): Promise<string> {
  const u = (await getDb().get("SELECT email FROM users WHERE id = ?", [c.get("userId")])) as { email: string } | undefined;
  return u?.email || "anonymous@localhost";
}

export const onboardingRoutes = new Hono<AuthEnv>();

function fail(c: C, err: unknown) {
  if (err instanceof TooManyRequestsError) {
    c.header("Retry-After", String(err.retryAfter));
    return c.json({ error: err.message }, 429);
  }
  if (err instanceof AppError) return c.json({ error: err.message }, err.statusCode as any);
  throw err;
}

/** Onboarding state is the person's own: a nest-scoped or system key has none. */
onboardingRoutes.use("*", async (c, next) => {
  if (c.get("nestScope")) return c.json({ error: "This key is scoped to one nest and has no onboarding." }, 403);
  if (c.req.method !== "GET" && c.get("keyCapability") === "read") {
    return c.json({ error: "This API key is read-only and cannot perform write or governance actions." }, 403);
  }
  // Creating a nest and distilling write content: the same read-only gate as
  // every other write (suspended, licence overdue, past the Free tier).
  if (c.req.method === "POST" && /\/(nest|distill)$/.test(c.req.path) && !(await writesAllowed())) {
    return c.json({ error: "This server is read-only right now, so nothing can be created. Ask your server admin.", read_only: true }, 503);
  }
  return next();
});

onboardingRoutes.get("/", async (c) => {
  try {
    return c.json(await getOnboardingState(c.get("userId"), requestBaseUrl(c.req.url)));
  } catch (err) {
    return fail(c, err);
  }
});

onboardingRoutes.post("/dismiss", async (c) => {
  try {
    await dismissOnboarding(c.get("userId"));
    return c.json(await getOnboardingState(c.get("userId"), requestBaseUrl(c.req.url)));
  } catch (err) {
    return fail(c, err);
  }
});

onboardingRoutes.post("/reopen", async (c) => {
  try {
    await reopenOnboarding(c.get("userId"));
    return c.json(await getOnboardingState(c.get("userId"), requestBaseUrl(c.req.url)));
  } catch (err) {
    return fail(c, err);
  }
});

onboardingRoutes.post("/nest", async (c) => {
  try {
    if (!credentialMayContribute(c)) return c.json({ error: "Creating your nest needs your own full credential (a browser session or a read-write key)." }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const nest = await createMyNest(c.get("userId"), typeof b.name === "string" ? b.name : undefined);
    return c.json({ nest, state: await getOnboardingState(c.get("userId"), requestBaseUrl(c.req.url)) }, nest.created ? 201 : 200);
  } catch (err) {
    return fail(c, err);
  }
});

onboardingRoutes.get("/connection", async (c) => {
  try {
    const nestId = c.req.query("nest_id") ?? "";
    if (!nestId) return c.json({ error: "nest_id is required" }, 400);
    await assertCanReadNest(c.get("userId"), nestId);
    return c.json(await connectionEvidence(c.get("userId"), nestId, c.req.query("since")));
  } catch (err) {
    return fail(c, err);
  }
});

onboardingRoutes.post("/distill", async (c) => {
  try {
    const b = (await c.req.json().catch(() => ({}))) as { nest_id?: unknown; url?: unknown };
    if (typeof b.nest_id !== "string" || !b.nest_id) return c.json({ error: "nest_id is required" }, 400);
    const out = await startDistill({ nestId: b.nest_id, userId: c.get("userId"), userEmail: await callerEmail(c), url: b.url });
    return c.json(out, out.mode === "server" ? 202 : 200);
  } catch (err) {
    return fail(c, err);
  }
});

onboardingRoutes.get("/distill/:jobId", async (c) => {
  try {
    const job = await getDistillJob(c.req.param("jobId"), c.get("userId"));
    if (!job) return c.json({ error: "Not found" }, 404);
    return c.json({ job });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * The browser entry point for self-serve Slack: hands over to the Surfaces
 * Slack route, which owns every check (toggle, ownership, session binding,
 * rate limit) and the OAuth state. A redirect, not a second implementation.
 */
onboardingRoutes.get("/slack/start", async (c) => {
  const nestId = c.req.query("nest_id") ?? "";
  return c.redirect(`/surfaces/slack/hosted/oauth/self-serve?home_nest_id=${encodeURIComponent(nestId)}`, 302);
});
