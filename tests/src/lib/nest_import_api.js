/**
 * Nest Import REST Helpers
 *
 * Preconditions for the Nest Import suite — a nest, an existing document, a
 * read-only share — are arranged through the REST API, and the documents the
 * Import dialog created are read back the same way.
 *
 * Extends NewDocumentApi, so the nest, document and cleanup helpers are the
 * same ones: every nest created here is in the entity registry and is deleted
 * after the test (`deleteCreatedNests()`), and the teardown or the next run's
 * orphan sweeper catches anything left behind.
 */

import NewDocumentApi from './new_document_api.js';

class NestImportApi extends NewDocumentApi {
  /** The ids of every document in the nest, sorted ("nodes/guides/setup", …). */
  async documentIds(nestId) {
    return (await this.listDocuments(nestId)).map((d) => d.id).sort();
  }
}

export default NestImportApi;
