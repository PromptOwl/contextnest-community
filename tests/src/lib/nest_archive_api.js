/**
 * Nest Archive REST Helpers
 *
 * Preconditions for the Nest archive suite — nests, a document, a published
 * link, an editor's share and archive requests — are arranged through the REST
 * API, and the outcome (live or archived) is read back the same way.
 *
 * Extends MyWorkApi, so the nest, sharing, document, request and notification
 * helpers are the same ones. Every nest created here is in the entity registry
 * and is remembered by this instance: the suite deletes it after the test
 * (`deleteCreatedNests()`), and the teardown or the next run's orphan sweeper
 * catches anything left behind.
 */

import MyWorkApi from './my_work_api.js';
import { markDeleted } from './entity_registry.js';
import logger from '../helper/logger/logger.js';

class NestArchiveApi extends MyWorkApi {
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

  /**
   * POST /nests/:id/publications — publish one document as a public link.
   * @returns {Promise<string>} The link's absolute URL
   */
  async publishDocument(nestId, nodeId) {
    const data = await this.expectOk('POST', `/nests/${nestId}/publications`, {
      node_id: nodeId,
      access_mode: 'public',
    });
    logger.info(`[NestArchiveApi] Published ${nodeId} at ${data.link}`);
    return data.link;
  }

  /** Whether the nest is in the caller's live nest list. */
  async isLive(nestId) {
    return (await this.listNests()).some((n) => n.id === nestId);
  }

  /** Whether the nest is in the caller's archived list. */
  async isArchived(nestId) {
    return (await this.listNests({ archived: true })).some((n) => n.id === nestId);
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

export default NestArchiveApi;
