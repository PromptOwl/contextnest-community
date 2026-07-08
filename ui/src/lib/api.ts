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
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data as T;
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
    auth_mode: string;
    logo_url?: string | null;
    promptowl_sign_in_gate?: "open" | "admin-only" | "disabled";
    workflow_plane_enabled?: boolean;
    subagent_runs_enabled?: boolean;
    suspended_reason?: string;
  }>("/health");
}

export type SignInGate = "open" | "admin-only" | "disabled";

/** Server-wide settings editable from the admin Settings page. */
export interface AdminSettings {
  promptowl_sign_in_gate: SignInGate;
  logo_url: string | null;
  telemetry_enabled: boolean;
  public_base_url: string;
  max_body_bytes: number;
  workflow_plane_enabled: boolean;
  subagent_runs_enabled: boolean;
  slack_webhook_url: string;
  smtp_url: string;
  notify_email_from: string;
  notify_email_to: string;
}

export async function getAdminSettings() {
  return request<AdminSettings>("/admin/settings");
}

/** Admin: patch one or more server settings. Live + persisted server-side. */
export async function updateAdminSettings(patch: Partial<AdminSettings>) {
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

/** Rotate the caller's existing key — atomic DELETE + INSERT. */
export async function rotateApiKey(opts?: { label?: string; nest_id?: string }) {
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
  return request<{ stewardship_enabled: boolean; allow_self_approve: boolean }>(
    `/nests/${nestId}/settings`,
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

/** Import a folder the user picked in their browser. The browser reads the
 *  folder and uploads each file; the server writes them into the workspace. */
export async function importNest(name: string, files: ImportedFile[]) {
  return request<{ nest: any; documents: number }>("/nests/import", {
    method: "POST",
    body: JSON.stringify({ name, files }),
  });
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
  return request<{ nest: any; documents: number }>("/nests/unsynced/sync", {
    method: "POST",
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

// ─── Edge-type registry ("turing" workflow plane) ───────────────────────
// The vocabulary of connections: stewards articulate once what a relation
// (`next`, `escalates-when`, …) MEANS; edges reference the registry. Every
// route is feature-flagged server-side — 404 unless FEATURE_WORKFLOW_PLANE
// / the "Workflow plane" admin toggle is on. Reads read-tier, writes write-tier.

export interface EdgeTypeCondition {
  /** Named parameters a conditional edge fills in (e.g. ["term","op","value"]). */
  params: string[];
  mode_default: "structured" | "nl" | "open";
}

export interface EdgeType {
  id: string;
  nest_id: string;
  name: string;
  description: string;
  direction: "directed" | "undirected";
  /** Flow types form the workflow DAG; non-flow are lineage/ownership. */
  is_flow: boolean;
  condition_schema: EdgeTypeCondition | null;
  color: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function listEdgeTypes(nestId: string) {
  return request<{ count: number; edge_types: EdgeType[] }>(
    `/nests/${nestId}/edge-types`,
  );
}

export async function upsertEdgeType(
  nestId: string,
  data: {
    name: string;
    description: string;
    direction?: "directed" | "undirected";
    is_flow?: boolean;
    // 6-digit hex (e.g. #16a34a) or null/"" to clear. Bad hex → server 400.
    color?: string | null;
    // Omit / null for a plain edge type; provide params to make it conditional.
    condition_schema?: { params: string[]; mode_default?: EdgeTypeCondition["mode_default"] } | null;
  },
) {
  return request<{ edge_type: EdgeType }>(`/nests/${nestId}/edge-types`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteEdgeType(nestId: string, id: string) {
  return request<{ deleted: boolean }>(
    `/nests/${nestId}/edge-types/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

// ─── Runs ("turing" workflow plane) ─────────────────────────────────────
// A nest's agent runs and their step traces, plus triggerRun (creates the run
// record + bundle; the server never executes it — a runner does).
// `inputs`/`trace`/`detail` come back null when the caller lacks write tier
// (server-side redaction).

export interface Run {
  id: string;
  nest_id: string;
  agent_node: string;
  triggered_by: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  inputs: unknown | null;
  trace: unknown | null;
  started_at: string;
  finished_at: string | null;
  /** Sub-agent runs: the run that spawned this one (null = top-level), and its
   * depth in the call tree (0 = top-level). Present once migration 018 ran. */
  parent_run_id: string | null;
  depth: number;
}

export interface RunStep {
  seq: number;
  node_id: string | null;
  edge_id: string | null;
  action: "read" | "write" | "branch" | "notify" | "external";
  detail: unknown | null;
  at: string;
}

export async function listRuns(
  nestId: string,
  opts?: { agent?: string; status?: string; limit?: number },
) {
  const params = new URLSearchParams();
  if (opts?.agent) params.set("agent", opts.agent);
  if (opts?.status) params.set("status", opts.status);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<{ count: number; runs: Run[] }>(
    `/nests/${nestId}/runs${qs ? `?${qs}` : ""}`,
  );
}

export async function getRun(runId: string) {
  return request<{ run: Run; steps: RunStep[] }>(
    `/runs/${encodeURIComponent(runId)}`,
  );
}

/** The executable bundle a trigger returns — handed to an external runner. */
export interface RunBundle {
  run_id: string;
  parent_run_id: string | null;
  depth: number;
  agent: {
    id: string;
    title: string;
    type: string;
    schedule: unknown;
    content: string;
  };
  edges: unknown[];
  definitions: unknown[];
  trace_hint: { retrieval: string; steps: string };
}

/**
 * Trigger a run: creates the run record and returns the executable bundle.
 * The server does NOT execute — an external runner must walk the bundle and
 * report steps back. Write tier required. `agentNode` is a node id like
 * `nodes/my-agent`; its slashes are preserved (the route matches `.+`), so
 * don't encode the whole path.
 *
 * Pass `parentRunId` to spawn this as a SUB-AGENT run nested under a still-
 * running parent (requires FEATURE_SUBAGENT_RUNS; the server rejects it with a
 * 400 when the flag is off, and bounds depth/fan-out/re-entrancy when on).
 */
export async function triggerRun(
  nestId: string,
  agentNode: string,
  inputs?: unknown,
  parentRunId?: string | null,
) {
  const path = agentNode
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const body: { inputs?: unknown; parent_run_id?: string } = {};
  if (inputs !== undefined) body.inputs = inputs;
  if (parentRunId) body.parent_run_id = parentRunId;
  return request<RunBundle>(`/nests/${nestId}/run/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** A runnable node (type agent/skill) — powers the trigger picker. */
export interface Runnable {
  id: string;
  title: string;
  type: string;
}

/** Every runnable node (agent/skill) in the nest, filtered server-side. */
export async function listRunnables(nestId: string) {
  return request<{ count: number; runnables: Runnable[] }>(
    `/nests/${nestId}/runnables`,
  );
}
// ─── Nodes ──────────────────────────────────────────────────────────────

// Upload an image into the nest's assets folder. Multipart (not the JSON
// request() helper) — the browser sets the boundary content-type itself.
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
  return request<{ count: number; nodes: any[] }>(`/nests/${nestId}/nodes`);
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

/** URL of the sandboxed artifact render (iframe `src`). `v` pins a snapshot. */
export function hostedArtifactUrl(
  nestId: string,
  nodeId: string,
  version?: number | null,
): string {
  const v = version != null ? `?v=${version}` : "";
  return `${API_BASE}/nests/${nestId}/nodes/${nodeId}/hosted${v}`;
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
): Promise<{ html: string; snapshot: number | null }> {
  const res = await fetch(hostedArtifactUrl(nestId, nodeId, version), {
    credentials: "include",
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
