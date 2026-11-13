/**
 * Nest Settings REST Helpers
 *
 * Preconditions for the Nest Settings suite — stewardship and the other
 * governance settings, stewards, documents waiting for review, shares, an
 * archived nest, an API key for agent writes — are arranged through the REST
 * API, and what the Nest settings dialog saved is read back the same way.
 *
 * Extends StewardsApi, so the nest, document, share, steward and cleanup
 * helpers are the same ones: every nest created here is in the entity registry
 * and is deleted after the test (`deleteCreatedNests()`), and the teardown or
 * the next run's orphan sweeper catches anything left behind. API keys and
 * Systems are not inside a nest, so the suite revokes those itself.
 */

import StewardsApi from './stewards_api.js';

class NestSettingsApi extends StewardsApi {
  // ── Settings ───────────────────────────────────────────────────────────────

  /** GET /nests/:id/settings — the saved settings. */
  async settings(nestId) {
    const data = await this.expectOk('GET', `/nests/${nestId}/settings`);
    return data?.settings ?? data;
  }

  /** PATCH /nests/:id/settings — `{ok, status, data}`, never throws. */
  async patchSettings(nestId, patch) {
    return this.request('PATCH', `/nests/${nestId}/settings`, patch);
  }

  /** PATCH /nests/:id/settings, and throw unless it was accepted. */
  async setSettings(nestId, patch) {
    return this.expectOk('PATCH', `/nests/${nestId}/settings`, patch);
  }

  // ── Activity ───────────────────────────────────────────────────────────────

  /** The actors of a document's "read" entries in the nest's activity log. */
  async readers(nestId, nodeId) {
    const { data } = await this.request(
      'GET',
      `/nests/${nestId}/activity-log?node=${encodeURIComponent(nodeId)}&type=read&limit=50`
    );
    return (data?.items ?? []).map((i) => String(i.actor ?? '').toLowerCase());
  }

  // ── API keys (an agent's identity) ─────────────────────────────────────────

  /** POST /auth/keys — a personal API key; `{id, api_key}`. */
  async createApiKey(label) {
    const data = await this.expectOk('POST', '/auth/keys', { label });
    return { id: data.id, apiKey: data.api_key, label };
  }

  /** DELETE /auth/keys/:id — `{ok, status, data}`, never throws. */
  async revokeApiKey(keyId) {
    return this.request('DELETE', `/auth/keys/${keyId}`);
  }

  /**
   * A request made with an API key alone — no session cookie, the way an agent
   * or a script would call. `{status, data}`.
   */
  async withKey(apiKey, method, urlPath, body = undefined) {
    const res = await fetch(new URL(urlPath, process.env.BASE_URL), {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Non-JSON body — the status is enough.
    }
    return { status: res.status, data };
  }

  /** Create a document with an API key (as an agent); `{status, data}`. */
  async agentWrite(apiKey, nestId, title) {
    return this.withKey(apiKey, 'POST', `/nests/${nestId}/nodes`, {
      title,
      content: `# ${title}\n\nWritten by an agent.\n`,
    });
  }

  /** The keys that skip agent-write confirmation in this nest ("Always allow"). */
  async pushAllowlist(nestId) {
    const { data } = await this.request('GET', `/nests/${nestId}/push-allowlist`);
    return data?.allowlist ?? [];
  }

  /** The nest's held agent writes with this status ("pending", "applied", "rejected"). */
  async pendingPushes(nestId, status = 'pending') {
    const { data } = await this.request('GET', `/nests/${nestId}/pending-pushes?status=${status}`);
    return data?.pending_pushes ?? [];
  }

  // ── Systems ────────────────────────────────────────────────────────────────

  /** GET /nests/:id/systems — the Systems that work in this nest. */
  async nestSystems(nestId) {
    const { data } = await this.request('GET', `/nests/${nestId}/systems`);
    return data?.systems ?? data ?? [];
  }

  /** DELETE /systems/:id — `{ok, status, data}`, never throws. */
  async revokeSystem(systemId) {
    return this.request('DELETE', `/systems/${systemId}`);
  }
}

export default NestSettingsApi;
