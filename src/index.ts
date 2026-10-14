#!/usr/bin/env node
// First: snapshot the env Node's networking reads at start, before config.ts loads .env.
import "./shared/boot-env.js";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { initDb } from "./db/client.js";
import { loadServerSettings } from "./db/settings.js";
import {
  backfillNodeVersionsFromHistory,
  backfillNotificationTitles,
} from "./db/backfill.js";
import { repairGraftedVersionChains } from "./db/repair-version-chains.js";
import {
  validateLicense,
  startLicenseSafetyPoll,
} from "./auth/license.js";
import { moveStoredAnthropicKey } from "./shared/model-credential.js";
import { startTelemetryLoop, trackEvent } from "./telemetry/tracker.js";
import {
  loadAccessConfig,
  loadGrantedSuperAdmins,
} from "./governance/access-service.js";
import { loadActiveCommunitySites } from "./auth/community-sites.js";
import { startDriftScanner } from "./governance/external-edit-service.js";
import { startScheduler } from "./workflow/scheduler.js";
import { startRunRetention } from "./workflow/run-retention.js";
import { startReviewSlaLoop } from "./governance/review-sla.js";
import { sweepStale } from "./shared/rate-limit.js";
import { purgeExpired as purgeExpiredOAuth } from "./auth/oauth-store.js";
import { bannerHeading } from "./shared/startup-banner.js";
import { currentEgressProxyStatus, currentExtraCaStatus, networkStartupLines } from "./shared/egress-proxy.js";
import { parseTrustedProxies } from "./shared/trusted-proxies.js";
import { FREE_TIER_MAX_USERS } from "./auth/free-tier.js";

async function main() {
  // Refuse to boot on a malformed TRUSTED_PROXIES rather than guess who to trust.
  parseTrustedProxies(config.TRUSTED_PROXIES);

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

  // One-shot: re-anchor documents whose version chain was grafted by an import
  // that reused live version numbers, so their current version reads again.
  // Also gated by schema_migrations.
  try {
    await repairGraftedVersionChains(db);
  } catch (err) {
    console.error("[repair] version chain repair failed:", err);
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

  // Load active official community sites into the in-memory cache GET
  // /auth/sso reads synchronously. Refreshed on every admin write; a failure
  // here must not stop the server (the legacy env-var pair still works).
  try {
    await loadActiveCommunitySites();
  } catch (err) {
    console.error("[sso] failed to load community sites:", err);
  }

  // Validate PromptOwl license key (non-blocking — server runs either way).
  // Ask PromptOwl at boot rather than trusting the 24h cache, so a restart
  // can't hide a suspension; unreachable falls back to the cache as before.
  const license = await validateLicense({ forceFresh: true });

  await moveStoredAnthropicKey();

  if (!license.valid) {
    console.warn(`
  WARNING: No valid PromptOwl license key found.
  Free tier: writes, governance and teammate management stay open while
  the server has ${FREE_TIER_MAX_USERS} or fewer users (viewers are free and never count).
  Past that, writes return 503 until a key is installed.

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
  ${bannerHeading()}
  ────────────────────────────────────
  Port:      ${config.PORT}${config.HOST ? ` (listening on ${config.HOST} only)` : ""}
  Data:      ${config.DATA_ROOT}
  Database:  ${dbDesc}
  License:   ${license.valid ? `${license.tier}${license.org ? ` (${license.org})` : ""}` : "unlicensed (register at promptowl.ai)"}
  Auth:      ${authDesc}
  Telemetry: ${config.TELEMETRY_ENABLED ? "on" : "off"}
  Hootie:    ${config.HOOTIE_ENABLED ? "on" : "off (default since 1.28 — enable in Settings → General or set HOOTIE_ENABLED=true)"}
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
    GET  /search?q=              Search every nest you can see
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
     Set HOST=127.0.0.1 to listen locally only, or switch to AUTH_MODE=key before exposing.
`);
  }

  const net = networkStartupLines(currentEgressProxyStatus(), currentExtraCaStatus());
  for (const line of net.info) console.log(line);
  for (const line of net.warn) console.warn(line);
  // Cloud Run (K_SERVICE) always fronts the server with Google's proxy, so the
  // legacy trust-all default is right there; elsewhere, nudge once.
  if (!config.TRUSTED_PROXIES && !process.env.K_SERVICE) {
    console.warn(
      "  ⚠️  X-Forwarded-For / X-Forwarded-Proto are trusted from any client. Behind a reverse proxy, set\n" +
      "     TRUSTED_PROXIES (e.g. loopback or 10.0.0.0/8). If this server is exposed directly, set it to\n" +
      "     loopback so clients can't spoof their IP or scheme. See CONFIGURATION.md → Reverse proxies.",
    );
  }

  if (config.MANUAL_SIGN_IN_OPEN_WITH_SSO) {
    console.warn(`
      ⚠️  MANUAL_SIGN_IN=open while single sign-on (OIDC) is on.
        Anyone who can reach this server can register a password account the
        identity provider never sees and can't disable. Unset MANUAL_SIGN_IN (it
        defaults to invite-only with SSO) or set it to invite-only or disabled.
    `);
  }
  if (config.HOOTIE_DEBUG_LOG) {
    console.warn(`
      ⚠️  HOOTIE_DEBUG_LOG is on — every Hootie prompt and answer, including the
        nest documents behind it, is written to the logs. Testing only.
    `);
  }

  serve({ fetch: app.fetch, port: config.PORT, ...(config.HOST ? { hostname: config.HOST } : {}) });

  // Workflow-plane interval schedules → run rows (no-op unless the flag is on).
  startScheduler();
  startRunRetention();

  // Review SLA escalation (per-nest review_sla_hours). Independent of the
  // workflow plane — that loop above is a no-op unless its flag is on, and
  // review governance isn't. Inert while no nest sets an SLA.
  startReviewSlaLoop();

  // Metacognition runs execute in this process; any still "running" from a
  // previous process lost their loop. Close them so the agents aren't stuck.
  if (config.FEATURE_METACOGNITION) {
    void import("./metacognition/service.js")
      .then((m) => m.recoverOrphanedRuns())
      .then((n) => n && console.log(`[metacognition] closed ${n} run(s) left running by a previous process`))
      .catch((err) => console.error("[metacognition] orphan sweep failed", err));
  }

  // Rate-limit bucket GC — bounded keys can still accumulate across a long
  // uptime; sweep expired buckets every 10 minutes.
  setInterval(() => sweepStale(), 10 * 60_000).unref?.();

  // MCP OAuth: drop codes and tokens that can never be used again.
  setInterval(() => {
    purgeExpiredOAuth().catch((err) => console.error("[oauth] purge failed", err));
  }, 60 * 60_000).unref?.();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
