/**
 * Stewards REST Helpers
 *
 * Preconditions for the Assign Steward suite — stewardship on or off, steward
 * rows at nest, tag or document scope, documents waiting for review, shares
 * and an archived nest — are arranged through the REST API, and what the UI
 * saved (steward rows, document status, review history) is read back the
 * same way.
 *
 * Extends FieldsApi, so the nest, document, share, steward and cleanup
 * helpers are the same ones: every nest created here is in the entity registry
 * and is deleted after the test (`deleteCreatedNests()`), and the teardown or
 * the next run's orphan sweeper catches anything left behind. Steward rows,
 * documents and reviews live inside those nests and go with them.
 */

import FieldsApi from './fields_api.js';

class StewardsApi extends FieldsApi {
  // ── Stewardship ────────────────────────────────────────────────────────────

  /** PATCH /nests/:id/settings — stewardship on (owner/admin edits still need review) or off. */
  async setStewardship(nestId, on) {
    return this.expectOk('PATCH', `/nests/${nestId}/settings`, {
      stewardship_enabled: on,
      ...(on ? { allow_self_approve: false } : {}),
    });
  }

  // ── Steward rows ───────────────────────────────────────────────────────────

  /**
   * The nest's steward rows ({id, userEmail, scope, role, tagName,
   * nodePattern}). GET /nests/:id/stewards; the owner is not a row.
   */
  async stewardRows(nestId) {
    return this.stewards(nestId);
  }

  /** A person's steward row, or null. */
  async stewardOf(nestId, email) {
    return (
      (await this.stewardRows(nestId)).find(
        (s) => (s.userEmail ?? '').toLowerCase() === email.toLowerCase()
      ) ?? null
    );
  }

  /** PATCH /nests/:id/stewards/:stewardId — change a row's role and/or scope. */
  async updateSteward(nestId, stewardId, { role, scope, tag, nodeId }) {
    return this.expectOk('PATCH', `/nests/${nestId}/stewards/${stewardId}`, {
      ...(role ? { role } : {}),
      ...(scope ? { scope } : {}),
      ...(tag ? { tagName: tag } : {}),
      ...(nodeId ? { nodePattern: nodeId } : {}),
    });
  }

  /** DELETE /nests/:id/stewards/:stewardId — `{ok, status, data}`, never throws. */
  async removeSteward(nestId, stewardId) {
    return this.request('DELETE', `/nests/${nestId}/stewards/${stewardId}`);
  }

  // ── QA test accounts ───────────────────────────────────────────────────────

  /** The QA test accounts (qa-…@example.com) in the server's directory, qa-viewer first. */
  async testPeople(exclude = []) {
    const { ok, data } = await this.request('GET', '/auth/teammates');
    if (!ok) return [];
    const skip = new Set(exclude.map((e) => e.toLowerCase()));
    const emails = (data?.teammates ?? [])
      .map((t) => t.email ?? '')
      .filter((e) => /^qa-[a-z0-9._-]+@example\.com$/i.test(e) && !skip.has(e.toLowerCase()))
      .sort();
    return [...emails.filter((e) => /^qa-viewer/i.test(e)), ...emails.filter((e) => !/^qa-viewer/i.test(e))];
  }

  /**
   * A QA test account that is still on the free (Viewer) seat, so making it a
   * Reviewer raises the billing step. Asked of the server directly: for a
   * free account, POST …/stewards answers 409 "raises what someone is billed"
   * and assigns nothing. An account already on a paid seat (it holds an owner,
   * admin or reviewer role in some other nest) is assigned at once — that row
   * is removed again and the next account is tried. Null when none is free.
   */
  async freeTestPerson(nestId, exclude = []) {
    for (const email of await this.testPeople(exclude)) {
      const res = await this.request('POST', `/nests/${nestId}/stewards`, { email, role: 'reviewer', scope: 'nest' });
      if (res.status === 409 && /billed/i.test(res.data?.error ?? '')) return email;
      if (res.ok && res.data?.steward?.id) await this.removeSteward(nestId, res.data.steward.id);
    }
    return null;
  }

  // ── Documents and reviews ──────────────────────────────────────────────────

  /** Create a document and submit it for review; returns the node. */
  async createPendingDoc(nestId, { title, tags }) {
    const doc = await this.createDoc(nestId, { title, tags });
    await this.submitForReview(nestId, doc.id);
    return doc;
  }

  /** A document's status ("draft", "pending_review", "published", "rejected"). */
  async statusOf(nestId, nodeId) {
    return (await this.node(nestId, nodeId))?.status ?? null;
  }

  /** Whether this caller may approve the document now (GET …/can-approve). */
  async canApprove(nestId, nodeId) {
    const { data } = await this.request(
      'GET',
      `/nests/${nestId}/nodes/${encodeURIComponent(nodeId)}/can-approve`
    );
    return data?.allowed === true;
  }

  /** The document's review history, newest first. */
  async reviews(nestId, nodeId) {
    const { data } = await this.request(
      'GET',
      `/nests/${nestId}/nodes/${encodeURIComponent(nodeId)}/reviews`
    );
    return [...(data?.reviews ?? [])].sort((a, b) =>
      String(b.requestedAt).localeCompare(String(a.requestedAt))
    );
  }
}

export default StewardsApi;
