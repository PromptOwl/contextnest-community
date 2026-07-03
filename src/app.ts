import { Hono } from "hono";
import { LinearRouter } from "hono/router/linear-router";
import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";
import { authRoutes } from "./auth/routes.js";
import { nestRoutes } from "./nests/routes.js";
import { sharingRoutes } from "./nests/sharing-routes.js";
import { listNests, listSharedNests } from "./nests/service.js";
import { engineCache } from "./nodes/engine.js";
import { resolveCallerEmail, filterAccessible } from "./governance/access-guard.js";
import { resolveStewardsForNode } from "./governance/stewardship-service.js";
import { nodeRoutes } from "./nodes/routes.js";
import { annotationRoutes } from "./annotations/routes.js";
import { queryRoutes } from "./nodes/query-routes.js";
import { mcpRoutes } from "./mcp/routes.js";
import { assetRoutes } from "./nests/asset-routes.js";
import { logTraceEvent, listTraceEvents } from "./telemetry/trace-log.js";
import { isSuperAdmin } from "./governance/access-service.js";
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
  type NestPermission,
} from "./shared/access.js";
import { AppError } from "./shared/errors.js";
import { config } from "./config.js";
import { getDb } from "./db/client.js";
import { ensureAnonymousUser } from "./auth/anonymous.js";
import {
  isSuspended,
  getSuspensionReason,
  getCurrentLicense,
  installLicenseKey,
  isLicenseAdminUserId,
  upsertEnvVar,
} from "./auth/license.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { existsSync } from "node:fs";

