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

// In key mode, try a real credential (cookie session OR Bearer key) first.
// If present, validate via the real auth middleware. If absent, fall back
// to open behavior so anonymous open-mode clients still work.
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

  return c.json({ error: "Missing or invalid credentials" }, 401);
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
