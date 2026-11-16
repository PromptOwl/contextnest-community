/**
 * Review Queue REST Helpers
 *
 * Preconditions for the Review Queue suite — a governed nest, stewards of each
 * scope, submitted documents, comments, an agent's change, a seed's admin-only
 * folder — are arranged through the REST API, and what a decision changed is
 * read back the same way.
 *
 * Extends NestDocumentsApi, so the nest, document, review and cleanup helpers
 * are the same ones: every nest created here is in the entity registry and is
 * deleted after the test (`deleteCreatedNests()`), and the teardown or the next
 * run's orphan sweeper catches anything left behind.
 */

import NestDocumentsApi from './nest_documents_api.js';

class ReviewQueueApi extends NestDocumentsApi {
  /**
   * PATCH /nests/:id/settings — turn stewardship on with self-approve off, so
   * a document waits in the queue for someone other than its submitter.
   */
  async governNest(nestId) {
    return this.expectOk('PATCH', `/nests/${nestId}/settings`, {
      stewardship_enabled: true,
      allow_self_approve: false,
    });
  }

  /**
   * POST /nests/:id/stewards — make `email` a steward.
   * @param {string} nestId
   * @param {{email: string, role?: string, scope?: 'nest'|'tag'|'document', tag?: string, nodeId?: string}} steward
   */
  async addSteward(nestId, { email, role = 'reviewer', scope = 'nest', tag, nodeId }) {
    return this.expectOk('POST', `/nests/${nestId}/stewards`, {
      email,
      role,
      scope,
      ...(tag ? { tagName: tag } : {}),
      ...(nodeId ? { nodePattern: nodeId } : {}),
    });
  }

  /** POST …/submit-review with a priority: low, normal, high or urgent. */
  async submitWithPriority(nestId, nodeId, priority) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes/${nodeId}/submit-review`, { priority });
    return data.review;
  }

  /** POST …/approve — publish what is waiting in the queue. */
  async approve(nestId, nodeId) {
    return this.expectOk('POST', `/nests/${nestId}/nodes/${nodeId}/approve`, {});
  }

  /** GET /nests/:id/review-queue — the rows, each with the caller's `canReview`. */
  async reviewQueue(nestId) {
    const data = await this.expectOk('GET', `/nests/${nestId}/review-queue`);
    return data.requests;
  }

  /**
   * POST …/annotations — open a whole-document comment thread.
   * @returns {Promise<{id: string}>} The thread
   */
  async addComment(nestId, nodeId, body) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes/${nodeId}/annotations`, { body });
    return data.thread;
  }

  /** POST /nests/:id/nodes — a document whose write names an agent as its client. */
  async createAgentDocument(nestId, { title, agent }) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes`, {
      title,
      content: `# ${title}\n\nWritten by ${agent}.\n`,
      client: { agent },
    });
    return data.node;
  }

  /**
   * POST /surfaces/seeds/apply — apply the bundled generic-team seed, which
   * makes `agents/` an admin-only folder.
   * @returns {Promise<boolean>} False when this server doesn't offer seeds
   */
  async applyGenericTeamSeed(nestId) {
    const res = await this.request('POST', '/surfaces/seeds/apply', {
      nest_id: nestId,
      seed_id: 'generic-team',
    });
    return res.ok;
  }
}

export default ReviewQueueApi;
