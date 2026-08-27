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
  return request<{ status: string; token?: string }>(
    `/auth/device/poll?code=${encodeURIComponent(code)}&client_secret=${encodeURIComponent(clientSecret)}`,
  );
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
    logo_url?: string | null;
    promptowl_sign_in_gate?: "open" | "admin-only" | "disabled";
    manual_sign_in?: "open" | "invite-only" | "disabled";
    /** True only when OIDC SSO is enabled AND fully configured server-side. */
    oidc_enabled?: boolean;
    /** Present when oidc_enabled — lets the login page label the button by IdP. */
    oidc_issuer?: string;
    workflow_plane_enabled?: boolean;
    /** Import teams from PromptOwl (default OFF). Off → the panel is hidden. */
    promptowl_teams_enabled?: boolean;
    /** Content-type toggles — default ON server-side; the editor's type
     *  picker hides a disabled type exactly when create would refuse it. */
    type_artifact_enabled?: boolean;
    type_table_enabled?: boolean;
    subagent_runs_enabled?: boolean;
    subagent_max_depth?: number;
    subagent_max_children?: number;
    runner_key_configured?: boolean;
    suspended_reason?: string;
  }>("/health");
}

export type SignInGate = "open" | "admin-only" | "disabled";
export type ManualSignIn = "open" | "invite-only" | "disabled";

/** Server-wide settings editable from the admin Settings page. */
export interface AdminSettings {
  promptowl_sign_in_gate: SignInGate;
  manual_sign_in: ManualSignIn;
  logo_url: string | null;
  telemetry_enabled: boolean;
  public_base_url: string;
  max_body_bytes: number;
  workflow_plane_enabled: boolean;
  /** Import teams from PromptOwl (default OFF). Off → /teams/promptowl 404s
   *  and the PromptOwl Teams panel is hidden. */
  promptowl_teams_enabled: boolean;
  /** Content-type toggles (default ON). Disabling refuses new creations of
   *  the type only — existing nodes still read/render/version. */
  type_artifact_enabled: boolean;
  type_table_enabled: boolean;
  subagent_runs_enabled: boolean;
  subagent_max_depth: number;
  subagent_max_children: number;
  trace_retention_days: number;
  /** OIDC SSO. The client secret is write-only — only its presence comes back. */
  oidc_enabled: boolean;
  oidc_issuer: string;
  oidc_client_id: string;
  oidc_client_secret_set?: boolean;
  oidc_allowed_domains: string;
  oidc_auto_provision: boolean;
  /** Tag new documents with the creator's directory department (dept:<slug>). */
  oidc_department_tagging: boolean;
  /** Server-computed readiness: enabled AND issuer+client id+secret present. */
  oidc_ready?: boolean;
  /** Write-only: string sets/replaces, null clears; never returned. */
  oidc_client_secret?: string | null;
  anthropic_api_key_masked?: string | null;
  slack_webhook_url: string;
  msteams_webhook_url: string;
  smtp_url: string;
  notify_email_from: string;
  notify_email_to: string;
  anthropic_api_key?: string | null
}

export async function getAdminSettings() {
  return request<AdminSettings>("/admin/settings");
}

/** Admin: patch one or more server settings. Live + persisted server-side. */
export async function updateAdminSettings(
  patch: Partial<AdminSettings> & {
    anthropic_api_key?: string | null;
  },
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

// ─── License ───────────────────────────────────────────────────────────

export interface LicenseStatus {
  valid: boolean;
  tier: string;
  org: string | null;
  owner_email: string | null;
  suspended: boolean;
  suspended_reason: string | null;
  limits: { maxNests: number; maxUsers: number } | null;
}

export async function getLicenseStatus() {
  return request<LicenseStatus>("/license/status");
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
  }>("/license/install", {
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
}

/** Mint another external-client API key. 409s only at the per-user ceiling. */
export async function createApiKey(opts?: { label?: string; nest_id?: string }) {
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

// ─── Nest settings ─────────────────────────────────────────────────────

export interface NestSettings {
  stewardship_enabled: boolean;
  allow_self_approve: boolean;
  /** Review only prime documents; everything else self-publishes. */
  prime_only_review: boolean;
  /** Tags that mark a document prime (normalized, no leading `#`). */
  prime_tags: string[];
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
  },
) {
  return request<NestSettings>(`/nests/${nestId}/settings`, {
    method: "PATCH",
    body: JSON.stringify(data),
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

export async function listNests() {
  return request<{ nests: any[] }>("/nests");
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
  let cur: ImportedFile[] = [];
  let curBytes = 0;
  for (const f of files) {
    const size = encoder.encode(f.path).length + encoder.encode(f.content ?? "").length;
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
  const rejected: string[] = [];
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
  visibility: "private" | "public",
) {
  return request<{ visibility: "private" | "public" }>(
    `/nests/${nestId}/visibility`,
    { method: "PATCH", body: JSON.stringify({ visibility }) },
  );
}

export async function getNest(nestId: string) {
  return request<{
    nest: { id: string; name: string; visibility: "private" | "public" };
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

export async function getNode(nestId: string, nodeId: string) {
  return request<{ node: any }>(`/nests/${nestId}/nodes/${nodeId}`);
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
  },
) {
  return request<{ node: any; stewards?: any[] }>(`/nests/${nestId}/nodes`, {
    method: "POST",
    body: JSON.stringify(data),
  });
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
  return request<{ stewards: any[] }>(`/nests/${nestId}/stewards`);
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

// ── Deletion requests ─────────────────────────────────────────────────────
// Flagging is open to anyone who can read the node; resolving needs the same
// write permission a direct delete does (server-enforced).

export interface DeletionRequest {
  id: string;
  /** Node id, folder path, or nest id — see targetType. */
  nodeId: string;
  targetType?: "document" | "folder" | "nest";
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

/** Flag a whole folder ("api/limits") or the nest itself for deletion. */
export async function requestTargetDeletion(
  nestId: string,
  targetType: "folder" | "nest",
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

export type FeedItem = FeedChangeItem | FeedCommentItem;

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
    counts: { changes: number; comments: number };
    filter: FeedFilter;
    limit: number;
    offset: number;
  }>(`/nests/${nestId}/feed?${params.toString()}`);
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
): string {
  const params = new URLSearchParams();
  if (version != null) params.set("v", String(version));
  if (cacheBust != null) params.set("_", String(cacheBust));
  const qs = params.toString();
  return `${API_BASE}/nests/${nestId}/nodes/${nodeId}/hosted${qs ? `?${qs}` : ""}`;
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
  | "review_resolved";

export interface ActivityEntry {
  type: ActivityType;
  nodeId: string;
  actor: string;
  at: string;
  detail?: string;
  refId?: string;
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

// ─── Sharing ────────────────────────────────────────────────────────────

export async function listCollaborators(nestId: string) {
  return request<{ collaborators: any[] }>(`/nests/${nestId}/collaborators`);
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
   *  owners/admins get those in the waiting-on-me bucket. */
  type: "review" | "deletion";
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
  /** Deletion items only. For "folder"/"nest", node_id is a folder path or the
   *  nest id — NOT a document id, so don't open the editor on it. */
  target_type?: "document" | "folder" | "nest";
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
}

export interface WorkPagination {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
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

export async function getMyDrafts(opts?: { limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  if (opts?.offset != null) q.set("offset", String(opts.offset));
  const qs = q.toString();
  return request<{ drafts: MyDraft[]; pagination: WorkPagination }>(
    `/me/drafts${qs ? `?${qs}` : ""}`,
  );
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
