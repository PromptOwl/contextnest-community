import { Hono } from "hono";
import { LinearRouter } from "hono/router/linear-router";
import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";
import { authRoutes } from "./auth/routes.js";
import { nestRoutes } from "./nests/routes.js";
import { sharingRoutes } from "./nests/sharing-routes.js";
import { grantRoutes } from "./nests/grant-routes.js";
import { nestTeamRoutes } from "./nests/nest-team-routes.js";
import { teamRoutes } from "./governance/team-routes.js";
import { listNests, listSharedNests } from "./nests/service.js";
import { getReviewQueue } from "./governance/review-service.js";
import { engineCache } from "./nodes/engine.js";
import { resolveCallerEmail, filterAccessible } from "./governance/access-guard.js";
import {
  resolveStewardsForNode,
  canManageStewards,
} from "./governance/stewardship-service.js";
import { resolveNodeGrant, hasAnyGrant } from "./governance/grants-service.js";
import { nodeRoutes } from "./nodes/routes.js";
import { annotationRoutes } from "./annotations/routes.js";
import { queryRoutes } from "./nodes/query-routes.js";
import { mcpRoutes } from "./mcp/routes.js";
import { edgeTypeRoutes } from "./workflow/edge-type-routes.js";
import { edgeRoutes } from "./workflow/edge-routes.js";
import {
  runTriggerRoutes,
  runListRoutes,
  runDetailRoutes,
} from "./workflow/run-routes.js";
import { scheduleRoutes } from "./workflow/schedule-routes.js";
import { envRoutes } from "./workflow/env-routes.js";
import { connectorRoutes } from "./notify/connector-routes.js";
import { hookNestRoutes, hookFireRoutes } from "./workflow/hook-routes.js";
import {
  listNotifications,
  markNotificationsRead,
} from "./governance/notify-service.js";
import { definitionRoutes } from "./definitions/routes.js";
import { assetRoutes } from "./nests/asset-routes.js";
import { logTraceEvent, listTraceEvents } from "./telemetry/trace-log.js";
import {
  isSuperAdmin,
  isConfigSuperAdmin,
  getAccessConfig,
  loadGrantedSuperAdmins,
} from "./governance/access-service.js";
import {
  llmsTxtRoutes,
  nestIndexRoutes,
  serverMcpRoutes,
} from "./mcp/server-routes.js";
import { governanceRoutes, governanceNodeRoutes } from "./governance/routes.js";
import { authMiddleware, type AuthEnv } from "./auth/middleware.js";
import { assertSafeNodeId } from "./shared/node-id.js";
import {
  resolveNestPermission,
  permissionLevel,
  isServerAdminUserId,
  type NestPermission,
} from "./shared/access.js";
import { AppError } from "./shared/errors.js";
import { config, isEmailish, isEmailListish } from "./config.js";
import { verifySmtp } from "./notify/email.js";
import { getDb } from "./db/client.js";
import { ensureAnonymousUser } from "./auth/anonymous.js";
import {
  isSuspended,
  getSuspensionReason,
  getCurrentLicense,
  installLicenseKey,
  isLicenseAdminUserId,
} from "./auth/license.js";
import { persistSetting } from "./db/settings.js";
import { isOidcReady } from "./auth/oidc.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Resolve UI static files. In built mode this file lives at dist/index.js,
// so siblings of __dirname include dist/web3. In dev (`tsx src/index.ts`)
// __dirname is src/, which has no web3 — fall back to <cwd>/dist/web3
// (vite build output) so `npm run dev` serves the freshly-built bundle.
// serveStatic wants a path relative to CWD.
const HERE = dirname(fileURLToPath(import.meta.url));

// Built mode puts this file at dist/app.js, dev at src/app.ts — package.json
// is one level up from either.
const SERVICE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"))
      .version as string;
  } catch {
    return "unknown";
  }
})();
const UI_DIR_CANDIDATES = [
  join(HERE, "web3"),
  join(process.cwd(), "dist", "web3"),
];
const UI_DIR_ABS =
  UI_DIR_CANDIDATES.find((p) => existsSync(p)) || UI_DIR_CANDIDATES[0];
const UI_DIR_REL = relative(process.cwd(), UI_DIR_ABS) || ".";

// In open mode, assign the anonymous admin user to every request.
// This gives full access without requiring auth headers.
const openModeMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const anonId = await ensureAnonymousUser();
  c.set("userId", anonId);
  c.set("nestScope", null);
  await next();
});

// Unauth GETs in key mode: allow read-only access to a specific nest
// (/nests/:id and its sub-routes) so public nests work without login.
// The bare /nests list is excluded — anon callers must not discover the
// nest inventory. Admin paths and writes still 401.
function isPublicReadEligiblePath(method: string, path: string): boolean {
  if (method !== "GET") return false;
  if (!/^\/nests\/[^/]+(\/.*)?$/.test(path)) return false;
  // The nest steward roster (/nests/:id/stewards) is admin-gated, never
  // public — keep it behind real auth. Without this, an anonymous caller on
  // an anon-owned nest (nests.user_id === ANON_USER_ID, e.g. created under a
  // previous AUTH_MODE=open run) is treated as the anon owner, so the
  // roster gate below resolves "owner" and leaks emails/roles. The
  // node-level resolve (/nests/:id/nodes/:nid/stewards) stays public so the
  // editor UI can still resolve a caller's per-node role.
  if (/^\/nests\/[^/]+\/stewards/.test(path)) return false;
  return !/\/(collaborators|visibility|settings|mcp)/.test(path);
}

const flexAuthMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const hasBearer = c.req.header("Authorization")?.startsWith("Bearer cnst_");
  const hasCookie = !!c.req.header("Cookie")?.includes("cnst_session=");
  if (hasBearer || hasCookie) {
    return authMiddleware(c, next);
  }

  if (config.AUTH_MODE === "open") {
    const anonId = await ensureAnonymousUser();
    c.set("userId", anonId);
    c.set("nestScope", null);
    return next();
  }

  if (isPublicReadEligiblePath(c.req.method, c.req.path)) {
    const anonId = await ensureAnonymousUser();
    c.set("userId", anonId);
    c.set("nestScope", null);
    return next();
  }

  return c.json({ error: "Missing or invalid credentials" }, 401);
});

