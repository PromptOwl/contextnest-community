/**
 * Nest Overview REST Helpers
 *
 * Preconditions for the Nest Overview suite — folders, documents of each type,
 * edits, a governed nest, a read-only share, an archived nest — are arranged
 * through the REST API, and what the Overview changed is read back the same way.
 *
 * Extends NewFolderApi, so the nest, folder and cleanup helpers are the same
 * ones: every nest created here is in the entity registry and is deleted after
 * the test (`deleteCreatedNests()`), and the teardown or the next run's orphan
 * sweeper catches anything left behind.
 */

import NewFolderApi from './new_folder_api.js';

class NestOverviewApi extends NewFolderApi {
  /** POST /nests/:id/folders — an empty folder ("notes", "guides/advanced"). */
  async createFolder(nestId, folder) {
    return this.expectOk('POST', `/nests/${nestId}/folders`, { folder });
  }

  /**
   * POST /nests/:id/nodes — a document, optionally of another type
   * ("artifact", "agent", "skill", "task") and in a folder.
   */
  async createTypedDocument(nestId, { title, type, folder, content }) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes`, {
      title,
      content: content ?? `# ${title}\n\nSeeded by the Nest Overview suite.\n`,
      ...(type ? { type } : {}),
      ...(folder ? { folder } : {}),
    });
    return data.node;
  }

  /** PATCH /nests/:id/nodes/:nodeId — edit a document. */
  async updateDocument(nestId, nodeId, patch) {
    const data = await this.expectOk('PATCH', `/nests/${nestId}/nodes/${nodeId}`, patch);
    return data.node;
  }
}

export default NestOverviewApi;
