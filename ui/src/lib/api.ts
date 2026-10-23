/**
 * API client for the community server REST endpoints.
 *
 * Browser auth uses an httpOnly session cookie set by the server on
 * /auth/login, /auth/register, /auth/promptowl. JS cannot read the
 * cookie value — the browser auto-attaches it to same-origin requests
 * via `credentials: "include"`. Token-style helpers (setToken,
 * getCurrentToken, etc.) intentionally do NOT exist on this client.
 *
 * External clients (Hootie, Claude Desktop, ctx CLI, MCP) still use
 * Authorization: Bearer cnst_* — those keys are minted on demand via
 * /auth/keys and shown to the user once via the Connect modal.
 */

import { clearDraft } from "./draft";
import { streamQueryString, type StreamQuery } from "./doc-stream";
import {
  ACCESS_OFFER_EVENT,
  accessOfferFromError,
  type AccessRequest,
  type AccessTarget,
} from "./access-requests";
import type { NestBranding } from "./branding";
import type { InstructionsRevision } from "./instructions";

/**
 * A nest's visibility tier. 'org' = every authenticated user of this
 * deployment (a self-hosted install is one organization); 'public' = anyone,
 * including anonymous callers. Nothing in the UI sets 'org' yet, but the API
 * returns it, so every surface that renders visibility has to handle it.
 */
export type NestVisibility = "private" | "org" | "public";

const API_BASE = "";
const STALE_LOCAL_STORAGE_KEY = "cnst_token";

/**
 * One-time cleanup for users upgrading from the localStorage token era.
 * The browser session is now cookie-based, so any leftover cnst_token
 * key is dead weight at best and a security smell at worst — drop it.
 */
export function clearLegacyLocalStorage() {
  try {
    localStorage.removeItem(STALE_LOCAL_STORAGE_KEY);
  } catch {
    // Private mode / disabled storage — nothing to clean up.
  }
}

async function request<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    // Send + receive the httpOnly session cookie. Same-origin only — the
    // browser will not attach our cookie to cross-origin requests, so
    // CSRF via random websites is blocked by the browser itself.
    credentials: "include",
  });

  // Some endpoints return empty body (e.g. 204 No Content).
  const text = await res.text();
  // Infrastructure between the browser and the app answers in plain text, not
  // JSON — Cloud Run's proxy returns a bare "upstream request timeout" on 504,
  // and load balancers return HTML error pages. Parsing those unguarded threw a
  // SyntaxError before the !res.ok branch below could report the real status,
  // so every proxy-level failure surfaced to the user as a JSON parse error.
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }

  if (!res.ok) {
    // A role change that raises someone's billed class: one listener
    // (BillingConfirmHost) asks, and a yes resends with the confirm header.
    if (res.status === 409 && data.code === "billing_confirm" && !headers["X-Confirm-Billing"] && typeof window !== "undefined") {
      const ok = await new Promise<boolean>((resolve) => {
        const ev = new CustomEvent<BillingConfirmRequest>(BILLING_CONFIRM_EVENT, {
          detail: { changes: data.changes ?? [], resolve },
          cancelable: true,
        });
        if (window.dispatchEvent(ev)) resolve(false); // no host mounted
      });
      if (ok) return request<T>(path, { ...options, headers: { ...headers, "X-Confirm-Billing": "true" } });
      data.error = "Cancelled. Nothing was saved and no one's billing changed.";
    }
    // 401 = the server says we're not logged in. Drop any legacy
    // localStorage entry and signal the auth context to reset UI state
    // (re-render to logged-out without a manual page refresh).
    if (res.status === 401) {
      clearLegacyLocalStorage();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("auth:unauthorized"));
      }
    }
    // Carry the parsed error body on the Error so callers can read structured
    // fields (e.g. `fieldErrors` from /admin/settings) instead of the flat
    // message text.
    const err = new Error(data.error || `Request failed: ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = data;
    // A role grant past the pricing plan: the dialog shows the message; the
    // license banner offers admins the way to change plans (one listener).
    if (res.status === 402 && data.code === "plan_limit" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("license:plan-limit", { detail: data }));
    }
    // A write refused for someone who could ask for the access instead
    // (CU-wdqcq041jn): one listener (RequestAccessHost) offers the request over
    // whatever they were doing. The caller still gets the error, so its own
    // state — an unsaved edit above all — stays as it was.
    const offer =
      (options.method ?? "GET").toUpperCase() !== "GET"
        ? accessOfferFromError(path, res.status, data)
        : null;
    if (offer && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(ACCESS_OFFER_EVENT, { detail: offer }));
    }
    throw err;
  }
  // Every successful mutation invalidates the cached reads its result affects.
  // Routing that off the request path means a new endpoint is covered the day
  // it is added, rather than the day someone remembers to register it — the
  // query layer owns the path-to-key mapping (see invalidateForPath there).
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET") readCacheHooks?.invalidatePath(path);
  return data as T;
}

// ─── Read-cache invalidation ─────────────────────────────────────────────
// Reads are cached by the query layer in ./queries, which owns keys, staleness
// and garbage collection. This module keeps the invalidation hooks, because the
// events that make data stale are mutations — and every mutation goes through
// request() below. The dependency only points one way (queries imports api), so
// the query client registers its invalidators here at startup rather than being
// imported.
interface ReadCacheHooks {
  /** Drop every cached read. For identity changes, where nothing may carry over. */
  clear(): void;
  /** Mark stale whatever a mutation to this request path could have changed. */
  invalidatePath(path: string): void;
}

let readCacheHooks: ReadCacheHooks | null = null;

/** Called once from the app shell, after the query client exists. */
export function registerReadCache(hooks: ReadCacheHooks): void {
  readCacheHooks = hooks;
}

/** Drop cached reads for a nest, or ALL cached reads when no id is given.
 *  Called automatically on any successful mutation under /nests/{id} in
 *  request(); called with no argument on login, logout and user switch, where
 *  a permission-filtered response from the previous identity must never be
 *  served to the next one. */
export function invalidateNestReads(nestId?: string): void {
  if (!nestId) {
    readCacheHooks?.clear();
    return;
  }
  readCacheHooks?.invalidatePath(`/nests/${nestId}`);
}

/** Error thrown by `request` on a non-2xx response, with the parsed body. */
/** A role change the server says raises someone's billed class (409 billing_confirm). */
export interface BillingChange {
  userId: string | null;
  email: string | null;
  from: "viewer" | "subscriber" | "user";
  to: "viewer" | "subscriber" | "user";
}
export interface BillingConfirmRequest {
  changes: BillingChange[];
  resolve: (confirmed: boolean) => void;
}
export const BILLING_CONFIRM_EVENT = "billing:confirm";

export interface ApiError extends Error {
  status?: number;
  body?: { error?: string; fieldErrors?: Record<string, string>; [k: string]: unknown };
}

// ─── Auth ───────────────────────────────────────────────────────────────

export interface AuthedUser {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
}

export async function login(email: string, password: string) {
  return request<{ user: AuthedUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function register(email: string, password: string, name?: string) {
  return request<{ user: AuthedUser }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
}

export async function logout() {
  return request<{ ok: boolean }>("/auth/logout", { method: "POST" });
}

export async function startDeviceAuth() {
  return request<{
    deviceCode: string;
    clientSecret: string;
    verificationUrl: string;
  }>("/auth/device", { method: "POST", body: JSON.stringify({}) });
}

export async function pollDeviceAuth(code: string, clientSecret: string) {
  // Secret in the body, not the URL, so access logs never record it.
  return request<{ status: string; token?: string }>("/auth/device/poll", {
    method: "POST",
    body: JSON.stringify({ code, client_secret: clientSecret }),
  });
}

export type ClaimBlocked =
  | { reason: "license_required" }
  | { reason: "email_mismatch"; license_owner_email: string | null };

export async function exchangePromptOwlToken(token: string) {
  return request<{
    user: AuthedUser;
    claim_blocked?: ClaimBlocked;
  }>("/auth/promptowl", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

// ─── Health ─────────────────────────────────────────────────────────────

export async function getHealth() {
  return request<{
    status: string;
    version?: string;
    auth_mode: string;
    /** The server runs an OAuth authorization server for MCP clients. */
    mcp_oauth_enabled?: boolean;
    logo_url?: string | null;
    promptowl_sign_in_gate?: "open" | "admin-only" | "disabled";
    manual_sign_in?: "open" | "invite-only" | "disabled";
    /** True only when OIDC SSO is enabled AND fully configured server-side. */
    oidc_enabled?: boolean;
    /** Present when oidc_enabled — lets the login page label the button by IdP. */
    oidc_issuer?: string;
    /** Present when PromptOwl SSO tickets are accepted — the Google button target. */
    promptowl_google_url?: string;
    workflow_plane_enabled?: boolean;
    /** Import teams from PromptOwl (default OFF). Off → the panel is hidden. */
    promptowl_teams_enabled?: boolean;
    /** Content-type toggles — default ON server-side; the editor's type
     *  picker hides a disabled type exactly when create would refuse it. */
    type_artifact_enabled?: boolean;
    shared_deployment?: boolean;
    type_table_enabled?: boolean;
    type_task_enabled?: boolean;
    subagent_runs_enabled?: boolean;
    subagent_max_depth?: number;
    subagent_max_children?: number;
    runner_key_configured?: boolean;
    /** Hootie in the nest (default OFF — admins opt in). Off → the launcher
     *  is hidden and POST /nests/:id/chat 404s. */
    hootie_enabled?: boolean;
    /** Metacognition agents: server-run, persona-attributed, proposals only.
     *  Needs the workflow plane too. Off → the Workflows "Agents" tab hides. */
    metacognition_enabled?: boolean;
    /** Experimental features, one key each (default off; superadmin switches
     *  under Settings → Features). Off → the routes 404 and the UI hides it. */
    experimental?: {
      /** Document pins: editorial + personal (CU-wdqcq02crw). */
      doc_pins?: boolean;
      /** Cross-nest document stream (GET /me/stream, the Stream page). */
      doc_stream?: boolean;
    };
    /** The assistant identity to show: the admin's custom one on an
     *  enterprise licence, the default Hootie otherwise (server-enforced). */
    hootie_brand?: HootieBrand;
    /** Whether custom assistant identity is allowed (enterprise licence). */
    hootie_branding_available?: boolean;
    /** Own model key / gateway allowed (licence feature byok, Enterprise). */
    byok_available?: boolean;
    /** PostHog project key, or null when analytics is unconfigured or usage
     *  telemetry is switched off. The browser needs it to send events. */
    posthog_key?: string | null;
    posthog_host?: string;
    /** Mail transport is set up — email/invite publish gates need it. */
    email_configured?: boolean;
    /** Who may create nests; "admins" hides the create CTAs from everyone else. */
    nest_creation?: "admins" | "everyone";
    suspended_reason?: string;
  }>("/health");
}

export type SignInGate = "open" | "admin-only" | "disabled";
export type ManualSignIn = "open" | "invite-only" | "disabled";

/** Server-wide settings editable from the admin Settings page. */
/** The assistant's identity as every surface renders it (from /health). */
export interface HootieBrand {
  name: string;
  logo_url: string | null;
  accent_color: string | null;
  greeting: string | null;
}

export const DEFAULT_HOOTIE_BRAND: HootieBrand = {
  name: "Hootie",
  logo_url: null,
  accent_color: null,
  greeting: null,
};

export interface AdminSettings {
  promptowl_sign_in_gate: SignInGate;
  manual_sign_in: ManualSignIn;
  /** Password self-registration is open while SSO is live (warned about). */
  manual_sign_in_open_with_sso?: boolean;
  community_name: string | null;
  logo_url: string | null;
  telemetry_enabled: boolean;
  /** PostHog project key ("" = analytics off) and ingestion host. */
  posthog_key: string;
  posthog_host: string;
  public_base_url: string;
  /**
   * Serve OAuth discovery and challenge MCP clients, so an agent signs its
   * user in instead of carrying a shared API key. Requires public_base_url.
   */
  mcp_oauth_enabled: boolean;
  max_body_bytes: number;
  workflow_plane_enabled: boolean;
  /** Import teams from PromptOwl (default OFF). Off → /teams/promptowl 404s
   *  and the PromptOwl Teams panel is hidden. */
  promptowl_teams_enabled: boolean;
  /** Content-type toggles (default ON). Disabling refuses new creations of
   *  the type only — existing nodes still read/render/version. */
  type_artifact_enabled: boolean;
  type_table_enabled: boolean;
  /** The server accepts `task` nodes (its engine knows the type). */
  type_task_enabled?: boolean;
  /** Hootie in the nest (default OFF — admins opt in). */
  hootie_enabled: boolean;
  /** Custom assistant identity (enterprise). "" = default. Returned even
   *  when not in effect; `hootie_branding_available` says whether it is. */
  hootie_name: string;
  hootie_logo_url: string;
  hootie_accent_color: string;
  hootie_greeting: string;
  hootie_branding_available: boolean;
  /** Own key + gateway fields are in effect and editable only with byok. */
  byok_available?: boolean;
  /** Model Hootie answers with (default claude-sonnet-5; a gateway-side name
   *  such as `ollama/…` when routed through a gateway). */
  hootie_model: string;
  subagent_runs_enabled: boolean;
  metacognition_enabled: boolean;
  /** Experimental cross-nest document stream (EXPERIMENTAL_DOC_STREAM). */
  experimental_doc_stream_enabled: boolean;
  /** Experimental document pins (EXPERIMENTAL_DOC_PINS). */
  experimental_doc_pins: boolean;
  subagent_max_depth: number;
  subagent_max_children: number;
  trace_retention_days: number;
  /** File operations one folder import keeps in flight (1–256; engine default 32). */
  import_io_concurrency: number;
  /** Superadmin message log: retention in days (0 = forever) and whether redacted bodies are kept. */
  message_log_retention_days: number;
  message_log_store_bodies: boolean;
  /** Agent-run retention (runs + steps); 0 keeps every run. */
  run_retention_days: number;
  /** OIDC SSO. The client secret is write-only — only its presence comes back. */
  oidc_enabled: boolean;
  oidc_issuer: string;
  oidc_client_id: string;
  oidc_client_secret_set?: boolean;
  oidc_allowed_domains: string;
  oidc_auto_provision: boolean;
  /** Tag new documents with the creator's directory department (dept:<slug>). */
  oidc_department_tagging: boolean;
  /** Enterprise identity providers allowed (licence feature sso). Google is on every plan. */
  sso_available?: boolean;
  /** Offer every registered account in the add-a-person pickers. Default OFF:
   *  a server holding several unrelated customers would otherwise hand one
   *  customer's staff another customer's email addresses. */
  nest_creation: "admins" | "everyone";
  people_suggest_all_users: boolean;
  /** This server hosts several organizations (PromptOwl-hosted). On, nest
   *  visibility 'org' needs the same acknowledgement as 'public' and the
   *  picker words both tiers to name the real boundary. Default OFF. */
  shared_deployment: boolean;
  /** Server-computed readiness: enabled AND issuer+client id+secret present. */
  oidc_ready?: boolean;
  /** Write-only: string sets/replaces, null clears; never returned. */
  oidc_client_secret?: string | null;
  /** Agent SSO / token-exchange (POST /auth/token-exchange). Signing secret is
   *  write-only — only its presence (mcp_signing_secret_set) comes back. */
  sso_token_exchange_enabled: boolean;
  mcp_signing_secret_set?: boolean;
  mcp_signing_secret?: string | null;
  mcp_token_ttl_seconds: number;
  ms_token_exchange_enabled: boolean;
  ms_client_id: string;
  ms_tenant_id: string;
  google_token_exchange_enabled: boolean;
  google_client_id: string;
  slack_webhook_url: string;
  msteams_webhook_url: string;
  email_provider: "smtp" | "ses";
  smtp_url: string;
  ses_region: string;
  ses_access_key_id: string;
  /** SES secret is write-only — GET reports presence; PATCH sends a string to
   *  set or null to clear. */
  ses_secret_access_key_set?: boolean;
  ses_secret_access_key?: string | null;
  notify_email_from: string;
  notify_email_to: string;
  /** Own-provider keys PromptOwl holds for this licence (byok): masked tails only. */
  own_providers?: Record<string, { masked: string; updatedAt: string | null }>;
  /** The server's own model gateway (byok): LiteLLM / Bedrock / Azure / Ollama
   *  speaking /v1/messages. "" = off (PromptOwl's gateway). */
  anthropic_base_url?: string;
  /** Masked tail of the gateway's key; never the value. */
  anthropic_api_key_masked?: string | null;
  /** Write-only: the gateway's key to set, or null to clear. */
  anthropic_api_key?: string | null;
  /** Which key Hootie's calls use: own (the server's gateway) or promptowl (credits). */
  model_source?: "own" | "promptowl" | null;
  /** Write-only: provider → key to set, or null to clear. Sent to PromptOwl, never stored here. */
  provider_keys?: Record<string, string | null>;
}

export async function getAdminSettings() {
  return request<AdminSettings>("/admin/settings");
}

/** Admin: patch one or more server settings. Live + persisted server-side. */
export async function updateAdminSettings(
  patch: Partial<AdminSettings>,
) {
  return request<{ settings: AdminSettings }>("/admin/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Admin: send a test message to the saved Slack/Teams webhook. Resolves on
 *  success; rejects (with the server's reason) if the webhook didn't accept it. */
export async function sendTestNotification(channel: "slack" | "teams") {
  return request<{ ok: true }>("/admin/settings/test-notification", {
    method: "POST",
    body: JSON.stringify({ channel }),
  });
}

// ─── Network & status (admin) ──────────────────────────────────────────
// Mirrors src/ops/status.ts and src/ops/egress.ts.

export type CheckState = "green" | "amber" | "red" | "off";

export interface StatusCheck {
  id: string;
  group: "data" | "license" | "network" | "services" | "runtime";
  label: string;
  state: CheckState;
  detail: string;
  fix?: string;
}

export interface EgressTarget {
  id: string;
  purpose: string;
  host: string;
  port: number;
  protocol: "https" | "smtp" | "postgres";
  configuredBy: string;
  required: boolean;
}

export interface StatusReport {
  generatedAt: string;
  version: string;
  build: string | null;
  listenPort: number;
  checks: StatusCheck[];
  address: {
    effectiveBaseUrl: string;
    pinned: boolean;
    requestOrigin: string;
    forwarded: { proto: string | null; host: string | null; for: string | null };
    privateHost: boolean;
  };
  egress: EgressTarget[];
}

export interface ProbeStage {
  stage: "dns" | "tcp" | "tls" | "http" | "smtp";
  ok: boolean;
  ms: number;
  detail: string;
}

export interface EgressReport {
  ranAt: string;
  proxy: string | null;
  proxyProblem: string | null;
  results: { id: string; purpose: string; host: string; port: number; ok: boolean; stages: ProbeStage[]; hint?: string }[];
  clockSkewSeconds: number | null;
}

export interface InboundReport {
  ranAt: string;
  url: string | null;
  ok: boolean;
  stages: ProbeStage[];
  privateAddresses: boolean;
  note: string;
  hint?: string;
}

export interface DiscoveryReport {
  ranAt: string;
  issuer: string | null;
  ok: boolean;
  ms: number;
  detail: string;
  endpointHosts: string[];
  hint?: string;
}

export async function getServerStatus() {
  return request<StatusReport>("/admin/status");
}

export async function runEgressCheck() {
  return request<EgressReport>("/admin/status/egress", { method: "POST", body: "{}" });
}

export async function runInboundCheck() {
  return request<InboundReport>("/admin/status/inbound", { method: "POST", body: "{}" });
}

export async function runOidcDiscoveryCheck() {
  return request<DiscoveryReport>("/admin/status/oidc-discovery", { method: "POST", body: "{}" });
}

// ─── License ───────────────────────────────────────────────────────────

export interface LicenseContact {
  url: string;
  email: string;
}

/** Trial / expiry / refusal fields shared by the public and admin views. */
export interface LicenseTerms {
  trial?: boolean;
  expires_at?: string | null;
  /** Whole days until expires_at (negative once past); null = no end date. */
  days_left?: number | null;
  /** not_found | deactivated | suspended | expired — or expired_grace (past
   *  the end date, still fully working until grace_ends_at). */
  reason?: string | null;
  grace_ends_at?: string | null;
  contact?: LicenseContact;
}

export interface LicenseStatus {
  valid: boolean;
  tier: string;
  org: string | null;
  owner_email: string | null;
  suspended: boolean;
  suspended_reason: string | null;
  limits: { maxNests: number; maxUsers: number } | null;
  /** Never licensed: show activation. False for a lapsed license. */
  setup_required?: boolean;
}

export async function getLicenseStatus() {
  return request<LicenseStatus>("/license/status");
}

/** Admin-only license detail (Settings → License, the admin banner). */
export interface AdminLicense extends LicenseTerms {
  valid: boolean;
  tier: string;
  org: string | null;
  owner_email: string | null;
  suspended: boolean;
  suspended_reason: string | null;
  seats: {
    licensed: number | null;
    used: number;
    over_limit: boolean;
    at_limit: boolean;
  };
  pending_rejections: number;
  /** Last good check, set once PromptOwl has been unreachable for over 24h: read-only until it answers. */
  offline_since?: string | null;
  last_checked_at: string | null;
  /** Own model keys / LLM gateway (licence feature byok) is on for this licence. */
  byok?: boolean;
  /** free | trial | self_hosted | enterprise. */
  plan?: string;
  /** Editors in use and the cap (null = unlimited, 0 = needs a paid plan). */
  subscribers?: { licensed: number | null; used: number };
  max_account_owners?: number | null;
  /** PromptOwl's page for this key: plan and Upgrade. */
  manage_url?: string | null;
}

export async function getAdminLicense() {
  return request<AdminLicense>("/admin/license");
}

/** Models this server's credential can reach (admin), and the one Hootie uses now. */
export async function getAdminModels() {
  return request<{ models: string[]; current: string; source: "own" | "promptowl" | null; own_models?: string[]; providers?: Record<string, string>; error?: string }>(
    "/admin/models",
  );
}

export async function installLicense(key: string) {
  return request<{
    valid: boolean;
    tier?: string;
    org?: string | null;
    limits?: { maxNests: number; maxUsers: number } | null;
    error?: string;
    // false when the key validated but couldn't be written to disk (lost on
    // restart); `warning` carries the operator-facing explanation.
    persisted?: boolean;
    warning?: string;
  } & LicenseTerms>("/license/install", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

// ─── Admin / Teammates ─────────────────────────────────────────────────

export async function getAdminStatus() {
  return request<{
    claimed: boolean;
    admin: { email: string; name: string | null } | null;
    me: { email: string; name: string | null; is_admin: boolean } | null;
  }>("/auth/admin-status");
}

export async function listTeammates() {
  return request<{
    teammates: Array<{
      id: string;
      email: string;
      name: string | null;
      is_admin: boolean;
      key_count: number;
      last_active: string | null;
    }>;
    pending_stewards: string[];
  }>("/auth/teammates");
}

export async function inviteTeammate(email: string) {
  return request<{
    temporary_password: string;
    user: { id: string; email: string };
    /** PromptOwl sign-in is open to everyone, so the teammate can use it too. */
    promptowl_sign_in?: boolean;
    /** The invite email with the password was sent to them. */
    emailed?: boolean;
    message: string;
  }>("/auth/invite", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// ─── Superadmins (server admins) ────────────────────────────────────────
// Effective superadmin = license owner ∪ access.yaml super_admins ∪ DB
// grants. Only "granted" rows are revocable from the UI.

export interface SuperAdminRow {
  email: string;
  source: "license" | "config" | "granted";
  granted_by: string | null;
  granted_at: string | null;
  self: boolean;
}

export async function listSuperAdmins() {
  return request<{ super_admins: SuperAdminRow[] }>("/admin/super-admins");
}

export async function addSuperAdmin(email: string) {
  return request<{ email: string; source: "granted"; granted_by: string }>(
    "/admin/super-admins",
    { method: "POST", body: JSON.stringify({ email }) },
  );
}

export async function removeSuperAdmin(email: string) {
  return request<{ ok: boolean; email: string }>(
    `/admin/super-admins/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
}

