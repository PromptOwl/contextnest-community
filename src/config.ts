import { join, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { z } from "zod";

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
let msteamsUrlWarned = false;
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
const EMAIL_SCHEMA = z.email();
export function isEmailish(v: string): boolean {
  // Delegate to zod's maintained email validator (rejects junk like
  // `*'/*'/8////@gmail.com`). Keep the explicit CR/LF reject to close the
  // header-injection shape a trailing "\n" could otherwise sneak past.
  return EMAIL_SCHEMA.safeParse(v.trim()).success && !/[\r\n]/.test(v);
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
  /**
   * Interface to listen on, e.g. `127.0.0.1` to accept only local / reverse-
   * proxy traffic. Unset = every interface (Node's default, unchanged).
   */
  get HOST(): string | undefined {
    return process.env.HOST?.trim() || undefined;
  },
  /**
   * Peers whose X-Forwarded-For / X-Real-IP / X-Forwarded-Proto are believed:
   * comma-separated IPs, CIDRs, or the keywords `loopback` / `private`.
   * Unset = legacy behaviour, every peer is trusted (see shared/trusted-proxies.ts).
   */
  get TRUSTED_PROXIES(): string {
    return process.env.TRUSTED_PROXIES?.trim() || "";
  },
  /** Commit this build came from (GIT_SHA, or BUILD_SHA from some CI), for the status page. */
  get GIT_SHA(): string {
    return process.env.GIT_SHA?.trim() || process.env.BUILD_SHA?.trim() || "";
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
   * Whether importing/syncing teams FROM PromptOwl is offered. Default OFF
   * (only an explicit "true" enables) — an operator opts the PO-team surface
   * in from Settings or env. When off, the /teams/promptowl routes 404 and the
   * UI hides the panel. Independent of PROMPTOWL_SIGN_IN_GATE: a user may sign
   * in with PromptOwl yet not be allowed to pull their PO teams in.
   */
  get PROMPTOWL_TEAMS_ENABLED(): boolean {
    return process.env.PROMPTOWL_TEAMS_ENABLED === "true";
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
   * Dedicated secret this deployment uses to SIGN the short-lived MCP tickets
   * minted by the SSO token-exchange (POST /auth/token-exchange). Kept distinct
   * from OFFICIAL_COMMUNITY_SSO_SECRET so a SELF-HOSTED server can issue its own
   * MCP bearers without the official PromptOwl trust relationship. The MCP
   * acceptor verifies a ticket signed with EITHER secret. Unset ⇒ token-exchange
   * cannot mint (and the acceptor simply doesn't offer this key).
   */
  get MCP_SIGNING_SECRET(): string {
    return process.env.MCP_SIGNING_SECRET || "";
  },
  /**
   * Master switch for the SSO token-exchange endpoint. Default OFF — a
   * deployment must deliberately enable it (and set MCP_SIGNING_SECRET + at
   * least one provider) before /auth/token-exchange will mint anything.
   */
  get SSO_TOKEN_EXCHANGE_ENABLED(): boolean {
    return process.env.SSO_TOKEN_EXCHANGE_ENABLED === "true";
  },
  get MS_TOKEN_EXCHANGE_ENABLED(): boolean {
    return process.env.MS_TOKEN_EXCHANGE_ENABLED === "true";
  },
  get GOOGLE_TOKEN_EXCHANGE_ENABLED(): boolean {
    return process.env.GOOGLE_TOKEN_EXCHANGE_ENABLED === "true";
  },
  /**
   * Microsoft Entra: the app (client) id inbound tokens must be issued for
   * (audience), and the tenant id used to build the expected issuer
   * https://login.microsoftonline.com/<tenant>/v2.0.
   */
  get MS_CLIENT_ID(): string {
    return (process.env.MS_CLIENT_ID || "").trim();
  },
  get MS_TENANT_ID(): string {
    return (process.env.MS_TENANT_ID || "").trim();
  },
  /**
   * Google: the OAuth client id inbound tokens must be issued for (audience).
   * Issuer is fixed at https://accounts.google.com.
   */
  get GOOGLE_CLIENT_ID(): string {
    return (process.env.GOOGLE_CLIENT_ID || "").trim();
  },
  /**
   * Lifetime of a minted MCP ticket, in seconds. Clamped to [30, 3600]; short
   * by design so a leaked exchange token expires quickly. Default 300.
   */
  get MCP_TOKEN_TTL_SECONDS(): number {
    const raw = parseInt(process.env.MCP_TOKEN_TTL_SECONDS || "", 10);
    if (!Number.isFinite(raw)) return 300;
    return Math.max(30, Math.min(3600, raw));
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
   *   "open"        — anyone may log in and self-register (default without SSO).
   *   "invite-only" — existing + admin-invited users may log in and an invited
   *                   placeholder may set its password ("claim"), but brand-new
   *                   self-registration is refused. Use this when the admin
   *                   provisions accounts (invite / share / steward) and users
   *                   shouldn't be able to create their own.
   *   "disabled"    — no email/password sign-in at all (PromptOwl only).
   * Enforced at POST /auth/login and POST /auth/register. The /admin/settings
   * validator refuses "disabled" while PromptOwl is also disabled, so a server
   * can never be left with no way to sign in.
   *
   * Unset, the default follows SSO: with OIDC enabled and configured it is
   * "invite-only", because everyone the IdP vouches for already gets in
   * through SSO, and an open password door would let anyone mint an account
   * the IdP never sees (and can't disable). An explicit "open" is honoured,
   * with a startup warning.
   */
  get MANUAL_SIGN_IN(): "open" | "invite-only" | "disabled" {
    const raw = (process.env.MANUAL_SIGN_IN || "").trim().toLowerCase();
    if (raw === "invite-only" || raw === "disabled" || raw === "open") return raw;
    return this.OIDC_CONFIGURED ? "invite-only" : "open";
  },
  /**
   * OIDC enabled AND fully configured (issuer + client id + secret). Same
   * test as auth/oidc.ts isOidcReady(), kept here so config getters can use
   * it without importing the auth layer.
   */
  get OIDC_CONFIGURED(): boolean {
    return (
      this.OIDC_ENABLED &&
      !!this.OIDC_ISSUER &&
      !!this.OIDC_CLIENT_ID &&
      !!this.OIDC_CLIENT_SECRET
    );
  },
  /**
   * Password self-registration is open while SSO is live — the setup the
   * startup log, /admin/settings and the Settings page warn about.
   */
  get MANUAL_SIGN_IN_OPEN_WITH_SSO(): boolean {
    return this.OIDC_CONFIGURED && this.MANUAL_SIGN_IN === "open";
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
   * Widen the add-a-person suggestions (GET /people/suggest) from "people you
   * already work with" to every registered account on this server.
   *
   * OFF BY DEFAULT, and the default is the point. On a single-company
   * self-hosted server every account is a colleague, so the whole directory is
   * the useful answer and this saves asking someone for their address. On the
   * PromptOwl-hosted deployment, one server holds many unrelated customers —
   * so the same list is one customer's staff being offered another customer's
   * email addresses. The hosted deployment leaves this unset; a self-hosted
   * operator who knows their user table is their own staff turns it on.
   *
   * Narrows nothing when off: the default scoping (shared nests and teams,
   * plus everything for a server admin, who administers the accounts anyway)
   * is unchanged. Suggestions never gate the add either way — an address that
   * appears in no list is still valid to type, so this only ever affects what
   * is *offered*, never who can be invited. Superadmin-togglable at runtime
   * via /admin/settings.
   */
  get PEOPLE_SUGGEST_ALL_USERS(): boolean {
    return process.env.PEOPLE_SUGGEST_ALL_USERS === "true";
  },
  /**
   * Who may create nests. "admins" (default): server admins only, until the
   * server is on a paid plan. "everyone": any signed-in user. Open mode is
   * unaffected (everyone is admin there).
   */
  get NEST_CREATION(): "admins" | "everyone" {
    return process.env.NEST_CREATION?.trim().toLowerCase() === "everyone"
      ? "everyone"
      : "admins";
  },
  /**
   * This server hosts several unrelated organizations (the PromptOwl-hosted
   * deployment) rather than one company (a self-hosted install).
   *
   * OFF BY DEFAULT. Nest visibility 'org' means "every authenticated account
   * on this deployment" (src/shared/access.ts) — on a single-company server
   * that IS the organization, so the tier is safe to flip in one click. On a
   * shared server it is every customer, so with this on: flipping a nest to
   * 'org' needs the same explicit acknowledgement 'public' always needs
   * (PATCH /nests/:id/visibility 409s without it — the server enforces it, not only the UI), and
   * the UI words both tiers to say so. Exposed on /health as
   * `shared_deployment`. Superadmin-togglable at runtime via /admin/settings.
   */
  get SHARED_DEPLOYMENT(): boolean {
    return process.env.SHARED_DEPLOYMENT === "true";
  },
  /**
   * MCP OAuth authorization server. Default OFF, and off means the surface
   * does not exist: `/.well-known/*` keeps 404ing and `/mcp` answers
   * unauthenticated callers exactly as it did before.
   *
   * On, this server advertises itself as an OAuth 2.1 authorization server so
   * a vendor-hosted agent (Claude, ChatGPT, Grok, Cursor) can sign its user in
   * and be issued a token scoped to THAT person — which is the only way the
   * per-user nest visibility `canRead()` already enforces can be reached from
   * those surfaces. A shared API key makes every caller the same user.
   *
   * Requires PUBLIC_BASE_URL: the metadata's `resource` and the token audience
   * are built from it, and a guessed value fails the client's exact-match
   * check. Superadmin-togglable at runtime via /admin/settings.
   */
  get MCP_OAUTH_ENABLED(): boolean {
    return process.env.MCP_OAUTH_ENABLED === "true";
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
   * PostHog product analytics. Empty key = off, which is the default: a
   * self-hosted operator brings their own project. The key is a public client
   * key by design (the browser sends it), so /health may hand it out — but
   * only while TELEMETRY_ENABLED is on, so one switch stops all outbound
   * usage data. Editable at runtime from the admin Settings page.
   */
  get POSTHOG_KEY(): string {
    return (process.env.POSTHOG_KEY || "").trim();
  },
  get POSTHOG_HOST(): string {
    return (process.env.POSTHOG_HOST || "").trim() || "https://us.i.posthog.com";
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
   * Superadmin message log (outbound_messages behind GET /admin/messages)
   * retention in days. 0 = keep forever. Invalid / negative → default 30;
   * capped at 3650. Message bodies carry other users' content, so the default
   * is deliberately short. Editable at runtime from /admin/settings.
   */
  get MESSAGE_LOG_RETENTION_DAYS(): number {
    const n = parseInt(process.env.MESSAGE_LOG_RETENTION_DAYS || "30", 10);
    if (!Number.isFinite(n) || n < 0) return 30;
    return Math.min(n, 3650);
  },
  /**
   * Store (redacted) message bodies in the message log. On by default; "false"
   * keeps metadata only — channel, sender, recipients, subject, status — for
   * deployments that must not hold a second copy of message content.
   * Editable at runtime from /admin/settings.
   */
  get MESSAGE_LOG_STORE_BODIES(): boolean {
    return process.env.MESSAGE_LOG_STORE_BODIES !== "false";
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
  /** Display name for this community (Server settings → Basic). Unset = null. */
  get COMMUNITY_NAME(): string | null {
    return process.env.COMMUNITY_NAME?.trim() || null;
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

  /**
   * Optional Microsoft Teams incoming-webhook URL (Workflows app) for team
   * notifications — same events as SLACK_WEBHOOK_URL, posted as Adaptive
   * Cards. Empty/unset = connector off. https only — a webhook carries an
   * implicit secret in its path, so it never travels plaintext. Named
   * MSTEAMS_* deliberately: "teams" in this codebase means user groups.
   */
  get MSTEAMS_WEBHOOK_URL(): string | null {
    const raw = process.env.MSTEAMS_WEBHOOK_URL?.trim();
    if (!raw) return null;
    if (!/^https:\/\//i.test(raw)) {
      if (!msteamsUrlWarned) {
        msteamsUrlWarned = true;
        console.warn(
          "[config] MSTEAMS_WEBHOOK_URL rejected: must be an https:// URL. Microsoft Teams notifications disabled.",
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
   * Content-type toggles — soft-disable a node type server-wide. DEFAULT ON:
   * missing/unset/anything-but-"false" = enabled, so existing deployments see
   * zero behavior change. Only CREATION of the type is refused when disabled;
   * existing nodes of that type still read/render/version (never data loss).
   * Runnable types (agent/skill/tool) are NOT governed here — they stay gated
   * by FEATURE_WORKFLOW_PLANE. Superadmin-editable at runtime via
   * /admin/settings (type_artifact_enabled / type_table_enabled).
   */
  get TYPE_ARTIFACT_ENABLED(): boolean {
    return process.env.TYPE_ARTIFACT_ENABLED !== "false";
  },
  get TYPE_TABLE_ENABLED(): boolean {
    return process.env.TYPE_TABLE_ENABLED !== "false";
  },
  /**
   * Hootie in the nest: the assistant side panel on every page of the UI and
   * its POST /nests/:id/chat route. Default OFF (since 1.28, CU-wdqcq03ewc):
   * an admin opts in from Settings → General (hootie_enabled) or the deploy
   * sets HOOTIE_ENABLED=true. Off → the route 404s and the launcher is
   * hidden. Answering additionally needs a model key (PromptOwl's gateway from
   * the licence, or an own-provider key); without one the route answers 503,
   * not 404 — the feature is on, it just isn't configured yet. Its name/logo/colour/greeting are enterprise-only
   * (src/hootie/brand.ts).
   */
  get HOOTIE_ENABLED(): boolean {
    return process.env.HOOTIE_ENABLED === "true";
  },
  /** Model Hootie answers with. Superadmin-editable at runtime via
   *  /admin/settings (hootie_model): a plain name from the model list. */
  get HOOTIE_MODEL(): string {
    return process.env.HOOTIE_MODEL || "claude-sonnet-5"; // efficient default (pricing spec §6.6)
  },
  /** Testing aid: log Hootie's full model request and answer (nest content!).
   *  Off by default; summaries (model, key tail, tokens) are always logged. */
  get HOOTIE_DEBUG_LOG(): boolean {
    return process.env.HOOTIE_DEBUG_LOG === "true";
  },
  /**
   * The server's own model gateway (Enterprise, licence feature byok): a
   * LiteLLM / Bedrock / Azure / Ollama front speaking Anthropic's
   * /v1/messages. With ANTHROPIC_API_KEY as its key it routes Hootie AND agent
   * runs (via the run bundle's env floor) — one setting, superadmin-editable
   * (anthropic_base_url). Used only as a pair with the key; empty = off.
   */
  get ANTHROPIC_BASE_URL(): string {
    return (process.env.ANTHROPIC_BASE_URL || "").trim().replace(/\/$/, "");
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
  /**
   * Metacognition agents (CU-wdqcq041jm): agent nodes the SERVER runs as a
   * persona — a native ReAct loop on the nest's model key that reads within a
   * configured scope and changes the nest only by filing proposals for review.
   * Off by default. Requires FEATURE_WORKFLOW_PLANE (runs, schedules and the
   * run trace are the plane's). This is the one place the server executes an
   * agent itself; see WORKFLOW_PLANE.md.
   */
  get FEATURE_METACOGNITION(): boolean {
    return process.env.FEATURE_METACOGNITION === "true";
  },
  /**
   * Development only: let a metacognition agent's feeds and MCP servers be
   * plain-http or private addresses (a local MCP server, a feed on the LAN).
   * Off, which is the only safe production setting: the server fetches these
   * from its own network position.
   */
  get METACOGNITION_ALLOW_PRIVATE_URLS(): boolean {
    return process.env.METACOGNITION_ALLOW_PRIVATE_URLS === "true";
  },
  /** Manual/hook starts per metacognition agent per hour; bounds spend. */
  get METACOGNITION_STARTS_PER_HOUR(): number {
    return Number(process.env.METACOGNITION_STARTS_PER_HOUR) || 30;
  },
  /** How often a running metacognition agent checks for a person's cancel (ms). */
  get METACOGNITION_CANCEL_POLL_MS(): number {
    return Number(process.env.METACOGNITION_CANCEL_POLL_MS) || 2000;
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
  /**
   * Agent-run retention in days (the runs + run_steps tables behind the Run
   * Trace and the per-agent activity history). 0 = keep forever, the default:
   * a run is the record of what an agent did, and an operator should choose to
   * drop it. Finished runs older than this are pruned hourly; a running run is
   * never pruned. Same [0, 3650] range as TRACE_RETENTION_DAYS. Editable at
   * runtime from the admin Settings page (/admin/settings).
   */
  get RUN_RETENTION_DAYS(): number {
    const n = parseInt(process.env.RUN_RETENTION_DAYS || "0", 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, 3650);
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
   * Email transport: "smtp" (SMTP_URL, default) or "ses" (AWS SES via the SDK,
   * for deployments that can't use SMTP). Anything else falls back to smtp.
   */
  get EMAIL_PROVIDER(): "smtp" | "ses" {
    return process.env.EMAIL_PROVIDER?.trim().toLowerCase() === "ses" ? "ses" : "smtp";
  },
  /** AWS region for SES, e.g. us-east-1. Required when EMAIL_PROVIDER=ses. */
  get SES_REGION(): string | null {
    return process.env.SES_REGION?.trim() || null;
  },
  /**
   * Optional static SES credentials. Both unset → the AWS default credential
   * chain (IAM role, AWS_* env, shared profile). The secret is write-only.
   */
  get SES_ACCESS_KEY_ID(): string | null {
    return process.env.SES_ACCESS_KEY_ID?.trim() || null;
  },
  get SES_SECRET_ACCESS_KEY(): string | null {
    return process.env.SES_SECRET_ACCESS_KEY?.trim() || null;
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
   * Who may frame this server, as a CSP `frame-ancestors` source list.
   *
   * Defaults to `'self'`: no other site can embed the UI, which is what stops
   * a hostile page from framing it invisibly and stealing clicks from a
   * signed-in operator. Deployments that are *meant* to be embedded name the
   * embedding origin — e.g. the PromptOwl Data Room iframes this server, so
   * that install sets `FRAME_ANCESTORS="https://app.promptowl.ai"`.
   *
   * Comma-separated; `'self'` is always included. `*` allows any site to frame
   * this server and disables the protection.
   *
   * Note we deliberately do NOT also send `X-Frame-Options` — it only
   * understands "same origin", so it would block a sibling subdomain that
   * `frame-ancestors` is configured to allow. Every browser that matters
   * honours `frame-ancestors`, and it wins where both are present.
   */
  get FRAME_ANCESTORS(): string {
    const raw = process.env.FRAME_ANCESTORS?.trim();
    if (!raw) return "'self'";
    if (raw === "*") return "*";
    const sources = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return [...new Set(["'self'", ...sources])].join(" ");
  },
  /** Requests per minute a single headless access key (CU-wdqcq0314u) may
   *  make. The keys are handed to outside parties by design, so the limit is
   *  what stops one from becoming an unmetered scraping endpoint. Per key,
   *  in-memory (same single-instance limiter as the auth endpoints). Clamped
   *  to [1, 100000]; default 120. */
  get HEADLESS_KEY_RATE_LIMIT_PER_MIN(): number {
    const n = parseInt(process.env.HEADLESS_KEY_RATE_LIMIT_PER_MIN || "120", 10);
    return Number.isFinite(n) ? Math.min(100000, Math.max(1, n)) : 120;
  },
  /**
   * Max JSON body size in bytes. Prevents DoS via giant payloads.
   * Default: 10 MB. Override via MAX_BODY_BYTES env.
   */
  get MAX_BODY_BYTES() {
    return parseInt(process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
  },
  /**
   * Max video upload size in bytes. Default 30 MB — kept under Cloud Run's
   * 32 MiB HTTP/1 request-body limit so a too-big video is rejected cleanly by
   * our own check (clear message) instead of a bare 413 from the platform.
   * Raise via VIDEO_MAX_MB only when the deployment can actually accept it
   * (e.g. not behind Cloud Run, or on HTTP/2 / direct-to-bucket upload).
   */
  get VIDEO_MAX_BYTES() {
    const mb = parseInt(process.env.VIDEO_MAX_MB || "30", 10);
    return (Number.isFinite(mb) && mb > 0 ? mb : 30) * 1024 * 1024;
  },
  /**
   * Push Confirmation Gate — max serialized size (bytes) of a single held push
   * (pending_pushes.payload_blob). A gated push carries its FULL staged payload
   * so a later confirm applies it byte-for-byte, so it must be bounded like any
   * other stored body. Default 5 MB; override via MAX_PENDING_PUSH_BYTES.
   */
  get MAX_PENDING_PUSH_BYTES() {
    const n = parseInt(
      process.env.MAX_PENDING_PUSH_BYTES || String(5 * 1024 * 1024),
      10,
    );
    return Number.isFinite(n) && n > 0 ? n : 5 * 1024 * 1024;
  },
  /**
   * Push Confirmation Gate — time-to-live (ms) for a held push before it lazily
   * expires (reported as `expired`, and no longer confirmable). Default 7 days;
   * override via PENDING_PUSH_TTL_MS.
   */
  get PENDING_PUSH_TTL_MS() {
    const n = parseInt(
      process.env.PENDING_PUSH_TTL_MS || String(7 * 24 * 60 * 60 * 1000),
      10,
    );
    return Number.isFinite(n) && n > 0 ? n : 7 * 24 * 60 * 60 * 1000;
  },

  /**
   * Max PDF upload size in bytes (POST /nests/:id/nodes/pdf). Default 25 MB —
   * under Cloud Run's 32 MiB HTTP/1 request-body limit, with room for the
   * multipart framing, so an oversized PDF is refused by our own check (413
   * with a clear message) rather than by the platform. Read per request, so a
   * change takes effect without a restart. Override via PDF_MAX_MB.
   */
  get PDF_MAX_BYTES() {
    const mb = parseInt(process.env.PDF_MAX_MB || "25", 10);
    return (Number.isFinite(mb) && mb > 0 ? mb : 25) * 1024 * 1024;
  },

  /**
   * File operations one import keeps in flight (engine `limits.ioConcurrency`).
   * Unset leaves the engine default (32). Raise it on a network mount (gcsfuse).
   */
  get IMPORT_IO_CONCURRENCY(): number | undefined {
    const n = parseInt(process.env.IMPORT_IO_CONCURRENCY || "", 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  },
};
