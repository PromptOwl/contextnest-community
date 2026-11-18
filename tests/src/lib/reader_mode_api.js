/**
 * Reader Mode REST Helpers
 *
 * Preconditions for the Reader Mode suite — a nest with a home page and a
 * second page, its visibility, Reader mode on or off, and a share at a given
 * role — are arranged through the REST API, and what the "Public Docs Reader
 * Mode" dialog saved is read back the same way.
 *
 * Extends NestSettingsApi, so the nest, document, share and cleanup helpers are
 * the same ones: every nest created here is in the entity registry and is
 * deleted after the test (`deleteCreatedNests()`), and the teardown or the next
 * run's orphan sweeper catches anything left behind.
 */

import NestSettingsApi from './nest_settings_api.js';

class ReaderModeApi extends NestSettingsApi {
  /** GET /nests/:id — whether Reader mode is on and its home document. */
  async readerMode(nestId) {
    const { data } = await this.request('GET', `/nests/${nestId}`);
    const nest = data?.nest ?? data ?? {};
    return { enabled: !!nest.reader_mode, homeNode: nest.reader_home_node ?? null };
  }

  /** PATCH /nests/:id/reader-mode — turn Reader mode on or off. */
  async setReaderMode(nestId, enabled) {
    return this.expectOk('PATCH', `/nests/${nestId}/reader-mode`, { enabled });
  }

  /** PATCH /nests/:id/reader-mode as this caller — `{ok, status, data}`, never throws. */
  async tryReaderMode(nestId, enabled) {
    return this.request('PATCH', `/nests/${nestId}/reader-mode`, { enabled });
  }

  /**
   * PATCH /nests/:id/collaborators/:collabId — change `email`'s role.
   * `{ok, status, data}`, never throws, so a case can skip on a full plan (402).
   */
  async setPermission(nestId, email, permission) {
    const row = await this.collaborator(nestId, email);
    if (!row) return { ok: false, status: 404, data: { error: `${email} is not on the nest` } };
    return this.request('PATCH', `/nests/${nestId}/collaborators/${row.id}`, { permission });
  }
}

export default ReaderModeApi;