// ─── Community sites (official-site SSO connections) ───────────────────
// Sites trusted for one-click SSO auto-login (GET /auth/sso). `secret` is
// write-only — set it to change it, otherwise omit it; the server never
// echoes the value back, only whether one is set.

export interface CommunitySite {
  id: string;
  name: string;
  url: string;
  secret_set: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export async function listCommunitySites() {
  return request<{ community_sites: CommunitySite[] }>("/admin/community-sites");
}

export async function addCommunitySite(input: {
  name: string;
  url: string;
  secret: string;
  is_active?: boolean;
}) {
  return request<CommunitySite>("/admin/community-sites", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateCommunitySite(
  id: string,
  patch: Partial<{ name: string; url: string; secret: string; is_active: boolean }>,
) {
  return request<CommunitySite>(`/admin/community-sites/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function removeCommunitySite(id: string) {
  return request<{ ok: boolean; id: string }>(
    `/admin/community-sites/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

// Logged-in user renames themselves; empty clears the name (email shows).
export async function updateProfile(name: string) {
  return request<{ ok: boolean; name: string | null }>("/auth/profile", {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

// Logged-in user changes their own password (e.g., after an admin reset
// handed them a temporary one). Invalidates other sessions server-side.
export async function changePassword(current: string, next: string) {
  return request<{ ok: boolean }>("/auth/password", {
    method: "POST",
    body: JSON.stringify({ current, next }),
  });
}

// Superadmin activity trace — API + MCP call rows, newest first, paginated.
export async function getAdminTrace(params: {
  kind?: "api" | "mcp";
  user?: string;
  nest?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const qs = new URLSearchParams();
  if (params.kind) qs.set("kind", params.kind);
  if (params.user) qs.set("user", params.user);
  if (params.nest) qs.set("nest", params.nest);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<{
    count: number;
    total: number;
    limit: number;
    offset: number;
    events: any[];
  }>(`/admin/trace${suffix}`);
}

// ─── Superadmin message log ────────────────────────────────────────────────

export type MessageChannel = "email" | "slack" | "msteams" | "webhook" | "inbox" | "comment";
export type MessageSenderKind = "human" | "persona" | "system";
export type MessageStatus = "sent" | "failed" | "skipped";

export interface OutboundMessageRow {
  id: string;
  channel: MessageChannel;
  sender_kind: MessageSenderKind;
  sender: string | null;
  recipients: string[];
  subject: string | null;
  status: MessageStatus;
  provider_id: string | null;
  error: string | null;
  nest_id: string | null;
  nest_name: string | null;
  node_id: string | null;
  run_id: string | null;
  /** Left through the egress proxy (HTTPS_PROXY); null when not applicable. */
  via_proxy: boolean | null;
  created_at: string;
  has_body?: boolean;
  /** Detail view only: the redacted body (null when bodies aren't stored). */
  body?: string | null;
}

export interface MessageLogFilters {
  channel?: MessageChannel;
  sender_kind?: MessageSenderKind;
  status?: MessageStatus;
  sender?: string;
  nest?: string;
  run?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// Superadmin only — the server refuses everyone else, including open mode.
// Every call is recorded in the access log.
export async function getMessageLog(params: MessageLogFilters = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<{
    total: number;
    limit: number;
    offset: number;
    retention_days: number;
    store_bodies: boolean;
    messages: OutboundMessageRow[];
  }>(`/admin/messages${suffix}`);
}

export async function getMessageLogEntry(id: string) {
  return request<{ message: OutboundMessageRow }>(`/admin/messages/${encodeURIComponent(id)}`);
}

export interface MessageLogView {
  id: string;
  viewer: string | null;
  action: "list" | "detail" | "views";
  filters: Record<string, string> | null;
  message_id: string | null;
  at: string;
}

export async function getMessageLogViews(params: { limit?: number; offset?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<{ total: number; limit: number; offset: number; views: MessageLogView[] }>(
    `/admin/messages/views${suffix}`,
  );
}

// Per-nest activity trace — same rows/shape as getAdminTrace but always
// scoped server-side to one nest. Owner / nest-admin only.
export async function getNestTrace(
  nestId: string,
  params: {
    kind?: "api" | "mcp";
    user?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const qs = new URLSearchParams();
  if (params.kind) qs.set("kind", params.kind);
  if (params.user) qs.set("user", params.user);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<{
    count: number;
    total: number;
    limit: number;
    offset: number;
    events: any[];
  }>(`/nests/${encodeURIComponent(nestId)}/trace${suffix}`);
}

// Admin removes a user entirely — revokes all access and deletes them.
// Blocked server-side if they own nests or are the caller.
export async function removeUser(userId: string) {
  return request<{ ok: boolean; email: string }>(
    `/auth/users/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}

// Admin resets another user's password in-platform (no email). Omit
// `password` to have the server generate a temporary one, returned once.
export async function resetUserPassword(userId: string, password?: string) {
  return request<{
    ok: boolean;
    email: string;
    keys_revoked?: boolean;
    temporary_password?: string;
  }>(`/auth/admin/reset-password/${encodeURIComponent(userId)}`, {
    method: "POST",
    body: JSON.stringify(password ? { password } : {}),
  });
}

// ─── External-client API keys ──────────────────────────────────────────
// A user can hold several — one per place they connect from — so rotating
// the key for one client doesn't disconnect the others.

export interface ApiKeyMeta {
  id: string;
  key_prefix: string;
  nest_id: string | null;
  label: string | null;
  /** "read" keys can't write; anything else is read-write. */
  capability?: string | null;
  created_at: string;
  last_used_at: string | null;
}

export async function listApiKeys() {
  return request<{ keys: ApiKeyMeta[] }>("/auth/keys");
}

export interface ApiKeyMinted {
  id: string;
  api_key: string;
  key_prefix: string;
  label: string | null;
  /** The one nest this key is scoped to, or null for an all-nests key. */
  nest_id?: string | null;
}

/** Mint another external-client API key. 409s at the per-user ceiling or on a
 *  duplicate name; with nest_id, 404s unless the caller can reach that nest. */
export async function createApiKey(opts?: {
  label?: string;
  nest_id?: string;
  /** "read" requires nest_id — the server 400s otherwise. */
  capability?: "read" | "write";
}) {
  return request<ApiKeyMinted>("/auth/keys", {
    method: "POST",
    body: JSON.stringify(opts || {}),
  });
}

/** Rotate ONE key — atomic DELETE + INSERT, other keys untouched.
 *  key_id picks the target; omitting it works only when the account holds
 *  exactly one key. nest_id: null clears a per-nest scope, omitting keeps it. */
export async function rotateApiKey(opts?: {
  label?: string;
  nest_id?: string | null;
  key_id?: string;
}) {
  return request<ApiKeyMinted>("/auth/keys/rotate", {
    method: "POST",
    body: JSON.stringify(opts || {}),
  });
}

export async function deleteApiKey(keyId: string) {
  return request<{ deleted: boolean }>(`/auth/keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
  });
}

// ─── Connected apps (MCP OAuth grants) ─────────────────────────────────

export interface ConnectedApp {
  clientId: string;
  clientName: string;
  scopes: string[];
  redirectOrigin: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
}

export async function listConnectedApps() {
  return request<{ apps: ConnectedApp[] }>("/oauth/connected");
}

export async function disconnectApp(clientId: string) {
  return request<{ revoked: boolean }>(`/oauth/connected/${encodeURIComponent(clientId)}`, {
    method: "DELETE",
  });
}

// ─── Nest settings ─────────────────────────────────────────────────────

export interface NestSettings {
  stewardship_enabled: boolean;
  allow_self_approve: boolean;
  /** Review only prime documents; everything else self-publishes. */
  prime_only_review: boolean;
  /** Tags that mark a document prime (normalized, no leading `#`). */
  prime_tags: string[];
  /** Push Confirmation Gate — superadmin-only to SET; readable by anyone. */
  require_push_confirmation: boolean;
  /** The person who creates a document becomes its reviewer; v1 publishes. */
  creator_is_reviewer: boolean;
  /** Review SLA in hours; null = off. Overdue reviews escalate one rung. */
  review_sla_hours?: number | null;
  /** Reads, pulls and exports are recorded in the activity log (default on).
   *  Only the owner or server admin may turn it off. */
  access_log_enabled?: boolean;
}

// ── Instructions (CONTEXT.md) — CU-wdqcq05mty ─────────────────────────────

export async function getInstructions(nestId: string) {
  return request<{ content: string; revision: InstructionsRevision | null }>(
    `/nests/${nestId}/instructions`,
  );
}

/** Owner/admin. `baseRevision` is the revision the editor opened (0 = none);
 *  a 409 means someone saved since. */
export async function saveInstructions(
  nestId: string,
  data: { content: string; note?: string; baseRevision: number },
) {
  return request<{ content: string; revision: InstructionsRevision }>(
    `/nests/${nestId}/instructions`,
    { method: "PUT", body: JSON.stringify(data) },
  );
}

export async function listInstructionsRevisions(nestId: string) {
  return request<{ revisions: InstructionsRevision[] }>(
    `/nests/${nestId}/instructions/revisions`,
  );
}

export async function getInstructionsRevision(nestId: string, seq: number) {
  return request<{
    revision: InstructionsRevision;
    content: string;
    previousContent: string | null;
  }>(`/nests/${nestId}/instructions/revisions/${seq}`);
}

export async function restoreInstructionsRevision(
  nestId: string,
  seq: number,
  baseRevision: number,
) {
  return request<{ content: string; revision: InstructionsRevision }>(
    `/nests/${nestId}/instructions/revisions/${seq}/restore`,
    { method: "POST", body: JSON.stringify({ baseRevision }) },
  );
}

export async function getNestSettings(nestId: string) {
  return request<NestSettings>(`/nests/${nestId}/settings`);
}

export async function updateNestSettings(
  nestId: string,
  data: {
    stewardship_enabled?: boolean;
    allow_self_approve?: boolean;
    prime_only_review?: boolean;
    prime_tags?: string[];
    /** Superadmin-only — a per-field 403 is returned to anyone else. */
    require_push_confirmation?: boolean;
    creator_is_reviewer?: boolean;
    review_sla_hours?: number | null;
    /** Owner / server admin only to turn OFF; any nest admin may turn on. */
    access_log_enabled?: boolean;
  },
) {
  return request<NestSettings>(`/nests/${nestId}/settings`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ─── Push Confirmation Gate ────────────────────────────────────────────────

export type PendingPushStatus = "pending" | "applied" | "rejected" | "expired";

/** One staged document in a held push, as the modal renders it. */
export interface PushManifestEntry {
  /** null when the title has no ASCII slug: the id is generated on apply. */
  id: string | null;
  title: string;
  type: string;
  tags: string[];
  /** Single-push GET only: the document body. */
  content?: string;
}

export interface PendingPush {
  id: string;
  status: PendingPushStatus;
  nest_name: string;
  doc_count: number;
  manifest: PushManifestEntry[];
  submitter_label: string | null;
  submitter_email: string | null;
  submitter_user_id: string;
  created_at: string;
  expires_at: string;
  decided_by?: string;
  decided_at?: string;
  applied_node_count?: number;
  /** Single-push GET only: the context.md the push would write. */
  context_md?: string | null;
}

export interface PushAllowlistEntry {
  user_id: string;
  key_id: string | null;
  /** Resolved for display; null if the user or key has since been deleted. */
  user_email: string | null;
  key_label: string | null;
  created_by_user_id: string;
  created_at: string;
}

/** Reviewer view of held pushes (owner/admin/reviewer only). */
export async function getPendingPushes(
  nestId: string,
  status?: PendingPushStatus,
) {
  const qs = status ? `?status=${status}` : "";
  return request<{ pending_pushes: PendingPush[]; count: number }>(
    `/nests/${nestId}/pending-pushes${qs}`,
  );
}

/** Single held push — readable by the submitter OR a reviewer. */
export async function getPendingPush(nestId: string, pendingId: string) {
  return request<PendingPush>(
    `/nests/${nestId}/pending-pushes/${pendingId}`,
  );
}

/** Confirm a held push; alwaysAllow whitelists the submitter's exact key. */
export async function confirmPush(
  nestId: string,
  pendingId: string,
  alwaysAllow = false,
) {
  return request<PendingPush>(
    `/nests/${nestId}/pending-pushes/${pendingId}/confirm`,
    {
      method: "POST",
      body: JSON.stringify({ always_allow: alwaysAllow }),
    },
  );
}

export async function rejectPush(nestId: string, pendingId: string) {
  return request<PendingPush>(
    `/nests/${nestId}/pending-pushes/${pendingId}/reject`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function getPushAllowlist(nestId: string) {
  return request<{ allowlist: PushAllowlistEntry[]; count: number }>(
    `/nests/${nestId}/push-allowlist`,
  );
}

export async function removeFromAllowlist(
  nestId: string,
  userId: string,
  keyId: string | null = null,
) {
  return request<{ removed: boolean }>(`/nests/${nestId}/push-allowlist`, {
    method: "DELETE",
    body: JSON.stringify({ user_id: userId, key_id: keyId }),
  });
}

/**
 * Does this document need steward approval regardless of who edits it?
 * Mirrors the server's document → tag → nest resolution (`isPrimeDocument`);
 * the badge is advisory, the server gate is authoritative.
 */
export function isPrimeNode(
  node: { tags?: string[]; prime?: boolean },
  primeTags: string[],
): boolean {
  if (typeof node.prime === "boolean") return node.prime;
  if (!primeTags.length) return false;
  const wanted = new Set(primeTags);
  return (node.tags || []).some((t) =>
    wanted.has(t.trim().replace(/^#+/, "").toLowerCase()),
  );
}

// ─── Nests ──────────────────────────────────────────────────────────────

/** `archived` lists ONLY archived nests — the dashboard's Archived tab.
 *  Without it archived nests are absent, as they are from every other surface. */
export async function listNests(opts?: { archived?: boolean }) {
  return request<{ nests: any[] }>(
    opts?.archived ? "/nests?archived=1" : "/nests",
  );
}

export async function createNest(name: string, description?: string) {
  return request<{ nest: any }>("/nests", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}

export async function deleteNest(nestId: string) {
  return request("/nests/" + nestId, { method: "DELETE" });
}

/** Put the nest away: hidden and read-only, nothing deleted. */
export async function archiveNest(nestId: string) {
  return request<{ archived: true }>("/nests/" + nestId + "/archive", {
    method: "POST",
  });
}

/** Bring an archived nest back exactly as it was. */
export async function restoreNest(nestId: string) {
  return request<{ restored: true }>("/nests/" + nestId + "/restore", {
    method: "POST",
  });
}
/** Pin/unpin this nest for the signed-in user. A pin is personal — it changes
 *  nothing about the nest and nobody else sees it. */
export async function setNestPinned(nestId: string, pinned: boolean) {
  return request<{ pinned: boolean }>("/nests/" + nestId + "/pin", {
    method: pinned ? "POST" : "DELETE",
  });
}

// ─── Document pins (experimental, CU-wdqcq02crw) ──────────────────────────
export type DocPinScope = "nest" | "user";
export interface DocPin {
  node_id: string;
  scope: DocPinScope;
  title: string;
  type: string;
  status: string;
  position: number;
  pinned_by: string | null;
  pinned_at: string;
}
export interface DocPins {
  /** Pinned for everyone, in the steward's order. */
  editorial: DocPin[];
  /** The caller's own bookmarks. */
  personal: DocPin[];
  /** The caller may pin for everyone and reorder. */
  can_pin_editorial: boolean;
}
export async function getDocPins(nestId: string) {
  return request<DocPins>(`/nests/${nestId}/pins`);
}
export async function pinDoc(nestId: string, nodeId: string, scope: DocPinScope) {
  return request<{ pin: DocPin; created: boolean }>(`/nests/${nestId}/pins`, {
    method: "POST",
    body: JSON.stringify({ node_id: nodeId, scope }),
  });
}
export async function unpinDoc(nestId: string, nodeId: string, scope: DocPinScope) {
  const q = new URLSearchParams({ node_id: nodeId, scope });
  return request<{ unpinned: boolean }>(`/nests/${nestId}/pins?${q}`, { method: "DELETE" });
}
export async function reorderDocPins(nestId: string, nodeIds: string[]) {
  return request<DocPins>(`/nests/${nestId}/pins/order`, {
    method: "PUT",
    body: JSON.stringify({ node_ids: nodeIds }),
  });
}

export async function updateNest(
  nestId: string,
  patch: { name?: string; description?: string | null },
) {
  return request<{ nest: any }>("/nests/" + nestId, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** One file from the browser folder pick, path relative to the chosen folder. */
export interface ImportedFile {
  path: string;
  content: string;
}

/** Upload budget per import request. A whole folder in one body hit proxy
 *  request-size limits (and gave no usable error when it did); ~4MB chunks stay
 *  well under every hop's ceiling and each one reports its own HTTP status. */
const IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Biggest single file an import request can carry. A file over the chunk
 *  budget cannot be split, so it used to ship alone in one oversized body and
 *  the server answered 413 — failing the WHOLE import, not just that file.
 *  Under the server's MAX_BODY_BYTES (10MB) with room for JSON escaping. */
const IMPORT_FILE_MAX_BYTES = 8 * 1024 * 1024;

/** Import a folder the user picked in their browser. The browser reads the
 *  folder and uploads each file; the server writes them into the workspace.
 *
 *  Uploaded in bounded chunks over plain JSON requests, NOT as one body and
 *  not over an NDJSON stream. The stream had already committed HTTP 200 before
 *  the import ran, so every failure surfaced as a bare "Import failed" with the
 *  cause stuck in the server log — and a buffering proxy ate the progress lines
 *  that were its only reason to exist. Each chunk here fails with a real status
 *  and a real message.
 *
 *  `onProgress` reports files uploaded; reaching `done === total` means the
 *  upload finished and the server is registering documents (one final call,
 *  no per-document progress). */
export async function importNest(
  name: string,
  files: ImportedFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ nest: any; documents: number; rejected: string[] }> {
  // Measured in UTF-8 bytes, which is what actually travels. `String.length`
  // counts UTF-16 code units: a CJK document encodes to roughly three bytes per
  // counted character, so sizing by length would build a chunk several times
  // over budget and walk straight back into the request-size limit this
  // batching exists to avoid.
  const encoder = new TextEncoder();
  const chunks: ImportedFile[][] = [];
  const oversized: string[] = [];
  let cur: ImportedFile[] = [];
  let curBytes = 0;
  for (const f of files) {
    const size = encoder.encode(f.path).length + encoder.encode(f.content ?? "").length;
    // Too big to travel in any request. Reported like a server-side rejection
    // instead of sent, so one huge file no longer 413s the whole import.
    if (size > IMPORT_FILE_MAX_BYTES) {
      oversized.push(f.path);
      continue;
    }
    // A single file over budget still goes alone rather than being split.
    if (cur.length && curBytes + size > IMPORT_CHUNK_BYTES) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += size;
  }
  if (cur.length || !chunks.length) chunks.push(cur);

  onProgress?.(0, files.length);
  // Files the server refused (an unsafe path), gathered across every chunk so
  // the caller can report a partial import honestly instead of a clean one.
  const rejected: string[] = [...oversized];
  const first = await request<{ nest: any; documents?: number; rejected?: string[] }>(
    "/nests/import",
    {
      method: "POST",
      body: JSON.stringify({ name, files: chunks[0], partial: chunks.length > 1 }),
    },
  );
  rejected.push(...(first.rejected ?? []));
  let done = chunks[0].length;
  onProgress?.(done, files.length);
  // Small folder — the server already registered it in that one call.
  if (chunks.length === 1) {
    return { nest: first.nest, documents: first.documents ?? 0, rejected };
  }

  const nestId = first.nest.id;
  try {
    for (const chunk of chunks.slice(1)) {
      const res = await request<{ rejected?: string[] }>("/nests/import", {
        method: "POST",
        body: JSON.stringify({ nestId, files: chunk }),
      });
      rejected.push(...(res.rejected ?? []));
      done += chunk.length;
      onProgress?.(done, files.length);
    }
    const final = await request<{ nest: any; documents: number }>("/nests/import", {
      method: "POST",
      body: JSON.stringify({ nestId, finalize: true }),
    });
    return { ...final, rejected };
  } catch (err) {
    // A half-uploaded nest is worse than none — it lists as a real nest with
    // silently missing documents. Drop it so a retry starts clean.
    await deleteNest(nestId).catch(() => {});
    throw err;
  }
}

/** A folder under DATA_ROOT that has not been converted to a nest yet. */
export interface UnsyncedFolder {
  /** Path relative to DATA_ROOT (e.g. "nodes/architecture"). */
  name: string;
  /** Display label — leaf folder name (e.g. "architecture"). */
  label: string;
  mdCount: number;
  sizeBytes: number;
}

export async function listUnsyncedFolders() {
  return request<{ folders: UnsyncedFolder[] }>("/nests/unsynced");
}

export async function syncUnsyncedFolder(name: string) {
  // request() invalidates the nests list and the unsynced-folder list on its
  // own — "unsynced" is not a nest id, so the path falls to the generic /nests
  // rule (see invalidateForPath).
  return request<{ nest: any; documents: number }>("/nests/unsynced/sync", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function deleteUnsyncedFolder(name: string) {
  return request<{ ok: true }>("/nests/unsynced/sync", {
    method: "DELETE",
    body: JSON.stringify({ name }),
  });
}

export async function setNestVisibility(
  nestId: string,
  visibility: NestVisibility,
  // Publishing (→ public) requires an explicit acknowledgement that the nest
  // becomes readable by anyone on the internet, outside your organization.
  // Without it the server returns 409 requires_acknowledgement. Going back to
  // private needs no acknowledgement, so this is optional. Despite the name,
  // the same flag also acknowledges → org on a SHARED deployment (/health
  // shared_deployment), where "organization" is every account on the server:
  // one wire field for "I understand who this reaches", whichever tier.
  acknowledgePublic?: boolean,
) {
  return request<{ visibility: NestVisibility }>(
    `/nests/${nestId}/visibility`,
    {
      method: "PATCH",
      body: JSON.stringify(
        acknowledgePublic
          ? { visibility, acknowledge_public: true }
          : { visibility },
      ),
    },
  );
}

// Headless publishing (CU-wdqcq0314u) — owner / nest admin only. A headless
// nest is API-only: buyers get read-only access keys that work with ctx/MCP,
// and can never open or browse the nest.
export interface HeadlessKey {
  id: string;
  label: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export async function getNestHeadless(nestId: string) {
  return request<{
    enabled: boolean;
    keys: HeadlessKey[];
    /** Who keeps their seat — headless doesn't remove existing access. */
    shared_with?: { collaborators: number; teams: number; grants: number };
  }>(`/nests/${nestId}/headless`);
}

export async function setNestHeadless(nestId: string, enabled: boolean) {
  return request<{ enabled: boolean }>(`/nests/${nestId}/headless`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

/** The token comes back ONCE — show it, then it is gone. */
export async function mintNestHeadlessKey(nestId: string, label: string) {
  return request<{ key: HeadlessKey; api_key: string }>(`/nests/${nestId}/headless/keys`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

export async function revokeNestHeadlessKey(nestId: string, keyId: string) {
  return request<{ revoked: true }>(`/nests/${nestId}/headless/keys/${keyId}`, {
    method: "DELETE",
  });
}

// Configure Public Docs Reader Mode (superadmin-only). Either field may be sent
// on its own; home_node: null clears the designated landing node.
export async function setNestReaderMode(
  nestId: string,
  body: { enabled?: boolean; home_node?: string | null },
) {
  return request<{ reader_mode: number; reader_home_node: string | null }>(
    `/nests/${nestId}/reader-mode`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

// Per-nest reader branding (owner / nest admin / server admin). The body
// replaces the whole branding; null clears it. hide_powered_by is server-admin
// only (403 otherwise).
export async function setNestBranding(nestId: string, branding: NestBranding | null) {
  return request<{ branding: NestBranding | null }>(`/nests/${nestId}/branding`, {
    method: "PATCH",
    body: JSON.stringify(branding),
  });
}

// Public docs site (CU-wdqcq05jhm) — owner / nest admin / server admin.
export interface SiteSettings {
  title?: string;
  description?: string;
  public_url?: string;
  og_image_url?: string;
  organization_name?: string;
  organization_url?: string;
  organization_logo_url?: string;
  same_as?: string[];
  twitter_site?: string;
  google_site_verification?: string;
  bing_site_verification?: string;
  language?: string;
  noindex?: boolean;
  ai_training?: boolean;
  ai_actions?: boolean;
  indexnow?: boolean;
  redirects?: Array<{ from: string; to: string }>;
}
export interface SiteInfo {
  live: boolean;
  reason: string | null;
  url: string | null;
  domain: string | null;
  domain_verified: boolean;
  domain_verified_at: string | null;
  serving_domain: string | null;
  dns: { txt: { name: string; value: string } | null; cname: string | null } | null;
  public_url_verified: boolean;
  public_url_dns: { name: string; value: string } | null;
  settings: SiteSettings;
  pages: Array<{ node_id: string; title: string; path: string; custom: boolean }>;
}
export async function getNestSite(nestId: string) {
  return request<SiteInfo>(`/nests/${nestId}/site`);
}
export async function updateNestSite(nestId: string, body: { domain?: string | null; settings?: SiteSettings }) {
  return request<SiteInfo>(`/nests/${nestId}/site`, { method: "PATCH", body: JSON.stringify(body) });
}
export async function verifyNestSiteDomain(nestId: string) {
  return request<SiteInfo>(`/nests/${nestId}/site/verify-domain`, { method: "POST", body: "{}" });
}
export async function verifyNestSitePublicUrl(nestId: string) {
  return request<SiteInfo>(`/nests/${nestId}/site/verify-public-url`, { method: "POST", body: "{}" });
}
export async function setNestSitePageUrl(nestId: string, nodeId: string, path: string | null) {
  return request<SiteInfo>(`/nests/${nestId}/site/pages`, {
    method: "PUT",
    body: JSON.stringify({ node_id: nodeId, path }),
  });
}

export async function getNest(nestId: string) {
  return request<{
    nest: {
      id: string;
      name: string;
      visibility: NestVisibility;
      // Public Docs Reader Mode fields — surfaced straight off the SELECT *.
      reader_mode?: number;
      reader_home_node?: string | null;
      // Set when the nest is archived — surfaced straight off the SELECT *.
      archived_at?: string | null;
      // Per-nest reader branding, parsed server-side; null = unbranded.
      branding?: NestBranding | null;
    };
    permission: string;
    // Caller's merged effective roles (collaborator + steward), nest-wide.
    roles?: Array<"owner" | "admin" | "editor" | "reviewer" | "viewer">;
    // Caller's own steward rows (scoped). Full roster is admin-only.
    myStewards?: any[];
  }>(`/nests/${nestId}`);
}

// ─── Glossary definitions ──────────────────────────────────────────────

export interface Definition {
  id: string;
  term: string;
  definition: string;
  linked_tag: string | null;
  defined_by: string;
  created_at: string;
  updated_at: string;
}

export async function listDefinitions(nestId: string) {
  return request<{ count: number; definitions: Definition[] }>(
    `/nests/${nestId}/definitions`,
  );
}

export async function upsertDefinition(
  nestId: string,
  data: {
    term: string;
    definition: string;
    linked_tag?: string | null;
    // The row being edited, when renaming/editing an existing definition.
    // Scopes the upsert to that row so a rename can't overwrite a sibling
    // that already owns the new term (server returns 409 instead).
    editing_id?: string;
  },
) {
  return request<{ definition: Definition }>(`/nests/${nestId}/definitions`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteDefinition(nestId: string, id: string) {
  return request<{ deleted: boolean }>(
    `/nests/${nestId}/definitions/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

// ─── Structure rules ───────────────────────────────────────────────────
// One nest's folder layout, naming and template rules, kept in that nest's
// own vault. The server (the engine) judges everything: this module only
// carries rules and verdicts.

/** One folder rule as written in the nest's config (its key is the pattern). */
export interface StructureFolderConfig {
  description?: string;
  types?: string[];
  folder_name?: string;
  file_name?: string;
  template?: string;
  required?: boolean;
  files?: Record<string, { template?: string; type?: string } | null>;
}

export interface StructureTemplateConfig {
  body?: string;
  required_sections?: string[];
}

/** The three config blocks a nest's rules live in. */
export interface StructureRules {
  structure?: { enforce?: boolean; closed?: boolean };
  folders?: Record<string, StructureFolderConfig | null>;
  templates?: Record<string, StructureTemplateConfig | null>;
}

export interface StructureViolation {
  code: string;
  /** Content-relative path (no `nodes/`) of the folder or document at fault. */
  path: string;
  rule?: string;
  message: string;
}

export interface StructureFolderRule extends StructureFolderConfig {
  pattern: string;
  required: boolean;
  files: Record<string, { template?: string; type?: string }>;
}

export interface StructureResponse {
  enforce: boolean;
  closed: boolean;
  folders: StructureFolderRule[];
  templates: Record<string, { body: string; required_sections: string[] }>;
  warnings?: string[];
  /** The saved rules do not compile (hand-edited config): why. */
  error?: string;
  /** With `folder`: the rule that governs it, or null. */
  resolved?: (StructureFolderRule & { template_body?: string; required_sections?: string[] }) | null;
  /** With `report`: existing content that breaks the rules. */
  violations?: StructureViolation[];
  /** The saved blocks as written — what the editor starts from. */
  rules: StructureRules;
  yaml: string;
  /** Node types this server accepts. */
  types: string[];
}

export interface StructureCheckResult {
  fieldErrors: Record<string, string>;
  error?: string;
  warnings: string[];
  /** `generated`: the title has no a-z letters or digits, so the name is generated (document-1, …). */
  results: Array<{ ok: boolean; slug: string; generated?: boolean; violations: StructureViolation[] }>;
  folders: Array<{
    folder: string;
    violations: StructureViolation[];
    creates: { folders: string[]; files: Array<{ path: string }> };
  }>;
  report?: { violations: StructureViolation[] };
}

export async function getStructure(nestId: string, opts: { folder?: string; report?: boolean } = {}) {
  const q = new URLSearchParams();
  if (opts.folder !== undefined) q.set("folder", opts.folder);
  if (opts.report) q.set("report", "1");
  const qs = q.toString();
  return request<StructureResponse>(`/nests/${nestId}/structure${qs ? `?${qs}` : ""}`);
}

/** Owner/admin. A 400 carries `fieldErrors` keyed like `folders.<pattern>.file_name`. */
export async function saveStructure(nestId: string, rules: StructureRules) {
  return request<Omit<StructureResponse, "rules" | "yaml" | "types" | "violations"> & { violations: number | null }>(
    `/nests/${nestId}/structure`,
    { method: "PUT", body: JSON.stringify(rules) },
  );
}

/** Judge titles and folders against the saved rules, or (owner/admin) a draft. */
export async function checkStructure(
  nestId: string,
  body: {
    rules?: StructureRules;
    report?: boolean;
    /** With `file_name` / `folder_name`, the name is tried against that format alone. */
    tests?: Array<{ folder?: string; title?: string; name?: string; type?: string; body?: string; file_name?: string; folder_name?: string }>;
    folders?: string[];
  },
) {
  return request<StructureCheckResult>(`/nests/${nestId}/structure/check`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── Nodes ──────────────────────────────────────────────────────────────

// Upload an image or video into the nest's assets folder. Multipart (not
// the JSON request() helper) — the browser sets the boundary content-type
// itself. `markdown` is `![alt](url)` for images, the bare URL for video.
export async function uploadAsset(nestId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/nests/${nestId}/assets`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed: ${res.status}`);
  return data as { file: string; url: string; markdown: string };
}

/** Nest-wide shape that rides along with a folder-scoped listing. */
export interface NestCensus {
  total: number;
  folders: Array<{ path: string; count: number; total: number }>;
  tags: Record<string, number>;
  types: Record<string, number>;
  statuses: Record<string, number>;
  authors: string[];
  editedLast7d: number;
  recent: Array<{ id: string; title: string; type: string; updated_at?: string }>;
}

/**
 * The whole nest, WITH document bodies.
 *
 * `content=1` is not optional here: wiki-link analysis is the reason this call
 * exists at its widest. Backlinks, unlinked mentions, stale alias links,
 * related-doc scoring and the orphan/broken-link panel all read `[[targets]]`
 * out of every document's body, and a nest-wide listing is the only place they
 * get it. Without the flag they degrade to empty silently — no error, no failed
 * request, just a permanently blank panel.
 *
 * Every caller shares one react-query key, so this is a single cached payload
 * rather than a fetch per consumer. NOT used by the nest detail page's document
 * tree — that goes through listFolderNodes, which stays body-free on purpose.
 */
export async function listNodes(nestId: string) {
  return request<{ count: number; nodes: any[] }>(
    `/nests/${nestId}/nodes?content=1`,
  );
}

/**
 * One folder LEVEL — the documents sitting directly in `folder` ("" is the
 * nest root), never its subtree. The census describes the whole nest so the
 * caller can render the full folder tree without loading the documents in it.
 *
 * Deliberately WITHOUT `content=1`, unlike listNodes: this is the nest detail
 * page's tree fetch, it renders name/tags/status and no body, and it is the one
 * request path the node index exists to keep off the filesystem. Anything here
 * that needs a body should fetch that document.
 */
export async function listFolderNodes(nestId: string, folder: string) {
  return request<{ count: number; nodes: any[] }>(
    `/nests/${nestId}/nodes?folder=${encodeURIComponent(folder)}`,
  );
}

/**
 * The whole nest, metadata only — no body, no `folder` scope. Same
 * body-free/index-backed path as listFolderNodes (see its comment), just
 * unscoped so every node in the nest comes back in one request.
 *
 * For consumers like the Board that bucket EVERY node by tag/folder/status
 * and never read a body: using listNodes here would force the `content=1`
 * vault crawl for bytes that are thrown away, on every load and refresh.
 */
export async function listNodesMeta(nestId: string, approvedOnly = false) {
  return request<{ count: number; nodes: any[] }>(
    `/nests/${nestId}/nodes${approvedOnly ? "?approved_only=1" : ""}`,
  );
}

/** The nest-wide shape — one per nest, not per folder level. */
export async function getNestCensus(nestId: string) {
  return request<{ census: NestCensus }>(`/nests/${nestId}/census`);
}

/** Per-node comment (annotation thread) counts for sorting the document list. */
export async function getCommentCounts(nestId: string) {
  return request<{
    counts: Record<string, { count: number; lastAt: string | null }>;
  }>(`/nests/${nestId}/comment-counts`);
}

/** approvedOnly serves the approved body, as a public reader would get it. */
export async function getNode(nestId: string, nodeId: string, approvedOnly = false) {
  return request<{ node: any }>(
    `/nests/${nestId}/nodes/${nodeId}${approvedOnly ? "?approved_only=1" : ""}`,
  );
}

export async function createNode(
  nestId: string,
  data: {
    title: string;
    content: string;
    tags?: string[];
    type?: string;
    folder?: string;
    /** Orchestrator schedule — runnable types (agent/skill) only. */
    schedule?: string;
    /** Flag as prime (always needs approval). Owner/admin only. */
    prime?: boolean;
    /** Board fields — any node; `null` clears (see src/nodes/task-fields.ts). */
    assignee?: string | null;
    due?: string | null;
    priority?: string | null;
    parent?: string | null;
    /** Custom field values, key → value (see lib/custom-fields.ts). */
    fields?: Record<string, unknown>;
  },
) {
  return request<{ node: any; stewards?: any[] }>(`/nests/${nestId}/nodes`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** The `pdf:` block a pdf node carries (engine §1.11). */
export interface PdfMeta {
  file: string;
  sha256: string;
  bytes: number;
  pages: number;
  /** False for a scanned PDF: no text could be extracted, the body is empty. */
  text_layer: boolean;
  extractor: string;
  extractor_version: string;
  extracted_at: string;
}

/**
 * Upload a PDF as a governed `pdf` document (multipart — the browser sets the
 * boundary). Pass `nodeId` to replace the PDF of an existing pdf node: that is
 * a new version, governed like any edit. The body becomes the extracted text.
 */
export async function createPdfNode(
  nestId: string,
  file: File,
  opts: { title?: string; folder?: string; tags?: string[]; nodeId?: string; changeNote?: string } = {},
) {
  const form = new FormData();
  form.append("file", file);
  if (opts.title) form.append("title", opts.title);
  if (opts.folder) form.append("folder", opts.folder);
  if (opts.nodeId) form.append("nodeId", opts.nodeId);
  if (opts.changeNote?.trim()) form.append("changeNote", opts.changeNote.trim());
  for (const t of opts.tags ?? []) form.append("tags", t);
  const res = await fetch(`/nests/${nestId}/nodes/pdf`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `PDF upload failed: ${res.status}`);
  return data as { node: any; version: number; stewards?: any[] };
}

/**
 * Same-origin URL of a pdf node's binary. The server picks the version a
 * caller may see (a public reader always gets the approved one); `approvedOnly`
 * asks for that view explicitly, `download` for an attachment disposition.
 */
export function pdfUrl(
  nestId: string,
  nodeId: string,
  opts: { version?: number; approvedOnly?: boolean; download?: boolean } = {},
): string {
  const q = new URLSearchParams();
  if (opts.version) q.set("version", String(opts.version));
  if (opts.approvedOnly) q.set("approved_only", "1");
  if (opts.download) q.set("download", "1");
  const qs = q.toString();
  return `/nests/${nestId}/nodes/${nodeId}/pdf${qs ? `?${qs}` : ""}`;
}

export async function updateNode(
  nestId: string,
  nodeId: string,
  data: {
    content?: string;
    tags?: string[];
    title?: string;
    changeNote?: string;
    /** Runnable types (agent/skill) only; "" clears it. */
    schedule?: string;
    /** Owner/admin only; `null` clears the flag back to tag/nest inheritance. */
    prime?: boolean | null;
    /** Re-type the node ("Turn into…"). Same accepted set as create. */
    type?: string;
    /** Board fields — any node; `null` clears (see src/nodes/task-fields.ts). */
    assignee?: string | null;
    due?: string | null;
    priority?: string | null;
    parent?: string | null;
    /** Custom field values to set; `null` clears one, omitted keys stay. */
    fields?: Record<string, unknown>;
  },
  baseVersion?: number,
) {
  const headers: Record<string, string> = {};
  if (baseVersion !== undefined) {
    headers["X-Base-Version"] = String(baseVersion);
  }
  return request(`/nests/${nestId}/nodes/${nodeId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(data),
  });
}

export async function deleteNode(nestId: string, nodeId: string) {
  return request(`/nests/${nestId}/nodes/${nodeId}`, { method: "DELETE" });
}

/** Move a document to another folder ("" = nest root). The node id changes;
 *  history, review state, annotations, edges, and grants follow it. */
export async function moveNode(nestId: string, nodeId: string, folder: string) {
  return request<{ ok: boolean; node: any; previousId: string }>(
    `/nests/${nestId}/nodes/${nodeId}/move`,
    { method: "POST", body: JSON.stringify({ folder }) },
  );
}

// ─── Search & Query ─────────────────────────────────────────────────────

export async function searchNodes(nestId: string, query: string) {
  return request<{ count: number; nodes: any[] }>(
    `/nests/${nestId}/search?q=${encodeURIComponent(query)}`,
  );
}

/** One hit from the cross-nest search — a node plus the nest it lives in. */
export interface GlobalSearchHit {
  id: string;
  title: string;
  type: string;
  tags: string[];
  snippet: string;
  nest_id: string;
  nest_name: string;
}

/** Same full-text match as searchNodes, run across every nest the caller can
 *  see — so a document can be found without knowing which nest holds it.
 *  `count` is everything found; `nodes` is capped at `limit`. */
export async function searchAllNests(query: string, limit = 20) {
  return request<{ query: string; count: number; nodes: GlobalSearchHit[] }>(
    `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
}

export async function getOverview(nestId: string) {
  return request(`/nests/${nestId}/overview`);
}

/** Nest markdown export — returns raw `text/markdown` (NOT JSON), so it
 *  bypasses the JSON-parsing `request` helper. Backs the UI "Export" action;
 *  agents fetch the same URL directly. */
export async function exportNestMarkdown(
  nestId: string,
  opts: { selector?: string; maxTokens?: number } = {},
): Promise<string> {
  const params = new URLSearchParams({ format: "markdown" });
  if (opts.selector) params.set("selector", opts.selector);
  if (opts.maxTokens) params.set("max_tokens", String(opts.maxTokens));
  const res = await fetch(
    `${API_BASE}/nests/${nestId}/export?${params.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    const body = await res.text();
    let msg = `Export failed (${res.status})`;
    try {
      msg = (JSON.parse(body) as { error?: string }).error || msg;
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(msg);
  }
  return res.text();
}

/**
 * Download the full-fidelity portability bundle (.zip) for a nest — content +
 * version history + structural governance. Owner/admin only. Triggers a browser
 * download; resolves once the blob is fetched.
 */
export async function exportNestBundle(
  nestId: string,
  opts: { nestName?: string; includeDrafts?: boolean } = {},
): Promise<void> {
  const params = new URLSearchParams({ format: "bundle" });
  if (opts.includeDrafts) params.set("includeDrafts", "1");
  const res = await fetch(
    `${API_BASE}/nests/${nestId}/export?${params.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    const body = await res.text();
    let msg = `Export failed (${res.status})`;
    try {
      msg = (JSON.parse(body) as { error?: string }).error || msg;
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const slug =
    (opts.nestName || "nest").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "nest";
  a.download = `${slug}-bundle.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function listTags(nestId: string): Promise<string[]> {
  const res = await request<{ tags?: Record<string, number> }>(
    `/nests/${nestId}/overview`,
  );
  const tags = res?.tags ?? {};
  return Object.keys(tags)
    .map((t) => t.replace(/^#+/, ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

// ─── Governance ─────────────────────────────────────────────────────────

export async function listStewards(nestId: string) {
  return request<{ stewards: any[]; ownerEmail: string | null }>(`/nests/${nestId}/stewards`);
}

export async function syncStewards(nestId: string) {
  return request<{ synced: number }>(`/nests/${nestId}/stewards/sync`, {
    method: "POST",
    body: "{}",
  });
}

export async function assignSteward(nestId: string, data: any) {
  return request(`/nests/${nestId}/stewards`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function removeSteward(nestId: string, stewardId: string) {
  return request(`/nests/${nestId}/stewards/${stewardId}`, {
    method: "DELETE",
  });
}

export async function updateSteward(
  nestId: string,
  stewardId: string,
  update: {
    role?: string;
    scope?: string;
    nodePattern?: string;
    tagName?: string;
  },
) {
  return request<{ steward: any }>(`/nests/${nestId}/stewards/${stewardId}`, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

export async function getNodeStewards(nestId: string, nodeId: string) {
  return request<{ stewards: any[] }>(
    `/nests/${nestId}/nodes/${nodeId}/stewards`,
  );
}

/** Who besides the caller could approve the caller's submission of this node. */
export async function getNodeApprovers(nestId: string, nodeId: string) {
  return request<{
    approvers: Array<{ email: string; name: string | null }>;
    /** The roster passed the server's cap — an empty list proves nothing. */
    truncated?: boolean;
  }>(
    `/nests/${nestId}/nodes/${nodeId}/approvers`,
  );
}

// ── Deletion requests ─────────────────────────────────────────────────────
// Flagging is open to anyone who can read the node; resolving needs the same
// write permission a direct delete does (server-enforced).

export interface DeletionRequest {
  id: string;
  /** Node id, folder path, or nest id — see targetType. */
  nodeId: string;
  targetType?: "document" | "folder" | "nest" | "nest_archive";
  title?: string;
  requestedBy: string;
  reason: string;
  status: "pending" | "declined";
  createdAt: string;
  resolvedBy?: string;
  resolutionNote?: string;
}

export async function requestNodeDeletion(
  nestId: string,
  nodeId: string,
  reason: string,
) {
  return request<{ request: DeletionRequest }>(
    `/nests/${nestId}/nodes/${nodeId}/request-deletion`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

/** Delete a folder and every document under it. Owner/admin only. */
export async function deleteFolder(nestId: string, folder: string) {
  return request<{ deleted: number; nodeIds: string[] }>(
    `/nests/${nestId}/delete-folder`,
    { method: "POST", body: JSON.stringify({ folder }) },
  );
}

/** Rename or move a folder (`to` is its new full path) with everything in it. Owner/admin only. */
export async function moveFolder(nestId: string, folder: string, to: string) {
  return request<{ folder: string; moved: Array<{ id: string; previousId: string }> }>(
    `/nests/${nestId}/folders/move`,
    { method: "POST", body: JSON.stringify({ folder, to }) },
  );
}

/** Flag a whole folder ("api/limits") or the nest itself. "nest_archive" asks
 *  for the nest to be archived rather than destroyed — same queue, same
 *  reviewers, different outcome when it is honoured. */
export async function requestTargetDeletion(
  nestId: string,
  targetType: "folder" | "nest" | "nest_archive",
  target: string,
  reason: string,
) {
  return request<{ request: DeletionRequest }>(
    `/nests/${nestId}/request-deletion`,
    {
      method: "POST",
      body: JSON.stringify({ targetType, target, reason }),
    },
  );
}

/** status: "pending" | "declined" | "all" */
export async function getDeletionRequests(nestId: string, status = "pending") {
  return request<{ requests: DeletionRequest[]; total: number }>(
    `/nests/${nestId}/deletion-requests?status=${encodeURIComponent(status)}`,
  );
}

// ─── Access requests (CU-wdqcq041jn) ─────────────────────────────────────

/** Ask for write access to a document, folder or the nest. 201 = filed,
 *  200 = the pending one already there (`created: false`). */
export async function requestAccess(
  nestId: string,
  target: AccessTarget,
  note?: string,
) {
  return request<{ request: AccessRequest; created: boolean }>(
    `/nests/${nestId}/access-requests`,
    {
      method: "POST",
      body: JSON.stringify({
        target_type: target.type,
        target_id: target.id,
        level: "write",
        ...(note ? { note } : {}),
      }),
    },
  );
}

/** The caller's latest request for one target, whatever its state. */
export async function getMyAccessRequest(nestId: string, target: AccessTarget) {
  return request<{ request: AccessRequest | null }>(
    `/nests/${nestId}/access-requests/mine?target_type=${encodeURIComponent(target.type)}&target_id=${encodeURIComponent(target.id)}`,
  );
}

export async function approveAccessRequest(nestId: string, id: string, note?: string) {
  return request<{ request: AccessRequest }>(
    `/nests/${nestId}/access-requests/${id}/approve`,
    { method: "POST", body: JSON.stringify(note ? { note } : {}) },
  );
}

export async function denyAccessRequest(nestId: string, id: string, note?: string) {
  return request<{ request: AccessRequest }>(
    `/nests/${nestId}/access-requests/${id}/deny`,
    { method: "POST", body: JSON.stringify(note ? { note } : {}) },
  );
}

export async function approveDeletionRequest(nestId: string, id: string) {
  return request<{ deleted: boolean; nodeId: string }>(
    `/nests/${nestId}/deletion-requests/${id}/delete`,
    { method: "POST" },
  );
}

export async function declineDeletionRequest(
  nestId: string,
  id: string,
  note: string,
) {
  return request<{ request: DeletionRequest }>(
    `/nests/${nestId}/deletion-requests/${id}/decline`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
}

/** Withdraw your own pending deletion request. */
export async function withdrawDeletionRequest(nestId: string, id: string) {
  return request<{ withdrawn: boolean; request: DeletionRequest }>(
    `/nests/${nestId}/deletion-requests/${id}/withdraw`,
    { method: "POST" },
  );
}

/** Create a folder with nothing in it — no placeholder document. */
export async function createFolder(nestId: string, folder: string) {
  return request<{ folder: string }>(`/nests/${nestId}/folders`, {
    method: "POST",
    body: JSON.stringify({ folder }),
  });
}

/** Withdraw your own pending review — the document returns to draft. */
export async function cancelReview(nestId: string, nodeId: string) {
  return request<{ review: unknown }>(
    `/nests/${nestId}/nodes/${nodeId}/cancel-review`,
    { method: "POST" },
  );
}

export async function getReviewQueue(nestId: string, status = "pending") {
  return request<{ requests: any[]; total: number }>(
    `/nests/${nestId}/review-queue?status=${encodeURIComponent(status)}`,
  );
}

// ── Nest activity feed (changes + comments) ───────────────────────────────

export type FeedFilter = "all" | "changes" | "comments";

/** A pending change submission — same fields the review queue returns. */
export interface FeedChangeItem {
  type: "change";
  id: string;
  nestId: string;
  nodeId: string;
  title?: string;
  version: number;
  requestedBy: string;
  requestedAt: string;
  requestNote?: string;
  status: string;
  priority: string;
  canReview: boolean;
  createdAt: string;
}

/** One comment event — a new annotation thread, or a reply on one. */
export interface FeedCommentItem {
  type: "comment";
  id: string;
  threadId: string;
  nodeId: string;
  title?: string;
  author: string;
  snippet: string;
  createdAt: string;
  resolved: boolean;
  isReply: boolean;
}

/** A held agent write awaiting confirmation (Push Confirmation Gate). */
export interface FeedPendingPushItem {
  type: "pending_push";
  id: string;
  nestId: string;
  nestName: string;
  docCount: number;
  manifest: PushManifestEntry[];
  submitterLabel: string | null;
  submitterEmail: string | null;
  createdAt: string;
  expiresAt: string;
  canConfirm: boolean;
}

export type FeedItem =
  | FeedChangeItem
  | FeedCommentItem
  | FeedPendingPushItem;

/** Activity feed: pending changes + annotation activity, newest first. */
export async function getNestFeed(
  nestId: string,
  filter: FeedFilter = "all",
  limit = 50,
  offset = 0,
) {
  const params = new URLSearchParams({
    filter,
    limit: String(limit),
    offset: String(offset),
  });
  return request<{
    items: FeedItem[];
    total: number;
    counts: { changes: number; comments: number; pending_pushes: number };
    filter: FeedFilter;
    limit: number;
    offset: number;
  }>(`/nests/${nestId}/feed?${params.toString()}`);
}

// ─── Agent activity (CU-wdqcq0314v) ──────────────────────────────────────

export type AgentActivityKind = "create" | "update" | "restore" | "delete";
export type AgentUndoEffect = "restore" | "discard" | "delete";

export interface AgentActivityItem {
  id: string;
  kind: AgentActivityKind;
  nodeId: string;
  title?: string;
  version?: number;
  status?: string;
  actor: string;
  agent?: string;
  changeNote?: string;
  at: string;
  undo: { available: boolean; effect?: AgentUndoEffect; restoreTo?: number; reason?: string };
}

/** What agents did to this nest, newest first, each with an undo verdict. */
export async function getAgentActivity(
  nestId: string,
  opts: { scope?: "agents" | "all"; agent?: string; limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams({
    scope: opts.scope ?? "agents",
    limit: String(opts.limit ?? 50),
    offset: String(opts.offset ?? 0),
  });
  if (opts.agent) params.set("agent", opts.agent);
  return request<{ items: AgentActivityItem[]; limit: number; offset: number; hasMore: boolean }>(
    `/nests/${nestId}/agent-activity?${params.toString()}`,
  );
}

/** Undo one change: restore the previous version, discard a draft, or delete
 *  a document the agent created. 409 carries why it can't be undone. */
export async function undoAgentChange(nestId: string, nodeId: string, version: number) {
  return request<{
    ok: true;
    effect: AgentUndoEffect;
    version: number | null;
    status?: string;
    restoredVersion?: number;
  }>(`/nests/${nestId}/agent-activity/undo`, {
    method: "POST",
    body: JSON.stringify({ nodeId, version }),
  });
}

// ─── Admin activity log (CU-wdqcq03aw2) ──────────────────────────────────

export type ActivityLogType =
  | "created"
  | "edited"
  | "restored"
  | "review_requested"
  | "approved"
  | "rejected"
  | "review_cancelled"
  | "commented"
  | "comment_resolved"
  | "deleted"
  | "read"
  | "retrieved"
  | "exported";

export interface ActivityLogItem {
  id: string;
  type: ActivityLogType;
  /** null for a whole-nest event (a full export). */
  nodeId: string | null;
  title?: string;
  actor: string;
  agent?: string;
  at: string;
  version?: number;
  detail?: string;
  surface?: "api" | "mcp";
}

export type ActivityLogScope =
  | { kind: "node"; nodeId: string }
  | { kind: "folder"; folder: string }
  | { kind: "nest" };

/** Admin-only: who changed, reviewed, read, retrieved or exported a document,
 *  a folder, or the nest. 403 for anyone but the owner / a nest admin. */
export async function getActivityLog(
  nestId: string,
  scope: ActivityLogScope,
  opts: { types?: ActivityLogType[]; actor?: string; agent?: string; limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 50),
    offset: String(opts.offset ?? 0),
  });
  if (scope.kind === "node") params.set("node", scope.nodeId);
  if (scope.kind === "folder") params.set("folder", scope.folder);
  if (opts.types?.length) params.set("type", opts.types.join(","));
  if (opts.actor) params.set("actor", opts.actor);
  if (opts.agent) params.set("agent", opts.agent);
  return request<{ items: ActivityLogItem[]; limit: number; offset: number; hasMore: boolean }>(
    `/nests/${encodeURIComponent(nestId)}/activity-log?${params.toString()}`,
  );
}

export async function submitForReview(
  nestId: string,
  nodeId: string,
  note?: string,
  priority?: string,
) {
  return request(`/nests/${nestId}/nodes/${nodeId}/submit-review`, {
    method: "POST",
    body: JSON.stringify({ note, priority }),
  });
}

export async function approveNode(
  nestId: string,
  nodeId: string,
  note?: string,
) {
  return request(`/nests/${nestId}/nodes/${nodeId}/approve`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

/** Reviewer edits someone's pending submission and approves it in one step. */
export async function approveWithEdits(
  nestId: string,
  nodeId: string,
  edit: { title?: string; content?: string; tags?: string[]; note?: string; baseVersion?: number },
) {
  return request(`/nests/${nestId}/nodes/${nodeId}/approve-with-edits`, {
    method: "POST",
    body: JSON.stringify(edit),
  });
}

export async function rejectNode(
  nestId: string,
  nodeId: string,
  note: string,
) {
  return request(`/nests/${nestId}/nodes/${nodeId}/reject`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

/**
 * Approve or reject several pending documents in one request. One call, not N,
 * so the batch is bounded server-side and reported as one outcome — items can
 * fail individually (not a steward for it, already resolved) while the rest
 * still land.
 */
export async function bulkReview(
  nestId: string,
  action: "approve" | "reject",
  nodeIds: string[],
  note?: string,
): Promise<{
  succeeded: number;
  failed: number;
  results: Array<{ nodeId: string; ok: boolean; error?: string }>;
}> {
  return request(`/nests/${nestId}/review-queue/bulk`, {
    method: "POST",
    body: JSON.stringify({ action, nodeIds, note }),
  });
}

// Steward/editor reverts a node to an earlier version (writes its content as
// a new version; history is preserved).
export async function revertToVersion(
  nestId: string,
  nodeId: string,
  targetVersion: number,
) {
  return request<{ ok: boolean; version: number }>(
    `/nests/${nestId}/nodes/${nodeId}/revert`,
    { method: "POST", body: JSON.stringify({ targetVersion }) },
  );
}

export async function getNodeVersions(nestId: string, nodeId: string) {
  return request<{
    versions: any[];
    approvedVersion: number | null;
    currentVersion: number;
    /** Verdicts on out-of-band edits — a rejection commits no version. */
    externalEditVerdicts?: ExternalEditVerdict[];
  }>(`/nests/${nestId}/nodes/${nodeId}/versions`);
}

/**
 * One version's full body, reconstructed server-side on demand.
 *
 * The versions list ships each version's change log (a small diff) rather than
 * every full body, so a body is fetched only for the version actually being
 * previewed, compared, or restored. `content` is null when that version's chain
 * no longer reconstructs.
 */
export async function getNodeVersionContent(
  nestId: string,
  nodeId: string,
  version: number,
) {
  return request<{ version: number; content: string | null }>(
    `/nests/${nestId}/nodes/${nodeId}/versions/${version}`,
  );
}

export async function getNodeReviews(nestId: string, nodeId: string) {
  return request<{ reviews: any[] }>(`/nests/${nestId}/nodes/${nodeId}/reviews`);
}

// ─── Hosted artifacts + annotations ──────────────────────────────────────

export interface AnnotationAnchor {
  /** 1-based line in the artifact's extracted text. Hint only. */
  line?: number;
  /** The highlighted text. */
  quote: string;
  /** Up to ~250 chars before the quote. */
  before: string;
  /** Up to ~250 chars after the quote. */
  after: string;
}

export interface AnnotationComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** Set when an agent run posted it: links to its trace. */
  runId?: string;
}

export interface AnnotationThread {
  id: string;
  nestId: string;
  nodeId: string;
  snapshotVersion: number | null;
  anchor: AnnotationAnchor | null;
  status: "open" | "resolved";
  createdBy: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  comments: AnnotationComment[];
}

/**
 * URL of the sandboxed artifact render (iframe `src`). `v` pins a snapshot.
 * `cacheBust` appends an ignored param so a remount actually refetches instead
 * of serving the browser's cached response for an identical URL (the served
 * body changes under the same URL after a save/restore). The server ignores
 * unknown query params, so this only defeats the HTTP cache.
 */
export function hostedArtifactUrl(
  nestId: string,
  nodeId: string,
  version?: number | null,
  cacheBust?: number | string | null,
  opts?: { embed?: boolean },
): string {
  const params = new URLSearchParams();
  // embed=1: the in-app viewer's iframe, which gets the place/highlight
  // bridge appended (src/shared/artifact-bridge.ts). Open in new tab and the
  // text fetch never ask for it.
  if (opts?.embed) params.set("embed", "1");
  if (version != null) params.set("v", String(version));
  if (cacheBust != null) params.set("_", String(cacheBust));
  const qs = params.toString();
  // The route already lives under /nodes, and a node id carries its own
  // `nodes/` prefix — emitting both produced …/nodes/nodes/<slug>/hosted. The
  // server accepts either spelling; this one says the segment once.
  const path = nodeId.replace(/^nodes\//, "");
  return `${API_BASE}/nests/${nestId}/nodes/${path}/hosted${qs ? `?${qs}` : ""}`;
}

/**
 * Fetch the artifact's served HTML as text — used to derive the *extracted
 * text* the annotation layer highlights over (same text the nest indexes).
 * Same-origin, cookie-authed; not subject to the iframe sandbox.
 */
export async function fetchArtifactHtml(
  nestId: string,
  nodeId: string,
  version?: number | null,
  cacheBust?: number | string | null,
): Promise<{ html: string; snapshot: number | null }> {
  const res = await fetch(hostedArtifactUrl(nestId, nodeId, version, cacheBust), {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Failed to load artifact (${res.status})`);
  }
  const snapHeader = res.headers.get("X-Artifact-Snapshot");
  const snapshot = snapHeader ? Number(snapHeader) : null;
  return {
    html: await res.text(),
    snapshot: Number.isFinite(snapshot as number) ? snapshot : null,
  };
}

export async function listAnnotations(nestId: string, nodeId: string) {
  return request<{ threads: AnnotationThread[] }>(
    `/nests/${nestId}/nodes/${nodeId}/annotations`,
  );
}

export async function createAnnotation(
  nestId: string,
  nodeId: string,
  input: {
    body: string;
    anchor?: AnnotationAnchor | null;
    snapshotVersion?: number | null;
  },
) {
  return request<{ thread: AnnotationThread }>(
    `/nests/${nestId}/nodes/${nodeId}/annotations`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function replyAnnotation(
  nestId: string,
  nodeId: string,
  threadId: string,
  body: string,
) {
  return request<{ thread: AnnotationThread }>(
    `/nests/${nestId}/nodes/${nodeId}/annotations/${threadId}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
}

export async function resolveAnnotation(
  nestId: string,
  nodeId: string,
  threadId: string,
) {
  return request<{ thread: AnnotationThread }>(
    `/nests/${nestId}/nodes/${nodeId}/annotations/${threadId}/resolve`,
    { method: "POST", body: "{}" },
  );
}

export async function reopenAnnotation(
  nestId: string,
  nodeId: string,
  threadId: string,
) {
  return request<{ thread: AnnotationThread }>(
    `/nests/${nestId}/nodes/${nodeId}/annotations/${threadId}/reopen`,
    { method: "POST", body: "{}" },
  );
}


// ─── Comments & activity (collaboration) ─────────────────────────────────

export interface CommentAnchor {
  // Document character offsets — optional. A client that only has the quoted
  // text (plain selection, no editor offset mapping) sends just `text`.
  start?: number;
  end?: number;
  text?: string;
}

export interface Comment {
  id: string;
  nestId: string;
  nodeId: string;
  version?: number;
  anchor?: CommentAnchor;
  parentId?: string;
  author: string;
  body: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export type ActivityType =
  | "comment"
  | "comment_resolved"
  | "edit"
  | "edit_proposed"
  | "review_requested"
  | "review_resolved"
  | "task_activity";

export interface ActivityEntry {
  type: ActivityType;
  nodeId: string;
  actor: string;
  at: string;
  detail?: string;
  refId?: string;
  /** task_activity only: working | done | blocked. */
  status?: string;
  /** task_activity only: the agent the caller reported (§9.4 client.agent). */
  agent?: string;
  /** task_activity only: the API key the call came in on. */
  key?: { label?: string; prefix?: string; scoped: boolean };
  /** task_activity only: the server's one-line description. */
  summary?: string;
}

export async function getNodeComments(
  nestId: string,
  nodeId: string,
  status?: "open" | "resolved",
) {
  const qs = status ? `?status=${status}` : "";
  return request<{ comments: Comment[] }>(
    `/nests/${nestId}/nodes/${nodeId}/comments${qs}`,
  );
}

export async function createComment(
  nestId: string,
  nodeId: string,
  input: {
    body: string;
    version?: number;
    parentId?: string;
    anchor?: CommentAnchor;
  },
) {
  return request<{ comment: Comment }>(
    `/nests/${nestId}/nodes/${nodeId}/comments`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function resolveComment(
  nestId: string,
  nodeId: string,
  commentId: string,
) {
  return request<{ comment: Comment }>(
    `/nests/${nestId}/nodes/${nodeId}/comments/${commentId}/resolve`,
    { method: "POST", body: "{}" },
  );
}

export async function getNodeActivity(
  nestId: string,
  nodeId: string,
  limit = 100,
) {
  return request<{ activity: ActivityEntry[] }>(
    `/nests/${nestId}/nodes/${nodeId}/activity?limit=${limit}`,
  );
}

// ─── External edits (direct filesystem edits awaiting approval) ──────────

export interface ExternalEditEntry {
  suggestion_id: string;
  nest_id: string;
  document_id: string;
  source: string;
  detected_at: string;
  actor: string;
  target_hash: string;
  proposed_hash: string;
  note?: string;
  patch?: string;
}

export interface PendingChange {
  suggestion_id: string;
  detected_at: string;
  source: string;
  proposed_hash: string;
}

/** A resolved external edit, from the engine's chain-event log. */
export interface ExternalEditVerdict {
  suggestion_id: string;
  status: "approved" | "rejected";
  actor: string;
  at: string;
  note?: string;
  source?: string;
}

export async function listExternalEdits(nestId: string, refresh = false) {
  const qs = refresh ? "?refresh=true" : "";
  return request<{ entries: ExternalEditEntry[]; total: number }>(
    `/nests/${nestId}/external-edits${qs}`,
  );
}

/** Pending external edits, as a number — the badge read. */
export async function countExternalEdits(nestId: string) {
  return request<{ total: number }>(`/nests/${nestId}/external-edits?count=1`);
}

export async function scanExternalEdits(nestId: string) {
  return request<{ scanned: number; staged: number }>(
    `/nests/${nestId}/external-edits/scan`,
    { method: "POST", body: "{}" },
  );
}

export async function getNodePendingExternalEdit(
  nestId: string,
  nodeId: string,
) {
  return request<{ pending: PendingChange | null }>(
    `/nests/${nestId}/nodes/${nodeId}/external-edits`,
  );
}

export async function getExternalEditDetail(
  nestId: string,
  nodeId: string,
  suggestionId: string,
) {
  return request<{ entry: ExternalEditEntry }>(
    `/nests/${nestId}/nodes/${nodeId}/external-edits/${suggestionId}`,
  );
}

export async function approveExternalEdit(
  nestId: string,
  nodeId: string,
  suggestionId: string,
  comment?: string,
) {
  return request<{
    approved: true;
    version: number;
    chainEvent: string;
  }>(
    `/nests/${nestId}/nodes/${nodeId}/external-edits/${suggestionId}/approve`,
    { method: "POST", body: JSON.stringify({ comment }) },
  );
}

export async function rejectExternalEdit(
  nestId: string,
  nodeId: string,
  suggestionId: string,
  reason: string,
) {
  return request<{ rejected: true; chainEvent: string }>(
    `/nests/${nestId}/nodes/${nodeId}/external-edits/${suggestionId}/reject`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

// ─── Publish (gated public hosting of one document at /p/<slug>) ─────────

export type PublishMode = "public" | "email" | "code" | "invite";

export interface Publication {
  id: string;
  slug: string;
  node_id: string;
  access_mode: PublishMode;
  comments_enabled: boolean;
  watermark: boolean;
  no_download: boolean;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  link?: string;
}

export interface PublicationView {
  email: string | null;
  created_at: string;
}

export async function listPublications(nestId: string) {
  return request<{ count: number; publishes: Publication[] }>(
    `/nests/${nestId}/publications`,
  );
}

export async function createPublication(
  nestId: string,
  data: {
    node_id: string;
    access_mode: PublishMode;
    comments_enabled?: boolean;
    watermark?: boolean;
    no_download?: boolean;
    code?: string | null;
    allowlist?: string[];
    expires_at?: string | null;
  },
) {
  return request<{ publish: Publication; link: string }>(
    `/nests/${nestId}/publications`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export async function listPublicationViews(nestId: string, publishId: string) {
  return request<{ count: number; views: PublicationView[] }>(
    `/nests/${nestId}/publications/${publishId}/views`,
  );
}

export async function revokePublication(nestId: string, publishId: string) {
  return request<{ revoked: boolean }>(`/nests/${nestId}/publications/${publishId}`, {
    method: "DELETE",
  });
}

// ─── Sharing ────────────────────────────────────────────────────────────

export async function listCollaborators(nestId: string) {
  // `collaborators` is the manageable roster; `people` is everyone who can
  // reach the nest (owner, shared teams, stewards, grant holders included) —
  // what the editor's @mention picker offers and validates against.
  return request<{
    collaborators: any[];
    people?: Array<{
      email: string;
      name: string | null;
      source: "owner" | "collaborator" | "team" | "steward" | "grant";
    }>;
  }>(`/nests/${nestId}/collaborators`);
}

/** The nest's people, for the `@mention` pickers. Read tier (see the route),
 *  so a read-only reviewer's comment box can offer the roster too — unlike
 *  listCollaborators, which needs write. */
export async function listMentionablePeople(nestId: string) {
  return request<{ people: Array<{ email: string; name: string | null; member?: boolean }> }>(
    `/nests/${nestId}/mentionable`,
  );
}

/** People the caller already works with — what the add-a-person controls
 *  autocomplete against. An address that appears nowhere here is still valid
 *  to type: that's how you add someone who has no account yet. */
export async function suggestPeople(q = "") {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return request<{
    people: Array<{
      email: string;
      name: string | null;
      source: "nest" | "team" | "directory";
    }>;
  }>(`/people/suggest${query}`);
}

export async function addCollaborator(
  nestId: string,
  data: { email?: string; user_id?: string; permission: string },
) {
  return request(`/nests/${nestId}/collaborators`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateCollaborator(
  nestId: string,
  collabId: string,
  permission: string,
) {
  return request<{ updated: boolean }>(
    `/nests/${nestId}/collaborators/${collabId}`,
    { method: "PATCH", body: JSON.stringify({ permission }) },
  );
}

export async function removeCollaborator(nestId: string, collabId: string) {
  return request<{ removed: boolean }>(
    `/nests/${nestId}/collaborators/${collabId}`,
    { method: "DELETE" },
  );
}

// ─── Share grants ───────────────────────────────────────────────────────
// Access to ONE document or ONE folder for someone who is not a nest-wide
// collaborator. Distinct from stewardship (review governance) — see
// src/governance/grants-service.ts. Managing them is owner/admin only.

export interface Grant {
  id: string;
  nest_id: string;
  target_type: "document" | "folder";
  target: string;
  user_id: string;
  role: "read" | "write";
  granted_by: string;
  email: string | null;
  created_at: string;
}

export async function listGrants(nestId: string) {
  return request<{ count: number; grants: Grant[] }>(`/nests/${nestId}/grants`);
}

export async function createGrant(
  nestId: string,
  data: {
    target_type: "document" | "folder";
    target: string;
    email: string;
    role: "read" | "write";
  },
) {
  return request<{ grant: Grant }>(`/nests/${nestId}/grants`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteGrant(nestId: string, grantId: string) {
  return request<{ deleted: boolean }>(`/nests/${nestId}/grants/${grantId}`, {
    method: "DELETE",
  });
}

// ─── Teams ──────────────────────────────────────────────────────────────
// A team is a reusable, owner-managed group. Each member carries a role
// (mirrors the server enum in src/shared/types.ts) applied on every nest the
// team is shared to.

export type TeamRole = "admin" | "editor" | "viewer";

export interface TeamMember {
  userId: string;
  email: string;
  role: TeamRole;
  /** True = real registered account; false = invited placeholder (from API). */
  registered?: boolean;
}

export interface Team {
  id: string;
  name: string;
  owner_id: string;
  /** Owner email for display ("Created by …"), from API. */
  owner_email?: string;
  members: TeamMember[];
  /** "promptowl" for an imported team; null when created here. */
  source?: string | null;
  /** The team's id in `source`'s system; null when created here. */
  external_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Picker options for a team member's role. Mirrors TeamMemberRole server-side. */
export const TEAM_ROLES: { value: TeamRole; label: string; hint: string }[] = [
  { value: "viewer", label: "Viewer", hint: "Read only" },
  { value: "editor", label: "Editor", hint: "Read and edit documents" },
  { value: "admin", label: "Admin", hint: "Full access except deleting the nest" },
];

export async function listTeams() {
  return request<{ teams: Team[] }>(`/teams`);
}

export async function getTeam(teamId: string) {
  return request<{ team: Team }>(`/teams/${teamId}`);
}

export async function createTeam(name: string) {
  return request<{ team: Team }>(`/teams`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function renameTeam(teamId: string, name: string) {
  return request<{ team: Team }>(`/teams/${teamId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteTeam(teamId: string) {
  return request<{ removed: boolean }>(`/teams/${teamId}`, { method: "DELETE" });
}

export async function addTeamMember(
  teamId: string,
  data: { email?: string; user_id?: string; role: TeamRole },
) {
  return request<{ team: Team }>(`/teams/${teamId}/members`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateTeamMemberRole(
  teamId: string,
  userId: string,
  role: TeamRole,
) {
  return request<{ team: Team }>(`/teams/${teamId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export async function removeTeamMember(teamId: string, userId: string) {
  return request<{ team: Team }>(`/teams/${teamId}/members/${userId}`, {
    method: "DELETE",
  });
}

// ─── PromptOwl team import ──────────────────────────────────────────────
// Only available to users who signed in with PromptOwl: the token lives in an
// httpOnly cookie set at that sign-in, and the browser attaches it, so these
// calls carry no token of their own. Anyone else gets `promptowl_connect_
// required` from the server, and `hasPromptowlSession()` keeps the UI from
// offering the feature in the first place. Nothing is stored server-side.

/** A team as PromptOwl reports it — not yet imported. */
export interface PromptowlTeam {
  id: string;
  name: string;
  /** True when you own the team in PromptOwl. */
  owned: boolean;
  /** Your role on the team in PromptOwl: Owner | Editor | Viewer | User. */
  your_role: string;
  source: string | null;
  enterprise: { id: string; name: string } | null;
  updated_at: string | null;
  members: { email: string; role: string }[];
}

/**
 * Whether you may import a team — Owner or Editor in PromptOwl only.
 * Importing makes you owner of the copy here, which is more reach than a
 * view-only member holds upstream. Mirrors the server, which enforces it.
 */
export function canImportPromptowlTeam(team: PromptowlTeam): boolean {
  return ["owner", "editor"].includes((team.your_role || "").toLowerCase());
}

/** What importing one team changed locally. Emails, not user ids. */
export interface PromptowlSyncResult {
  team_id: string;
  external_id: string;
  name: string;
  created: boolean;
  added: string[];
  updated: string[];
  removed: string[];
}

/** Server marker meaning "sign in with PromptOwl to use this". */
export const PROMPTOWL_CONNECT_REQUIRED = "promptowl_connect_required";

/**
 * True when this session signed in with PromptOwl — the only sessions that can
 * import teams. Reads the readable marker cookie the server sets at PromptOwl
 * sign-in (the token itself is httpOnly and unreadable here, by design).
 *
 * A UI hint only: the server independently requires the real token cookie, so
 * faking this marker just yields a tab whose requests are refused.
 */
export function hasPromptowlSession(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith("cnst_po_session="));
}

/**
 * True when an error from the calls below means the PromptOwl session is gone
 * (never signed in, or the token was revoked upstream). The server answers 428
 * (not 401) for this, so it never trips the logged-out handling in `request`.
 */
export function isPromptowlConnectRequired(err: any): boolean {
  return (err as ApiError)?.body?.code === PROMPTOWL_CONNECT_REQUIRED;
}

/** The caller's PromptOwl teams — not yet imported. */
export async function listPromptowlTeams() {
  return request<{ teams: PromptowlTeam[] }>(`/teams/promptowl`);
}

export async function syncPromptowlTeams(teamIds: string[]) {
  return request<{ results: PromptowlSyncResult[] }>(`/teams/promptowl/sync`, {
    method: "POST",
    body: JSON.stringify({ team_ids: teamIds }),
  });
}

/** Teams shared onto a nest, each enriched with its member roster. */
export async function listNestTeams(nestId: string) {
  return request<{
    teams: { teamId: string; teamName: string; members: TeamMember[] }[];
  }>(`/nests/${nestId}/teams`);
}

export async function shareNestWithTeam(nestId: string, teamId: string) {
  return request(`/nests/${nestId}/teams`, {
    method: "POST",
    body: JSON.stringify({ team_id: teamId }),
  });
}

export async function unshareNestTeam(nestId: string, teamId: string) {
  return request(`/nests/${nestId}/teams/${teamId}`, { method: "DELETE" });
}

// ─── Ontology graph ───────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
}

export interface NestGraph {
  nodes: GraphNode[];
  links: Array<{ source: string; target: string }>;
  stewards: Array<{
    /** Stable identity key — email for write+ callers, opaque "sN" otherwise. */
    id: string;
    /** Display name — email for write+ callers, "Steward N" otherwise. */
    label: string;
    role: string;
    scope: "nest" | "tag" | "document";
    target: string;
  }>;
  /** Steward → tag/doc/nest-root edges, pre-assembled server-side. */
  stewardEdges: Array<{
    steward: string;
    target: string;
    scope: "nest" | "tag" | "document";
  }>;
  tags: Array<{ name: string; count: number }>;
  /** Governance gaps, computed server-side over the full set. */
  signals: {
    orphans: GraphNode[];
    unstewardedTags: Array<{ name: string; count: number }>;
    bottlenecks: Array<{ steward: string; label: string; share: number }>;
  };
  /** True when the drawn node set was capped; signals stay full-set accurate. */
  truncated: boolean;
  totalNodes: number;
}

export async function getNestGraph(nestId: string) {
  return request<NestGraph>(`/nests/${nestId}/graph`);
}

// ─── My Work — cross-nest inbox ──────────────────────────────────────────

export interface WorkItem {
  /** "deletion" = someone asked for the document to be deleted; only nest
   *  owners/admins get those in the waiting-on-me bucket. "access" = someone
   *  who can only read asked to edit (CU-wdqcq041jn) — same owners/admins. */
  type: "review" | "deletion" | "access";
  nest_id: string;
  nest_name: string;
  node_id: string;
  title: string;
  requested_by: string;
  requested_at: string;
  priority?: string;
  /** Deletion items only: why it was flagged, and the row to resolve. */
  reason?: string;
  request_id?: string;
  /** Deletion items only. For "folder"/"nest"/"nest_archive", node_id is a
   *  folder path or the nest id — NOT a document id, so don't open the editor
   *  on it. "nest_archive" is the reversible ask: honouring it archives. */
  target_type?: "document" | "folder" | "nest" | "nest_archive" | "node";
  /** Access items only: the level asked for. */
  level?: "read" | "write";
  /** Review and access items: the agent run that filed it, if one did. */
  run_id?: string | null;
}

export interface WatcherNotification {
  id: string;
  nest_id: string;
  kind: string;
  subject_id: string | null;
  message: string;
  created_at: string;
  read_at: string | null;
  /** Document the row is about, when there is one — null for nest-level rows. */
  node_id?: string | null;
  /** Resolved server-side; the inbox navigates on it without a nest list. */
  nest_name: string;
}

export interface WorkPagination {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

/** A board card assigned to the caller (open ones only), from /me/work. */
export interface AssignedItem {
  nest_id: string;
  nest_name: string;
  node_id: string;
  title: string;
  type: string;
  due: string | null;
  priority: string | null;
  assigned_at: string | null;
  /** Open blockers (task relations); absent when nothing open blocks it. */
  open_blockers?: number;
}

export async function getMyWork(opts?: { limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  if (opts?.offset != null) q.set("offset", String(opts.offset));
  const qs = q.toString();
  return request<{
    items: WorkItem[];
    waiting: WorkItem[];
    notifications?: WatcherNotification[];
    assigned?: AssignedItem[];
    pagination?: WorkPagination;
  }>(`/me/work${qs ? `?${qs}` : ""}`);
}

/** A document you left unsubmitted (or that came back rejected). */
export interface MyDraft {
  nest_id: string;
  nest_name: string;
  node_id: string;
  title: string;
  /** Folder path inside the nest ("" for a root-level doc). */
  folder: string;
  status: "draft" | "rejected";
  /** Version that would go to review — shown in the submit dialog. */
  version: number;
  updated_at: string;
}

export async function getMyDrafts(opts?: {
  limit?: number;
  offset?: number;
  /** Matched against title, nest name and node id. */
  q?: string;
  sort?: "updated" | "title";
}) {
  const q = new URLSearchParams();
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  if (opts?.offset != null) q.set("offset", String(opts.offset));
  if (opts?.q) q.set("q", opts.q);
  if (opts?.sort && opts.sort !== "updated") q.set("sort", opts.sort);
  const qs = q.toString();
  return request<{ drafts: MyDraft[]; pagination: WorkPagination }>(
    `/me/drafts${qs ? `?${qs}` : ""}`,
  );
}

// ── Experimental: cross-nest document stream (GET /me/stream) ──────────────

export type StreamKind = "created" | "updated" | "published" | "approved" | "rejected";

export interface StreamItem {
  /** Stable key: `${nestId}:${nodeId}@${version}`. */
  id: string;
  nestId: string;
  nestName: string;
  nodeId: string;
  title: string;
  type: string;
  tags: string[];
  version: number;
  status: string;
  /** null where the caller reads the nest only publicly. */
  author: string | null;
  at: string;
  summary: string;
  /** Comments on the document's open threads; null where the caller reads
   *  the nest only publicly (no comment UI on those cards). */
  commentCount: number | null;
  kind: StreamKind;
}

export interface StreamFacet {
  value: string;
  count: number;
}

export interface StreamPage {
  items: StreamItem[];
  total: number;
  /** Per-facet totals over the caller's whole stream (filters not applied).
   *  Sent with the first page only (offset 0); null on later pages. */
  counts: null | {
    nest: Array<{ id: string; name: string; count: number }>;
    tag: StreamFacet[];
    type: StreamFacet[];
    author: StreamFacet[];
  };
  limit: number;
  offset: number;
  has_more: boolean;
}

export async function getDocStream(opts: StreamQuery = {}, pinnedNest?: string) {
  return request<StreamPage>(`/me/stream${streamQueryString(opts, pinnedNest)}`);
}

/**
 * Throw away the unreviewed work on a node. A document that was published
 * before goes back to that version; one that never was is deleted outright —
 * `deleted` says which happened.
 *
 * Clearing the locally parked draft is part of the operation, not something
 * callers remember to do. Those edits describe a body the server no longer
 * holds, and the editor re-applies a parked draft whenever its `baseVersion`
 * matches the version it just loaded — which a discard can walk the document
 * straight back onto, resurrecting the edits the user just threw away. Doing it
 * here means every entry point (My Drafts, the version panel, the editor's own
 * button) is covered by construction.
 */
export async function discardDraft(nestId: string, nodeId: string) {
  const res = await request<{ ok: true; deleted: boolean; version: number | null }>(
    `/nests/${nestId}/nodes/${nodeId}/discard`,
    { method: "POST" },
  );
  clearDraft(nestId, nodeId);
  return res;
}

export async function approveReview(nestId: string, nodeId: string, note?: string) {
  return request(`/nests/${nestId}/nodes/${nodeId}/approve`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export async function rejectReview(nestId: string, nodeId: string, note?: string) {
  return request(`/nests/${nestId}/nodes/${nodeId}/reject`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

// ─── Workflow plane (typed edges + governed runs) ────────────────────────

export interface EdgeType {
  id: string;
  name: string;
  description: string;
  direction: "directed" | "undirected";
  is_flow: boolean;
  color: string | null;
}

export interface WorkflowEdge {
  id: string;
  from_node: string;
  to_node: string;
  type: { id: string; name: string; color: string | null; is_flow: boolean };
  condition_mode: "structured" | "nl" | "open" | null;
  condition: string | null;
}

export interface RunSummary {
  id: string;
  agent_node: string;
  triggered_by: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  started_at: string;
  finished_at: string | null;
  depth?: number;
  parent_run_id?: string | null;
  /** Set when a runner claims the run (GET /runs/:id/bundle). Until then the
      run is only *queued* — the wire status says "running" from creation. */
  claimed_by?: string | null;
  claimed_at?: string | null;
  /** Write-tier only; null for read-tier callers. */
  trace?: { error?: string; [k: string]: unknown } | null;
}

/** A run is only really running once a runner has claimed it. */
export const isQueued = (r: Pick<RunSummary, "status" | "claimed_by">) =>
  r.status === "running" && !r.claimed_by;

export interface RunStep {
  seq: number;
  node_id: string | null;
  edge_id: string | null;
  action: string;
  detail: any;
  at: string;
}

export interface RunDetail extends RunSummary {
  nest_id: string;
  inputs: any;
  trace: any;
  steps: RunStep[];
}

export async function listEdgeTypes(nestId: string) {
  const r = await request<{ edge_types: EdgeType[] }>(
    `/nests/${nestId}/edge-types`,
  );
  return r.edge_types;
}

export async function listEdges(nestId: string) {
  const r = await request<{ edges: WorkflowEdge[] }>(`/nests/${nestId}/edges`);
  return r.edges;
}

export async function createEdge(
  nestId: string,
  body: {
    from_node: string;
    to_node: string;
    type: string;
    condition_mode?: "structured" | "nl" | "open" | null;
    condition?: unknown;
  },
) {
  const r = await request<{ edge: WorkflowEdge }>(`/nests/${nestId}/edges`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return r.edge;
}

export async function updateEdge(
  nestId: string,
  edgeId: string,
  body: {
    type?: string;
    condition_mode?: "structured" | "nl" | "open" | null;
    condition?: unknown;
  },
) {
  const r = await request<{ edge: WorkflowEdge }>(
    `/nests/${nestId}/edges/${edgeId}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  return r.edge;
}

export async function deleteEdge(nestId: string, edgeId: string) {
  return request(`/nests/${nestId}/edges/${edgeId}`, { method: "DELETE" });
}

export interface Schedule {
  id: string;
  agent_node: string;
  every_minutes: number;
  enabled: boolean;
  last_run_at: string | null;
  next_due_at: string | null;
  max_runs: number | null;
  runs_created: number;
  created_by: string;
  created_at: string;
}

export async function listSchedules(nestId: string) {
  const r = await request<{ schedules: Schedule[] }>(`/nests/${nestId}/schedules`);
  return r.schedules;
}

export async function createSchedule(
  nestId: string,
  body: {
    agent_node: string;
    every_minutes: number;
    enabled?: boolean;
    max_runs?: number | null;
  },
) {
  const r = await request<{ schedule: Schedule }>(`/nests/${nestId}/schedules`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return r.schedule;
}

export async function updateSchedule(
  nestId: string,
  id: string,
  body: { every_minutes?: number; enabled?: boolean; max_runs?: number | null },
) {
  const r = await request<{ schedule: Schedule }>(
    `/nests/${nestId}/schedules/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  return r.schedule;
}

export async function deleteSchedule(nestId: string, id: string) {
  return request(`/nests/${nestId}/schedules/${id}`, { method: "DELETE" });
}

// Task relations — blocks / blocked by / relates to / duplicates.
export type RelationKind =
  | "blocks"
  | "blocked_by"
  | "relates_to"
  | "duplicates"
  | "duplicated_by";

export interface TaskRelation {
  id: string;
  type: RelationKind;
  node: { id: string; title: string; type: string; done: boolean };
  created_by: string;
  created_at: string;
}

export interface TaskRelations {
  node_id: string;
  relations: TaskRelation[];
  /** Related documents the caller can't read, per kind — never named. */
  hidden: Partial<Record<RelationKind, number>>;
  hidden_count: number;
  open_blockers: number;
  blocked: boolean;
}

export async function listRelations(nestId: string, nodeId: string) {
  return request<TaskRelations>(`/nests/${nestId}/nodes/${nodeId}/relations`);
}

export async function addRelation(
  nestId: string,
  nodeId: string,
  type: RelationKind,
  node: string,
) {
  const r = await request<{ relation: TaskRelation; relations: TaskRelations }>(
    `/nests/${nestId}/nodes/${nodeId}/relations`,
    { method: "POST", body: JSON.stringify({ type, node }) },
  );
  return r.relations;
}

export async function removeRelation(nestId: string, nodeId: string, relationId: string) {
  return request<TaskRelations>(
    `/nests/${nestId}/nodes/${nodeId}/relations/${encodeURIComponent(relationId)}`,
    { method: "DELETE" },
  );
}

// Watchers — tag a person to a node (usually an agent) for HITL notifications.
export async function listNodeWatchers(nestId: string, nodeId: string) {
  const r = await request<{ watchers: Array<{ user_email: string }> }>(
    `/nests/${nestId}/nodes/${nodeId}/watchers`,
  );
  return r.watchers;
}

export async function addNodeWatcher(nestId: string, nodeId: string, email: string) {
  const r = await request<{ watchers: Array<{ user_email: string }> }>(
    `/nests/${nestId}/nodes/${nodeId}/watchers`,
    { method: "POST", body: JSON.stringify({ email }) },
  );
  return r.watchers;
}

export async function removeNodeWatcher(nestId: string, nodeId: string, email: string) {
  const r = await request<{ watchers: Array<{ user_email: string }> }>(
    `/nests/${nestId}/nodes/${nodeId}/watchers?email=${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
  return r.watchers;
}

export async function listUnreadNotifications() {
  return request<{ notifications: WatcherNotification[] }>(
    "/me/notifications?unread=true",
  );
}

/** Decline a nest invite — removes the caller's own access to that nest. */
export async function leaveNest(nestId: string) {
  return request<{ left: boolean }>(`/me/nests/${nestId}/leave`, { method: "POST" });
}

export async function markNotificationsRead(ids: string[] | "all") {
  return request<{ ok: boolean }>("/me/notifications/read", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

// Per-nest env store — tool credentials; values are masked on read.
export interface EnvEntry {
  key: string;
  value_masked: string;
  updated_by: string;
  updated_at: string;
}

export async function listEnv(nestId: string) {
  const r = await request<{ env: EnvEntry[] }>(`/nests/${nestId}/env`);
  return r.env;
}

export async function putEnv(nestId: string, key: string, value: string) {
  return request<{ key: string; value_masked: string }>(`/nests/${nestId}/env`, {
    method: "PUT",
    body: JSON.stringify({ key, value }),
  });
}

export async function deleteEnv(nestId: string, key: string) {
  return request(`/nests/${nestId}/env/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

// Inbound trigger hooks — tokenized listener URLs (slack/teams/webhook).
export interface TriggerHook {
  id: string;
  /** Full URL only at creation; null in list responses (token masked). */
  url: string | null;
  agent_node: string;
  preset: "slack" | "teams" | "webhook";
  enabled: boolean;
  fire_count: number;
  last_fired_at: string | null;
}

export async function listHooks(nestId: string, agent?: string) {
  const q = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  const r = await request<{ hooks: TriggerHook[] }>(`/nests/${nestId}/hooks${q}`);
  return r.hooks;
}

export async function createHook(
  nestId: string,
  agentNode: string,
  preset: TriggerHook["preset"],
) {
  const r = await request<{ hook: TriggerHook }>(`/nests/${nestId}/hooks`, {
    method: "POST",
    body: JSON.stringify({ agent_node: agentNode, preset }),
  });
  return r.hook;
}

export async function deleteHook(nestId: string, id: string) {
  return request(`/nests/${nestId}/hooks/${id}`, { method: "DELETE" });
}

// Outbound connectors — event → channel bricks.
export interface Connector {
  id: string;
  channel: "slack" | "teams" | "webhook";
  url: string;
  events: string[];
  enabled: boolean;
}

export async function listConnectors(nestId: string) {
  const r = await request<{ connectors: Connector[] }>(`/nests/${nestId}/connectors`);
  return r.connectors;
}

export async function createConnector(
  nestId: string,
  body: { channel: Connector["channel"]; url: string; events: string[] },
) {
  const r = await request<{ connector: Connector }>(`/nests/${nestId}/connectors`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return r.connector;
}

export async function updateConnector(
  nestId: string,
  id: string,
  body: { enabled?: boolean; events?: string[]; url?: string },
) {
  const r = await request<{ connector: Connector }>(
    `/nests/${nestId}/connectors/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  return r.connector;
}

export async function deleteConnector(nestId: string, id: string) {
  return request(`/nests/${nestId}/connectors/${id}`, { method: "DELETE" });
}

/** Deterministic table lookup — exact rows from a TABLE node. */
export async function tableQuery(nestId: string, table: string, query: string) {
  return request<{
    table: string;
    columns: string[];
    rows: string[][];
    matched: number;
    returned: number;
    total: number;
  }>(`/nests/${nestId}/table-query`, {
    method: "POST",
    body: JSON.stringify({ table, query, include_drafts: true }),
  });
}

/** Deterministic context assembly — what an agent run will actually read. */
export async function queryContext(
  nestId: string,
  selector: string,
  hops: number,
  maxTokens = 4000,
) {
  return request<{
    context: string;
    trace?: { hops_used?: number; nodes_traversed?: number };
    nodes_traversed?: number;
  }>(`/nests/${nestId}/context`, {
    method: "POST",
    body: JSON.stringify({ selector, hops, max_tokens: maxTokens }),
  });
}

export async function listRuns(nestId: string, agent?: string, limit?: number) {
  const params = new URLSearchParams();
  if (agent) params.set("agent", agent);
  // The Runs page derives child-count and ancestor-chain (re-entrancy) checks
  // from this list, so it asks for more than the server's default 50 — a wider
  // window keeps those client-side checks closer to the server's unbounded
  // truth. Server clamps to 500.
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  const r = await request<{ runs: RunSummary[] }>(
    `/nests/${nestId}/runs${qs ? `?${qs}` : ""}`,
  );
  return r.runs;
}

export async function getRun(runId: string) {
  const r = await request<{ run: RunDetail; steps: RunStep[] }>(
    `/runs/${runId}`,
  );
  return { ...r.run, steps: r.steps };
}

/** Cancel a queued or running run (PATCH is rejected once terminal). */
export async function cancelRun(runId: string, reason?: string) {
  return request<{ ok: true; status: string }>(`/runs/${runId}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "cancelled",
      trace: { error: reason ?? "Cancelled from the Runs page" },
    }),
  });
}

/** Trigger an agent — returns the run bundle (the runner's entry point). */
export async function triggerRun(
  nestId: string,
  agentNode: string,
  inputs?: Record<string, unknown>,
  parentRunId?: string,
) {
  return request<{ run_id: string }>(
    `/nests/${nestId}/run/${agentNode}`,
    // The route reads body.inputs / body.parent_run_id — wrap, don't spread
    // (a bare {foo:1} body would silently drop the inputs). parent_run_id
    // nests the new run under a still-running parent as a sub-agent
    // (bounded server-side by depth / fan-out / re-entrancy caps).
    {
      method: "POST",
      body: JSON.stringify({
        ...(inputs ? { inputs } : {}),
        ...(parentRunId ? { parent_run_id: parentRunId } : {}),
      }),
    },
  );
}

// ─── Hootie in the nest ──────────────────────────────────────────────────

export interface HootieNode {
  id: string;
  title: string;
  url?: string;
  tags: string[];
  type: string;
}

export type HootieMention =
  | {
      status: "posted";
      node_id: string;
      node_title: string;
      thread_id: string;
      notified: number;
    }
  | { status: "undeliverable"; reason: "no_anchor" | "post_failed" };

export interface HootieTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Ask Hootie about a nest. The route streams server-sent events; each one is
 * handed to the matching callback as it lands so the panel renders the answer
 * while it is still being written. Resolves when the stream closes.
 *
 * Non-2xx responses (feature off, no key, 400, 429) throw the same ApiError
 * shape as request(), with the JSON body on `err.body`.
 */
export async function chatWithHootie(
  nestId: string,
  body: { message: string; node_id?: string | null; history?: HootieTurn[] },
  on: {
    meta?: (m: { nodes: HootieNode[]; anchor: HootieNode | null }) => void;
    delta?: (text: string) => void;
    done?: (d: {
      answer: string;
      cited: HootieNode[];
      mention: HootieMention | null;
    }) => void;
    error?: (message: string) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/nests/${nestId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (res.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("auth:unauthorized"));
    }
    const err = new Error(data.error || `Request failed: ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = data;
    throw err;
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (chunk: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    let payload: any;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (event === "meta") on.meta?.(payload);
    else if (event === "delta") on.delta?.(payload.text ?? "");
    else if (event === "done") on.done?.(payload);
    else if (event === "error") on.error?.(payload.error ?? "Something went wrong.");
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Events are separated by a blank line; keep any partial tail for the
    // next read.
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      dispatch(buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}

// ─── Boards (saved Board views) ─────────────────────────────────────────

export interface SavedBoard {
  id: string;
  nest_id: string;
  name: string;
  private: boolean;
  position: number;
  created_by: string;
  created_by_email: string | null;
  /** BoardSettings plus filterTags and per-column ranks; see board-service.ts. */
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export async function listBoards(nestId: string) {
  return request<{ boards: SavedBoard[] }>(`/nests/${nestId}/boards`);
}

export async function createBoard(
  nestId: string,
  data: { name: string; private?: boolean; config?: Record<string, any> },
) {
  return request<{ board: SavedBoard }>(`/nests/${nestId}/boards`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateBoard(
  nestId: string,
  boardId: string,
  data: { name?: string; private?: boolean; config?: Record<string, any>; position?: number },
) {
  return request<{ board: SavedBoard }>(`/nests/${nestId}/boards/${boardId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

/** Set one column's card order (merged server-side, per column). */
export async function rankBoardColumn(
  nestId: string,
  boardId: string,
  key: string,
  order: string[],
) {
  return request<{ board: SavedBoard }>(`/nests/${nestId}/boards/${boardId}/rank`, {
    method: "POST",
    body: JSON.stringify({ key, order }),
  });
}

/** One change over many nodes (src/nodes/bulk-update.ts). Max 100 ids. */
export interface BulkPatch {
  board_id?: string;
  column?: string;
  add_tags?: string[];
  remove_tags?: string[];
  priority?: string | null;
  assignee?: string | null;
  due?: string | null;
  change_note?: string;
}

export interface BulkRowResult {
  id: string;
  title?: string;
  outcome: "updated" | "unchanged" | "skipped" | "failed";
  code?: "needs_review" | "locked" | "forbidden" | "not_found" | "conflict" | "invalid" | "error";
  reason?: string;
  version?: number;
  status?: string;
  completed_at?: string | null;
}

export interface BulkUpdateResult {
  requested: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  results: BulkRowResult[];
}

export const BULK_UPDATE_MAX = 100;

export async function bulkUpdateNodes(
  nestId: string,
  ids: string[],
  patch: BulkPatch,
  opts: { allowDraft?: boolean } = {},
) {
  return request<BulkUpdateResult>(`/nests/${nestId}/nodes/bulk-update`, {
    method: "POST",
    body: JSON.stringify({ ids, patch, ...(opts.allowDraft ? { allow_draft: true } : {}) }),
  });
}

/** Move / delete over a selection (src/nodes/bulk-actions.ts). Per-document rows. */
export interface BulkActionResult {
  requested: number;
  done: number;
  unchanged: number;
  skipped: number;
  failed: number;
  results: (BulkRowResult & { new_id?: string })[];
}

export async function bulkMoveNodes(nestId: string, ids: string[], folder: string) {
  return request<BulkActionResult>(`/nests/${nestId}/nodes/bulk-move`, {
    method: "POST",
    body: JSON.stringify({ ids, folder }),
  });
}

export async function bulkDeleteNodes(nestId: string, ids: string[]) {
  return request<BulkActionResult>(`/nests/${nestId}/nodes/bulk-delete`, {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function deleteBoard(nestId: string, boardId: string) {
  return request<{ deleted: boolean }>(`/nests/${nestId}/boards/${boardId}`, {
    method: "DELETE",
  });
}

// ─── Custom fields ─────────────────────────────────────────────────────────

export type FieldType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "date"
  | "user"
  | "url"
  | "checkbox"
  | "time_in_status";

/** A nest's field definition (src/nodes/custom-fields.ts FieldDefinition). */
export interface FieldDefinition {
  id: string;
  nest_id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  required: boolean;
  default_value: unknown;
  /** Node types it applies to; ["*"] = every type. */
  applies_to: string[];
  unit: string | null;
  preset: "estimate" | "time_in_status" | null;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FieldDefinitionInput {
  key?: string;
  label?: string;
  type?: FieldType;
  options?: string[];
  required?: boolean;
  default_value?: unknown;
  applies_to?: string[];
  unit?: string | null;
  preset?: "estimate" | "time_in_status";
  position?: number;
}

export async function listFields(nestId: string) {
  return request<{ fields: FieldDefinition[]; can_manage: boolean }>(`/nests/${nestId}/fields`);
}

export async function createField(nestId: string, data: FieldDefinitionInput) {
  return request<{ field: FieldDefinition }>(`/nests/${nestId}/fields`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateField(nestId: string, key: string, data: FieldDefinitionInput) {
  return request<{ field: FieldDefinition; invalid_values?: number; invalid_nodes?: string[] }>(
    `/nests/${nestId}/fields/${encodeURIComponent(key)}`,
    {
    method: "PATCH",
    body: JSON.stringify(data),
  },
  );
}

export async function deleteField(nestId: string, key: string) {
  return request<{ deleted: boolean }>(`/nests/${nestId}/fields/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

// ─── Metacognition agents (CU-wdqcq041jm) ─────────────────────────────────

export interface MetacognitionAgentConfig {
  persona: { name: string; avatar: string | null };
  scope: { read: string[]; propose: string[] };
  caps: { max_steps: number; max_tokens: number; max_seconds: number; max_proposals: number; max_comments?: number };
  feeds: Array<{ name: string; url: string }>;
  mcp_servers: Array<{ name: string; url: string; allowed_tools: string[]; auth_env?: string }>;
  model: string | null;
  /** Who it may notify (CU-wdqcq05rkq). Empty recipients = off. */
  notify?: MetacognitionNotifyConfig;
}

/** "owner" = the nest owner, "reviewers" = its reviewers, else a member's email. */
export interface MetacognitionNotifyConfig {
  recipients: string[];
  channels: Array<"email" | "connectors">;
  max_per_run: number;
}

export interface MetacognitionAgent extends Omit<MetacognitionAgentConfig, "persona"> {
  node_id: string;
  enabled: boolean;
  persona: { name: string; avatar: string | null; email: string };
  configured_by: string;
  updated_at: string;
}

/** What a metacognition run records on its trace (write tier). */
export interface MetacognitionTrace {
  persona?: { name: string; avatar: string | null };
  model?: string;
  billing?: "promptowl_credits" | "own_key";
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  est_cost_usd?: number | null;
  proposals?: number;
  notifications?: number;
  stopped_by?: string;
  summary?: string;
  skipped?: string;
  error?: string;
}

export async function listMetacognitionAgents(nestId: string) {
  const r = await request<{ agents: MetacognitionAgent[] }>(`/nests/${nestId}/metacognition`);
  return r.agents;
}

export async function saveMetacognitionAgent(
  nestId: string,
  nodeId: string,
  body: MetacognitionAgentConfig & { enabled: boolean },
) {
  const r = await request<{ agent: MetacognitionAgent }>(`/nests/${nestId}/metacognition/${nodeId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return r.agent;
}

/** GET /nests/:id/metacognition/:node/suggest — a starting config read off
 *  the agent document (never saved), each field with a plain-words `why`. */
export interface MetacognitionSuggestion {
  config: MetacognitionAgentConfig;
  why: Record<string, string>;
  /** MCP links in the instructions; a person names their tools before saving. */
  mcp_candidates: Array<{ name: string; url: string }>;
  /** "none" when the document has no approved instructions yet. */
  instructions: "approved" | "none";
}

export async function suggestMetacognitionConfig(nestId: string, nodeId: string) {
  const r = await request<{ suggestion: MetacognitionSuggestion }>(`/nests/${nestId}/metacognition/${nodeId}/suggest`);
  return r.suggestion;
}

/** GET /nests/:id/folders — every folder path in the nest (no documents). */
export async function listNestFolderPaths(nestId: string) {
  const r = await request<{ folders: Array<{ path: string; count: number; total: number }> }>(`/nests/${nestId}/folders`);
  return r.folders.map((f) => f.path);
}

export async function deleteMetacognitionAgent(nestId: string, nodeId: string) {
  return request<{ deleted: boolean }>(`/nests/${nestId}/metacognition/${nodeId}`, { method: "DELETE" });
}

export type AgentRunOutcome = "running" | "succeeded" | "failed" | "timeout" | "skipped" | "cancelled";

export interface AgentRunSummary {
  id: string;
  outcome: AgentRunOutcome;
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  tokens: number;
  est_cost_usd: number | null;
  proposals: number;
  approved: number;
  rejected: number;
  comments: number;
  notifications?: number;
  error: string | null;
}

/** GET /nests/:id/metacognition/:node/stats — what one agent did over a window. */
export interface AgentStats {
  node_id: string;
  window_days: number;
  runs: { total: number } & Record<AgentRunOutcome, number>;
  tokens: number;
  est_cost_usd: number;
  proposals: {
    made: number;
    approved: number;
    rejected: number;
    pending: number;
    withdrawn: number;
    approval_rate: number | null;
  };
  comments: number;
  notifications?: number;
  access_requests: number;
  blocked_by_scope: number;
  last_run_at: string | null;
  last_error: { run_id: string; at: string; message: string } | null;
  history: AgentRunSummary[];
}

export async function getMetacognitionStats(nestId: string, nodeId: string, days = 30, limit = 25) {
  const r = await request<{ stats: AgentStats }>(
    `/nests/${nestId}/metacognition/${nodeId}/stats?days=${days}&limit=${limit}`,
  );
  return r.stats;
}

export async function runMetacognitionAgent(nestId: string, nodeId: string) {
  return request<{ run_id: string; executes: "server" }>(`/nests/${nestId}/metacognition/${nodeId}/run`, {
    method: "POST",
    body: "{}",
  });
}
