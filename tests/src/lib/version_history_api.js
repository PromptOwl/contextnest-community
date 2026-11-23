/**
 * Document Version History REST Helpers
 *
 * Preconditions for the Document Version History suite — documents with
 * several versions, an HTML page, a governed nest with a reviewer, rejected
 * and approved reviews, a pending review, a read-only share — are arranged
 * through the REST API, and what a restore or a discard changed is read back
 * the same way.
 *
 * Extends ReviewQueueApi, so the nest, document, steward, review and cleanup
 * helpers are the same ones: every nest created here is in the entity
 * registry and is deleted after the test (`deleteCreatedNests()`), and the
 * teardown or the next run's orphan sweeper catches anything left behind.
 */

import ReviewQueueApi from './review_queue_api.js';

class VersionHistoryApi extends ReviewQueueApi {
  /** POST /nests/:id/nodes — an HTML page (an "artifact") with the given heading. */
  async createHtmlPage(nestId, { title, heading }) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes`, {
      title,
      type: 'artifact',
      content: VersionHistoryApi.html(heading),
    });
    return data.node;
  }

  /** The HTML body of a page whose only content is `heading`. */
  static html(heading) {
    return `<!DOCTYPE html>\n<html><body><h1>${heading}</h1></body></html>`;
  }

  /** PATCH …/nodes/:nodeId — one more version whose body is `line`. */
  async addVersion(nestId, nodeId, title, line) {
    return this.updateDocument(nestId, nodeId, { content: `# ${title}\n\n${line}\n` });
  }

  /**
   * GET …/nodes/:nodeId/versions — `{ versions, currentVersion, approvedVersion }`.
   * `versions` is newest first; each row carries `version`, `status` and `changeNote`.
   */
  async versions(nestId, nodeId) {
    return this.expectOk('GET', `/nests/${nestId}/nodes/${nodeId}/versions`);
  }

  /** How many versions the document has. */
  async versionCount(nestId, nodeId) {
    return (await this.versions(nestId, nodeId)).versions.length;
  }

  /** The document's current body. */
  async body(nestId, nodeId) {
    const data = await this.expectOk('GET', `/nests/${nestId}/nodes/${nodeId}`);
    return String(data.node?.content ?? '');
  }

  /** POST …/approve with the reviewer's note, which the history shows as "Reviewer note". */
  async approveWithNote(nestId, nodeId, note) {
    return this.expectOk('POST', `/nests/${nestId}/nodes/${nodeId}/approve`, { note });
  }

  /**
   * POST …/reject — a verdict with the (required) reason. `kind` is "reject"
   * (the history reads "Rejected by") or "changes" ("Changes requested by").
   */
  async rejectReview(nestId, nodeId, note, kind = 'reject') {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes/${nodeId}/reject`, { note, kind });
    return data.review;
  }
}

export default VersionHistoryApi;
