/**
 * API Keys REST Helpers
 *
 * Preconditions for the API keys suite — keys, and the nest a key can be
 * scoped to — are arranged through the REST API. Keys are not in
 * the entity registry (it tracks nests and documents only), so every key made
 * by a test is found again by its name token and revoked by
 * `revokeKeysNamed()`, which the suite calls after each test.
 *
 * An account may hold at most 20 keys (MAX_API_KEYS_PER_USER in
 * src/auth/keys.ts); `freeSlots()` lets a test skip rather than fail on an
 * account that is already near the cap.
 *
 * Extends DashboardApi, so `request` / `expectOk` and the nest helpers are the
 * same ones.
 */

import { request as playwrightRequest } from '@playwright/test';
import DashboardApi from './dashboard_api.js';
import logger from '../helper/logger/logger.js';

/** Same cap the server enforces (src/auth/keys.ts). */
export const MAX_API_KEYS_PER_USER = 20;

class ApiKeysApi extends DashboardApi {
  /** GET /auth/keys — `{ keys: [{ id, key_prefix, nest_id, label, created_at, last_used_at }] }`. */
  async listKeys() {
    return (await this.expectOk('GET', '/auth/keys')).keys ?? [];
  }

  /** How many more keys this account may create. */
  async freeSlots() {
    return MAX_API_KEYS_PER_USER - (await this.listKeys()).length;
  }

  /**
   * POST /auth/keys — mint a key. `{ api_key, key }`; the plaintext is only
   * ever in this response.
   * @param {string} label
   * @param {string} [nestId] - Scope the key to one nest
   */
  async createKey(label, nestId) {
    return this.expectOk('POST', '/auth/keys', { label, ...(nestId ? { nest_id: nestId } : {}) });
  }

  /** DELETE /auth/keys/:id — `{ok, status, data}`, never throws. */
  async revokeKey(keyId) {
    return this.request('DELETE', `/auth/keys/${keyId}`);
  }

  /** Revoke every key whose name contains `token` (a test's own keys). */
  async revokeKeysNamed(token) {
    const mine = (await this.listKeys()).filter((k) => (k.label ?? '').includes(token));
    for (const k of mine) {
      const res = await this.revokeKey(k.id);
      if (!res.ok && res.status !== 404) logger.warn(`[ApiKeysApi] Could not revoke ${k.label}: HTTP ${res.status}`);
    }
    return mine.length;
  }

  /**
   * Call the API with a key alone — no session cookie, which would otherwise
   * win over the Bearer header (authMiddleware) — and return the status.
   * @param {string} apiKey
   * @param {string} [urlPath]
   */
  async statusWithKey(apiKey, urlPath = '/auth/keys') {
    const ctx = await playwrightRequest.newContext({
      baseURL: process.env.BASE_URL || 'http://localhost:3838',
      extraHTTPHeaders: { Authorization: `Bearer ${apiKey}` },
    });
    try {
      return (await ctx.get(urlPath)).status();
    } finally {
      await ctx.dispose();
    }
  }
}

export default ApiKeysApi;
