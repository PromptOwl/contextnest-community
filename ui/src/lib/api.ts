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
  const data = text ? (JSON.parse(text) as any) : ({} as any);

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
  // A successful mutation under /nests/{id} changes what the cached structural
  // reads (node list, nest, settings) would return — drop that nest's read
  // cache so approval/edit state is never served stale. See cachedRead below.
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    const m = path.match(/^\/nests\/([^/?]+)/);
    if (m) invalidateNestReads(m[1]);
    // Creating / deleting / renaming a nest changes the nests list itself.
    if (path === "/nests" || /^\/nests\/[^/?]+$/.test(path)) {
      invalidateNestsList();
    }
  }
  return data as T;
}

// ─── Client read cache (structural, slow-changing GETs) ──────────────────
// The node list / nest / settings get re-fetched on every navigation, which
// makes the app feel like it "reloads forever" on a large nest. Cache just
// those structural reads in memory, stale-while-revalidate: a fresh entry is
// served instantly; an expired entry still paints instantly while a background
// fetch refreshes it. Any mutation invalidates the nest's reads (handled in
// request() above) so approval/edit state is never served stale — an
// invalidated key has no entry at all and the next read blocks on the network.
// Live document bodies, search, and feeds are intentionally NOT cached — they
// need freshness.
const READ_TTL_MS = 30_000;
type CacheEntry = { data: unknown; ts: number; inflight?: Promise<unknown> };
const readCache = new Map<string, CacheEntry>();
// Bumped on every invalidation. A read in flight when a mutation lands must
// not write its (pre-mutation) response back into the cache — it snapshots
// this counter at start and only caches if unchanged on completion.
let cacheGen = 0;

async function cachedRead<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = readCache.get(key);
  if (hit?.inflight) {
    // Revalidation already underway — paint stale data if we have any,
    // otherwise join the in-flight fetch (dedupe).
    if (hit.data !== undefined) return hit.data as T;
    return hit.inflight as Promise<T>;
  }
  if (hit && Date.now() - hit.ts < READ_TTL_MS) return hit.data as T; // fresh → instant
  const gen = cacheGen;
  const inflight = fetcher()
    .then((data) => {
      // An invalidation raced this fetch → the response may predate the
      // mutation; don't cache it (the entry was already dropped).
      if (gen === cacheGen) readCache.set(key, { data, ts: Date.now() });
      return data;
    })
    .catch((err) => {
      // Drop only our in-flight marker; keep any prior good value.
      const cur = readCache.get(key);
      if (cur?.inflight === inflight) {
        if (cur.data !== undefined) readCache.set(key, { data: cur.data, ts: cur.ts });
        else readCache.delete(key);
      }
      throw err;
    });
  readCache.set(key, { data: hit?.data, ts: hit?.ts ?? 0, inflight });
  if (hit?.data !== undefined) {
    // Stale-while-revalidate: serve the expired value now; the fetch above
    // refreshes in the background (its failure only means the next read
    // retries, so swallow it here — the caller already has data).
    void (inflight as Promise<unknown>).catch(() => {});
    return hit.data as T;
  }
  return inflight as Promise<T>;
}

/** Drop cached structural reads for a nest (or all when no id). Called
 *  automatically on any successful mutation under /nests/{id} in request();
 *  exported for manual busts and tests. */
export function invalidateNestReads(nestId?: string): void {
  cacheGen++; // tell in-flight reads not to cache their (pre-mutation) response
  if (!nestId) {
    readCache.clear();
    return;
  }
  const prefix = `/nests/${nestId}`;
  for (const k of readCache.keys()) {
    // Exact key or a sub-path — but not a different nest whose id merely
    // shares this prefix (nest-1 must not clear nest-12).
    if (k === prefix || k.startsWith(`${prefix}/`)) readCache.delete(k);
  }
}

/** Drop the cached nests list. Needed by mutations that create a nest but
 *  don't route through request()'s /nests/{id} hook (streaming import,
 *  unsynced-folder sync). */
