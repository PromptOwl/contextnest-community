#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { initDb } from "./db/client.js";
import { loadServerSettings } from "./db/settings.js";
import {
  backfillNodeVersionsFromHistory,
  backfillNotificationTitles,
} from "./db/backfill.js";
import {
  validateLicense,
  startLicenseSafetyPoll,
} from "./auth/license.js";
import { startTelemetryLoop, trackEvent } from "./telemetry/tracker.js";
import {
  loadAccessConfig,
  loadGrantedSuperAdmins,
} from "./governance/access-service.js";
import { startDriftScanner } from "./governance/external-edit-service.js";
import { startScheduler } from "./workflow/scheduler.js";
import { sweepStale } from "./shared/rate-limit.js";

async function main() {
  // Initialize the database backend (SQLite by default, or Postgres/Cloud SQL
  // when configured) and run migrations before anything touches the DB.
  const db = await initDb();

  // Overlay durable, DB-backed server settings (admin Settings + the installed
  // license key) onto process.env before anything reads config. This is what
  // makes those values survive a Cloud Run rebuild and stay consistent across
  // instances (see db/settings.ts). MUST run before validateLicense() below,
  // since PROMPTOWL_KEY may be one of the persisted settings.
  try {
    const loaded = await loadServerSettings();
    if (loaded > 0) {
      console.log(`  Loaded ${loaded} persisted server setting(s) from the database`);
    }
  } catch (err) {
    console.error("[settings] failed to load persisted server settings:", err);
  }

  // One-shot: catch historic nests up where engine history.yaml ran
  // ahead of node_versions (pre-fix steward approvals). Gated by
  // schema_migrations so it only runs once per deployment.
  try {
    await backfillNodeVersionsFromHistory(db);
  } catch (err) {
    console.error("[backfill] node_versions backfill failed:", err);
  }

  // One-shot: rewrite historic inbox messages that embed a raw node id
  // (pre-fix notify-service composed them from the storage path).
  try {
    await backfillNotificationTitles(db);
  } catch (err) {
    console.error("[backfill] notification title backfill failed:", err);
  }

  // Load access control config (if present)
  const accessCfg = loadAccessConfig();
  if (accessCfg) {
    console.log(`  Loaded access.yaml (mode: ${accessCfg.mode || "open"})`);
  }

  // Load DB-granted superadmins into the in-memory cache that keeps
  // isSuperAdmin() synchronous. Refreshed on every grant/revoke write; a
  // failure here must not stop the server (access.yaml admins still work).
  try {
    await loadGrantedSuperAdmins();
  } catch (err) {
    console.error("[access] failed to load DB-granted superadmins:", err);
  }

  // Validate PromptOwl license key (non-blocking — server runs either way)
  const license = await validateLicense();

  if (!license.valid) {
    console.warn(`
  WARNING: No valid PromptOwl license key found.
  Server boots in SETUP MODE — writes return 503 and admin features
  (stewards, teammates, governance) are locked until a key is installed.

  To activate:
    1. Sign up at https://app.promptowl.ai
    2. Open Overview > Community License
    3. Generate a key
    4. Paste it into the setup screen (UI) or POST /license/install,
       or set PROMPTOWL_KEY=pk_... in your environment and restart.
`);
  }

  // One-click SSO hardening: the audience check is the cross-server replay
  // guard, but it can only run when PUBLIC_BASE_URL is set. Warn loudly if the
  // shared secret is configured without it — otherwise any validly-signed
  // ticket would be accepted regardless of its intended audience.
  if (config.OFFICIAL_COMMUNITY_SSO_SECRET && !config.PUBLIC_BASE_URL) {
    console.warn(`
      WARNING: OFFICIAL_COMMUNITY_SSO_SECRET is set but PUBLIC_BASE_URL is not.
      One-click SSO will skip the audience check, weakening cross-server replay
      protection. Set PUBLIC_BASE_URL to this server's public URL.
    `);
  }

  const app = createApp();

  // Periodic forceFresh revalidate (60s) so PromptOwl-side
  // deactivations/revocations propagate without a restart.
  startLicenseSafetyPoll();

  // Periodic drift scanner: detects out-of-band file edits and stages
  // them as suggestions for approval (bridge-function-spec Story 3.1).
  // Explicit parse so DRIFT_SCAN_INTERVAL_MS=0 actually disables the scanner
  // (a plain `Number(...) || 30_000` would treat 0 as falsy and reset to the
  // default — disabling is exactly what a GCS FUSE mount needs). Unset / empty
  // / non-numeric falls back to the 30s default.
  const driftRaw = process.env.DRIFT_SCAN_INTERVAL_MS;
  const driftScanIntervalMs =
    driftRaw != null && driftRaw !== "" && Number.isFinite(Number(driftRaw))
      ? Number(driftRaw)
      : 30_000;
  if (driftScanIntervalMs > 0) {
    startDriftScanner(driftScanIntervalMs);
  }

  // Start telemetry
  startTelemetryLoop();
  trackEvent("server.start", {
    tier: license.tier,
    org: license.org,
    licensed: license.valid,
  });

  const authDesc =
    config.AUTH_MODE === "open"
      ? "open (no auth — single-user / LAN only)"
      : "key (API key required on every request)";

  const dbDesc =
    db.dialect === "postgres"
      ? `postgres (${config.CLOUD_SQL_CONNECTION_NAME ? `cloudsql ${config.CLOUD_SQL_CONNECTION_NAME}` : config.DATABASE_URL ? "DATABASE_URL" : `${config.DB_HOST || "localhost"}:${config.DB_PORT}/${config.DB_NAME}`})`
      : `sqlite (${config.DATABASE_PATH})`;

  console.log(`
  ContextNest Community Server v0.1.0
  ────────────────────────────────────
  Port:      ${config.PORT}
  Data:      ${config.DATA_ROOT}
  Database:  ${dbDesc}
  License:   ${license.valid ? `${license.tier}${license.org ? ` (${license.org})` : ""}` : "unlicensed (register at promptowl.ai)"}
  Auth:      ${authDesc}
  Telemetry: ${config.TELEMETRY_ENABLED ? "on" : "off"}
  ────────────────────────────────────

  To switch auth modes, set the AUTH_MODE env var:
    AUTH_MODE=key    — default, safe for public/multi-user deployments
    AUTH_MODE=open   — no auth, local/single-user only

  Full reference: apps/community-server/CONFIGURATION.md

  Ready! Endpoints:
    GET  /nests                  List nests
    POST /nests                  Create nest
    GET  /nests/:id/nodes        List nodes
    POST /nests/:id/nodes        Create node
    POST /nests/:id/query        Selector query
    POST /nests/:id/context      One-call context retrieval
    GET  /nests/:id/search?q=    Full-text search
    POST /nests/:id/publish      Bulk publish
    POST /nests/:id/mcp          MCP endpoint
    GET  /health                 Health check
${config.AUTH_MODE === "key" ? `
  Auth endpoints:
    POST /auth/register          Create account
    POST /auth/login             Login
    POST /auth/device            PromptOwl device auth
    POST /auth/promptowl         Exchange PromptOwl token
` : ""}`);

  if (config.AUTH_MODE === "open") {
    console.warn(`
  ⚠️  Running in open mode — no authentication.
     Anyone who can reach this port has full read/write + admin access.
     Bind to 127.0.0.1 only, or switch to AUTH_MODE=key before exposing.
`);
  }

  serve({ fetch: app.fetch, port: config.PORT });

  // Workflow-plane interval schedules → run rows (no-op unless the flag is on).
  startScheduler();

  // Rate-limit bucket GC — bounded keys can still accumulate across a long
  // uptime; sweep expired buckets every 10 minutes.
  setInterval(() => sweepStale(), 10 * 60_000).unref?.();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
