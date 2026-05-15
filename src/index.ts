#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { getDb } from "./db/client.js";
import { validateLicense, startLicenseWatcher } from "./auth/license.js";
import { startTelemetryLoop, trackEvent } from "./telemetry/tracker.js";
import { loadAccessConfig } from "./governance/access-service.js";

async function main() {
  // Initialize SQLite
  getDb();

  // Load access control config (if present)
  const accessCfg = loadAccessConfig();
  if (accessCfg) {
    console.log(`  Loaded access.yaml (mode: ${accessCfg.mode || "open"})`);
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

  const app = createApp();

  // Start long-poll watcher so deactivations/revocations from PromptOwl
  // propagate within seconds instead of next restart.
  startLicenseWatcher();

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

  console.log(`
  ContextNest Community Server v0.1.0
  ────────────────────────────────────
  Port:      ${config.PORT}
  Data:      ${config.DATA_ROOT}
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
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
