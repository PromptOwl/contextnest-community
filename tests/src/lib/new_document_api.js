/**
 * New Document REST Helpers
 *
 * Preconditions for the New Document suite — a nest, a seeded document or
 * folder, the governance posture — are arranged through the REST API, and
 * what the editor created is read back the same way.
 *
 * Extends MyWorkApi, so the nest, document and settings helpers are the same
 * ones. Every nest created here is in the entity registry and is remembered by
 * this instance: the suite deletes it after the test (`deleteCreatedNests()`),
 * and the teardown or the next run's orphan sweeper catches anything left
 * behind. Documents live inside those nests and go with them.
 */

import MyWorkApi from './my_work_api.js';
import { markDeleted } from './entity_registry.js';

class NewDocumentApi extends MyWorkApi {
  /**
   * @param {import('@playwright/test').Page} page - Authenticated page
   */
  constructor(page) {
    super(page);
    /** Ids of the nests this instance created, for deleteCreatedNests(). */
    this.nestIds = new Set();
  }

  /** POST /nests — create, register and remember for deleteCreatedNests(). */
  async createNest(name, description = '') {
    const nest = await super.createNest(name, description);
    this.nestIds.add(nest.id);
    return nest;
  }

  /** GET /nests/:id/nodes — every document the nest lists. */
  async listDocuments(nestId) {
    const data = await this.expectOk('GET', `/nests/${nestId}/nodes`);
    return data?.nodes ?? [];
  }

  /** GET /nests/:id/nodes/:nodeId — the document, or null when there is none. */
  async findDocument(nestId, nodeId) {
    const { ok, data } = await this.getNode(nestId, nodeId);
    return ok ? (data?.node ?? null) : null;
  }

  /**
   * PATCH /nests/:id/settings — stewardship on, with neither bypass: the
   * owner's own edits don't auto-publish and a creator doesn't review their
   * own documents, so a new document is saved as a draft.
   */
  async requireReview(nestId) {
    return this.expectOk('PATCH', `/nests/${nestId}/settings`, {
      stewardship_enabled: true,
      allow_self_approve: false,
      creator_is_reviewer: false,
    });
  }

  /** Delete every nest this instance created, and mark it deleted in the registry. */
  async deleteCreatedNests() {
    for (const id of this.nestIds) {
      const res = await this.request('DELETE', `/nests/${id}`).catch(() => null);
      // 404 means it's already gone — that's a successful cleanup.
      if (res && (res.ok || res.status === 404)) markDeleted('nests', id);
    }
    this.nestIds.clear();
  }
}

export default NewDocumentApi;
