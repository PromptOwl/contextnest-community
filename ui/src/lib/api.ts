/**
 * API client for the community server REST endpoints.
 * Handles auth token management and request formatting.
 */

const API_BASE = "";

function getToken(): string | null {
  return localStorage.getItem("cnst_token");
}

export function setToken(token: string) {
  localStorage.setItem("cnst_token", token);
}

export function clearToken() {
  localStorage.removeItem("cnst_token");
}

export function hasToken(): boolean {
  return !!getToken();
}

async function request<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

// ─── Auth ───────────────────────────────────────────────────────────────

export async function login(email: string, password: string) {
  const data = await request<{ api_key: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setToken(data.api_key);
  return data;
}

export async function register(email: string, password: string, name?: string) {
  const data = await request<{ api_key: string; user: any }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
  setToken(data.api_key);
  return data;
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

export async function exchangePromptOwlToken(token: string) {
  const data = await request<{ api_key: string; user: any }>(
    "/auth/promptowl",
    { method: "POST", body: JSON.stringify({ token }) },
  );
  setToken(data.api_key);
  return data;
}

// ─── Health ─────────────────────────────────────────────────────────────

export async function getHealth() {
  return request<{
    status: string;
    auth_mode: string;
    suspended_reason?: string;
  }>("/health");
}

// ─── Admin / Teammates ─────────────────────────────────────────────────

export async function getAdminStatus() {
  return request<{
    claimed: boolean;
    admin: { email: string; name: string | null } | null;
    me: { email: string; is_admin: boolean } | null;
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

export async function inviteTeammate(email: string, label?: string) {
  return request<{
    api_key: string;
    user: { id: string; email: string };
    message: string;
  }>("/auth/invite", {
    method: "POST",
    body: JSON.stringify({ email, label }),
  });
}

// ─── Nest settings ─────────────────────────────────────────────────────

export async function getNestSettings(nestId: string) {
  return request<{ stewardship_enabled: boolean }>(
    `/nests/${nestId}/settings`,
  );
}

export async function updateNestSettings(
  nestId: string,
  data: { stewardship_enabled?: boolean },
) {
  return request<{ stewardship_enabled: boolean }>(
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

// ─── Nodes ──────────────────────────────────────────────────────────────

export async function listNodes(nestId: string) {
  return request<{ count: number; nodes: any[] }>(`/nests/${nestId}/nodes`);
}

export async function getNode(nestId: string, nodeId: string) {
  return request<{ node: any }>(`/nests/${nestId}/nodes/${nodeId}`);
}

export async function createNode(
  nestId: string,
  data: { title: string; content: string; tags?: string[]; type?: string },
) {
  return request<{ node: any; stewards?: any[] }>(`/nests/${nestId}/nodes`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateNode(
  nestId: string,
  nodeId: string,
  data: { content?: string; tags?: string[]; title?: string; changeNote?: string },
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

export async function getNodeStewards(nestId: string, nodeId: string) {
  return request<{ stewards: any[] }>(
    `/nests/${nestId}/nodes/${nodeId}/stewards`,
  );
}

export async function getReviewQueue(nestId: string, status = "pending") {
  return request<{ requests: any[]; total: number }>(
    `/nests/${nestId}/review-queue?status=${status}`,
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
