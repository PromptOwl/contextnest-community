/**
 * My Work REST Helpers
 *
 * Preconditions for the My Work suite — documents, pending reviews, deletion
 * and archive requests — are arranged through the REST API, the same way
 * dashboard_api.js arranges nests. My Work is an inbox: what it shows is what
 * *other people* asked of the caller, so most of it has to be raised by a
 * second account before the page under test has anything to render.
 *
 * Extends DashboardApi, so the nest, sharing and notification helpers (and the
 * entity-registry bookkeeping in `createNest`) are the same ones.
 */

import DashboardApi from './dashboard_api.js';
import logger from '../helper/logger/logger.js';

class MyWorkApi extends DashboardApi {
  // ── The inbox itself ─────────────────────────────────────────────────────

  /**
   * GET /me/work — `{ items, waiting, notifications, pagination }`.
   * @param {{limit?: number, offset?: number}} [opts]
   */
  async myWork({ limit, offset } = {}) {
    const query = new URLSearchParams();
    if (limit != null) query.set('limit', String(limit));
    if (offset != null) query.set('offset', String(offset));
    const qs = query.toString();
    return this.expectOk('GET', `/me/work${qs ? `?${qs}` : ''}`);
  }

  /**
   * What the My Work rail badge shows for a /me/work response, the same sum as
   * `waitingOnMeCount` in ui/src/lib/my-work-groups.ts: the reviews and
   * requests waiting on the caller (`waiting_on_me_total`, which leaves out
   * what they handed off — CU-wdqcq0658p), plus the open tasks assigned to
   * them (CU-wdqcq05jg8), plus their unread notifications (CU-wdqcpzy4z6).
   * `assigned` and `notifications` are not paged, so a one-row read carries
   * all of them.
   */
  static waitingOnMe(work) {
    return (
      (work?.waiting_on_me_total ?? work?.pagination?.total ?? 0) +
      (work?.assigned?.length ?? 0) +
      (work?.notifications?.length ?? 0)
    );
  }

  /**
   * Poll /me/work until `predicate(work)` holds, and return that response.
   *
   * Needed because "can this caller approve in that nest?" is cached
   * server-side for 30 seconds: any page that drew the rail between the nest
   * being created and self-approve being switched on (the dashboard suite runs
   * alongside this one) pins the answer to "no" until the entry expires, and a
   * freshly submitted review stays out of the inbox for that long.
   *
   * @param {(work: any) => boolean} predicate
   * @param {{timeout?: number, what?: string}} [opts]
   */
  async waitForWork(predicate, { timeout = 45000, what = 'the expected rows' } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const work = await this.myWork();
      if (predicate(work)) return work;
      if (Date.now() > deadline) {
        throw new Error(`/me/work never showed ${what} within ${timeout}ms`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // ── Nest governance ──────────────────────────────────────────────────────

  /**
   * PATCH /nests/:id/settings — with self-approve on, the owner can approve
   * what collaborators submit, which is what puts reviews in their inbox.
   */
  async setSelfApprove(nestId, on) {
    return this.expectOk('PATCH', `/nests/${nestId}/settings`, { allow_self_approve: on });
  }

  /**
   * Give `email` the right to write in a nest, so it can submit documents for
   * review and raise deletion requests there.
   *
   * An editor ('write') is the natural grant, but editors are a paid seat class
   * and a plan without them answers 402 — an admin collaborator raises exactly
   * the same requests, so that is the fallback.
   *
   * @returns {Promise<string>} The permission the collaborator holds
   */
  async shareForAuthoring(nestId, email) {
    // Sharing twice is a 409, and the nest is reused across the suite's tests.
    const existing = (await this.listCollaborators(nestId)).find(
      (c) => (c.email ?? '').toLowerCase() === email.toLowerCase()
    );
    if (existing) return existing.permission;

    const asEditor = await this.request('POST', `/nests/${nestId}/collaborators`, {
      email,
      permission: 'write',
    });
    if (asEditor.ok) return 'write';
    if (asEditor.status !== 402) {
      throw new Error(
        `POST /nests/${nestId}/collaborators → HTTP ${asEditor.status}${
          asEditor.data?.error ? ` (${asEditor.data.error})` : ''
        }`
      );
    }
    logger.info('[MyWorkApi] No editor seats on this plan — sharing as admin instead');
    await this.addCollaborator(nestId, email, 'admin');
    return 'admin';
  }

  // ── Documents ────────────────────────────────────────────────────────────

  /**
   * POST /nests/:id/nodes — create a document. Not registered for cleanup on
   * its own: it lives in a registered nest and goes when the nest does.
   * @param {string} nestId
   * @param {{title: string, content?: string, folder?: string}} doc
   */
  async createDocument(nestId, { title, content, folder }) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes`, {
      title,
      content: content ?? `# ${title}\n\nSeeded by the My Work suite.\n`,
      ...(folder ? { folder } : {}),
    });
    return data.node;
  }

