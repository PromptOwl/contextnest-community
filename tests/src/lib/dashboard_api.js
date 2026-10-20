/**
 * Dashboard REST Helpers
 *
 * Preconditions for the Community Dashboard suite (nests, archive state, pins,
 * visibility, sharing) are arranged through the REST API rather than by driving
 * the UI: creating ten nests through the New Nest dialog is ten dialogs' worth
 * of flake for setup that isn't what the test is about.
 *
 * The calls ride the authenticated page's request context, so the `cnst_session`
 * cookie stored by setup-auth authorizes them — the same approach
 * cleanup_manager.js uses for teardown.
 *
 * Every nest created here is registered in the entity registry so the teardown
 * (and the next run's orphan sweeper) removes it. Always name nests with
 * `commonFunction.generateEntityName()` so the AUTO_ sweep can find them.
 */

import { registerEntity } from './entity_registry.js';
import logger from '../helper/logger/logger.js';

class DashboardApi {
  /**
   * @param {import('@playwright/test').Page} page - Authenticated page
   */
  constructor(page) {
    this.page = page;
  }

  /**
   * Issue an authenticated API request through the page's request context.
   *
   * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
   * @param {string} urlPath - Path relative to baseURL (e.g. '/nests')
   * @param {Object} [body] - JSON body
   * @returns {Promise<{ok: boolean, status: number, data: any}>}
   */
  async request(method, urlPath, body = undefined) {
    const response = await this.page.request.fetch(urlPath, {
      method,
      ...(body !== undefined ? { data: body } : {}),
      // A shared server under a full suite run can take longer than the
      // default 30s to answer a write; a slow answer isn't a failure.
      timeout: 60_000,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // 204 / non-JSON — fine.
    }
    return { ok: response.ok(), status: response.status(), data };
  }

  /**
   * Same as request(), but throws on a non-2xx so a broken precondition fails
   * loudly instead of surfacing later as a confusing assertion failure.
   */
  async expectOk(method, urlPath, body = undefined) {
    const res = await this.request(method, urlPath, body);
    if (!res.ok) {
      throw new Error(
        `${method} ${urlPath} → HTTP ${res.status}${res.data?.error ? ` (${res.data.error})` : ''}`
      );
    }
    return res.data;
  }

  // ── Server / caller facts ────────────────────────────────────────────────

  /** GET /health — carries `nest_creation` ('admins' | 'everyone'). */
  async health() {
    const { data } = await this.request('GET', '/health');
    return data ?? {};
  }

  /** GET /auth/admin-status — `me.is_admin` gates unsynced folders and create. */
  async adminStatus() {
    const { data } = await this.request('GET', '/auth/admin-status');
    return data ?? {};
  }

  /** Whether this caller may create or import a nest (mirrors the UI's rule). */
  async canCreateNests() {
    const [health, admin] = await Promise.all([this.health(), this.adminStatus()]);
    return !!admin?.me?.is_admin || health?.nest_creation === 'everyone';
  }

  /** Whether this caller is the server admin (unsynced folders are admin-only). */
  async isServerAdmin() {
    const admin = await this.adminStatus();
    return !!admin?.me?.is_admin;
  }

  // ── Nests ────────────────────────────────────────────────────────────────

  /**
   * GET /nests — owned + shared + discovered. Archived nests are absent.
   * @param {{archived?: boolean}} [opts]
   */
  async listNests({ archived = false } = {}) {
    const { data } = await this.request('GET', archived ? '/nests?archived=1' : '/nests');
    return data?.nests ?? [];
  }

  /** Nests this caller owns (excludes shared and discovered rows). */
  async listOwnedNests() {
    const nests = await this.listNests();
    return nests.filter((n) => n.is_owner ?? (n.permission ?? 'owner') === 'owner');
  }

  /**
   * POST /nests — create and register for cleanup.
   * @param {string} name - Must be an AUTO_ name (generateEntityName)
   * @param {string} [description]
   */
  async createNest(name, description = '') {
    const data = await this.expectOk('POST', '/nests', { name, description });
    const nest = data.nest;
    registerEntity('nests', { id: nest.id, name: nest.name });
    logger.info(`[DashboardApi] Created nest ${nest.name} (${nest.id})`);
    return nest;
  }

  /**
   * POST /nests/import — one-shot folder import, so the nest comes back with
   * `is_imported` set and the card shows its Imported badge + provenance.
   * @param {string} name
   * @param {Array<{path: string, content: string}>} [files]
   */
  async importNest(name, files = [{ path: 'welcome.md', content: '# Welcome\n\nImported.\n' }]) {
    const data = await this.expectOk('POST', '/nests/import', { name, files });
    const nest = data.nest;
    registerEntity('nests', { id: nest.id, name: nest.name });
    logger.info(`[DashboardApi] Imported nest ${nest.name} (${nest.id})`);
    return nest;
  }

  /**
   * Create `count` nests in one go, each with a unique AUTO_ name.
   * @param {number} count
   * @param {import('../helper/utility/utility.js').default} commonFunction
   * @param {string} [suffix] - Name suffix for readability in reports
   */
  async createNests(count, commonFunction, suffix = 'nest') {
    const created = [];
    for (let i = 0; i < count; i++) {
      created.push(
        await this.createNest(
          commonFunction.generateEntityName(`${suffix}-${i + 1}`),
          `Seeded nest ${i + 1}`
        )
      );
    }
    return created;
  }

  /**
   * Top the account up to at least `target` owned nests — the dashboard's
   * filter bar needs more than 5 and its grid pages at 24, and a shared test
   * account may already carry some.
   * @param {number} target
   * @param {import('../helper/utility/utility.js').default} commonFunction
   * @returns {Promise<{existing: number, created: Array}>}
   */
  async ensureOwnedNests(target, commonFunction) {
    const existing = (await this.listOwnedNests()).length;
    const missing = Math.max(0, target - existing);
    const created = missing > 0 ? await this.createNests(missing, commonFunction, 'seed') : [];
    logger.info(`[DashboardApi] ensureOwnedNests(${target}): had ${existing}, created ${created.length}`);
    return { existing, created };
  }

  /** DELETE /nests/:id — owner only. */
  async deleteNest(nestId) {
    return this.request('DELETE', `/nests/${nestId}`);
  }

  /** POST /nests/:id/archive — owner only. */
  async archiveNest(nestId) {
    return this.expectOk('POST', `/nests/${nestId}/archive`);
  }

  /** POST /nests/:id/restore — owner only. */
  async restoreNest(nestId) {
    return this.expectOk('POST', `/nests/${nestId}/restore`);
  }

  /** POST / DELETE /nests/:id/pin — the caller's own bookmark. */
  async setPinned(nestId, pinned) {
    return this.expectOk(pinned ? 'POST' : 'DELETE', `/nests/${nestId}/pin`);
  }

  /**
   * PATCH /nests/:id/visibility — 'private' | 'org' | 'public'.
   * Public (and org on a shared deployment) needs the acknowledgement flag.
   */
  async setVisibility(nestId, visibility) {
    return this.expectOk('PATCH', `/nests/${nestId}/visibility`, {
      visibility,
      acknowledge_public: true,
    });
  }

  /** PATCH /nests/:id — rename / re-describe. */
  async updateNest(nestId, patch) {
    return this.expectOk('PATCH', `/nests/${nestId}`, patch);
  }

  // ── Sharing ──────────────────────────────────────────────────────────────

  /**
   * POST /nests/:id/collaborators — share with a user by email.
   * @param {string} nestId
   * @param {string} email
   * @param {'read'|'write'|'admin'} permission
   */
  async addCollaborator(nestId, email, permission) {
    return this.expectOk('POST', `/nests/${nestId}/collaborators`, { email, permission });
  }

  /** GET /nests/:id/collaborators — write-tier. */
  async listCollaborators(nestId) {
    const { data } = await this.request('GET', `/nests/${nestId}/collaborators`);
    return data?.collaborators ?? [];
  }

  /** DELETE /nests/:id/collaborators/:collabId — admin only. */
  async removeCollaborator(nestId, collabId) {
    return this.request('DELETE', `/nests/${nestId}/collaborators/${collabId}`);
  }

  /** POST /me/nests/:id/leave — decline an invite / drop own access. */
  async leaveNest(nestId) {
    return this.expectOk('POST', `/me/nests/${nestId}/leave`);
  }

  /**
   * GET /me/notifications — the inbox rows Pending invites is built from.
   * Defaults to `?unread=true`, which is exactly what the dashboard reads.
   * @param {{unread?: boolean}} [opts]
   */
  async notifications({ unread = true } = {}) {
    const { data } = await this.request(
      'GET',
      unread ? '/me/notifications?unread=true' : '/me/notifications'
    );
    return data?.notifications ?? [];
  }

  /** Unread `nest_invite` rows for a given nest. */
  async pendingInvitesFor(nestId) {
    const rows = await this.notifications();
    return rows.filter((n) => n.kind === 'nest_invite' && n.nest_id === nestId && !n.read_at);
  }

  /** POST /me/notifications/read — settle inbox rows by id, or 'all'. */
  async markNotificationsRead(ids) {
    return this.expectOk('POST', '/me/notifications/read', { ids });
  }

  /**
   * Settle the invite a fresh share raised, so the nest leaves Pending invites
   * and lands in the grid — which is where the shared-card tests look for it.
   * @param {string} nestId
   */
  async settleInvitesFor(nestId) {
    const invites = await this.pendingInvitesFor(nestId);
    if (invites.length > 0) {
      await this.markNotificationsRead(invites.map((i) => i.id));
    }
    return invites.length;
  }

  /** Nest ids with an unread `nest_invite` row — excluded from the grid. */
  async pendingInviteNestIds() {
    const rows = await this.notifications();
    return new Set(
      rows.filter((n) => n.kind === 'nest_invite' && !n.read_at).map((n) => n.nest_id)
    );
  }

  // ── Unsynced folders (server-admin only outside open mode) ───────────────

  /** GET /nests/unsynced — folders on disk that aren't registered nests. */
  async listUnsynced() {
    const { ok, data } = await this.request('GET', '/nests/unsynced');
    return ok ? data?.folders ?? [] : [];
  }
}

export default DashboardApi;
