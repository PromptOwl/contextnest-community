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
import { surfacesEnabled, ORG_ID } from "../../flags.js";
import { createInstall, getInstall, type InstallRow } from "../../services/install-store.js";
import { getSecret, secretPresence, setSecret, deleteSecrets } from "../../services/secret-store.js";
import { completeInstallerLink, recordUserChange } from "../../services/identity-service.js";
import { handleSurfaceSignal } from "../../services/guard-runner.js";
import { isOrgAdmin, SERVER_ADMIN_DISCLOSURE } from "../../services/binding-service.js";
import { ingest, count } from "../../services/ingest-service.js";
import { uninstall } from "../../services/lifecycle-service.js";
import { track } from "../../services/work.js";
import { buildManifest, BOT_SCOPES, slackUrls } from "./manifest.js";
import { verifySlackSignature } from "./verify.js";
import { normalizeSlack } from "./connector.js";
import { slackCall } from "./api.js";
import { handleCommand, handleInteraction } from "./interactions.js";

type C = Context<AuthEnv>;

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const hostedEnabled = () => surfacesEnabled() && config.FEATURE_SURFACES_SLACK_HOSTED;
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
  return c.json({ install: installView(i, await secretPresence(i.id)) });
});

slackAdminRoutes.put("/installs/:id/credentials", async (c) => {
  const denied = await assertAdmin(c);
  if (denied) return denied;
  const i = await getInstall(c.req.param("id"));
  if (!i || i.surface !== "slack" || i.mode === "hosted") return c.json({ error: "Not found" }, 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const stored: string[] = [];
  for (const k of ["client_id", "client_secret", "signing_secret"] as const) {
    const v = b[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim() || v.length > 300) return c.json({ error: `${k} must be a non-empty string` }, 422);
    await setSecret(i.id, k, v.trim(), c.get("userId"));
    stored.push(k);
  }
  return c.json({ stored, credentials: await secretPresence(i.id) });
});

/** The state is bound to this browser session (or this credential) and single use. */
function sessionBinding(c: C): string | null {
  const sid = getSessionIdFromRequest(c);
  return sid ? sha(`session:${sid}`) : null;
}

async function startOAuth(c: C, install: InstallRow, clientId: string | null, redirectBase: "manifest" | "hosted", returnTo: string | null = null) {
  const bindingHash = sessionBinding(c);
  if (!bindingHash) return c.json({ error: "Open this link from a signed-in browser session." }, 403);
  if (!clientId) return c.json({ error: "Save the app's client id first." }, 409);
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
  return startOAuth(c, i, await getSecret(i.id, "client_id"), "manifest");
});

slackAdminRoutes.get("/hosted/oauth/start", async (c) => {
  if (!hostedEnabled()) return c.json({ error: "Not found" }, 404);
  const denied = await assertAdmin(c);
  if (denied) return denied;
  const nestId = c.req.query("home_nest_id") ?? "";
  if (!nestId || !(await getDb().get("SELECT 1 AS x FROM nests WHERE id = ?", [nestId]))) return c.json({ error: "home_nest_id must name a nest" }, 422);
  const install = await createInstall({
    surface: "slack",
    mode: "hosted",
    tenantKey: `pending:${randomBytes(8).toString("hex")}`,
    homeNestId: nestId,
    installedByUserId: c.get("userId"),
  });
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
  if (!config.SURFACES_SLACK_SELF_SERVE && !admin) return c.json({ error: "A server admin must turn on self-serve Slack first." }, 403);
  const nestId = c.req.query("home_nest_id") ?? "";
  const nest = nestId ? ((await getDb().get("SELECT user_id FROM nests WHERE id = ? AND archived_at IS NULL", [nestId])) as { user_id: string } | undefined) : undefined;
  // Your own nest only (a server admin may target any nest, as on the admin path).
  if (!nest || (nest.user_id !== userId && !admin)) return c.json({ error: "home_nest_id must name a nest you own" }, 422);
  const { tryConsume } = await import("../../../shared/rate-limit.js");
  if (!tryConsume(`slack-self-serve:${userId}`, SELF_SERVE_LIMIT)) return c.json({ error: "Too many Slack connect attempts. Try again in an hour." }, 429);
  const creds = hostedCreds();
  if (!creds.clientId || !creds.clientSecret || !creds.signing) return c.json({ error: "A server admin must configure the Slack app on this server first." }, 409);
  if (!sessionBinding(c)) return c.json({ error: "Open this link from a signed-in browser session." }, 403);
  const install = await createInstall({
    surface: "slack",
    mode: "hosted",
    tenantKey: `pending:${randomBytes(8).toString("hex")}`,
    homeNestId: nestId,
    installedByUserId: userId,
  });
  return startOAuth(c, install, creds.clientId, "hosted", SELF_SERVE_RETURN);
});