export function createApp(): Hono<AuthEnv> {
  // LinearRouter, not the default SmartRouter — parity with upstream
  // development (bb96ca8), which hit the same bug class this branch fixed
  // structurally: greedy `/:nodeId{.+}` params vs suffix routes. SmartRouter
  // picks RegExpRouter (catch-all shadows suffix routes) or, when any route
  // pattern is unsupported, silently falls back to TrieRouter (suffix routes
  // dead for ids nested 3+ segments). LinearRouter matches in registration
  // order with per-route backtracking, so mount order = specificity order and
  // both failure modes disappear. Route count is small; the scan is cheap.
  const app = new Hono<AuthEnv>({ router: new LinearRouter() });

  // Hono request logger disabled — keep terminal clean. Re-enable by
  // restoring `app.use("*", logger())` if request tracing is needed.
  // CORS allowlist — see config.CORS_ORIGINS. In key mode we default to a
  // locked-down localhost-only list and set credentials:true so Bearer
  // tokens work. In open mode there are no credentials to exfiltrate, so
  // "*" is acceptable.
  const corsOrigins = config.CORS_ORIGINS;
  app.use(
    "*",
    corsOrigins === "*"
      ? cors({ origin: "*" })
      : cors({ origin: corsOrigins, credentials: true }),
  );

  // Request body size cap — prevents DoS via giant POST payloads before
  // a handler ever gets to parse JSON. Only applies when Content-Length
  // is declared; streamed bodies fall through (uncommon on this API).
  app.use("*", async (c, next) => {
    const lenStr = c.req.header("Content-Length");
    if (lenStr) {
      const len = parseInt(lenStr, 10);
      if (Number.isFinite(len) && len > config.MAX_BODY_BYTES) {
        return c.json(
          {
            error: `Request body too large (${len} bytes, max ${config.MAX_BODY_BYTES})`,
          },
          413,
        );
      }
    }
    return next();
  });

  // Activity trace — one row per API request (MCP tool calls log separately
  // in mcp/routes.ts with the tool name). Registered before the routes so it
  // wraps everything; userId is read AFTER next() because the per-group auth
  // middleware sets it downstream. Static assets, the SPA shell, and /health
  // are noise, not activity — skipped.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const traced =
      /^\/(nests|auth|admin|stats|license|index|mcp)(\/|$)/.test(path) &&
      !path.endsWith("/mcp"); // MCP transport rows come from the tool logger
    const started = Date.now();
    await next();
    if (!traced) return;
    void logTraceEvent({
      kind: "api",
      method: c.req.method,
      path,
      nestId: /^\/nests\/([^/]+)/.exec(path)?.[1] ?? null,
      userId: c.get("userId") ?? null,
      status: c.res.status,
      durationMs: Date.now() - started,
    });
  });

  // Health check (public)
  app.get("/health", (c) => {
    const oidcReady = isOidcReady();
    return c.json({
      status: isSuspended() ? "suspended" : "ok",
      service: "contextnest-community",
      version: SERVICE_VERSION,
      auth_mode: config.AUTH_MODE,
      logo_url: config.LOGO_URL,
      // Presence only, never the value: lets the UI stop prompting for a
      // runner key once the server-wide one exists.
      runner_key_configured: !!process.env.ANTHROPIC_API_KEY,
      promptowl_sign_in_gate: config.PROMPTOWL_SIGN_IN_GATE,
      // Manual (email/password) sign-in mode (open | invite-only | disabled).
      // The login page reads this to show/hide the credential form, and to
      // switch the Register link to an "activate invite" affordance.
      manual_sign_in: config.MANUAL_SIGN_IN,
      // OIDC SSO — true only when enabled AND fully configured, so the login
      // page never shows a button that would bounce with an error. The issuer
      // is exposed (when live) so the client can label the button by IdP
      // (login.microsoftonline.com → Microsoft, accounts.google.com → Google).
      oidc_enabled: oidcReady,
      ...(oidcReady && { oidc_issuer: config.OIDC_ISSUER }),
      // Public feature flags the SPA needs before auth to decide what to
      // render. Mirrors the server-side route gate so UI and API agree:
      // flag off → the plane's routes 404 AND its UI stays hidden.
      workflow_plane_enabled: config.FEATURE_WORKFLOW_PLANE,
      // Content-type toggles (default ON). The editor's type picker mirrors
      // these so a disabled type disappears from creation exactly when the
      // API would refuse it — existing nodes of the type stay readable.
      type_artifact_enabled: config.TYPE_ARTIFACT_ENABLED,
      type_table_enabled: config.TYPE_TABLE_ENABLED,
      // Sub-agent runs gate its own recursion surface separately (env-only,
      // must clear a security review — NOT a UI toggle). Exposed read-only so
      // the Runs page shows the "spawn sub-agent" option only when it's live.
      subagent_runs_enabled: config.FEATURE_SUBAGENT_RUNS,
      // Recursion bounds (env-overridable in config.ts). Exposed so the Runs
      // page validates a spawn against the SERVER's real caps instead of
      // duplicating the defaults — an operator raising/lowering these stays
      // in sync with the picker's grey-outs.
      subagent_max_depth: config.SUBAGENT_MAX_DEPTH,
      subagent_max_children: config.SUBAGENT_MAX_CHILDREN,
      ...(isSuspended() && { suspended_reason: getSuspensionReason() }),
    });
  });

  // Admin-features gate: teammate management and governance routes are
  // blocked until a valid license is installed. Login/register/device/
  // promptowl/admin-status stay public so users can sign in and reach
  // the setup flow.
  app.use("/auth/invite", async (c, next) => {
    if (!getCurrentLicense()?.valid) {
      return c.json(
        {
          error: "License required",
          reason:
            "Install a valid PromptOwl license key before inviting teammates.",
        },
        503,
      );
    }
    return next();
  });
  app.use("/auth/teammates", async (c, next) => {
    if (!getCurrentLicense()?.valid) {
      return c.json(
        {
          error: "License required",
          reason:
            "Install a valid PromptOwl license key to view teammates.",
        },
        503,
      );
    }
    return next();
  });

  // Auth routes (always available — admin can create keys even in open mode)
  app.route("/auth", authRoutes);

  // ─── License setup endpoints (public — needed before unlock) ──────────
  app.get("/license/status", (c) => {
    const lic = getCurrentLicense();
    return c.json({
      valid: !!lic?.valid,
      tier: lic?.tier || "none",
      org: lic?.org || null,
      owner_email: lic?.ownerEmail || null,
      suspended: !!lic?.suspended,
      suspended_reason: lic?.suspendedReason || null,
      limits: lic?.limits || null,
    });
  });

  app.post("/license/install", async (c) => {
    let body: { key?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const key = body?.key?.trim();
    if (!key || !key.startsWith("pk_")) {
      return c.json(
        { error: "Invalid license key. Must start with pk_." },
        400,
      );
    }
    try {
      const info = await installLicenseKey(key);
      if (!info.valid) {
        return c.json(
          {
            valid: false,
            error:
              "PromptOwl rejected this license key. It wasn't saved. Verify the key is correct and active, then try again.",
          },
          400,
        );
      }
      return c.json({
        valid: true,
        tier: info.tier,
        org: info.org,
        limits: info.limits,
        // The key validated and is live now, but if it couldn't be saved to the
        // database it'll be lost on restart — surface that instead of pretending
        // the setup is durable (the old behavior silently swallowed this).
        persisted: info.persisted,
        ...(info.persisted
          ? {}
          : {
              warning: `License validated, but it could not be saved to the database (${
                info.persistError || "unknown error"
              }). It will be LOST on the next restart. Check the database connection, or provide PROMPTOWL_KEY via the container environment.`,
            }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to install key";
      return c.json({ error: msg }, 500);
    }
  });

  // Server-admin guard shared by the /admin/* operator surfaces: open mode,
  // the license admin, or a superadmin (access.yaml ∪ DB grants).
  const serverAdminAllowed = async (c: any) =>
    config.AUTH_MODE === "open" ||
    (await isServerAdminUserId(c.get("userId")));

  // /admin/settings — server-wide settings the admin edits from the Settings
  // page. Each setting takes effect live (config getters read process.env) and
  // persists durably so it survives a restart. In open mode the anonymous
  // admin may edit; in key mode it's the server admin (license admin or
  // superadmin) only.
  app.use("/admin/settings", flexAuthMiddleware);
  const currentServerSettings = () => ({
    promptowl_sign_in_gate: config.PROMPTOWL_SIGN_IN_GATE,
    manual_sign_in: config.MANUAL_SIGN_IN,
    logo_url: config.LOGO_URL,
    telemetry_enabled: config.TELEMETRY_ENABLED,
    public_base_url: config.PUBLIC_BASE_URL,
    max_body_bytes: config.MAX_BODY_BYTES,
    workflow_plane_enabled: config.FEATURE_WORKFLOW_PLANE,
    type_artifact_enabled: config.TYPE_ARTIFACT_ENABLED,
    type_table_enabled: config.TYPE_TABLE_ENABLED,
    subagent_runs_enabled: config.FEATURE_SUBAGENT_RUNS,
    subagent_max_depth: config.SUBAGENT_MAX_DEPTH,
    subagent_max_children: config.SUBAGENT_MAX_CHILDREN,
    trace_retention_days: config.TRACE_RETENTION_DAYS,
    // OIDC SSO. The client secret is WRITE-ONLY: only its presence is
    // reported, never the value (same discipline as the Anthropic key below).
    oidc_enabled: config.OIDC_ENABLED,
    oidc_issuer: config.OIDC_ISSUER,
    oidc_client_id: config.OIDC_CLIENT_ID,
    oidc_client_secret_set: !!config.OIDC_CLIENT_SECRET,
    oidc_allowed_domains: config.OIDC_ALLOWED_DOMAINS.join(", "),
    oidc_auto_provision: config.OIDC_AUTO_PROVISION,
    oidc_department_tagging: config.OIDC_DEPARTMENT_TAGGING,
    // Live readiness (enabled AND issuer+id+secret present) — the SAVED state,
    // i.e. whether the login button is currently live. The Settings UI derives
    // its own "enabled but not configured" warning from the unsaved draft
    // instead, so this is for API consumers (and tests) rather than that badge.
    oidc_ready: isOidcReady(),
    // Server-wide runner default. NEVER the value — masked tail only.
    anthropic_api_key_masked: process.env.ANTHROPIC_API_KEY
      ? `••••${process.env.ANTHROPIC_API_KEY.slice(-4)}`
      : null,
    slack_webhook_url: config.SLACK_WEBHOOK_URL ?? "",
    smtp_url: config.SMTP_URL ?? "",
    notify_email_from: config.NOTIFY_EMAIL_FROM ?? "",
    notify_email_to: config.NOTIFY_EMAIL_TO ?? "",
  });

  app.get("/admin/settings", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can view this." }, 403);
    return c.json(currentServerSettings());
  });

  app.patch("/admin/settings", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can change this." }, 403);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // Validate every supplied field FIRST and stage the changes. Nothing is
    // applied (live env or disk) until all fields pass, so a single bad field
    // can't leave the server in a half-updated state that disagrees with the
    // 400 response. null value deletes the line (setting falls to its default).
    // Validation failures are keyed by the request field name (the same key the
    // UI sends and groups under a tab) so the client can focus the offending
    // field's tab deterministically instead of scraping the message text.
    const fieldErrors: Record<string, string> = {};
    const addError = (field: string, message: string) => {
      fieldErrors[field] = message;
    };
    const pending: Array<{ name: string; value: string | null }> = [];

    if ("promptowl_sign_in_gate" in body) {
      const v = String(body.promptowl_sign_in_gate ?? "").trim().toLowerCase();
      if (!["open", "admin-only", "disabled"].includes(v))
        addError("promptowl_sign_in_gate", "PromptOwl sign-in must be set to Everyone, Admins only, or Off.");
      else pending.push({ name: "PROMPTOWL_SIGN_IN_GATE", value: v });
    }
    if ("manual_sign_in" in body) {
      const v = String(body.manual_sign_in ?? "").trim().toLowerCase();
      if (!["open", "invite-only", "disabled"].includes(v))
        addError("manual_sign_in", "Manual sign-in must be set to Everyone, Invite only, or Off.");
      else pending.push({ name: "MANUAL_SIGN_IN", value: v });
    }
    if ("logo_url" in body) {
      const v = String(body.logo_url ?? "").trim();
      pending.push({ name: "LOGO_URL", value: v || null });
    }
    if ("public_base_url" in body) {
      const v = String(body.public_base_url ?? "").trim().replace(/\/$/, "");
      pending.push({ name: "PUBLIC_BASE_URL", value: v || null });
    }
    if ("telemetry_enabled" in body) {
      pending.push({ name: "TELEMETRY_ENABLED", value: body.telemetry_enabled ? "true" : "false" });
    }
    if ("workflow_plane_enabled" in body) {
      pending.push({
        name: "FEATURE_WORKFLOW_PLANE",
        value: body.workflow_plane_enabled ? "true" : null,
      });
    }
    // Content-type toggles. Default ON — an explicit "false" is the only
    // disabled state, so enabling clears the row (falls to the default) and
    // env-set values gate identically to UI-set ones.
    if ("type_artifact_enabled" in body) {
      pending.push({
        name: "TYPE_ARTIFACT_ENABLED",
        value: body.type_artifact_enabled ? null : "false",
      });
    }
    if ("type_table_enabled" in body) {
      pending.push({
        name: "TYPE_TABLE_ENABLED",
        value: body.type_table_enabled ? null : "false",
      });
    }
    if ("anthropic_api_key" in body) {
      const v = body.anthropic_api_key;
      if (v === null || v === "") {
        pending.push({ name: "ANTHROPIC_API_KEY", value: null });
      } else if (typeof v !== "string" || !v.trim().startsWith("sk-")) {
        addError("anthropic_api_key", 'Anthropic API key must start with "sk-" (or be empty to clear it).');
      } else {
        pending.push({ name: "ANTHROPIC_API_KEY", value: v.trim() });
      }
    }
    if ("subagent_runs_enabled" in body) {
      // Depends on the plane: enabling recursion without the plane's run routes
      // is inert (they'd 404). Honour the plane state THIS request sets, so a
      // single patch can turn both on together. This flag opens a recursion
      // surface — it's gated separately by design and should only be flipped
      // after the security review the feature ships behind.
      const planeOn =
        "workflow_plane_enabled" in body
          ? !!body.workflow_plane_enabled
          : config.FEATURE_WORKFLOW_PLANE;
      if (body.subagent_runs_enabled && !planeOn) {
        addError(
          "subagent_runs_enabled",
          "Sub-agent runs require the Workflow plane to be turned on.",
        );
      } else {
        pending.push({
          name: "FEATURE_SUBAGENT_RUNS",
          value: body.subagent_runs_enabled ? "true" : null,
        });
      }
    }
    // Sub-agent recursion caps. Same [min,max] the config getters clamp to, so
    // a UI-set value gates identically to an env-set one. null clears → default.
    if ("subagent_max_depth" in body) {
      const v = body.subagent_max_depth;
      if (v === null || v === "") {
        pending.push({ name: "SUBAGENT_MAX_DEPTH", value: null });
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 32)
          addError("subagent_max_depth", "Max sub-agent depth must be a whole number between 1 and 32.");
        else pending.push({ name: "SUBAGENT_MAX_DEPTH", value: String(n) });
      }
    }
    if ("subagent_max_children" in body) {
      const v = body.subagent_max_children;
      if (v === null || v === "") {
        pending.push({ name: "SUBAGENT_MAX_CHILDREN", value: null });
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 128)
          addError("subagent_max_children", "Max sub-agents per run must be a whole number between 1 and 128.");
        else pending.push({ name: "SUBAGENT_MAX_CHILDREN", value: String(n) });
      }
    }
    // Activity-trace retention window in days. Same [0, 3650] range the config
    // getter caps to, so a UI-set value gates identically to an env-set one.
    // 0 = keep forever (pruning skipped). null clears → default (14).
    if ("trace_retention_days" in body) {
      const v = body.trace_retention_days;
      if (v === null || v === "") {
        pending.push({ name: "TRACE_RETENTION_DAYS", value: null });
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 3650)
          addError("trace_retention_days", "Trace retention must be a whole number of days between 0 and 3650 (0 keeps activity forever).");
        else pending.push({ name: "TRACE_RETENTION_DAYS", value: String(n) });
      }
    }
    // ── OIDC SSO ──
    // The client secret is write-only: a non-empty string overwrites, null or
    // "" clears, and GET only ever reports `oidc_client_secret_set`. Issuer
    // must be a https URL (the trust root of the whole flow). Enabling
    // requires the effective post-PATCH config to be complete, so the toggle
    // can never be left on with a login button that just bounces errors.
    if ("oidc_issuer" in body) {
      const v = String(body.oidc_issuer ?? "").trim().replace(/\/$/, "");
      let ok = false;
      try {
        ok = !v || new URL(v).protocol === "https:";
      } catch {
        ok = false;
      }
      if (!ok)
        addError("oidc_issuer", "OIDC issuer must be a valid https:// URL (e.g. https://accounts.google.com), or empty to clear it.");
      else pending.push({ name: "OIDC_ISSUER", value: v || null });
    }
    if ("oidc_client_id" in body) {
      const v = String(body.oidc_client_id ?? "").trim();
      pending.push({ name: "OIDC_CLIENT_ID", value: v || null });
    }
    if ("oidc_client_secret" in body) {
      const v = body.oidc_client_secret;
      if (v === null || v === "") {
        pending.push({ name: "OIDC_CLIENT_SECRET", value: null });
      } else if (typeof v !== "string") {
        addError("oidc_client_secret", "OIDC client secret must be a string (or empty to clear it).");
      } else {
        pending.push({ name: "OIDC_CLIENT_SECRET", value: v.trim() });
      }
    }
    if ("oidc_allowed_domains" in body) {
      const raw = String(body.oidc_allowed_domains ?? "").trim();
      const entries = raw
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
      // Bare hostnames only — an entry with "@", a scheme, a slash, or no dot
      // is a typo'd email/URL, not a domain, and would silently never match.
      const bad = entries.find((d) => !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d));
      if (bad !== undefined)
        addError("oidc_allowed_domains", `"${bad}" is not a valid domain — use bare domains, comma-separated (e.g. acme.com, contractors.acme.com), or leave empty to allow any.`);
      else
        pending.push({
          name: "OIDC_ALLOWED_DOMAINS",
          value: entries.length ? entries.join(",") : null,
        });
    }
    if ("oidc_auto_provision" in body) {
      pending.push({
        name: "OIDC_AUTO_PROVISION",
        value: body.oidc_auto_provision ? "true" : "false",
      });
    }
    // Department auto-tagging (dept:<slug> on node create). Only meaningful
    // when an OIDC IdP emits the `department` claim, but deliberately NOT
    // gated on oidc_enabled — the toggle is inert without a department to
    // read, never harmful. Default off; false persists as null (unset) rather
    // than "false" because unset already means off — unlike oidc_auto_provision
    // above, whose default is ON and so needs an explicit "false" to disable.
    if ("oidc_department_tagging" in body) {
      pending.push({
        name: "OIDC_DEPARTMENT_TAGGING",
        value: body.oidc_department_tagging ? "true" : null,
      });
    }
    // Effective post-PATCH OIDC state: what this request sets, falling back
    // to current config for fields it doesn't touch. Shared by the enable
    // guard here AND the total-lockout guard below (SSO-only servers are a
    // supported configuration, so the lockout check must see OIDC too).
    const effOidcIssuer =
      "oidc_issuer" in body
        ? String(body.oidc_issuer ?? "").trim()
        : config.OIDC_ISSUER;
    const effOidcClientId =
      "oidc_client_id" in body
        ? String(body.oidc_client_id ?? "").trim()
        : config.OIDC_CLIENT_ID;
    const effOidcSecret =
      "oidc_client_secret" in body
        ? String(body.oidc_client_secret ?? "").trim()
        : config.OIDC_CLIENT_SECRET;
    const effOidcEnabled =
      "oidc_enabled" in body ? !!body.oidc_enabled : config.OIDC_ENABLED;
    const effOidcReady =
      effOidcEnabled && !!effOidcIssuer && !!effOidcClientId && !!effOidcSecret;
    if ("oidc_enabled" in body) {
      if (body.oidc_enabled && !effOidcReady) {
        addError(
          "oidc_enabled",
          "Set the OIDC issuer, client ID, and client secret before turning single sign-on on.",
        );
      } else {
        pending.push({
          name: "OIDC_ENABLED",
          value: body.oidc_enabled ? "true" : null,
        });
      }
    }
    if ("slack_webhook_url" in body) {
      const v = String(body.slack_webhook_url ?? "").trim();
      // Empty clears (connector off). A webhook URL carries an implicit
      // secret in its path — https only.
      if (v && !/^https:\/\//i.test(v))
        addError("slack_webhook_url", "Slack webhook must be an https:// URL (or leave it empty to turn Slack notifications off).");
      else pending.push({ name: "SLACK_WEBHOOK_URL", value: v || null });
    }
    if ("smtp_url" in body) {
      const v = String(body.smtp_url ?? "").trim();
      if (v && !/^smtps?:\/\//i.test(v))
        addError("smtp_url", "SMTP connection URL must start with smtp:// or smtps:// (or leave it empty to turn email notifications off).");
      else pending.push({ name: "SMTP_URL", value: v || null });
    }
    // Shape check (local@domain.tld, no CR/LF) — these flow into nodemailer's
    // envelope, so junk and header-injection shapes stop here. Same guard the
    // config getters apply, so env-set and UI-set values gate identically.
    if ("notify_email_from" in body) {
      const v = String(body.notify_email_from ?? "").trim();
      // From is the envelope sender — exactly one address. Call out a list
      // explicitly (recipients go in the To field) rather than a generic shape
      // error, since a comma also trips isEmailish.
      if (v && v.includes(","))
        addError("notify_email_from", "From address must be a single email address — put multiple addresses in Recipients (To) instead.");
      else if (v && !isEmailish(v))
        addError("notify_email_from", "From address must be a valid email like nest@company.com.");
      else pending.push({ name: "NOTIFY_EMAIL_FROM", value: v || null });
    }
    if ("notify_email_to" in body) {
      const v = String(body.notify_email_to ?? "").trim();
      if (v && !isEmailListish(v))
        addError("notify_email_to", "Recipients must be valid emails, comma-separated (e.g. team@company.com, ops@company.com).");
      else pending.push({ name: "NOTIFY_EMAIL_TO", value: v || null });
    }
    if ("max_body_bytes" in body) {
      const n = Number(body.max_body_bytes);
      if (!Number.isFinite(n) || n < 1024 * 1024 || n > 500 * 1024 * 1024)
        addError("max_body_bytes", "Max upload size must be between 1 MB and 500 MB.");
      else pending.push({ name: "MAX_BODY_BYTES", value: String(Math.floor(n)) });
    }

    // Total-lockout guard: at least ONE sign-in method must survive the
    // PATCH — manual, PromptOwl, or a ready+enabled OIDC flow. Evaluated on
    // the effective post-PATCH state (values this request sets, falling back
    // to current config for untouched fields), so the combination is checked
    // whichever side of it is in the body. This is symmetric: it blocks
    // disabling both classic methods without SSO, AND it blocks turning off /
    // un-configuring OIDC when it's the only remaining way in.
    const effManual =
      "manual_sign_in" in body
        ? String(body.manual_sign_in ?? "").trim().toLowerCase()
        : config.MANUAL_SIGN_IN;
    const effGate =
      "promptowl_sign_in_gate" in body
        ? String(body.promptowl_sign_in_gate ?? "").trim().toLowerCase()
        : config.PROMPTOWL_SIGN_IN_GATE;
    if (effManual === "disabled" && effGate === "disabled" && !effOidcReady) {
      // Cross-field rule — key it to the field group this request touched so
      // the client focuses the tab the admin is actually editing: the SSO tab
      // when the body only changes OIDC fields, else the General tab where
      // the two classic sign-in toggles live.
      const touchedOidcOnly =
        !("manual_sign_in" in body) &&
        !("promptowl_sign_in_gate" in body) &&
        ["oidc_enabled", "oidc_issuer", "oidc_client_id", "oidc_client_secret"].some(
          (k) => k in body,
        );
      addError(
        touchedOidcOnly ? "oidc_enabled" : "manual_sign_in",
        "Cannot disable both manual and PromptOwl sign-in unless SSO (OIDC) is enabled and configured — no one would be able to log in.",
      );
    }

    // Reject the whole request if any field failed validation — apply nothing.
    // `error` is the flat message for the banner; `fieldErrors` lets the client
    // focus the offending field's tab by key (no message-text scraping).
    const errorMessages = Object.values(fieldErrors);
    if (errorMessages.length)
      return c.json(
        { error: errorMessages.join("; "), fieldErrors, settings: currentServerSettings() },
        400,
      );

    // Shape is good — now prove the SMTP credentials actually work before we
    // persist them. A prefix-valid URL can still point at the wrong host or
    // carry a bad password; connect + authenticate so junk is blocked at save
    // instead of silently failing on the first governance event. Only runs when
    // the URL is being set to a non-empty value (empty = disabling the
    // connector, nothing to verify).
    const smtpChange = pending.find((p) => p.name === "SMTP_URL");
    if (smtpChange && smtpChange.value) {
      const result = await verifySmtp(smtpChange.value);
      if (!result.ok) {
        const message = `SMTP connection failed: ${result.error}`;
        return c.json(
          {
            error: message,
            fieldErrors: { smtp_url: message },
            settings: currentServerSettings(),
          },
          400,
        );
      }
    }

    // All valid: persist first, then mutate live env. Ordering persist-before-
    // live means a DB failure aborts before the running server changes, so a
    // 500 never leaves a live setting that was never durably stored. The store
    // is the database (durable + shared across instances) rather than a .env
    // file, which Cloud Run wipes on rebuild — see db/settings.ts.
    for (const { name, value } of pending) {
      try {
        await persistSetting(name, value);
      } catch (e) {
        return c.json(
          {
            error: `Could not persist ${name}: ${e instanceof Error ? e.message : String(e)}`,
            settings: currentServerSettings(),
          },
          500
        );
      }
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }

    return c.json({ settings: currentServerSettings() });
  });

  // GET /admin/trace — the operator audit surface: newest-first activity
  // rows (API + MCP), optional kind/nest/user/limit filters. Server admin
  // only (license admin OR super_admin) — cross-tenant data.
  app.use("/admin/trace", flexAuthMiddleware);
  app.get("/admin/trace", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can view this." }, 403);
    const limitRaw = Number(c.req.query("limit"));
    const offsetRaw = Number(c.req.query("offset"));
    const limit = Number.isFinite(limitRaw) ? limitRaw : 25;
    const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
    const { events, total } = await listTraceEvents({
      limit,
      offset,
      kind: c.req.query("kind") as any,
      nestId: c.req.query("nest") || undefined,
      user: c.req.query("user") || undefined,
    });
    // `count` = rows on this page (back-compat); `total` = full filtered count
    // for the pager. limit/offset echo the applied window.
    return c.json({ count: events.length, total, limit, offset, events });
  });

  // ─── /admin/super-admins — grant/revoke superadmins from the UI ──────────
  // (CU-wdqcpzwf2n). The effective superadmin set is the union of three
  // sources, surfaced per row as `source`:
  //   "license" — the PromptOwl account that owns the installed license
  //               (derived live, never stored, never revocable here)
  //   "config"  — access.yaml `super_admins` (the authoritative bootstrap;
  //               revocable only by editing the file — lockout safety)
  //   "granted" — rows in the super_admins DB table (managed by these routes)
  // All three routes use the same server-admin guard as /admin/trace.
  app.use("/admin/super-admins", flexAuthMiddleware);
  app.use("/admin/super-admins/*", flexAuthMiddleware);

  app.get("/admin/super-admins", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can view this." }, 403);
    const callerEmail = (await resolveCallerEmail(c.get("userId"))).toLowerCase();

    type Row = {
      email: string;
      source: "license" | "config" | "granted";
      granted_by: string | null;
      granted_at: string | null;
      self: boolean;
    };
    // Precedence license > config > granted: an email present in several
    // sources shows its least-revocable origin (that's what governs whether
    // DELETE is allowed).
    const byEmail = new Map<string, Row>();
    const add = (row: Row) => {
      if (!byEmail.has(row.email)) byEmail.set(row.email, row);
    };

    const lic = getCurrentLicense();
    if (lic?.valid && lic.ownerEmail) {
      const email = lic.ownerEmail.toLowerCase();
      add({ email, source: "license", granted_by: null, granted_at: null, self: email === callerEmail });
    }
    for (const raw of getAccessConfig()?.super_admins ?? []) {
      const email = raw.toLowerCase();
      add({ email, source: "config", granted_by: null, granted_at: null, self: email === callerEmail });
    }
    const granted = (await getDb().all(
      "SELECT email, granted_by, granted_at FROM super_admins ORDER BY granted_at, email",
    )) as Array<{ email: string; granted_by: string; granted_at: string }>;
    for (const g of granted) {
      const email = g.email.toLowerCase();
      add({ email, source: "granted", granted_by: g.granted_by, granted_at: g.granted_at, self: email === callerEmail });
    }

    return c.json({ super_admins: [...byEmail.values()] });
  });

  app.post("/admin/super-admins", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can grant superadmin." }, 403);

    let body: { email?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !isEmailish(email)) {
      return c.json({ error: "A valid email is required." }, 400);
    }

    // Must be an existing user on this server — a superadmin grant to a typo
    // would otherwise sit live and invisible until someone registers it.
    const user = await getDb().get(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      [email],
    );
    if (!user) {
      return c.json(
        { error: "No user with this email exists on this server. Invite them as a teammate first." },
        400,
      );
    }

    const lic = getCurrentLicense();
    const isLicenseOwner =
      !!lic?.valid && lic.ownerEmail?.toLowerCase() === email;
    if (isLicenseOwner || isSuperAdmin(email)) {
      return c.json({ error: "This user is already a superadmin." }, 409);
    }

    const grantedBy = (await resolveCallerEmail(c.get("userId"))).toLowerCase();
    try {
      await getDb().run(
        "INSERT INTO super_admins (email, granted_by) VALUES (?, ?)",
        [email, grantedBy],
      );
    } catch (err) {
      // Concurrent-grant race: the isSuperAdmin pre-check above reads the
      // in-memory cache, so two simultaneous grants can both pass it. The PK
      // on email is the real arbiter — map its violation to the intended 409.
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(msg)) {
        await loadGrantedSuperAdmins();
        return c.json({ error: "This user is already a superadmin." }, 409);
      }
      throw err;
    }
    await loadGrantedSuperAdmins();

    return c.json({ email, source: "granted", granted_by: grantedBy }, 201);
  });

  app.delete("/admin/super-admins/:email", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can revoke superadmin." }, 403);

    // Hono already percent-decodes path params — decoding again would throw
    // a URIError (→ 500) on an email containing a literal '%'.
    const email = c.req.param("email").trim().toLowerCase();
    const callerEmail = (await resolveCallerEmail(c.get("userId"))).toLowerCase();

    const lic = getCurrentLicense();
    if (lic?.valid && lic.ownerEmail?.toLowerCase() === email) {
      return c.json(
        { error: "The license admin can't be revoked — their access comes from owning the installed PromptOwl license." },
        400,
      );
    }
    // access.yaml entries are the file-authoritative bootstrap. Refusing to
    // revoke them via the API is the lockout safety: the operator always keeps
    // a set of admins that no API caller can remove.
    if (isConfigSuperAdmin(email)) {
      return c.json(
        { error: "This superadmin is defined in access.yaml and can't be revoked from here. Remove them from the file and restart the server." },
        400,
      );
    }

    const db = getDb();
    const row = await db.get(
      "SELECT email FROM super_admins WHERE LOWER(email) = ?",
      [email],
    );
    if (!row) return c.json({ error: "Not a granted superadmin." }, 404);

    // Lockout guard: you can't revoke yourself if you're the last effective
    // superadmin left (no license admin, no access.yaml entries, no other
    // DB grants) — that would leave the server with no admin at all.
    if (email === callerEmail) {
      const hasLicenseAdmin = !!lic?.valid && !!lic.ownerEmail;
      const hasConfigAdmins = (getAccessConfig()?.super_admins?.length ?? 0) > 0;
      const others = (await db.get(
        "SELECT COUNT(*) AS c FROM super_admins WHERE LOWER(email) != ?",
        [email],
      )) as { c: number };
      if (!hasLicenseAdmin && !hasConfigAdmins && others.c === 0) {
        return c.json(
          { error: "You're the last superadmin on this server — grant someone else superadmin before revoking yourself." },
          400,
        );
      }
    }

    await db.run("DELETE FROM super_admins WHERE LOWER(email) = ?", [email]);
    await loadGrantedSuperAdmins();

    return c.json({ ok: true, email });
  });

  // GET /stats — dashboard summary counts: nests visible to caller,
  // documents across those nests, total users on the server. Uses
  // ─── My Work — cross-nest inbox of things that need this person ──────────
  // The dashboard shows this above the nest list: reviews/approvals waiting on
  // you across every nest you can act in. Reuses the governance review queue
  // (an agent's write-back lands here too, once the runner submits governed
  // changes). flexAuth so it works in open mode and with a key.
  // Teams — global, owner-managed group primitive (not nest-scoped). Auth via
  // flexAuth; ownership + admin bypass enforced inside the service/handlers.
  app.use("/teams/*", flexAuthMiddleware);
  app.use("/teams", flexAuthMiddleware);
  app.route("/teams", teamRoutes);

  app.use("/me/*", flexAuthMiddleware);
  app.get("/me/work", async (c) => {
    const userId = c.get("userId");
    const me = await resolveCallerEmail(userId);
    const nestName = new Map<string, string>();
    for (const n of [
      ...(await listNests(userId)),
      ...(await listSharedNests(userId)),
    ])
      nestName.set(n.id, n.name ?? n.id);

    const { requests } = await getReviewQueue({ status: "pending", limit: 200 });
    const toItem = (r: (typeof requests)[number]) => ({
      type: "review" as const,
      nest_id: r.nestId,
      nest_name: nestName.get(r.nestId)!,
      node_id: r.nodeId,
      title: r.title || r.nodeId,
      requested_by: r.requestedBy,
      requested_at: r.requestedAt,
      priority: r.priority,
    });
    const mine = requests.filter((r) => nestName.has(r.nestId));
    const byNewest = (a: { requested_at: string }, b: { requested_at: string }) =>
      a.requested_at < b.requested_at ? 1 : -1;
    // items = waiting on ME (someone else asked); waiting = I asked, waiting on them.
    const items = mine.filter((r) => r.requestedBy !== me).map(toItem).sort(byNewest);
    const waiting = mine.filter((r) => r.requestedBy === me).map(toItem).sort(byNewest);
    // Watcher notifications (HITL tags) ride along so the inbox is one call.
    const notifications = await listNotifications(me, { unreadOnly: true, limit: 50 });
    return c.json({ items, waiting, notifications });
  });

  // Watcher notifications — read + mark-read (auth via the /me/* middleware).
  app.get("/me/notifications", async (c) => {
    const me = await resolveCallerEmail(c.get("userId"));
    const unreadOnly = c.req.query("unread") === "true";
    return c.json({ notifications: await listNotifications(me, { unreadOnly }) });
  });
  app.post("/me/notifications/read", async (c) => {
    const me = await resolveCallerEmail(c.get("userId"));
    const body = await c.req
      .json<{ ids?: string[] | "all" }>()
      .catch(() => ({}) as { ids?: string[] | "all" });
    await markNotificationsRead(me, body.ids === "all" ? "all" : body.ids ?? []);
    return c.json({ ok: true });
  });

  // flexAuthMiddleware so it works without auth in open mode and with
  // a Bearer/cookie in key mode.
  app.use("/stats", flexAuthMiddleware);
  app.get("/stats", async (c) => {
    const db = getDb();
    const userId = c.get("userId");
    const userEmail = await resolveCallerEmail(userId);

    const owned = await listNests(userId);
    const sharedNests = await listSharedNests(userId);
    const visibleNests = [...owned, ...sharedNests];

    // Count accessible documents across every nest the caller can see.
    // Mirrors the per-nest filterAccessible logic used by GET /nests/:id/nodes
    // so stewardship-gated docs don't inflate the total for non-stewards.
    let documents = 0;
    for (const nest of visibleNests) {
      try {
        const { storage } = await engineCache.get(nest.id);
        const docs = await storage.discoverDocuments();
        documents += (await filterAccessible(nest.id, userId, userEmail, docs)).length;
      } catch {
        // Nest with filesystem issue — skip; don't break the whole count.
      }
    }

    const usersRow = (await db.get(
      "SELECT COUNT(*) as c FROM users",
    )) as { c: number };

    return c.json({
      nests: visibleNests.length,
      documents,
      users: usersRow.c,
    });
  });

  // === Runner-facing run detail routes (turing) ===
  app.use("/runs/*", flexAuthMiddleware);
  app.route("/runs", runDetailRoutes);
  // Inbound trigger hooks — public by design: the unguessable token in the
  // path is the capability; presets add platform signature verification on
  // top (see workflow/hook-routes.ts).
  app.route("/hooks", hookFireRoutes);

  // === Agent entry point: /llms.txt (public manual), /index (person nest
  // index), /mcp (server-level MCP). See src/mcp/server-routes.ts. ===
  app.route("/llms.txt", llmsTxtRoutes);
  app.use("/index", flexAuthMiddleware);
  app.route("/index", nestIndexRoutes);
  app.use("/mcp", flexAuthMiddleware);
  app.route("/mcp", serverMcpRoutes);

  // === All /nests routes ===
  const nestsApp = new Hono<AuthEnv>();

  // Use flexible auth: open mode = no key needed, key mode = key required
  nestsApp.use("*", flexAuthMiddleware);

  // Access control for nest-scoped routes
  nestsApp.use("*", async (c, next) => {
    const localPath = c.req.path.replace(/^\/nests\//, "");
    const parts = localPath.split("/").filter(Boolean);
    if (parts.length < 2) return next();

    // "unsynced" is a server-admin namespace under /nests, not a nest id.
    // Without this bypass parts[0]="unsynced" is treated as a nest id and the
    // permission resolver 404s every call with "Nest not found". Its own
    // route handlers run the admin-gate check.
    if (parts[0] === "unsynced") return next();

    const nestId = parts[0];
    const userId = c.get("userId");
    const nestScope = c.get("nestScope");

    if (nestScope && nestScope !== nestId) {
      return c.json({ error: "API key not authorized for this nest" }, 403);
    }

    // Kill switch: if suspended, block writes but allow reads
    if (isSuspended() && c.req.method !== "GET") {
      return c.json(
        {
          error: "Server suspended by PromptOwl",
          reason: getSuspensionReason(),
          contact: "support@promptowl.ai",
        },
        503,
      );
    }

    // License gate: block writes until a valid PromptOwl key is
    // installed via /license/install. Reads stay open for plain
    // node/nest browsing — but governance endpoints (stewards,
    // review-queue, approve/reject, version history, capability
    // checks) are admin features and stay locked regardless of HTTP
    // method.
    {
      const path = c.req.path;
      // `/comments` and `/activity` must be matched as complete trailing route
      // segments, NOT substrings — a node id is `nodes/<slug>` and a title like
      // "Comments Draft" yields slug `comments-draft`, whose path contains the
      // substring `/comments`. Anchor to the actual comment/activity route
      // shapes so a node slug can't masquerade as a governance action (see the
      // matching guard in the permission block below).
      const isCommentPath =
        /\/comments$/.test(path) ||
        /\/comments\/[^/]+\/resolve$/.test(path);
      const isActivityPath = /\/activity$/.test(path);
      // The activity feed serves the review queue's rows under another URL
      // (/nests/:id/feed?filter=changes), so it must sit behind the same
      // license gate as /review-queue. Match the exact nest-scoped route
      // shape via the already-split path segments — NOT includes("/feed"),
      // which a node slug like nodes/product-feed would false-positive
      // (parts = [nestId, "feed"] only for the real feed route).
      const isFeedPath = parts.length === 2 && parts[1] === "feed";
      const isGovernance =
        path.includes("/stewards") ||
        path.includes("/review-queue") ||
        path.includes("/versions") ||
        path.includes("/reviews") ||
        path.includes("/submit-review") ||
        path.includes("/cancel-review") ||
        path.includes("/approve") ||
        path.includes("/reject") ||
        path.includes("/can-access") ||
        path.includes("/can-approve") ||
        path.includes("/can-edit") ||
        isCommentPath ||
        isActivityPath ||
        isFeedPath;
      const needsLicense = c.req.method !== "GET" || isGovernance;
      if (needsLicense) {
        const lic = getCurrentLicense();
        if (!lic?.valid) {
          return c.json(
            {
              error: "License required",
              reason:
                "Install a PromptOwl license key via the setup screen or POST /license/install.",
              setup_url: "/setup",
            },
            503,
          );
        }
      }
    }

    // In open mode, everyone gets owner-level access
    if (config.AUTH_MODE === "open") {
      c.set("nestPermission", "owner");
      return next();
    }

    const permission = await resolveNestPermission(nestId, userId);

    // Document/folder share grant: a caller BELOW nest access may still reach
    // a specific granted node (or a bare nest read, so a shared-doc deep link
    // loads the nest shell). Scoped strictly to the granted node's own
    // routes — a grant on one doc never opens the rest of the nest.
    // targetTail is the path under /nodes/, i.e. the node id + any subresource
    // (versions, comments, annotations) — the same prefix a grant covers.
    // Retrieval/query routes (context, query, search, export) are READ-tier:
    // the body is a query, not a mutation — same class as GET /search &
    // /export. A doc/folder grantee may use them; the handler scopes every
    // result to their granted docs via filterAccessible, exactly like the node
    // list. Deliberately NOT graph/publish (nest-write) or changes/overview
    // (whole-nest views). parts.length===2 pins the exact /nests/:id/<route>.
    const isReadQuery =
      parts.length === 2 &&
      ["context", "query", "search", "export"].includes(parts[1]);

    let grantRole: "read" | "write" | null = null;
    let grantNestVisible = false;
    if (permission === "none") {
      if (parts[1] === "nodes" && parts.length >= 3) {
        let targetTail = parts.slice(2).join("/");
        try {
          targetTail = decodeURIComponent(targetTail);
        } catch {
          /* malformed escape — resolve as-is */
        }
        grantRole = await resolveNodeGrant(nestId, userId, targetTail);
      } else if (parts.length === 1 && c.req.method === "GET") {
        // GET /nests/:id (bare) — let a grantee see the nest name so a shared
        // link resolves; the node LIST stays filtered to their grants.
        grantNestVisible = await hasAnyGrant(nestId, userId);
      } else if (
        parts[1] === "nodes" &&
        parts.length === 2 &&
        c.req.method === "GET"
      ) {
        // GET /nests/:id/nodes (the list) — allowed for grantees; the handler
        // (listNodesForCaller) filters to only the nodes they're granted.
        grantNestVisible = await hasAnyGrant(nestId, userId);
      } else if (isReadQuery) {
        // Retrieval routes — a grantee may query/search/context/export; the
        // handler's filterAccessible scopes every result to their grants, so
        // they can never read past what they were shared (same as the list).
        grantNestVisible = await hasAnyGrant(nestId, userId);
      }
      if (!grantRole && !grantNestVisible) {
        return c.json({ error: "Nest not found" }, 404);
      }
    }

    let required: NestPermission = "read";
    const path = c.req.path;
    // Stewardship endpoints run their own per-row permission checks
    // (steward role). Bumping every non-GET to "write" here blocks
    // reviewers — who legitimately have read-only collaborator access
    // plus a reviewer steward row — before their handler can even
    // decide. Let read-permission users through for these paths and
    // trust the handler.
    const isStewardActionPath =
      path.includes("/approve") ||
      path.includes("/reject") ||
      path.includes("/submit-review") ||
      path.includes("/cancel-review");
    // Hosted-artifact annotations are a read-tier collaboration action:
    // anyone who can SEE the artifact (notably read-only reviewers — the people
    // most likely to annotate) may open a thread, reply, resolve or reopen.
    // Handlers re-check node read-access; don't bump these POSTs to "write".
    //   POST …/annotations                        → create thread
    //   POST …/annotations/:id/{comments,resolve,reopen}
    const isAnnotationAction =
      /\/annotations$/.test(path) ||
      /\/annotations\/[^/]+\/(comments|resolve|reopen)$/.test(path);
    // Commenting is a read-tier collaboration action: anyone who can see the
    // node may leave or resolve a comment. Don't bump these POSTs to "write"
    // (that would block read-only reviewers — the people most likely to
    // comment). The handler/service own any finer-grained rules.
    //
    // Match `/comments` as a complete trailing route segment, NOT a substring:
    // a node id is `nodes/<slug>` and a title like "Comments Draft" → slug
    // `comments-draft` → path `…/nodes/comments-draft` contains `/comments`.
    // A substring match left `required` at "read", letting a read-only
    // collaborator PATCH/DELETE any node whose slug starts with "comments".
    const isCommentAction =
      /\/comments$/.test(path) ||
      /\/comments\/[^/]+\/resolve$/.test(path);
    // The steward roster — list, assign, remove, sync — is restricted to the
    // server (license) admin plus the nest owner/admin collaborators, so an
    // owner can delegate vault people-management by granting admin. All
    // methods on /nests/:id/stewards are gated. The node-level resolve route
    // (/nodes/:id/stewards) stays readable so the editor UI can resolve a
    // caller's per-node role.
    const isStewardRoster =
      path.includes("/stewards") && !path.includes("/nodes/");
    // Reuse the permission already resolved above — resolveNestPermission
    // folds the license/super admin into "admin", so owner/admin covers
    // server admin, nest owner, and admin collaborators (same rule as the
    // shared canManageStewards used by MCP).
    if (isStewardRoster && permission !== "owner" && permission !== "admin") {
      return c.json(
        {
          error:
            "You don't have permission to manage stewards. Only a nest admin, the nest owner, or the server admin can do this.",
        },
        403,
      );
    }
    // Match the resource as an exact path segment, NOT a substring: a node id
    // is derived from the doc title (e.g. "Collaborators Guide" → slug
    // `collaborators-guide`), so a substring `path.includes("/collaborators")`
    // would wrongly gate `…/nodes/collaborators-guide` as a collaborators route
    // and 403 a write user editing that doc. parts[1] is the resource segment.
    const resource = parts[1];
    if (resource === "visibility") {
      required = "admin";
    } else if (resource === "collaborators") {
      // Viewing the roster (GET) and inviting (POST) are open to write+
      // collaborators: the Collaborators tab loads the roster and lets editors
      // bring people in — you no longer need to be a nest admin. Kept at write
      // (not read) so a public nest's read tier can't enumerate member emails.
      // The escalation cap — you can't grant above your own level — is enforced
      // in addCollaborator. Changing or removing existing collaborators
      // (PATCH/DELETE) stays admin-only, per the ticket's governance rule.
      required = c.req.method === "GET" || c.req.method === "POST"
        ? "write"
        : "admin";
    } else if (resource === "teams") {
      // Team shares change who can reach the nest. Listing exposes member
      // emails (like the collaborator roster) → 'write'; sharing/unsharing a
      // whole team (which may include admin-role members) → 'admin'.
      required = c.req.method === "GET" ? "write" : "admin";
    } else if (parts[1] === "hooks") {
      // Hook rows carry trigger capability (the token fires runs, which is
      // a write-tier action) — reading the list must not be a read-tier
      // privilege escalation.
      required = "write";
    } else if (
      c.req.method !== "GET" &&
      !isStewardActionPath &&
      !isCommentAction &&
      !isAnnotationAction &&
      !isReadQuery
    ) {
      required = "write";
    }

    // Editor steward bypass for nest-read callers: PATCH/DELETE (and the
    // POST .../revert and .../move actions) allowed when an editor row
    // covers the node; POST to create a node allowed only for nest-scope
    // editors.
    const isNodeAction =
      c.req.method === "POST" &&
      parts.length >= 4 &&
      (parts[parts.length - 1] === "revert" ||
        parts[parts.length - 1] === "move");
    let stewardEditorBypass = false;
    if (required === "write" && permission === "read" && parts[1] === "nodes") {
      const userEmail = await resolveCallerEmail(userId);
      if (
        parts.length >= 3 &&
        (c.req.method === "PATCH" || c.req.method === "DELETE" || isNodeAction)
      ) {
        // Action paths carry a trailing /revert or /move segment — drop it
        // to recover the node id; PATCH/DELETE take the id as-is.
        const idParts = isNodeAction ? parts.slice(2, -1) : parts.slice(2);
        const rawNodeId = idParts.join("/");
        let nodeId = rawNodeId;
        try {
          nodeId = decodeURIComponent(rawNodeId);
        } catch {
          /* malformed escape */
        }
        const resolved = await resolveStewardsForNode(nestId, nodeId);
        stewardEditorBypass = resolved.some(
          (r) =>
            r.steward.userEmail.toLowerCase() === userEmail.toLowerCase() &&
            r.steward.role === "editor",
        );
      } else if (parts.length === 2 && c.req.method === "POST") {
        // Empty nodeId: doc/tag branches won't match; nest branch returns all.
        const resolved = await resolveStewardsForNode(nestId, "");
        stewardEditorBypass = resolved.some(
          (r) =>
            r.steward.userEmail.toLowerCase() === userEmail.toLowerCase() &&
            r.steward.role === "editor" &&
            r.steward.scope === "nest",
        );
      }
    }

    // A share grant on the targeted node counts toward the requirement, but
    // only for that node's routes (grantRole is null elsewhere) and never for
    // nest-management routes. grantNestVisible (bare nest read / filtered list)
    // satisfies the read requirement without conferring write.
    const grantLevel = grantRole
      ? permissionLevel(grantRole)
      : grantNestVisible
        ? permissionLevel("read")
        : 0;
    const effectiveLevel = Math.max(permissionLevel(permission), grantLevel);

    if (
      !stewardEditorBypass &&
      effectiveLevel < permissionLevel(required)
    ) {
      return c.json(
        {
          error: `You don't have access to perform this action on this nest. Required permission: '${required}', your permission: '${permission}'. Ask the nest owner or a server admin to grant you ${required} access.`,
          required_permission: required,
          your_permission: permission,
        },
        403,
      );
    }

    // Downstream sees the grant role when the caller is acting purely via a
    // grant (nest permission "none") — so node handlers treat them correctly.
    c.set(
      "nestPermission",
      permission === "none" && grantRole ? grantRole : permission,
    );
    return next();
  });

  // SECURITY: single containment chokepoint for every node-id-bearing route
  // across the three routers mounted below (governance node ops, annotations,
  // node CRUD). Node ids become filesystem paths in the engine's storage layer
  // (join(nestRoot, id + ".md"), no containment of its own), so a `../` id must
  // be rejected before ANY handler turns it into a read/write/delete — otherwise
  // a caller scoped to one nest reaches another tenant's files. Centralized here
  // (not per-route) so a newly added node route can't silently forget the guard.
  // The greedy {.+} captures the whole remainder incl. any suffix (/versions,
  // /annotations/:id/comments, …); assertSafeNodeId trips on a `..` segment
  // anywhere in it. Non-node routes (create/list POST|GET /nodes) don't match.
  nestsApp.use("/:nestId/nodes/:nodeId{.+}", async (c, next) => {
    assertSafeNodeId(c.req.param("nodeId")!);
    return next();
  });

  // GET /nests/:nestId/trace — the per-nest steward slice of the activity
  // trace: same shape/pagination/filters as GET /admin/trace, but ALWAYS
  // pinned to this nest server-side (a ?nest= query param can't widen it).
  // Authorized for the nest owner / admin collaborators via the same
  // canManageStewards rule the grants + steward-roster routes use (it folds
  // the license admin and super_admins in, and open mode is always allowed).
  // Registered before the sub-routers below so it matches first under the
  // LinearRouter. The nest access middleware above already 404s callers with
  // no access at all; this check downgrades read/write collaborators to 403.
  nestsApp.get("/:nestId/trace", async (c) => {
    const nestId = c.req.param("nestId")!;
    if (!(await canManageStewards(nestId, c.get("userId")))) {
      return c.json(
        {
          error:
            "Only the nest owner, a nest admin, or the server admin can view this nest's activity.",
        },
        403,
      );
    }
    const limitRaw = Number(c.req.query("limit"));
    const offsetRaw = Number(c.req.query("offset"));
    const limit = Number.isFinite(limitRaw) ? limitRaw : 25;
    const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
    const { events, total } = await listTraceEvents({
      limit,
      offset,
      kind: c.req.query("kind") as any,
      nestId, // pinned — the caller cannot query outside their nest
      user: c.req.query("user") || undefined,
    });
    return c.json({ count: events.length, total, limit, offset, events });
  });

  // Nest list/CRUD
  nestsApp.route("/", nestRoutes);

  // Nest-scoped sub-routes
  // Governance nest-level routes (stewards, review-queue)
  nestsApp.route("/:nestId", governanceRoutes);
  // Node-level sub-routers all share the /:nestId/nodes base and rely on a
  // greedy /:nodeId{.+} param (node ids are multi-segment paths). Under the
  // LinearRouter (see createApp) the FIRST registered match wins, so mount
  // order = specificity order, longest/most-specific first:
  //   1. annotationRoutes  — /:nodeId/annotations/:threadId/comments, /hosted.
  //      Must precede governanceNodeRoutes: its greedy POST /:nodeId/comments
  //      would otherwise swallow the annotation reply URL (…/annotations/:id/
  //      comments), capturing "…/annotations/:id" as the node id.
  //   2. governanceNodeRoutes — /:nodeId/{approve,reject,submit-review,comments,…}
  //   3. nodeRoutes — CRUD incl. the bare /:nodeId{.+} catch-all, mounted last
  //      so it only matches when no suffix route did.
  nestsApp.route("/:nestId/nodes", annotationRoutes);
  nestsApp.route("/:nestId/nodes", governanceNodeRoutes);
  nestsApp.route("/:nestId/nodes", nodeRoutes);
  nestsApp.route("/:nestId", queryRoutes);
  nestsApp.route("/:nestId", sharingRoutes);
  nestsApp.route("/:nestId/grants", grantRoutes);
  nestsApp.route("/:nestId/teams", nestTeamRoutes);
  nestsApp.route("/:nestId/edge-types", edgeTypeRoutes);
  nestsApp.route("/:nestId/edges", edgeRoutes);
  nestsApp.route("/:nestId/run", runTriggerRoutes);
  nestsApp.route("/:nestId/runs", runListRoutes);
  nestsApp.route("/:nestId/schedules", scheduleRoutes);
  nestsApp.route("/:nestId/env", envRoutes);
  nestsApp.route("/:nestId/connectors", connectorRoutes);
  nestsApp.route("/:nestId/hooks", hookNestRoutes);
  nestsApp.route("/:nestId/definitions", definitionRoutes);
  nestsApp.route("/:nestId/assets", assetRoutes);
  nestsApp.route("/:nestId/mcp", mcpRoutes);

  app.route("/nests", nestsApp);

  // ─── Dashboard UI (static files served from the bundled dist/web3 dir) ──
  // Hashed asset files are content-addressed — safe to cache forever.
  app.use(
    "/assets/*",
    serveStatic({
      root: UI_DIR_REL,
      onFound: (_p, c) =>
        c.header("Cache-Control", "public, max-age=31536000, immutable"),
    }),
  );
  // index.html is NOT hashed and points at the current bundle — it must never
  // be cached, or a browser keeps loading a stale bundle after every deploy
  // (the workflow-plane UI "not showing up" bug). Always revalidate.
  app.get(
    "*",
    serveStatic({
      root: UI_DIR_REL,
      path: "index.html",
      onFound: (_p, c) => c.header("Cache-Control", "no-cache"),
    }),
  );

  // Error handler — translate common low-level errors into messages
  // the UI can show as-is so users don't see "Internal server error"
  // for predictable failure modes (constraint violations, missing rows,
  // disk/path errors). Anything truly unexpected still falls through
  // to the 500.
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message }, err.statusCode as any);
    }

    const e = err as { code?: string; message?: string };
    const code = e.code;
    const msg = e.message || "";

    // SQLite constraint errors — surface a clear conflict instead of 500.
    if (code === "SQLITE_CONSTRAINT_UNIQUE") {
      let friendly =
        "That conflicts with existing data. Please change a value and try again.";
      if (msg.includes("node_versions")) {
        friendly =
          "A version record for this node already exists. The document may have been recreated with the same name — pick a different title or remove the old node first.";
      } else if (msg.includes("review_requests")) {
        friendly = "A review request for this node already exists.";
      } else if (msg.includes("nests")) {
        friendly = "A nest with that name already exists.";
      } else if (msg.includes("users")) {
        friendly = "An account with that email already exists.";
      } else if (msg.includes("stewards")) {
        friendly = "That steward is already assigned with the same scope.";
      }
      return c.json({ error: friendly }, 409);
    }
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return c.json(
        {
          error:
            "Required related record is missing. Ensure the parent resource still exists.",
        },
        409,
      );
    }
    if (code === "SQLITE_CONSTRAINT_CHECK") {
      return c.json(
        {
          error:
            "Provided value isn't allowed for one of the fields. Double-check your input.",
        },
        400,
      );
    }
    if (code === "SQLITE_CONSTRAINT_NOTNULL") {
      return c.json(
        { error: "A required field is missing. Please fill it in and retry." },
        400,
      );
    }

    // Node filesystem errors when reading/writing nest folders.
    if (code === "ENOENT") {
      return c.json(
        { error: "The requested file or folder doesn't exist." },
        404,
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      return c.json(
        { error: "Server doesn't have permission to access that file." },
        500,
      );
    }
    if (code === "ENOSPC") {
      return c.json(
        { error: "Out of disk space on the server. Free up space and retry." },
        507,
      );
    }

    // JSON / body parse failures — Hono surfaces SyntaxError.
    if (err instanceof SyntaxError && msg.toLowerCase().includes("json")) {
      return c.json({ error: "Request body isn't valid JSON." }, 400);
    }

    console.error("Unhandled error:", err);
    return c.json(
      {
        error:
          "Something went wrong on the server. Try again — if it keeps failing, check the server log.",
      },
      500,
    );
  });

  return app;
}
