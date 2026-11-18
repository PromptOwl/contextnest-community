/**
 * Collaborators REST Helpers
 *
 * Preconditions for the Collaborators suite — nests, shares at each role,
 * teams, visibility, a governed nest — are arranged through the REST API, and
 * what the tab changed is read back the same way. An API-only (headless) key
 * is used the way an outside tool would use it: a plain bearer request with
 * no session cookie.
 *
 * Extends ReviewQueueApi, so the nest, document, steward and cleanup helpers
 * are the same ones: every nest created here is in the entity registry and is
 * deleted after the test (`deleteCreatedNests()`), and the teardown or the next
 * run's orphan sweeper catches anything left behind. Teams created here are
 * remembered and deleted by `deleteCreatedTeams()`.
 */

import ReviewQueueApi from './review_queue_api.js';

/** QA accounts on the server under test that a case may add as a third person. */
const TEST_PERSON = /^qa-[a-z0-9._-]+@example\.com$/i;

class CollaboratorsApi extends ReviewQueueApi {
  /**
   * @param {import('@playwright/test').Page} page - Authenticated page
   */
  constructor(page) {
    super(page);
    /** Ids of the teams this instance created, for deleteCreatedTeams(). */
    this.teamIds = [];
  }

  // ── Sharing ────────────────────────────────────────────────────────────────

  /**
   * POST /nests/:id/collaborators — `{ok, status, data}`, never throws, so a
   * case can tell a plan with no free seats (402) from a real failure.
   */
  async grant(nestId, email, permission) {
    return this.request('POST', `/nests/${nestId}/collaborators`, { email, permission });
  }

  /** The collaborator row for `email`, or null. */
  async collaborator(nestId, email) {
    const rows = await this.listCollaborators(nestId);
    return rows.find((c) => (c.email ?? '').toLowerCase() === email.toLowerCase()) ?? null;
  }

  /** Remove `email` from the nest, if they are on it. */
  async removePerson(nestId, email) {
    const row = await this.collaborator(nestId, email);
    if (row) await this.removeCollaborator(nestId, row.id);
  }

  /** GET /nests/:id/nodes — the documents this caller can see. */
  async listNodes(nestId) {
    const { data } = await this.request('GET', `/nests/${nestId}/nodes`);
    return data?.nodes ?? [];
  }

  /** GET /nests/:id — the HTTP status this caller gets (200 when they can open it). */
  async openStatus(nestId) {
    return (await this.request('GET', `/nests/${nestId}`)).status;
  }

  /** The nest's visibility: 'private', 'org' or 'public'. */
  async visibility(nestId) {
    const { data } = await this.request('GET', `/nests/${nestId}`);
    return data?.nest?.visibility ?? null;
  }

  /** GET /nests/:id/stewards — the steward rows. */
  async stewards(nestId) {
    const { data } = await this.request('GET', `/nests/${nestId}/stewards`);
    return data?.stewards ?? [];
  }

  /** Whether `email` is a nest-wide reviewer steward. */
  async isNestReviewer(nestId, email) {
    return (await this.stewards(nestId)).some(
      (s) =>
        (s.email ?? s.userEmail ?? '').toLowerCase() === email.toLowerCase() &&
        s.role === 'reviewer' &&
        s.scope === 'nest'
    );
  }

  /**
   * A QA account on this server other than the ones in `exclude`, to add as a
   * third person. Only `qa-…@example.com` test accounts qualify, so a real
   * person is never added. Reads the server directory (server admins only);
   * null when there is none or the caller can't read it.
   * @param {string[]} exclude
   */
  async testPerson(exclude = []) {
    const { ok, data } = await this.request('GET', '/auth/teammates');
    if (!ok) return null;
    const skip = new Set(exclude.map((e) => e.toLowerCase()));
    const emails = (data?.teammates ?? [])
      .map((t) => t.email ?? '')
      .filter((e) => TEST_PERSON.test(e) && !skip.has(e.toLowerCase()))
      .sort();
    return emails.find((e) => /^qa-viewer/i.test(e)) ?? emails[0] ?? null;
  }

  // ── Teams ──────────────────────────────────────────────────────────────────

  /** POST /teams — create a team with `email` as a member. Remembered for cleanup. */
  async createTeamWith(name, email, role = 'viewer') {
    const data = await this.expectOk('POST', '/teams', { name });
    this.teamIds.push(data.team.id);
    await this.expectOk('POST', `/teams/${data.team.id}/members`, { email, role });
    return data.team;
  }

  /** POST /nests/:id/teams — share the nest with a team. */
  async shareWithTeam(nestId, teamId) {
    return this.expectOk('POST', `/nests/${nestId}/teams`, { team_id: teamId });
  }

  /** GET /nests/:id/teams — the teams the nest is shared with. */
  async nestTeams(nestId) {
    const { data } = await this.request('GET', `/nests/${nestId}/teams`);
    return data?.teams ?? [];
  }

  /** Delete every team this instance created. */
  async deleteCreatedTeams() {
    for (const id of this.teamIds.splice(0)) {
      await this.request('DELETE', `/teams/${id}`).catch(() => {});
    }
  }

  // ── API-only (headless) keys ───────────────────────────────────────────────

  /**
   * A request made with an API-only key alone — no session cookie, the way
   * ctx or an MCP client would call. Returns the HTTP status.
   */
  async statusWithKey(apiKey, method, urlPath, body = undefined) {
    const res = await fetch(new URL(urlPath, process.env.BASE_URL), {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return res.status;
  }
}

export default CollaboratorsApi;
