/**
 * Teams REST Helpers
 *
 * Preconditions for the Teams suite — teams and their members — are arranged
 * through the REST API, the same way dashboard_api.js arranges nests. Teams
 * are not in the entity registry (it tracks nests and documents only), so
 * every team made here is remembered and deleted by `deleteCreatedTeams()`,
 * which the suite calls after each test.
 *
 * Extends DashboardApi, so `request` / `expectOk` and the nest helpers are the
 * same ones.
 */

import DashboardApi from './dashboard_api.js';
import logger from '../helper/logger/logger.js';

class TeamsApi extends DashboardApi {
  constructor(page) {
    super(page);
    /** @type {string[]} */
    this.createdTeamIds = [];
  }

  /** GET /teams — `{ teams }` for the caller. */
  async listTeams() {
    return this.expectOk('GET', '/teams');
  }

  /**
   * POST /teams — create a team with a name only. Remembered for cleanup.
   * @param {string} name - Use an AUTO_ name (commonFunction.generateEntityName)
   */
  async createTeam(name) {
    const data = await this.expectOk('POST', '/teams', { name });
    this.createdTeamIds.push(data.team.id);
    logger.info(`[TeamsApi] Created team ${name} (${data.team.id})`);
    return data.team;
  }

  /** Remember a team created through the UI, so cleanup removes it too. */
  track(teamId) {
    if (teamId && !this.createdTeamIds.includes(teamId)) this.createdTeamIds.push(teamId);
  }

  /** POST /teams/:id/members — add someone by email. */
  async addMember(teamId, email, role = 'viewer') {
    return this.expectOk('POST', `/teams/${teamId}/members`, { email, role });
  }

  /** DELETE /teams/:id — `{ok, status, data}`, never throws. */
  async deleteTeam(teamId) {
    return this.request('DELETE', `/teams/${teamId}`);
  }

  /** Delete every team this helper created or was told about. */
  async deleteCreatedTeams() {
    for (const id of this.createdTeamIds.splice(0)) {
      const res = await this.deleteTeam(id);
      if (!res.ok && res.status !== 404) {
        logger.warn(`[TeamsApi] Could not delete team ${id}: HTTP ${res.status}`);
      }
    }
  }
}

export default TeamsApi;