// Resolve UI static files. In built mode this file lives at dist/index.js,
// so siblings of __dirname include dist/web3. In dev (`tsx src/index.ts`)
// __dirname is src/, which has no web3 — fall back to <cwd>/dist/web3
// (vite build output) so `npm run dev` serves the freshly-built bundle.
// serveStatic wants a path relative to CWD.
const HERE = dirname(fileURLToPath(import.meta.url));
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
  // LinearRouter, not the default RegExpRouter. Node ids are multi-segment
  // paths ("nodes/<folder>/<slug>") captured by greedy `/:nodeId{.+}` params.
  // RegExpRouter merges all same-method routes into one automaton and, for a
  // node id spanning >1 segment, lets the bare `/:nodeId{.+}` catch-all win
  // over suffix routes like `/:nodeId{.+}/hosted` or `/versions` — so opening
  // a foldered artifact 404s ("Node not found: …/hosted"). LinearRouter matches
  // in registration order with correct per-route backtracking, so the suffix
  // routes (mounted first) match regardless of id depth. Route count is small
  // and QPS low, so the linear scan cost is negligible here.
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
  app.get("/health", (c) =>
    c.json({
      status: isSuspended() ? "suspended" : "ok",
      service: "contextnest-community",
      version: "0.1.0",
      auth_mode: config.AUTH_MODE,
      logo_url: config.LOGO_URL,
      promptowl_sign_in_gate: config.PROMPTOWL_SIGN_IN_GATE,
      ...(isSuspended() && { suspended_reason: getSuspensionReason() }),
    }),
  );

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
        // The key validated and is live now, but if it couldn't be written to
        // disk it'll be lost on restart — surface that instead of pretending
        // the setup is durable (the old behavior silently swallowed this).
        persisted: info.persisted,
        ...(info.persisted
          ? {}
          : {
              warning: `License validated, but it could not be saved to disk (${
                info.persistError || "unknown error"
              }). It will be LOST on the next restart. Set ENV_FILE_PATH to a writable, persisted path (e.g. under DATA_ROOT) or provide PROMPTOWL_KEY via the container environment.`,
            }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to install key";
      return c.json({ error: msg }, 500);
    }
  });

  // /admin/settings — server-wide settings the admin edits from the Settings
  // page. Each setting takes effect live (config getters read process.env) and
  // persists to ENV_FILE_PATH so it survives a restart. In open mode the
  // anonymous admin may edit; in key mode it's the license admin only.
  app.use("/admin/settings", flexAuthMiddleware);
  const adminSettingsAllowed = async (c: any) =>
    config.AUTH_MODE === "open" ||
    (await isLicenseAdminUserId(c.get("userId")));
  const currentServerSettings = () => ({
    promptowl_sign_in_gate: config.PROMPTOWL_SIGN_IN_GATE,
    logo_url: config.LOGO_URL,
    telemetry_enabled: config.TELEMETRY_ENABLED,
    public_base_url: config.PUBLIC_BASE_URL,
    max_body_bytes: config.MAX_BODY_BYTES,
    slack_webhook_url: config.SLACK_WEBHOOK_URL ?? "",
  });

  app.get("/admin/settings", async (c) => {
    if (!(await adminSettingsAllowed(c)))
      return c.json({ error: "Only the server admin can view this." }, 403);
    return c.json(currentServerSettings());
  });

  app.patch("/admin/settings", async (c) => {
    if (!(await adminSettingsAllowed(c)))
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
    const errors: string[] = [];
    const pending: Array<{ name: string; value: string | null }> = [];

    if ("promptowl_sign_in_gate" in body) {
      const v = String(body.promptowl_sign_in_gate ?? "").trim().toLowerCase();
      if (!["open", "admin-only", "disabled"].includes(v))
        errors.push("promptowl_sign_in_gate must be open | admin-only | disabled");
      else pending.push({ name: "PROMPTOWL_SIGN_IN_GATE", value: v });
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
    if ("slack_webhook_url" in body) {
      const v = String(body.slack_webhook_url ?? "").trim();
      // Empty clears (connector off). A webhook URL carries an implicit
      // secret in its path — https only.
      if (v && !/^https:\/\//i.test(v))
        errors.push("slack_webhook_url must be an https:// URL (or empty to disable)");
      else pending.push({ name: "SLACK_WEBHOOK_URL", value: v || null });
    }
    if ("max_body_bytes" in body) {
      const n = Number(body.max_body_bytes);
      if (!Number.isFinite(n) || n < 1024 * 1024 || n > 500 * 1024 * 1024)
        errors.push("max_body_bytes must be between 1MB and 500MB");
      else pending.push({ name: "MAX_BODY_BYTES", value: String(Math.floor(n)) });
    }

    // Reject the whole request if any field failed validation — apply nothing.
    if (errors.length)
      return c.json({ error: errors.join("; "), settings: currentServerSettings() }, 400);

    // All valid: persist first, then mutate live env. Ordering persist-before-
    // live means a disk failure aborts before the running server changes, so a
    // 500 never leaves a live setting that was never written to disk.
    for (const { name, value } of pending) {
      try {
        upsertEnvVar(config.ENV_FILE_PATH, name, value);
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
  // only (license admin OR access.yaml super_admin) — cross-tenant data.
  app.use("/admin/trace", flexAuthMiddleware);
  const traceAllowed = async (c: any) => {
    if (config.AUTH_MODE === "open") return true;
    const userId = c.get("userId");
    if (await isLicenseAdminUserId(userId)) return true;
    return isSuperAdmin(await resolveCallerEmail(userId));
  };
  app.get("/admin/trace", async (c) => {
    if (!(await traceAllowed(c)))
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

  // GET /stats — dashboard summary counts: nests visible to caller,
  // documents across those nests, total users on the server. Uses
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
        isActivityPath;
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
    if (permission === "none") {
      return c.json({ error: "Nest not found" }, 404);
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
    } else if (
      c.req.method !== "GET" &&
      !isStewardActionPath &&
      !isCommentAction &&
      !isAnnotationAction
    ) {
      required = "write";
    }

    // Editor steward bypass for nest-read callers: PATCH/DELETE (and the
    // POST .../revert action) allowed when an editor row covers the node;
    // POST to create a node allowed only for nest-scope editors.
    const isNodeRevert =
      c.req.method === "POST" &&
      parts.length >= 4 &&
      parts[parts.length - 1] === "revert";
    let stewardEditorBypass = false;
    if (required === "write" && permission === "read" && parts[1] === "nodes") {
      const userEmail = await resolveCallerEmail(userId);
      if (
        parts.length >= 3 &&
        (c.req.method === "PATCH" || c.req.method === "DELETE" || isNodeRevert)
      ) {
        // Revert path carries a trailing /revert segment — drop it to
        // recover the node id; PATCH/DELETE take the id as-is.
        const idParts = isNodeRevert ? parts.slice(2, -1) : parts.slice(2);
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

    if (
      !stewardEditorBypass &&
      permissionLevel(permission) < permissionLevel(required)
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

    c.set("nestPermission", permission);
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
  nestsApp.route("/:nestId/assets", assetRoutes);
  nestsApp.route("/:nestId/mcp", mcpRoutes);

  app.route("/nests", nestsApp);

  // ─── Dashboard UI (static files served from the bundled dist/web3 dir) ──
  app.use("/assets/*", serveStatic({ root: UI_DIR_REL }));
  app.get("*", serveStatic({ root: UI_DIR_REL, path: "index.html" }));

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
