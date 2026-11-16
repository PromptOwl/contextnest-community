/**
 * New Folder REST Helpers
 *
 * Preconditions for the New Folder suite — a nest with a seeded document in a
 * folder, a read-only share, an archived nest — are arranged through the REST
 * API, and the folders the dialog created are read back the same way.
 *
 * Extends NewDocumentApi, so the nest, document and cleanup helpers are the
 * same ones: every nest created here is in the entity registry and is deleted
 * after the test (`deleteCreatedNests()`), and the teardown or the next run's
 * orphan sweeper catches anything left behind.
 */

import NewDocumentApi from './new_document_api.js';

class NewFolderApi extends NewDocumentApi {
  /** GET /nests/:id/folders — every folder path with its document counts. */
  async listFolders(nestId) {
    const data = await this.expectOk('GET', `/nests/${nestId}/folders`);
    return data?.folders ?? [];
  }

  /** The folder paths alone, sorted ("alpha", "gtm", "gtm/deals"). */
  async folderPaths(nestId) {
    return (await this.listFolders(nestId)).map((f) => f.path).sort();
  }

  /**
   * The titles of the documents directly in `folder`. A document's id is its
   * path ("nodes/alpha/alpha-one"), so its folder is everything before the
   * last segment.
   */
  async documentTitlesIn(nestId, folder) {
    const docs = await this.listDocuments(nestId);
    return docs.filter((d) => d.id.slice(0, d.id.lastIndexOf('/')) === `nodes/${folder}`).map((d) => d.title);
  }
}

export default NewFolderApi;
