import { join, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// ── .env loading ────────────────────────────────────────────────────────
// Load .env before any getter reads process.env. Try cwd first (typical
// dev: `npm run dev` from project root), then fall back to the directory
// next to the compiled entrypoint (packaged `node dist/index.js` runs).
// override: true so .env wins over stale OS-level vars — EXCEPT under
// vitest, where each test sets DATA_ROOT/PROMPTOWL_KEY before
// vi.resetModules() re-imports this file; overriding would clobber
// that test setup and the suite would all read the dev .env values.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envCandidates = [
  join(process.cwd(), ".env"),
  join(__dirname, "..", ".env"),
];
const envFileLoaded = envCandidates.find((p) => existsSync(p)) || null;
const isTestRun = !!process.env.VITEST;
if (envFileLoaded && !isTestRun) {
  dotenv.config({ path: envFileLoaded, override: true });
}
// Canonical, app-managed env file — the same path the license install flow
// writes PROMPTOWL_KEY into (see ENV_FILE_PATH). It lives under DATA_ROOT (the
// mounted volume) so a key persisted in a container survives restart. Loaded
// last + override so the persisted key wins; skipped if it's the file already
// loaded above (dev) to avoid a redundant pass.
const canonicalEnvFile = process.env.ENV_FILE_PATH || join(dataRoot(), ".env");
let canonicalEnvLoaded: string | null = null;
if (
  !isTestRun &&
  canonicalEnvFile !== envFileLoaded &&
  existsSync(canonicalEnvFile)
) {
  dotenv.config({ path: canonicalEnvFile, override: true });
  canonicalEnvLoaded = canonicalEnvFile;
}
if (!isTestRun) {
  console.log(
    `[config] dotenv: ${envFileLoaded ? `loaded ${envFileLoaded}` : "no .env file found"}` +
      (canonicalEnvLoaded ? ` + ${canonicalEnvLoaded}` : ""),
  );
}

function dataRoot() {
  return process.env.DATA_ROOT || join(process.cwd(), "data");
}

