/**
 * Slack routes (PRD §5.4, S2a).
 *
 * Public (no session; mounted at /surfaces/slack BEFORE the auth middleware,
 * the signature is the credential):
 *   POST /:installId/events, /:installId/interactions — manifest installs
 *   POST /hosted/events, /hosted/interactions          — PromptOwl app (flagged)
 * Signed-in (inside surfacesRoutes at /slack):
 *   POST /installs, GET /installs/:id, PUT /installs/:id/credentials,
 *   GET /installs/:id/oauth/start, GET /hosted/oauth/start, GET /oauth/callback
 *
 * Every entry point 404s while FEATURE_SURFACES is off (flag middleware runs
 * first, before auth). Signatures are checked in constant time with a 300 s
 * replay window. The 200 ack goes out before any heavy work (AC-INS-10).
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { AuthEnv } from "../../../auth/middleware.js";
import { getSessionIdFromRequest } from "../../../auth/sessions.js";
import { credentialMayContribute } from "../../../governance/org-contribution.js";
import { config } from "../../../config.js";
import { getDb } from "../../../db/client.js";
import { tryConsume } from "../../../shared/rate-limit.js";
import { surfacesEnabled, hostedEnabled, ORG_ID } from "../../flags.js";
import { createInstall, getInstall, type InstallRow } from "../../services/install-store.js";
import { getSecret, secretPresence, setSecret, deleteSecrets } from "../../services/secret-store.js";
import { completeInstallerLink, recordUserChange } from "../../services/identity-service.js";
import { handleSurfaceSignal } from "../../services/guard-runner.js";
import { isOrgAdmin, SERVER_ADMIN_DISCLOSURE } from "../../services/binding-service.js";
import { ingest, count } from "../../services/ingest-service.js";
import { uninstall } from "../../services/lifecycle-service.js";
import { track } from "../../services/work.js";
import { buildManifest, BOT_SCOPES, slackUrls, publicUrlProblem, originMismatch, PUBLIC_URL_SETTING } from "./manifest.js";
import { verifySlackSignature } from "./verify.js";
import { normalizeSlack } from "./connector.js";
import { slackCall, slackErrorCode, refusedClientPair } from "./api.js";
import { logCaught } from "../../log.js";
import { listInstallChannels, channelListFailure } from "./channels.js";
import { handleCommand, handleInteraction } from "./interactions.js";

type C = Context<AuthEnv>;

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

function hostedCreds() {
  return {
    clientId: config.SURFACES_SLACK_HOSTED_CLIENT_ID,
    clientSecret: config.SURFACES_SLACK_HOSTED_CLIENT_SECRET,
    signing: config.SURFACES_SLACK_HOSTED_SIGNING_SECRET,
  };
}

// ─── public: events + interactions ──────────────────────────────────────────

export const slackPublicRoutes = new Hono<AuthEnv>();

slackPublicRoutes.use("*", async (c, next) => {
  if (!surfacesEnabled()) return c.json({ error: "Not found" }, 404);
  return next();
});

/** Slack payloads are small; nothing unauthenticated may make us buffer more (round 2, L4). */
export const MAX_SLACK_BODY_BYTES = 1_000_000;
slackPublicRoutes.use(
  "*",
  bodyLimit({ maxSize: MAX_SLACK_BODY_BYTES, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
);

function signed(c: C, secret: string | null, raw: string): boolean {
  return verifySlackSignature(secret, c.req.header("x-slack-request-timestamp"), c.req.header("x-slack-signature"), raw);
}

/** One Slack app per server: a re-OAuth of a connected workspace returns the live install's
 *  own bot token, so revoking a refused token must skip one a live install still holds. */
async function liveInstallHolds(team: string, token: string): Promise<boolean> {
  if (!team) return false;
  const live = (await getDb().all("SELECT id FROM surface_installs WHERE surface = 'slack' AND team_id = ? AND status = 'active'", [team])) as Array<{ id: string }>;
  for (const l of live) if ((await getSecret(l.id, "bot_token").catch(() => null)) === token) return true;
  return false;
}

/** Map a Slack event to the work it implies; runs after the ack. */
export async function processSlackEvent(install: InstallRow, payload: Record<string, any>): Promise<void> {
  // S2b: App Home "My pending" is published when the person opens it — never as a nudge.
  if (payload.event?.type === "app_home_opened") {
    if (payload.event.tab === "home" && typeof payload.event.user === "string") {
      const { publishHome } = await import("../../services/home-service.js");
      await publishHome(install.id, payload.event.user);
    }
    return;
  }
  const out = normalizeSlack(payload);
  if (!Array.isArray(out)) {
    if (out.kind === "uninstalled" || out.kind === "tokens_revoked") {
      // A late Slack retry can carry a teardown from before this install existed
      // (same app, same team): it is about an older token, not this one.
      if (Number(payload.event_time) < Math.floor(Date.parse(String(install.created_at)) / 1000)) return;
      await uninstall(install.id, out.kind);
      return;
    }
    if (out.kind === "user_change") {
      const u = payload.event?.user;
      if (u?.id) {
        await recordUserChange(install.id, {
          surface_user_id: String(u.id),
          home_team_id: u.team_id ? String(u.team_id) : null,
          enterprise_id: null,
          email: typeof u.profile?.email === "string" ? u.profile.email : null,
          email_confirmed: typeof u.is_email_confirmed === "boolean" ? u.is_email_confirmed : null,
          is_restricted: !!u.is_restricted,
          is_ultra_restricted: !!u.is_ultra_restricted,
          is_stranger: !!u.is_stranger,
          is_bot: !!u.is_bot,
          deleted: !!u.deleted,
          user_role: null,
          display_name: u.profile?.display_name || u.real_name || u.name || null,
        });
      }
      return;
    }
    await handleSurfaceSignal(install.id, out);
    return;
  }
  if (out.length) await ingest(install, out);
}

async function eventsHandler(c: C, install: InstallRow | null, secret: string | null, raw: string) {
  if (!install || !signed(c, secret, raw)) return c.json({ error: "bad signature" }, 401);
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad request" }, 400);
  }
  if (payload.type === "url_verification") return c.json({ challenge: String(payload.challenge ?? "") });
  if (payload.type !== "event_callback") return c.json({ ok: true });
  if (install.status !== "active") return c.json({ ok: true });
  if (install.team_id && payload.team_id && payload.team_id !== install.team_id) return c.json({ ok: true });
  const eventId = typeof payload.event_id === "string" ? payload.event_id.slice(0, 100) : null;
  if (eventId) {
    const seen = await getDb().run(
      "INSERT INTO surface_events_seen (install_id, event_id, received_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (install_id, event_id) DO NOTHING",
      [install.id, eventId, iso(Date.now()), iso(Date.now())],
    );
    if (seen.changes === 0) {
      await count("drop_duplicate", null, install.id);
      return c.json({ ok: true });
    }
  }
  track(processSlackEvent(install, payload), "slack event");
  return c.json({ ok: true });
}

async function interactionsHandler(c: C, install: InstallRow | null, secret: string | null, raw: string) {
  if (!install || !signed(c, secret, raw)) return c.json({ error: "bad signature" }, 401);
  if (install.status !== "active") return c.body(null, 200);
  // S2b: block actions ack at once (work deferred); dialog submissions answer
  // with field errors or "clear" (AC-CMT-12).
  const out = await handleInteraction(install, raw);
  return out.body === null ? c.body(null, out.status as any) : c.json(out.body as any, out.status as any);
}

async function commandsHandler(c: C, install: InstallRow | null, secret: string | null, raw: string) {
  if (!install || !signed(c, secret, raw)) return c.json({ error: "bad signature" }, 401);
  if (install.status !== "active") return c.body(null, 200);
  const out = await handleCommand(install, raw);
  return out.body === null ? c.body(null, out.status as any) : c.json(out.body as any, out.status as any);
}

async function hostedInstall(raw: string, ct: string): Promise<InstallRow | null> {
  let team: string | null = null;
  try {
    const form = ct.includes("application/json") ? null : new URLSearchParams(raw);
    const p = form ? (form.get("payload") ? JSON.parse(form.get("payload")!) : { team_id: form.get("team_id") }) : JSON.parse(raw);
    team = p.team_id ?? p.team?.id ?? null;
  } catch {
    team = null;
  }
  if (!team) return null;
  return ((await getDb().get("SELECT * FROM surface_installs WHERE surface = 'slack' AND mode = 'hosted' AND team_id = ? AND status IN ('pending', 'active')", [
    String(team),
  ])) as InstallRow | undefined) ?? null;
}

slackPublicRoutes.post("/hosted/events", async (c) => {
  if (!hostedEnabled()) return c.json({ error: "Not found" }, 404);
  const raw = await c.req.text();
  const secret = hostedCreds().signing;
  if (!signed(c, secret, raw)) return c.json({ error: "bad signature" }, 401);
  let p: any = {};
  try {
    p = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad request" }, 400);
  }
  if (p.type === "url_verification") return c.json({ challenge: String(p.challenge ?? "") });
  return eventsHandler(c, await hostedInstall(raw, "application/json"), secret, raw);
});

slackPublicRoutes.post("/hosted/interactions", async (c) => {
  if (!hostedEnabled()) return c.json({ error: "Not found" }, 404);
  const raw = await c.req.text();
  // Verify with the hosted signing secret BEFORE any parsing or DB lookup (round 2, L4).
  const secret = hostedCreds().signing;
  if (!signed(c, secret, raw)) return c.json({ error: "bad signature" }, 401);
  return interactionsHandler(c, await hostedInstall(raw, c.req.header("content-type") ?? ""), secret, raw);
});

slackPublicRoutes.post("/:installId/events", async (c) => {
  const raw = await c.req.text();
  const install = await getInstall(c.req.param("installId"));
  const ok = install && install.surface === "slack" && install.mode !== "hosted" && (install.status === "pending" || install.status === "active");
  return eventsHandler(c, ok ? install : null, ok ? await getSecret(install!.id, "signing_secret") : null, raw);
});

slackPublicRoutes.post("/hosted/commands", async (c) => {
  if (!hostedEnabled()) return c.json({ error: "Not found" }, 404);
  const raw = await c.req.text();
  // Security L2 (as S2a L4): verify before ANY parsing or DB access.
  const secret = hostedCreds().signing;
  if (!signed(c, secret, raw)) return c.json({ error: "bad signature" }, 401);
  return commandsHandler(c, await hostedInstall(raw, c.req.header("content-type") ?? ""), secret, raw);
});

slackPublicRoutes.post("/:installId/commands", async (c) => {
  const raw = await c.req.text();
  const install = await getInstall(c.req.param("installId"));
  const ok = install && install.surface === "slack" && install.mode !== "hosted" && install.status === "active";
  return commandsHandler(c, ok ? install : null, ok ? await getSecret(install!.id, "signing_secret") : null, raw);
});

slackPublicRoutes.post("/:installId/interactions", async (c) => {
  const raw = await c.req.text();
  const install = await getInstall(c.req.param("installId"));
  const ok = install && install.surface === "slack" && install.mode !== "hosted" && install.status === "active";
  return interactionsHandler(c, ok ? install : null, ok ? await getSecret(install!.id, "signing_secret") : null, raw);
});

// ─── signed-in: install, credentials, OAuth ─────────────────────────────────

export const slackAdminRoutes = new Hono<AuthEnv>();

async function assertAdmin(c: C): Promise<Response | null> {
  if (!credentialMayContribute(c)) return c.json({ error: "Installing needs your own full credential (a session or an unscoped read-write key)." }, 403);
  if (!(await isOrgAdmin(c.get("userId")))) return c.json({ error: "Only a server administrator can connect a Slack workspace." }, 403);
  return null;
}

function installView(i: InstallRow, creds: Record<string, boolean>) {
  return { id: i.id, surface: i.surface, mode: i.mode, status: i.status, team_id: i.team_id, home_nest_id: i.home_nest_id, credentials: creds };
}

slackAdminRoutes.post("/installs", async (c) => {
  const denied = await assertAdmin(c);
  if (denied) return denied;
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const nestId = typeof b.home_nest_id === "string" ? b.home_nest_id : "";
  if (!nestId || !(await getDb().get("SELECT 1 AS x FROM nests WHERE id = ?", [nestId]))) return c.json({ error: "home_nest_id must name a nest" }, 422);
  const install = await createInstall({
    surface: "slack",
    mode: "manifest",
    tenantKey: `pending:${randomBytes(8).toString("hex")}`,
    homeNestId: nestId,
    installedByUserId: c.get("userId"),
  });
  const manifest = buildManifest({ baseUrl: config.PUBLIC_BASE_URL, installId: install.id });
  return c.json({ install_id: install.id, manifest, disclosure: SERVER_ADMIN_DISCLOSURE }, 201);
});

slackAdminRoutes.get("/installs/:id", async (c) => {
  const denied = await assertAdmin(c);
  if (denied) return denied;
  const i = await getInstall(c.req.param("id"));
  if (!i || i.surface !== "slack") return c.json({ error: "Not found" }, 404);
  // po-1186 CR3: a manifest install hands its manifest back, so the setup
  // wizard can offer "Download manifest" again on a later visit. No secrets in it.
  const manifest = i.mode === "manifest" ? buildManifest({ baseUrl: config.PUBLIC_BASE_URL, installId: i.id }) : null;
  return c.json({ install: installView(i, await secretPresence(i.id)), manifest });
});

slackAdminRoutes.put("/installs/:id/credentials", async (c) => {
  const denied = await assertAdmin(c);
  if (denied) return denied;
  const i = await getInstall(c.req.param("id"));
  if (!i || i.surface !== "slack" || i.mode === "hosted") return c.json({ error: "Not found" }, 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const keys = ["client_id", "client_secret", "signing_secret"] as const;
  const next: Partial<Record<(typeof keys)[number], string>> = {};
  for (const k of keys) {
    const v = b[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim() || v.length > 300) return c.json({ error: `${k} must be a non-empty string` }, 422);
    next[k] = v.trim();
  }
  // Check the pair with Slack before storing, so a wrong key is caught here, not after the Slack approval.
  if (next.client_id || next.client_secret) {
    const id = next.client_id ?? (await getSecret(i.id, "client_id"));
    const secret = next.client_secret ?? (await getSecret(i.id, "client_secret"));
    const refused = id && secret ? await refusedClientPair(id, secret) : null;
    if (refused) return c.json({ error: refused.error, field: refused.field }, 422);
  }
  for (const k of keys) if (next[k]) await setSecret(i.id, k, next[k]!, c.get("userId"));
  return c.json({ stored: Object.keys(next), credentials: await secretPresence(i.id) });
});

/**
 * po-1186 CR3: the channels the setup wizard offers. Only conversations the
 * bot is already a member of (users.conversations), never every channel in
 * the workspace: Nest can't listen where it hasn't been added. Names and
 * member counts only. Each row says whether this install already binds it.
 */
slackAdminRoutes.get("/installs/:id/channels", async (c) => {
  const denied = await assertAdmin(c);
  if (denied) return denied;
  const i = await getInstall(c.req.param("id"));
  if (!i || i.surface !== "slack") return c.json({ error: "Not found" }, 404);
  if (i.status !== "active") return c.json({ error: "Finish connecting Slack first: this install isn't active yet." }, 409);
  try {
    return c.json(await listInstallChannels(i));
  } catch (err) {
    logCaught("channels", err, { install: i.id }, "warn");
    const f = channelListFailure(err);
    if (f.retryAfterSec) c.header("Retry-After", String(f.retryAfterSec));
    return c.json({ error: f.error }, f.status);
  }
});

/** The state is bound to this browser session (or this credential) and single use. */
function sessionBinding(c: C): string | null {
  const sid = getSessionIdFromRequest(c);
  return sid ? sha(`session:${sid}`) : null;
}

async function startOAuth(c: C, install: InstallRow, clientId: string | null, redirectBase: "manifest" | "hosted", returnTo: string | null = null) {
  const bindingHash = sessionBinding(c);
  if (!bindingHash) return done(c, 403, "Open this link from a signed-in browser session, not with an API key.", {}, { link: SETUP_LINK });
  if (!clientId) return done(c, 409, "Save the Slack app's Client ID, Client secret and Signing secret in Control room → Setup first.", {}, { link: SETUP_LINK });
  const state = randomBytes(32).toString("base64url");
  await getDb().run(
    `INSERT INTO surface_oauth_states (state_hash, install_id, org_id, user_id, session_hash, nest_id, expires_at, created_at, return_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sha(state), install.id, ORG_ID, c.get("userId"), bindingHash, install.home_nest_id, iso(Date.now() + OAUTH_STATE_TTL_MS), iso(Date.now()), returnTo],
  );
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", slackUrls(config.PUBLIC_BASE_URL, redirectBase === "hosted" ? "hosted" : install.id).redirect);
  url.searchParams.set("state", state);
  return c.redirect(url.toString(), 302);
}

slackAdminRoutes.get("/installs/:id/oauth/start", async (c) => {
  const denied = await assertAdmin(c);
  if (denied) return denied;
  const i = await getInstall(c.req.param("id"));
  if (!i || i.surface !== "slack" || i.mode === "hosted" || (i.status !== "pending" && i.status !== "active")) return c.json({ error: "Not found" }, 404);
  const refused = urlRefusal(c);
  if (refused) return refused;
  return startOAuth(c, i, await getSecret(i.id, "client_id"), "manifest");
});

/**
 * An abandoned attempt leaves a pending install for this person and nest:
 * start again on it, so retries never pile up `pending:*` rows.
 */
async function pendingHostedInstall(nestId: string, userId: string): Promise<InstallRow> {
  const pending = (await getDb().get(
    "SELECT * FROM surface_installs WHERE surface = 'slack' AND mode = 'hosted' AND status = 'pending' AND home_nest_id = ? AND installed_by_user_id = ? AND tenant_key LIKE 'pending:%' ORDER BY created_at DESC LIMIT 1",
    [nestId, userId],
  )) as InstallRow | undefined;
  return (
    pending ??
    createInstall({
      surface: "slack",
      mode: "hosted",
      tenantKey: `pending:${randomBytes(8).toString("hex")}`,
      homeNestId: nestId,
      installedByUserId: userId,
    })
  );
}

/** The server's one Slack app: the manifest to create it from and the addresses it must keep. */
slackAdminRoutes.get("/app", async (c) => {
  const denied = await assertAdmin(c);
  if (denied) return denied;
  const creds = hostedCreds();
  return c.json({
    manifest: buildManifest({ baseUrl: config.PUBLIC_BASE_URL, installId: "hosted" }),
    urls: slackUrls(config.PUBLIC_BASE_URL, "hosted"),
    credentials: { client_id: !!creds.clientId, client_secret: !!creds.clientSecret, signing_secret: !!creds.signing },
  });
});

slackAdminRoutes.get("/hosted/oauth/start", async (c) => {
  if (!hostedEnabled()) return c.json({ error: "Not found" }, 404);
  const denied = await assertAdmin(c);
  if (denied) return denied;
  const nestId = c.req.query("home_nest_id") ?? "";
  if (!nestId || !(await getDb().get("SELECT 1 AS x FROM nests WHERE id = ?", [nestId]))) return c.json({ error: "home_nest_id must name a nest" }, 422);
  const refused = urlRefusal(c);
  if (refused) return refused;
  const install = await pendingHostedInstall(nestId, c.get("userId"));
  return startOAuth(c, install, hostedCreds().clientId, "hosted");
});

/**
 * Self-serve install (PO-1185): a signed-in person connects their OWN Slack
 * workspace to a nest they OWN, through the hosted app, from the welcome
 * screen. Needs SURFACES_SLACK_SELF_SERVE (superadmin toggle) on top of the
 * hosted app; a server admin may always use it. What stays admin-only: the
 * Slack app's credentials (server settings), manifest installs, and every
 * other install route above. Safety comes from the same callback as the admin
 * path (session-bound single-use state, one workspace per install, Grid
 * refused). An install grants no one a seat or a nest role: channels reach
 * the nest only through bindings, which need the nest's own admin.
 */
export const SELF_SERVE_RETURN = "/?onboarding=slack";
export const SELF_SERVE_LIMIT = { max: 5, windowMs: 60 * 60_000 };
slackAdminRoutes.get("/hosted/oauth/self-serve", async (c) => {
  if (!hostedEnabled()) return c.json({ error: "Not found" }, 404);
  const userId = c.get("userId");
  if (!credentialMayContribute(c)) return c.json({ error: "Connecting Slack needs your own full credential (a browser session)." }, 403);
  const admin = await isOrgAdmin(userId);
  if (!config.SURFACES_SLACK_SELF_SERVE && !admin) return c.json({ error: "Self-serve Slack is not turned on for this server. Contact your server admin to turn it on." }, 403);
  const nestId = c.req.query("home_nest_id") ?? "";
  const nest = nestId ? ((await getDb().get("SELECT user_id FROM nests WHERE id = ? AND archived_at IS NULL", [nestId])) as { user_id: string } | undefined) : undefined;
  // Your own nest only (a server admin may target any nest, as on the admin path).
  if (!nest || (nest.user_id !== userId && !admin)) return c.json({ error: "home_nest_id must name a nest you own" }, 422);
  // Configuration and session first: a misconfigured server must not spend
  // the person's attempts.
  const creds = hostedCreds();
  if (!creds.clientId || !creds.clientSecret || !creds.signing) return c.json({ error: "A server admin must configure the Slack app on this server first." }, 409);
  const refused = urlRefusal(c, admin);
  if (refused) return refused;
  if (!sessionBinding(c)) return c.json({ error: "Open this link from a signed-in browser session." }, 403);
  if (!tryConsume(`slack-self-serve:${userId}`, SELF_SERVE_LIMIT)) return c.json({ error: "Too many Slack connect attempts. Try again in an hour." }, 429);
  const install = await pendingHostedInstall(nestId, userId);
  return startOAuth(c, install, creds.clientId, "hosted", SELF_SERVE_RETURN);
});

/** Only a same-origin app path may be a return target (no //host, no scheme). */
export function safeReturnPath(p: string | null | undefined): string | null {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return null;
  return p;
}

const REFUSED_NO_TOKEN = "Nest was not connected. No token was kept and nothing was read from your workspace.";

/** Fixed same-origin links only; never built from request input. */
const SETUP_LINK = { href: "/control-room?section=setup", label: "Back to Setup" };
const SETTINGS_LINK = { href: "/settings", label: "Open Server settings" };
type DoneOpts = { steps?: string[]; link?: { href: string; label: string } };

const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function done(c: C, status: number, message: string, extra: Record<string, unknown> = {}, opts: DoneOpts = {}) {
  if ((c.req.header("Accept") || "").includes("application/json")) {
    return c.json({ ok: status === 200, message, ...(opts.steps ? { steps: opts.steps } : {}), ...extra }, status as any);
  }
  const steps = opts.steps?.length ? `<p><b>How to fix it:</b></p><ol>${opts.steps.map((s) => `<li>${escHtml(s)}</li>`).join("")}</ol>` : "";
  const link = opts.link ? `<p><a href="${opts.link.href}">${escHtml(opts.link.label)}</a></p>` : "";
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Slack</title><body style="font-family:system-ui;line-height:1.5;max-width:560px;margin:48px auto;padding:0 16px"><p>${escHtml(message)}</p>${steps}${link}</body>`,
    status as any,
  );
}

/**
 * po-1444: refuse before sending anyone to Slack when Slack can't reach this
 * server. Otherwise Slack shows its own redirect_uri error and never returns.
 */
function urlRefusal(c: C, admin = true): Response | null {
  // The address the browser used; a proxy's forwarded host wins. No header
  // (in-process calls) means we can't tell, so only the URL itself is checked.
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || null;
  const p = publicUrlProblem(config.PUBLIC_BASE_URL) ?? originMismatch(config.PUBLIC_BASE_URL, host);
  if (!p) return null;
  if (!admin) return done(c, 422, `Slack can't connect yet. ${p.problem} Ask a server admin to set ${PUBLIC_URL_SETTING}.`);
  return done(c, 422, `Slack can't connect yet. ${p.problem}`, {}, { steps: p.steps, link: SETTINGS_LINK });
}

/** Slack's own `error` on the way back (the person cancelled, or the app is misconfigured). */
function slackErrorMessage(code: string): string {
  if (code === "access_denied") return "You cancelled the install in Slack. Nothing was connected. To try again, open Control room → Setup and click Open Slack to approve.";
  const redirect = config.PUBLIC_BASE_URL ? slackUrls(config.PUBLIC_BASE_URL, "hosted").redirect : null;
  return `Slack returned an error: ${code.slice(0, 100)}. Nothing was connected.${redirect ? ` Check that your Slack app lists exactly ${redirect} under OAuth & Permissions → Redirect URLs, then try again from Setup.` : " Try again from Setup."}`;
}

/** oauth.v2.access failed: say what to fix and where, by Slack's error code. */
function exchangeFailed(c: C, code: string, redirect: string) {
  const where = "Control room → Setup → Slack app (or Server settings → Surfaces)";
  const link = SETUP_LINK;
  const tail = "Nothing was connected and no token was kept.";
  if (code === "invalid_client_id" || code === "bad_client_secret" || code === "invalid_client") {
    return done(c, 502, `Slack refused the app's Client ID or Client secret. ${tail}`, {}, {
      steps: [`Copy the Client ID and Client secret from your Slack app's Basic Information page.`, `Save them in ${where}.`, "Open Setup and click Open Slack to approve again."],
      link,
    });
  }
  if (code === "bad_redirect_uri") {
    return done(c, 502, `Slack refused the redirect address. ${tail}`, {}, {
      steps: [`Add ${redirect} under OAuth & Permissions → Redirect URLs in your Slack app.`, "Open Setup and click Open Slack to approve again."],
      link: SETUP_LINK,
    });
  }
  return done(c, 502, `Slack didn't accept the sign-in (${code}). ${tail} Start again from Setup.`, {}, { link: SETUP_LINK });
}

/**
 * OAuth v2 callback: state must exist, be unexpired, unused, minted by this
 * session — then it is consumed (compare-and-set) BEFORE the code is
 * exchanged. One workspace maps to one install: a workspace another install
 * owns, or an Enterprise Grid org-wide install, is refused and the token
 * Slack just issued is revoked at once.
 */
slackAdminRoutes.get("/oauth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const slackError = c.req.query("error");
  if (slackError) return done(c, 400, slackErrorMessage(slackError), {}, { link: SETUP_LINK });
  const bindingHash = sessionBinding(c);
  if (!state || !code || !bindingHash) return done(c, 400, "This sign-in link isn't valid. Start again from Control room → Setup.", {}, { link: SETUP_LINK });
  const row = (await getDb().get("SELECT * FROM surface_oauth_states WHERE state_hash = ?", [sha(state)])) as
    | { state_hash: string; install_id: string; user_id: string; session_hash: string; expires_at: string; used_at: string | null; return_to?: string | null }
    | undefined;
  const a = Buffer.from(row?.session_hash ?? "");
  const b = Buffer.from(bindingHash);
  const sameSession = !!row && a.length === b.length && timingSafeEqual(a, b) && row.user_id === c.get("userId");
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now() || !sameSession) {
    const where = config.PUBLIC_BASE_URL ? ` at the same address you started from (${config.PUBLIC_BASE_URL})` : "";
    return done(
      c,
      403,
      `This sign-in link expired or was opened in a different browser. Finish the Slack approval in the same browser, within 10 minutes${where}. Start again from Control room → Setup.`,
      {},
      { link: SETUP_LINK },
    );
  }
  const used = await getDb().run("UPDATE surface_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL", [iso(Date.now()), row.state_hash]);
  if (used.changes === 0) return done(c, 403, "This sign-in link was already used.");
  const install = await getInstall(row.install_id);
  if (!install || (install.status !== "pending" && install.status !== "active")) return done(c, 404, "This install no longer exists.");
  const hosted = install.mode === "hosted";
  const clientId = hosted ? hostedCreds().clientId : await getSecret(install.id, "client_id");
  const clientSecret = hosted ? hostedCreds().clientSecret : await getSecret(install.id, "client_secret");
  if (!clientId || !clientSecret) return done(c, 409, "Save the app's client id and secret first.");
  let res: Record<string, any>;
  try {
    res = await slackCall("oauth.v2.access", {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: slackUrls(config.PUBLIC_BASE_URL, hosted ? "hosted" : install.id).redirect,
    });
  } catch (err) {
    logCaught("oauth", err, { install: install.id });
    // A hosted attempt is cheap to restart: close it so a stale one is never reused.
    // A manifest install keeps its saved values, so the admin fixes only the wrong one.
    if (hosted) await getDb().run("UPDATE surface_installs SET status = 'disconnected', updated_at = ? WHERE id = ? AND status = 'pending'", [iso(Date.now()), install.id]);
    return exchangeFailed(c, slackErrorCode(err), slackUrls(config.PUBLIC_BASE_URL, hosted ? "hosted" : install.id).redirect);
  }
  const token = typeof res.access_token === "string" ? res.access_token : "";
  const team = res.team?.id ? String(res.team.id) : "";
  const enterprise = res.enterprise?.id ? String(res.enterprise.id) : null;
  const revoke = async () => {
    if (!token || (await liveInstallHolds(team, token))) return;
    await slackCall("auth.revoke", {}, { token }).catch((err) => logCaught("oauth", err, { install: install.id, call: "auth.revoke" }, "warn"));
  };
  // A refusal revokes only the token Slack just issued. A live install keeps
  // its own secrets and stays as it was (round 2, L5); only an install that
  // never went live is closed and cleared.
  const refuse = async (status: number, why: string) => {
    await revoke();
    if (install.status === "pending") {
      const r = await getDb().run("UPDATE surface_installs SET status = 'disconnected', updated_at = ? WHERE id = ? AND status = 'pending'", [iso(Date.now()), install.id]);
      if (r.changes) await deleteSecrets(install.id).catch((err) => logCaught("oauth", err, { install: install.id, call: "delete_secrets" }));
    }
    return done(c, status, `${why} ${REFUSED_NO_TOKEN}`);
  };
  if (!token || !team || res.token_type && res.token_type !== "bot") return refuse(422, "Slack returned no bot token.");
  if (res.is_enterprise_install === true) return refuse(422, "Enterprise Grid org-wide installs aren't supported yet; install it in one workspace.");
  const tenantKey = enterprise ? `${enterprise}:${team}` : team;
  // Re-running OAuth can refresh an install, never move it to another
  // workspace (round 2, L5).
  if (install.status === "active" && (install.team_id !== team || (install.enterprise_id ?? null) !== enterprise)) {
    return refuse(409, "This install belongs to a different Slack workspace. Connect the other workspace as a new install.");
  }
  const owner = (await getDb().get(
    "SELECT id FROM surface_installs WHERE surface = 'slack' AND tenant_key = ? AND status IN ('pending', 'active') AND id <> ?",
    [tenantKey, install.id],
  )) as { id: string } | undefined;
  if (owner) return refuse(409, "This Slack workspace is already connected to Nest.");
  try {
    const r = await getDb().run(
      `UPDATE surface_installs SET tenant_key = ?, team_id = ?, enterprise_id = ?, bot_user_id = ?, status = 'active', updated_at = ?
        WHERE id = ? AND status IN ('pending', 'active')`,
      [tenantKey, team, enterprise, res.bot_user_id ? String(res.bot_user_id) : null, iso(Date.now()), install.id],
    );
    if (r.changes === 0) return refuse(409, "This install changed while connecting.");
  } catch (err) {
    // Usually the tenant_key unique index (a race with another install); the line says if it was not.
    logCaught("oauth", err, { install: install.id, call: "activate" }, "warn");
    return refuse(409, "This Slack workspace is already connected to Nest.");
  }
  await setSecret(install.id, "bot_token", token, row.user_id);
  if (res.authed_user?.id) {
    await completeInstallerLink({ installId: install.id, authedUserId: String(res.authed_user.id), communityUserId: row.user_id }).catch((err) => logCaught("identity", err, { install: install.id, call: "installer_link" }));
  }
  const back = safeReturnPath(row.return_to);
  if (back && !(c.req.header("Accept") || "").includes("application/json")) {
    const to = new URL(back, "http://app.invalid");
    to.searchParams.set("slack", "connected");
    return c.redirect(`${to.pathname}${to.search}`, 302);
  }
  // Self-serve (PO-1185) returns to its own page; an admin install goes on to
  // the Control room setup wizard (po-1186 CR3).
  if (back) return done(c, 200, "Nest is connected to your Slack workspace. Bind a channel in Surfaces to start.", { install_id: install.id, return_to: back });
  return done(c, 200, "Nest is connected to your Slack workspace. Continue setup to choose the channels Nest listens in.", { install_id: install.id, next: "/control-room?section=setup" }, { link: { ...SETUP_LINK, label: "Continue setup" } });
});
