/**
 * Import Folder REST Helpers
 *
 * Reads what an import through the dialog produced (the new nest and its
 * documents) and removes it afterwards. The dialog names a nest after the
 * folder or zip it was given, so every fixture is named with an AUTO_ name
 * (`commonFunction.generateEntityName()`), and each nest found here is put in
 * the entity registry: the suite deletes it after the test, and the teardown
 * or the next run's orphan sweeper catches anything left behind.
 */

import { registerEntity, markDeleted } from './entity_registry.js';
import logger from '../helper/logger/logger.js';

class ImportFolderApi {
  /**
   * @param {import('@playwright/test').Page} page - Authenticated page
   */
  constructor(page) {
    this.page = page;
    /** Ids of the nests this instance found, for deleteImportedNests(). */
    this.nestIds = new Set();
  }

  async request(method, urlPath, body = undefined) {
    const response = await this.page.request.fetch(urlPath, {
      method,
      ...(body !== undefined ? { data: body } : {}),
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

  /** Every nest the caller can see with exactly this name. */
  async nestsNamed(name) {
    const { data } = await this.request('GET', '/nests');
    return (data?.nests ?? []).filter((n) => n.name === name);
  }

  /**
   * The nest an import created, by name — registered for cleanup. Null when
   * there is none.
   */
  async importedNest(name) {
    const [nest] = await this.nestsNamed(name);
    if (!nest) return null;
    if (!this.nestIds.has(nest.id)) {
      this.nestIds.add(nest.id);
      registerEntity('nests', { id: nest.id, name: nest.name });
      logger.info(`[ImportFolderApi] Imported nest ${nest.name} (${nest.id})`);
    }
    return nest;
  }

  /** The nest's documents: `{ id, title, tags, status, version }`, sorted by id. */
  async documents(nestId) {
    const { data } = await this.request('GET', `/nests/${nestId}/nodes?limit=200`);
    const list = data?.nodes ?? data?.items ?? [];
    return list
      .map((n) => ({ id: n.id, title: n.title, tags: n.tags ?? [], status: n.status, version: n.version }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Delete every nest this instance found, and mark it deleted in the registry. */
  async deleteImportedNests() {
    for (const id of this.nestIds) {
      const res = await this.request('DELETE', `/nests/${id}`).catch(() => null);
      // 404 means it's already gone — that's a successful cleanup.
      if (res && (res.ok || res.status === 404)) markDeleted('nests', id);
    }
    this.nestIds.clear();
  }
}

export default ImportFolderApi;