function invalidateNestsList(): void {
  cacheGen++;
  readCache.delete("/nests");
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

// ─── External-client API keys (one per user) ───────────────────────────

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

/**
 * Mint the caller's external-client API key. Returns 409 if a key
 * already exists — UI should prompt the user to rotate instead.
 */
export async function createApiKey(opts?: { label?: string; nest_id?: string }) {
  return request<{ api_key: string; key_prefix: string }>("/auth/keys", {
    method: "POST",
    body: JSON.stringify(opts || {}),
  });
}

/** Rotate the caller's existing key — atomic DELETE + INSERT.
 *  nest_id: null explicitly clears a per-nest scope; omitting keeps it. */
export async function rotateApiKey(opts?: {
  label?: string;
  nest_id?: string | null;
}) {
  return request<{ api_key: string; key_prefix: string }>("/auth/keys/rotate", {
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

export async function getNestSettings(nestId: string) {
  return cachedRead(`/nests/${nestId}/settings`, () =>
    request<{ stewardship_enabled: boolean; allow_self_approve: boolean }>(
      `/nests/${nestId}/settings`,
    ),
  );
}

export async function updateNestSettings(
  nestId: string,
  data: { stewardship_enabled?: boolean; allow_self_approve?: boolean },
) {
  return request<{ stewardship_enabled: boolean; allow_self_approve: boolean }>(
    `/nests/${nestId}/settings`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
}

// ─── Nests ──────────────────────────────────────────────────────────────

export async function listNests() {
  return cachedRead("/nests", () => request<{ nests: any[] }>("/nests"));
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

/** Import a folder the user picked in their browser. The browser reads the
 *  folder and uploads each file; the server writes them into the workspace.
 *
 *  When `onProgress` is supplied we hit the `?stream=1` endpoint, which streams
 *  NDJSON progress lines so the caller can render a real progress bar; without
 *  it, the original single JSON response is used. */
export async function importNest(
  name: string,
  files: ImportedFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ nest: any; documents: number }> {
  if (!onProgress) {
    return request<{ nest: any; documents: number }>("/nests/import", {
      method: "POST",
      body: JSON.stringify({ name, files }),
    });
  }

  const res = await fetch(`${API_BASE}/nests/import?stream=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, files }),
    credentials: "include",
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Import failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: { nest: any; documents: number } | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.phase === "register") onProgress(msg.done, msg.total);
      if (msg.complete) result = { nest: msg.nest, documents: msg.documents };
    }
  }
  if (!result) throw new Error("Import failed");
  // Streaming path uses raw fetch, so request()'s invalidation hook never ran.
  invalidateNestsList();
  return result;
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
  const out = await request<{ nest: any; documents: number }>("/nests/unsynced/sync", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  // Two-segment path doesn't match request()'s /nests/{id} list hook, but this
  // creates a nest — bust the list explicitly.
  invalidateNestsList();
  return out;
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
  return cachedRead(`/nests/${nestId}`, () =>
    request<{
      nest: { id: string; name: string; visibility: "private" | "public" };
      permission: string;
      // Caller's merged effective roles (collaborator + steward), nest-wide.
      roles?: Array<"owner" | "admin" | "editor" | "reviewer" | "viewer">;
      // Caller's own steward rows (scoped). Full roster is admin-only.
      myStewards?: any[];
    }>(`/nests/${nestId}`),
  );
}

export async function getServerStats() {
  return request<{ nests: number; documents: number; users: number }>("/stats");
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

export async function listNodes(nestId: string) {
  return cachedRead(`/nests/${nestId}/nodes`, () =>
    request<{ count: number; nodes: any[] }>(`/nests/${nestId}/nodes`),
  );
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
  }>(`/nests/${nestId}/nodes/${nodeId}/versions`);
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
  type: "review";
  nest_id: string;
  nest_name: string;
  node_id: string;
  title: string;
  requested_by: string;
  requested_at: string;
  priority?: string;
}

export interface WatcherNotification {
  id: string;
  nest_id: string;
  kind: string;
  subject_id: string | null;
  message: string;
  created_at: string;
  read_at: string | null;
}

export async function getMyWork() {
  return request<{
    items: WorkItem[];
    waiting: WorkItem[];
    notifications?: WatcherNotification[];
  }>("/me/work");
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
  /** Write-tier only; null for read-tier callers. */
  trace?: { error?: string; [k: string]: unknown } | null;
}

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