export const config = {
  get PORT() {
    return parseInt(process.env.PORT || "3838", 10);
  },
  get DATA_ROOT() {
    return dataRoot();
  },
  get DATABASE_PATH() {
    return (
      process.env.DATABASE_PATH || join(dataRoot(), "community.db")
    );
  },
  /**
   * Root directory for nest vault files. Defaults to `<DATA_ROOT>/nests`.
   * Override (e.g. a GCS volume mount on Cloud Run) to store nest files
   * separately from the SQLite DB. See `src/shared/paths.ts`.
   */
  get NEST_STORAGE_ROOT() {
    return process.env.NEST_STORAGE_ROOT || join(dataRoot(), "nests");
  },
  /**
   * Which database backend to use.
   *   "sqlite"   — default; the on-disk file at DATABASE_PATH (existing behaviour).
   *   "postgres" — Cloud SQL / PostgreSQL, for durable Cloud Run deployments.
   * Explicit DB_DRIVER wins; otherwise we infer "postgres" when a connection
   * is configured (DATABASE_URL or CLOUD_SQL_CONNECTION_NAME), else "sqlite".
   * So existing deployments with no new env vars keep using SQLite untouched.
   */
  get DB_DRIVER(): "sqlite" | "postgres" {
    const v = (process.env.DB_DRIVER || "").trim().toLowerCase();
    if (v === "postgres" || v === "postgresql" || v === "pg") return "postgres";
    if (v === "sqlite") return "sqlite";
    return process.env.DATABASE_URL || process.env.CLOUD_SQL_CONNECTION_NAME
      ? "postgres"
      : "sqlite";
  },
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/db (TCP). */
  get DATABASE_URL(): string {
    return process.env.DATABASE_URL || "";
  },
  /**
   * Cloud SQL instance connection name (project:region:instance). When set,
   * the server connects over the unix socket at /cloudsql/<name> created by
   * the Cloud SQL Auth Proxy (the recommended Cloud Run setup). Combine with
   * DB_USER / DB_PASSWORD / DB_NAME.
   */
  get CLOUD_SQL_CONNECTION_NAME(): string {
    return process.env.CLOUD_SQL_CONNECTION_NAME || "";
  },
  get DB_HOST(): string {
    return process.env.DB_HOST || "";
  },
  get DB_PORT(): number {
    return parseInt(process.env.DB_PORT || "5432", 10);
  },
  get DB_USER(): string {
    return process.env.DB_USER || "";
  },
  get DB_PASSWORD(): string {
    return process.env.DB_PASSWORD || "";
  },
  get DB_NAME(): string {
    return process.env.DB_NAME || "";
  },
  /** Max Postgres pool connections. Keep modest — Cloud SQL tiers cap connections. */
  get DB_POOL_MAX(): number {
    return parseInt(process.env.DB_POOL_MAX || "10", 10);
  },
  /** Enable TLS for Postgres TCP connections (not needed over the unix socket). */
  get DB_SSL(): boolean {
    return process.env.DB_SSL === "true";
  },
  /** Optional path to a CA cert (PEM) for verify-ca/verify-full TLS. */
  get DB_SSL_CA(): string {
    return process.env.DB_SSL_CA || "";
  },
  get PROMPTOWL_API_URL() {
    return process.env.PROMPTOWL_API_URL || "https://app.promptowl.ai";
  },
  get PROMPTOWL_KEY() {
    return process.env.PROMPTOWL_KEY || "";
  },
  /**
   * Shared secret for one-click SSO auto-login from PromptOwl (PO).
   *
   * THIS IS THE DOMAIN LOCK. Only the ONE official community deployment is
   * given this secret (it matches OFFICIAL_COMMUNITY_SSO_SECRET on PO). PO
   * signs a short-lived JWT ticket with it; this server verifies the ticket
   * with the same secret at GET /auth/sso.
   *
   * Self-hosted deployments leave this UNSET — GET /auth/sso then returns 404,
   * so the auto-login feature is disabled for every domain except ours. Those
   * users keep using the manual device-code flow (/auth/promptowl).
   */
  get OFFICIAL_COMMUNITY_SSO_SECRET(): string {
    return process.env.OFFICIAL_COMMUNITY_SSO_SECRET || "";
  },
  /**
   * This server's own canonical, externally-reachable base URL (e.g.
   * "https://community.promptowl.ai"). Used to validate the `aud` claim on
   * incoming SSO tickets — a ticket minted for a different audience is
   * rejected, so a ticket can't be replayed against another server. Compared
   * with the trailing slash stripped. When unset, the `aud` check is skipped
   * (the shared-secret check is still the primary gate).
   */
  get PUBLIC_BASE_URL(): string {
    return (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  },
  /**
   * Restrict "Sign in with PromptOwl":
   *   "open"       — anyone may sign in with PromptOwl (default)
   *   "admin-only" — only the license owner (admin) may; everyone else
   *                  uses email/password. Admin reaches it via the login
   *                  page's admin route (?admin=1).
   *   "disabled"   — nobody may sign in with PromptOwl.
   * Enforced server-side at the device entry points (POST /auth/device,
   * GET /auth/device/poll) and the identity point (POST /auth/promptowl).
   */
  get PROMPTOWL_SIGN_IN_GATE(): "open" | "admin-only" | "disabled" {
    const v = (process.env.PROMPTOWL_SIGN_IN_GATE || "open")
      .trim()
      .toLowerCase();
    return v === "admin-only" || v === "disabled"
      ? (v as "admin-only" | "disabled")
      : "open";
  },
  /**
   * Path to the .env file the server reads its config from and the license
   * install flow persists PROMPTOWL_KEY into. Defaults UNDER DATA_ROOT (not
   * $cwd) so it lands on the writable, volume-mounted, restart-surviving path
   * in containers — $cwd is /app in the official image: root-owned and
   * discarded on container recreate, which silently lost the key. The boot
   * dotenv loader reads this same path (see top of file).
   */
  get ENV_FILE_PATH() {
    return process.env.ENV_FILE_PATH || join(dataRoot(), ".env");
  },
  get TELEMETRY_ENABLED() {
    return process.env.TELEMETRY_ENABLED !== "false";
  },
  get TELEMETRY_INTERVAL_MS() {
    return parseInt(process.env.TELEMETRY_INTERVAL_MS || "3600000", 10);
  },
  /**
   * Optional custom logo URL shown in UI header + login screen.
   * Must be an absolute https://, http://, or data:image/… URL. Other
   * schemes (file://, javascript:, relative paths) are rejected with a
   * warning so an operator typo doesn't silently break the favicon.
   * When unset or invalid, the UI falls back to the bundled icon.
   */
  get LOGO_URL(): string | null {
    const raw = process.env.LOGO_URL?.trim();
    if (!raw) return null;
    const ok = /^(https?:\/\/|data:image\/)/i.test(raw);
    if (!ok) {
      console.warn(
        `[config] LOGO_URL rejected: must start with https://, http://, or data:image/ (got "${raw}"). Falling back to default logo.`,
      );
      return null;
    }
    return raw;
  },
  /**
   * Workflow plane ("turing" track): typed edges, edge-type registry, runs.
   * OFF by default — an optional feature an admin turns on (env or Settings).
   * This flag is also the future license-tier hook: gating a paid tier here
   * is a one-line change because every plane route checks it per request.
   */
  get FEATURE_WORKFLOW_PLANE(): boolean {
    return process.env.FEATURE_WORKFLOW_PLANE === "true";
  },
  /**
   * Sub-agent runs: lets a run spawn nested runs (an external runner calling
   * back into POST /run for a child agent). Gated SEPARATELY from the base
   * plane because recursion is the risky surface — unbounded fan-out,
   * re-entrancy, resource exhaustion. Off by default; must clear a security
   * review before an operator turns it on. Requires FEATURE_WORKFLOW_PLANE too.
   */
  get FEATURE_SUBAGENT_RUNS(): boolean {
    return process.env.FEATURE_SUBAGENT_RUNS === "true";
  },
  /** Hard ceiling on sub-agent nesting depth — keeps the call tree finite
   *  (haltable / statically bounded). Clamped to [1, 32]. */
  get SUBAGENT_MAX_DEPTH(): number {
    const n = parseInt(process.env.SUBAGENT_MAX_DEPTH || "8", 10);
    return Number.isFinite(n) ? Math.min(32, Math.max(1, n)) : 8;
  },
  /** Max direct children a single run may spawn. Depth bounds the tree's
   *  height; this bounds its width — together they cap total size so a
   *  runner can't fork-bomb the DB. Clamped to [1, 128]. */
  get SUBAGENT_MAX_CHILDREN(): number {
    const n = parseInt(process.env.SUBAGENT_MAX_CHILDREN || "16", 10);
    return Number.isFinite(n) ? Math.min(128, Math.max(1, n)) : 16;
  },
  /** Max steps a single run may accumulate — bounds a runaway/hostile
   *  runner's step log. Clamped to [10, 100000]. */
  get RUN_MAX_STEPS(): number {
    const n = parseInt(process.env.RUN_MAX_STEPS || "10000", 10);
    return Number.isFinite(n) ? Math.min(100000, Math.max(10, n)) : 10000;
  },
  get AUTH_MODE(): "open" | "key" {
    // Default is "key" — requires an explicit AUTH_MODE=open to run
    // without authentication. Safer default for public deployments;
    // local/dev users opt in explicitly.
    return (process.env.AUTH_MODE || "key") as "open" | "key";
  },
  /**
   * CORS origin allowlist. Comma-separated list of origins or "*".
   * Defaults to "*" in open mode (read-heavy, no credentials to steal)
   * and a locked-down list in key mode (Bearer tokens flow, CSRF matters).
   */
  get CORS_ORIGINS(): string[] | "*" {
    const raw = process.env.CORS_ORIGINS;
    if (raw === "*") return "*";
    if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
    // Sensible defaults
    if ((process.env.AUTH_MODE || "key") === "open") return "*";
    return ["http://localhost:5173", "http://localhost:3838"];
  },
  /**
   * Max JSON body size in bytes. Prevents DoS via giant payloads.
   * Default: 10 MB. Override via MAX_BODY_BYTES env.
   */
  get MAX_BODY_BYTES() {
    return parseInt(process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
  },
};