/** Only a same-origin app path may be a return target (no //host, no scheme). */
export function safeReturnPath(p: string | null | undefined): string | null {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return null;
  return p;
}

const REFUSED_NO_TOKEN = "Nest was not connected. No token was kept and nothing was read from your workspace.";

function done(c: C, status: number, message: string, extra: Record<string, unknown> = {}) {
  if ((c.req.header("Accept") || "").includes("application/json")) return c.json({ ok: status === 200, message, ...extra }, status as any);
  const esc = message.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  return c.html(`<!doctype html><meta charset="utf-8"><title>Slack</title><body style="font-family:system-ui;max-width:520px;margin:48px auto;padding:0 16px"><p>${esc}</p></body>`, status as any);
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
  const bindingHash = sessionBinding(c);
  if (!state || !code || !bindingHash) return done(c, 400, "This sign-in link isn't valid. Start again from Surfaces.");
  const row = (await getDb().get("SELECT * FROM surface_oauth_states WHERE state_hash = ?", [sha(state)])) as
    | { state_hash: string; install_id: string; user_id: string; session_hash: string; expires_at: string; used_at: string | null; return_to?: string | null }
    | undefined;
  const a = Buffer.from(row?.session_hash ?? "");
  const b = Buffer.from(bindingHash);
  const sameSession = !!row && a.length === b.length && timingSafeEqual(a, b) && row.user_id === c.get("userId");
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now() || !sameSession) {
    return done(c, 403, "This sign-in link expired or belongs to another session. Start again from Surfaces.");
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
  } catch {
    return done(c, 502, "Slack didn't accept the sign-in. No token was kept.");
  }
  const token = typeof res.access_token === "string" ? res.access_token : "";
  const team = res.team?.id ? String(res.team.id) : "";
  const enterprise = res.enterprise?.id ? String(res.enterprise.id) : null;
  const revoke = async () => {
    if (token) await slackCall("auth.revoke", {}, { token }).catch(() => {});
  };
  // A refusal revokes only the token Slack just issued. A live install keeps
  // its own secrets and stays as it was (round 2, L5); only an install that
  // never went live is closed and cleared.
  const refuse = async (status: number, why: string) => {
    await revoke();
    if (install.status === "pending") {
      const r = await getDb().run("UPDATE surface_installs SET status = 'disconnected', updated_at = ? WHERE id = ? AND status = 'pending'", [iso(Date.now()), install.id]);
      if (r.changes) await deleteSecrets(install.id).catch(() => 0);
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
  } catch {
    return refuse(409, "This Slack workspace is already connected to Nest.");
  }
  await setSecret(install.id, "bot_token", token, row.user_id);
  if (res.authed_user?.id) {
    await completeInstallerLink({ installId: install.id, authedUserId: String(res.authed_user.id), communityUserId: row.user_id }).catch(() => {});
  }
  const back = safeReturnPath(row.return_to);
  if (back && !(c.req.header("Accept") || "").includes("application/json")) return c.redirect(`${back}&slack=connected`, 302);
  return done(c, 200, "Nest is connected to your Slack workspace. Bind a channel in Surfaces to start.", { install_id: install.id, ...(back ? { return_to: back } : {}) });
});