  /**
   * POST /nests/:id/nodes — create an open board task assigned to `assignee`.
   * An open task assigned to the caller lists under My Work's `assigned` rows
   * and counts toward the rail badge (API.md, "Assigned rows").
   * @param {string} nestId
   * @param {{title: string, assignee: string}} task
   */
  async createTask(nestId, { title, assignee }) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes`, {
      title,
      type: 'task',
      tags: ['doing'],
      assignee,
      content: `# ${title}\n\nSeeded by the My Work suite.\n`,
    });
    return data.node;
  }

  /** DELETE /nests/:id/nodes/:nodeId — remove a seeded document or task. */
  async deleteNode(nestId, nodeId) {
    return this.request('DELETE', `/nests/${nestId}/nodes/${nodeId}`);
  }

  /** GET /nests/:id/nodes/:nodeId — `{ok, status, data}`; 404 once deleted. */
  async getNode(nestId, nodeId) {
    return this.request('GET', `/nests/${nestId}/nodes/${nodeId}`);
  }

  /** The document's lifecycle status ('draft', 'pending_review', 'rejected', …). */
  async nodeStatus(nestId, nodeId) {
    const { data } = await this.getNode(nestId, nodeId);
    return data?.node?.status ?? null;
  }

  // ── Reviews ──────────────────────────────────────────────────────────────

  /** POST …/submit-review — the caller becomes the review's requester. */
  async submitForReview(nestId, nodeId, note = undefined) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes/${nodeId}/submit-review`, {
      ...(note ? { note } : {}),
    });
    return data.review;
  }

  /** POST …/cancel-review — the submitter's own undo; back to Draft. */
  async cancelReview(nestId, nodeId) {
    return this.request('POST', `/nests/${nestId}/nodes/${nodeId}/cancel-review`);
  }

  /**
   * GET …/nodes/:nodeId/reviews — the document's most recent review request,
   * with its verdict (`status`, `resolvedBy`, `resolutionNote`) once resolved.
   */
  async latestReview(nestId, nodeId) {
    const { data } = await this.request('GET', `/nests/${nestId}/nodes/${nodeId}/reviews`);
    const history = [...(data?.reviews ?? [])].sort((a, b) =>
      String(b.requestedAt).localeCompare(String(a.requestedAt))
    );
    return history[0] ?? null;
  }

  // ── Deletion / archive requests ──────────────────────────────────────────

  /** POST …/nodes/:nodeId/request-deletion — flag one document. */
  async requestDocumentDeletion(nestId, nodeId, reason) {
    const data = await this.expectOk(
      'POST',
      `/nests/${nestId}/nodes/${nodeId}/request-deletion`,
      { reason }
    );
    return data.request;
  }

  /**
   * POST /nests/:id/request-deletion — flag a folder or the nest itself.
   * @param {string} nestId
   * @param {'folder'|'nest'|'nest_archive'} targetType
   * @param {string} reason
   * @param {string} [target] - Folder path (folder requests only)
   */
  async requestNestDeletion(nestId, targetType, reason, target = undefined) {
    const data = await this.expectOk('POST', `/nests/${nestId}/request-deletion`, {
      targetType,
      reason,
      ...(target ? { target } : {}),
    });
    return data.request;
  }

  /** GET /nests/:id/deletion-requests?status=pending|declined|all */
  async deletionRequests(nestId, status = 'pending') {
    const { data } = await this.request(
      'GET',
      `/nests/${nestId}/deletion-requests?status=${status}`
    );
    return data?.requests ?? [];
  }

  /** POST …/deletion-requests/:id/withdraw — the requester takes it back. */
  async withdrawDeletionRequest(nestId, requestId) {
    return this.request('POST', `/nests/${nestId}/deletion-requests/${requestId}/withdraw`);
  }

  // ── Notifications ────────────────────────────────────────────────────────

  /** Whether a notification is still in the caller's unread inbox. */
  async isNotificationUnread(notificationId) {
    return (await this.notifications()).some((n) => n.id === notificationId);
  }

  /**
   * Mark read every unread notification a nest raised for this caller — by
   * id, never 'all', so the account's real inbox is left exactly as it was.
   */
  async settleNotificationsFor(nestId) {
    const mine = (await this.notifications()).filter((n) => n.nest_id === nestId);
    if (mine.length > 0) await this.markNotificationsRead(mine.map((n) => n.id));
    return mine.length;
  }
}

export default MyWorkApi;
