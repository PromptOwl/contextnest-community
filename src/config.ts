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
// Warn at most once when SLACK_WEBHOOK_URL is set to a non-https value. The
// getter is read once per governance event, so without this a misconfigured
// env value (set directly, bypassing the /admin/settings validator) would
// spam the log on every submit/approve/reject/add-collaborator.
let slackUrlWarned = false;
let emailFromWarned = false;
let emailToWarned = false;
let oidcIssuerWarned = false;

/**
 * Email shape gate for the notification envelope: local@domain.tld, no
 * whitespace, no CR/LF. The domain MUST carry a dot + tail so junk with a bare
 * `@` (e.g. "a@b", "test@test") is refused — a value that passes the transport
 * envelope but isn't a real address. `\s` already excludes interior newlines;
 * the extra CR/LF reject closes the JS quirk where a non-`m` `$` still matches
 * before a single trailing "\n" (header-injection shape). Shared by config
 * getters and the /admin/settings validator so env-set and UI-set values gate
 * identically.
 */
export function isEmailish(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !/[\r\n]/.test(v);
}
/** Comma-separated recipient list where every entry is isEmailish(). */
export function isEmailListish(v: string): boolean {
  return v.split(",").every((e) => isEmailish(e.trim()));
}
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
  /** Vercel automation-bypass secret for PO calls; unset = no bypass. */
  get PROMPTOWL_BYPASS_SECRET(): string {
    return process.env.PROMPTOWL_BYPASS_SECRET || "";
  },
  /** Outbound headers for PO fetches; bypass header only when secret set. */
  get PROMPTOWL_FETCH_HEADERS(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.PROMPTOWL_BYPASS_SECRET) {
      // Server-side one-shot calls: only the bypass header is needed. The
      // x-vercel-set-bypass-cookie header is for in-browser follow-up
      // requests, which these are not — so it's omitted.
      h["x-vercel-protection-bypass"] = this.PROMPTOWL_BYPASS_SECRET;
    }
    return h;
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
   * Manual (email + password) sign-in. Three modes, independent of
   * `PROMPTOWL_SIGN_IN_GATE` (the two methods are controlled separately):
   *   "open"        — anyone may log in and self-register (default).
   *   "invite-only" — existing + admin-invited users may log in and an invited
   *                   placeholder may set its password ("claim"), but brand-new
   *                   self-registration is refused. Use this when the admin
   *                   provisions accounts (invite / share / steward) and users
   *                   shouldn't be able to create their own.
   *   "disabled"    — no email/password sign-in at all (PromptOwl only).
   * Enforced at POST /auth/login and POST /auth/register. The /admin/settings
   * validator refuses "disabled" while PromptOwl is also disabled, so a server
   * can never be left with no way to sign in.
   */
  get MANUAL_SIGN_IN(): "open" | "invite-only" | "disabled" {
    const v = (process.env.MANUAL_SIGN_IN || "open").trim().toLowerCase();
    return v === "invite-only" || v === "disabled"
      ? (v as "invite-only" | "disabled")
      : "open";
  },
  /**
   * Generic OIDC single sign-on (Microsoft Entra ID, Google, any spec-
   * compliant IdP). Off by default; superadmin-configurable at runtime via
   * /admin/settings. When enabled AND fully configured (issuer + client id +
   * client secret), GET /auth/oidc/login starts an authorization-code + PKCE
   * flow and GET /auth/oidc/callback finishes it with a normal browser
   * session — exactly like a password login.
   */
  get OIDC_ENABLED(): boolean {
    return process.env.OIDC_ENABLED === "true";
  },
  /**
   * OIDC issuer URL, e.g. "https://login.microsoftonline.com/<tenant>/v2.0"
   * or "https://accounts.google.com". https only — tokens and the client
   * secret ride this trust root, so a plaintext issuer is refused (warn once,
   * treated as unset). Trailing slash stripped so discovery-doc comparison is
   * canonical.
   */
  get OIDC_ISSUER(): string {
    const raw = (process.env.OIDC_ISSUER || "").trim().replace(/\/$/, "");
    if (!raw) return "";
    let ok = false;
    try {
      ok = new URL(raw).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) {
      if (!oidcIssuerWarned) {
        oidcIssuerWarned = true;
        console.warn(
          "[config] OIDC_ISSUER rejected: must be a valid https:// URL. OIDC sign-in disabled.",
        );
      }
      return "";
    }
    return raw;
  },
  get OIDC_CLIENT_ID(): string {
    return (process.env.OIDC_CLIENT_ID || "").trim();
  },
  get OIDC_CLIENT_SECRET(): string {
    return (process.env.OIDC_CLIENT_SECRET || "").trim();
  },
  /**
   * Comma-separated email-domain allowlist for OIDC sign-in (e.g.
   * "acme.com, contractors.acme.com"). Empty = any domain the IdP asserts.
   * Entries are normalized to lowercase; matching is on the part after the
   * final "@" of the asserted email.
   */
  get OIDC_ALLOWED_DOMAINS(): string[] {
    return (process.env.OIDC_ALLOWED_DOMAINS || "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  },
  /**
   * Auto-provision (JIT-create) an unknown user on first successful OIDC
   * sign-in. Default true. When false, only emails that already have a user
   * row (invited / registered) may sign in via OIDC — everyone else bounces
   * with ?sso_error=not_invited.
   */
  get OIDC_AUTO_PROVISION(): boolean {
    return process.env.OIDC_AUTO_PROVISION !== "false";
  },
  /**
   * Auto-tag content created by SSO users with their directory department:
   * when on, node CREATE appends `dept:<slugified-department>` to the new
   * node's tags (never on update, never retroactively). The department is
   * captured from the OIDC `department` claim at login (see oidc.ts), so
   * this is only meaningful alongside an IdP that emits that claim — but
   * there is no hard dependency on OIDC_ENABLED. Default off; superadmin-
   * togglable at runtime via /admin/settings.
   */
  get OIDC_DEPARTMENT_TAGGING(): boolean {
    return process.env.OIDC_DEPARTMENT_TAGGING === "true";
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
   * Activity-trace retention window in days (the api_events table behind
   * GET /admin/trace and GET /nests/:id/trace). 0 = keep forever (pruning is
   * skipped entirely). Invalid / negative → default 14; capped at 3650 (ten
   * years) so a typo can't schedule a prune cutoff in the distant past.
   * Editable at runtime from the admin Settings page (/admin/settings).
   */
  get TRACE_RETENTION_DAYS(): number {
    const n = parseInt(process.env.TRACE_RETENTION_DAYS || "14", 10);
    if (!Number.isFinite(n) || n < 0) return 14;
    return Math.min(n, 3650);
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
  /**
   * Optional Slack incoming-webhook URL for team notifications (review
   * submitted/approved/rejected). Empty/unset = connector off. https only —
   * a webhook carries an implicit secret in its path, so it never travels
   * plaintext. (Ported from development PR #105.)
   */
  get SLACK_WEBHOOK_URL(): string | null {
    const raw = process.env.SLACK_WEBHOOK_URL?.trim();
    if (!raw) return null;
    if (!/^https:\/\//i.test(raw)) {
      if (!slackUrlWarned) {
        slackUrlWarned = true;
        console.warn(
          "[config] SLACK_WEBHOOK_URL rejected: must be an https:// URL. Slack notifications disabled.",
        );
      }
      return null;
    }
    return raw;
  },

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
  /** Max concurrently-RUNNING root (depth-0) runs per nest. The subagent
   *  depth/fan-out caps bound a single tree; this bounds how many trees a
   *  caller can start at once, so root triggers can't flood the nest. */
  get RUN_MAX_CONCURRENT_ROOTS(): number {
    const n = parseInt(process.env.RUN_MAX_CONCURRENT_ROOTS || "50", 10);
    return Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : 50;
  },
  get AUTH_MODE(): "open" | "key" {
    // Default is "key" — requires an explicit AUTH_MODE=open to run
    // without authentication. Safer default for public deployments;
    // local/dev users opt in explicitly.
    return (process.env.AUTH_MODE || "key") as "open" | "key";
  },
  /**
   * Optional SMTP connection URL for email notifications, e.g.
   * smtps://user:pass@smtp.example.com:465. smtp:// or smtps:// only.
   * Empty/unset = email connector off. Requires NOTIFY_EMAIL_FROM/_TO.
   */
  get SMTP_URL(): string | null {
    const raw = process.env.SMTP_URL?.trim();
    if (!raw) return null;
    if (!/^smtps?:\/\//i.test(raw)) {
      console.warn(
        "[config] SMTP_URL rejected: must be an smtp:// or smtps:// URL. Email notifications disabled.",
      );
      return null;
    }
    return raw;
  },
  /**
   * From address for notification emails. Shape-validated here (not only in
   * the /admin/settings PATCH) so a value set directly via env/Docker can't
   * reach nodemailer's envelope unchecked. Invalid = connector off.
   */
  get NOTIFY_EMAIL_FROM(): string | null {
    const raw = process.env.NOTIFY_EMAIL_FROM?.trim();
    if (!raw) return null;
    if (!isEmailish(raw)) {
      if (!emailFromWarned) {
        emailFromWarned = true;
        console.warn(
          "[config] NOTIFY_EMAIL_FROM rejected: must be a plain email address. Email notifications disabled.",
        );
      }
      return null;
    }
    return raw;
  },
  /**
   * Comma-separated recipient list for notification emails. Shape-validated
   * here for the same env-bypass reason as NOTIFY_EMAIL_FROM. Invalid (any
   * entry malformed) = connector off.
   */
  get NOTIFY_EMAIL_TO(): string | null {
    const raw = process.env.NOTIFY_EMAIL_TO?.trim();
    if (!raw) return null;
    if (!isEmailListish(raw)) {
      if (!emailToWarned) {
        emailToWarned = true;
        console.warn(
          "[config] NOTIFY_EMAIL_TO rejected: must be a comma-separated list of email addresses. Email notifications disabled.",
        );
      }
      return null;
    }
    return raw;
  },
  /**
   * Per-nest notification digest window in milliseconds. A burst of governance
   * events on one nest inside this window collapses into a single digest
   * message instead of one post per event. Empty / non-numeric / negative /
   * unset → 15000 (15s).
   */
  get NOTIFY_DEBOUNCE_MS(): number {
    // Guard empty-but-set (NOTIFY_DEBOUNCE_MS=) first: Number("") is 0, not
    // NaN, so it would otherwise yield a 0ms window instead of the default.
    const raw = process.env.NOTIFY_DEBOUNCE_MS?.trim();
    if (!raw) return 15_000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 15_000;
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
