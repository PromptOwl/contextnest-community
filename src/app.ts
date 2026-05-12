import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { authRoutes } from "./auth/routes.js";
import { nestRoutes } from "./nests/routes.js";
import { sharingRoutes } from "./nests/sharing-routes.js";
import { nodeRoutes } from "./nodes/routes.js";
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
import { isSuspended, getSuspensionReason } from "./auth/license.js";
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

// In key mode, try Bearer token first. If present, validate it.
// If absent, fall through to open behavior (so open mode clients still work).
const flexAuthMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer cnst_")) {
    // Delegate to the real auth middleware
    return authMiddleware(c, next);
  }

  if (config.AUTH_MODE === "open") {
    const anonId = ensureAnonymousUser();
    c.set("userId", anonId);
    c.set("nestScope", null);
    return next();
  }

  return c.json({ error: "Missing or invalid API key" }, 401);
});

export function createApp(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Global middleware
  app.use("*", logger());
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
      ...(isSuspended() && { suspended_reason: getSuspensionReason() }),
    }),
  );

  // Auth routes (always available — admin can create keys even in open mode)
  app.route("/auth", authRoutes);

  // === All /nests routes ===
  const nestsApp = new Hono<AuthEnv>();

  // Use flexible auth: open mode = no key needed, key mode = key required
  nestsApp.use("*", flexAuthMiddleware);

  // Access control for nest-scoped routes
  nestsApp.use("*", async (c, next) => {
    const localPath = c.req.path.replace(/^\/nests\//, "");
    const parts = localPath.split("/").filter(Boolean);
    if (parts.length < 2) return next();

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
    if (
      path.includes("/collaborators") ||
      path.includes("/visibility")
    ) {
      required = "admin";
    } else if (c.req.method !== "GET") {
      required = "write";
    }

    if (permissionLevel(permission) < permissionLevel(required)) {
      return c.json({ error: "Insufficient permissions" }, 403);
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
  nestsApp.route("/:nestId/nodes", nodeRoutes);
  nestsApp.route("/:nestId", queryRoutes);
  nestsApp.route("/:nestId", sharingRoutes);
  nestsApp.route("/:nestId/mcp", mcpRoutes);

  app.route("/nests", nestsApp);

  // ─── Dashboard UI (static files served from the bundled dist/web3 dir) ──
  app.use("/assets/*", serveStatic({ root: UI_DIR_REL }));
  app.get("*", serveStatic({ root: UI_DIR_REL, path: "index.html" }));

  // Error handler
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message }, err.statusCode as any);
    }
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
