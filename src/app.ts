import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";
import { authRoutes } from "./auth/routes.js";
import { nestRoutes } from "./nests/routes.js";
import { sharingRoutes } from "./nests/sharing-routes.js";
import { listNests, listSharedNests } from "./nests/service.js";
import { engineCache } from "./nodes/engine.js";
import { resolveCallerEmail, filterAccessible } from "./governance/access-guard.js";
import {
  resolveStewardsForNode,
  canManageStewards,
} from "./governance/stewardship-service.js";
import { nodeRoutes } from "./nodes/routes.js";
import { annotationRoutes } from "./annotations/routes.js";
import { queryRoutes } from "./nodes/query-routes.js";
import { mcpRoutes } from "./mcp/routes.js";
import { governanceRoutes, governanceNodeRoutes } from "./governance/routes.js";
import { authMiddleware, type AuthEnv } from "./auth/middleware.js";
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
  const anonId = ensureAnonymousUser();
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
  return !/\/(collaborators|visibility|settings|mcp)/.test(path);
}

const flexAuthMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const hasBearer = c.req.header("Authorization")?.startsWith("Bearer cnst_");
  const hasCookie = !!c.req.header("Cookie")?.includes("cnst_session=");
  if (hasBearer || hasCookie) {
    return authMiddleware(c, next);
  }

  if (config.AUTH_MODE === "open") {
    const anonId = ensureAnonymousUser();
    c.set("userId", anonId);
    c.set("nestScope", null);
    return next();
  }

  if (isPublicReadEligiblePath(c.req.method, c.req.path)) {
    const anonId = ensureAnonymousUser();
    c.set("userId", anonId);
    c.set("nestScope", null);
    return next();
  }

  return c.json({ error: "Missing or invalid credentials" }, 401);
});

export function createApp(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

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

  // PATCH /admin/sign-in-gate — admin toggles the PromptOwl sign-in gate
  // (open | admin-only | disabled). Takes effect live (process.env, which the
  // config getter reads) and is persisted to ENV_FILE_PATH so it survives a
  // restart. In open mode the anonymous admin may set it; in key mode it's
  // restricted to the license admin.
  app.use("/admin/sign-in-gate", flexAuthMiddleware);
  app.patch("/admin/sign-in-gate", async (c) => {
    const userId = c.get("userId");
    const isOpen = config.AUTH_MODE === "open";
    if (!isOpen && !isLicenseAdminUserId(userId)) {
      return c.json({ error: "Only the server admin can change this." }, 403);
    }
    let body: { value?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const value = (body?.value || "").trim().toLowerCase();
    if (!["open", "admin-only", "disabled"].includes(value)) {
      return c.json(
        { error: "value must be one of: open, admin-only, disabled" },
        400,
      );
    }
    process.env.PROMPTOWL_SIGN_IN_GATE = value;
    let persisted = true;
    let persistError: string | null = null;
    try {
      upsertEnvVar(config.ENV_FILE_PATH, "PROMPTOWL_SIGN_IN_GATE", value);
    } catch (e) {
      persisted = false;
      persistError = e instanceof Error ? e.message : String(e);
    }
    return c.json({
      promptowl_sign_in_gate: config.PROMPTOWL_SIGN_IN_GATE,
      persisted,
      persistError,
    });
  });

  // GET /stats — dashboard summary counts: nests visible to caller,
  // documents across those nests, total users on the server. Uses
  // flexAuthMiddleware so it works without auth in open mode and with
  // a Bearer/cookie in key mode.
  app.use("/stats", flexAuthMiddleware);
  app.get("/stats", async (c) => {
    const db = getDb();
    const userId = c.get("userId");
    const userEmail = resolveCallerEmail(userId);

    const visibleNests = [...listNests(userId), ...listSharedNests(userId)];

    // Count accessible documents across every nest the caller can see.
    // Mirrors the per-nest filterAccessible logic used by GET /nests/:id/nodes
    // so stewardship-gated docs don't inflate the total for non-stewards.
    let documents = 0;
    for (const nest of visibleNests) {
      try {
        const { storage } = engineCache.get(nest.id);
        const docs = await storage.discoverDocuments();
        documents += filterAccessible(nest.id, userId, userEmail, docs).length;
      } catch {
        // Nest with filesystem issue — skip; don't break the whole count.
      }
    }

    const usersRow = db
      .prepare("SELECT COUNT(*) as c FROM users")
      .get() as { c: number };

    return c.json({
      nests: visibleNests.length,
      documents,
      users: usersRow.c,
    });
  });

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

    const permission = resolveNestPermission(nestId, userId);
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
    // server (license) admin: not nest owners or collaborators. All methods
    // on /nests/:id/stewards are locked. The node-level resolve route
    // (/nodes/:id/stewards) stays readable so the editor UI can resolve a
    // caller's per-node role.
    const isStewardRoster =
      path.includes("/stewards") && !path.includes("/nodes/");
    if (isStewardRoster && !canManageStewards(resolveCallerEmail(userId))) {
      return c.json(
        {
          error:
            "You don't have permission to manage stewards. Only the super admin can do this.",
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
      const userEmail = resolveCallerEmail(userId);
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
        const resolved = resolveStewardsForNode(nestId, nodeId);
        stewardEditorBypass = resolved.some(
          (r) =>
            r.steward.userEmail.toLowerCase() === userEmail.toLowerCase() &&
            r.steward.role === "editor",
        );
      } else if (parts.length === 2 && c.req.method === "POST") {
        // Empty nodeId: doc/tag branches won't match; nest branch returns all.
        const resolved = resolveStewardsForNode(nestId, "");
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

  // Nest list/CRUD
  nestsApp.route("/", nestRoutes);

  // Nest-scoped sub-routes
  // Governance nest-level routes (stewards, review-queue)
  nestsApp.route("/:nestId", governanceRoutes);
  // Governance node-level routes (approve, reject, submit-review, versions, etc.)
  // Must be mounted BEFORE nodeRoutes because nodeRoutes has a greedy /:nodeId{.+} catch-all.
  // POST routes work fine (Hono matches method+path), but GET routes clash.
  // Solution: mount governance node routes and node CRUD on the same Hono instance.
  nestsApp.route("/:nestId/nodes", governanceNodeRoutes);
  // Annotations + sandboxed artifact serving — must precede the greedy
  // nodeRoutes catch-all so /:nodeId/annotations and /:nodeId/hosted match.
  nestsApp.route("/:nestId/nodes", annotationRoutes);
  nestsApp.route("/:nestId/nodes", nodeRoutes);
  nestsApp.route("/:nestId", queryRoutes);
  nestsApp.route("/:nestId", sharingRoutes);
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
