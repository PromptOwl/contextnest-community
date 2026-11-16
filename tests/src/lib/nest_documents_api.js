/**
 * Nest Documents REST Helpers
 *
 * Preconditions for the Nest Documents suite — folders, tagged and typed
 * documents, a governed nest, editor and read-only shares, an archived nest —
 * are arranged through the REST API, and what the Documents tab changed is read
 * back the same way.
 *
 * Extends NestOverviewApi, so the nest, folder, document and cleanup helpers
 * are the same ones: every nest created here is in the entity registry and is
 * deleted after the test (`deleteCreatedNests()`), and the teardown or the next
 * run's orphan sweeper catches anything left behind.
 */

import NestOverviewApi from './nest_overview_api.js';

class NestDocumentsApi extends NestOverviewApi {
  /**
   * POST /nests/:id/nodes — a document with optional tags, type and folder.
   * The body carries "Body of <title>." so a search can find it by content.
   */
  async createDoc(nestId, { title, tags, type, folder, content }) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes`, {
      title,
      content: content ?? `# ${title}\n\nBody of ${title}.\n`,
      ...(tags ? { tags } : {}),
      ...(type ? { type } : {}),
      ...(folder ? { folder } : {}),
    });
    return data.node;
  }

  /** The ids of every document in the nest, sorted ("nodes/guides/gamma-guide", …). */
  async documentIds(nestId) {
    return (await this.listDocuments(nestId)).map((d) => d.id).sort();
  }

  /** A document's tags ("#qa-bulk", …), or null when it is gone. */
  async tagsOf(nestId, nodeId) {
    const doc = (await this.listDocuments(nestId)).find((d) => d.id === nodeId);
    return doc ? (doc.tags ?? []) : null;
  }
}

export default NestDocumentsApi;
