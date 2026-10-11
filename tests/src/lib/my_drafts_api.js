/**
 * My Drafts REST Helpers
 *
 * Preconditions for the My Drafts suite — drafts, rejected drafts and drafts
 * on top of an approved version — are arranged through the REST API, the same
 * way my_work_api.js arranges reviews. A draft is the caller's own unreviewed
 * work, so one account is enough: the suite's nest is governed (stewardship
 * on) with self-approve off, which makes every document its owner writes land
 * as a draft instead of publishing.
 *
 * Extends MyWorkApi, so the nest, document and review helpers (and the
 * entity-registry bookkeeping in `createNest`) are the same ones.
 */

import MyWorkApi from './my_work_api.js';

class MyDraftsApi extends MyWorkApi {
  // ── The list itself ──────────────────────────────────────────────────────

  /**
   * GET /me/drafts — `{ drafts, pagination }`.
   * @param {{limit?: number, offset?: number, q?: string, sort?: 'updated'|'title'}} [opts]
   */
  async myDrafts({ limit, offset, q, sort } = {}) {
    const query = new URLSearchParams();
    if (limit != null) query.set('limit', String(limit));
    if (offset != null) query.set('offset', String(offset));
    if (q) query.set('q', q);
    if (sort) query.set('sort', sort);
    const qs = query.toString();
    return this.expectOk('GET', `/me/drafts${qs ? `?${qs}` : ''}`);
  }

  /** Whether the caller's draft list (searched by `q`) holds this document. */
  async isDraft(nodeId, q) {
    const { drafts } = await this.myDrafts({ q, limit: 100 });
    return drafts.some((d) => d.node_id === nodeId);
  }

  // ── Nest governance ──────────────────────────────────────────────────────

  /**
   * PATCH /nests/:id/settings — stewardship and self-approve together.
   * Stewardship on + self-approve off is what makes the owner's writes drafts;
   * self-approve on lets the owner publish (or reject) their own work.
   * @param {string} nestId
   * @param {{stewardship?: boolean, selfApprove?: boolean}} posture
   */
  async setGovernance(nestId, { stewardship, selfApprove }) {
    return this.expectOk('PATCH', `/nests/${nestId}/settings`, {
      ...(stewardship !== undefined ? { stewardship_enabled: stewardship } : {}),
      ...(selfApprove !== undefined ? { allow_self_approve: selfApprove } : {}),
    });
  }

  // ── Documents ────────────────────────────────────────────────────────────

  /** PATCH /nests/:id/nodes/:nodeId — edit a document (a draft, when governed). */
  async updateDocument(nestId, nodeId, patch) {
    const data = await this.expectOk('PATCH', `/nests/${nestId}/nodes/${nodeId}`, patch);
    return data.node;
  }

  /**
   * POST …/discard — throw the draft away: back to the last approved version,
   * or deleted when there never was one. `{ok, status, data}`, never throws.
   */
  async discardDraft(nestId, nodeId) {
    return this.request('POST', `/nests/${nestId}/nodes/${nodeId}/discard`, {});
  }

  // ── Reviews ──────────────────────────────────────────────────────────────

  /** POST …/reject — a verdict with the (required) feedback note. */
  async rejectReview(nestId, nodeId, note) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes/${nodeId}/reject`, { note });
    return data.review;
  }
}

export default MyDraftsApi;
