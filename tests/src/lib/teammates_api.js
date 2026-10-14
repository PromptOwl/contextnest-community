/**
 * Teammates REST Helpers
 *
 * Read-only lookups for the Teammates suite: the directory the page lists
 * (`GET /auth/teammates`), who is a super admin and where that comes from
 * (`GET /admin/super-admins`), and whether the caller is a server admin
 * (`GET /auth/admin-status`). The suite never writes users through here — the
 * page's writes act on real accounts and are answered by teammates_stubs.js
 * instead.
 *
 * Extends DashboardApi, so `request` / `expectOk` and the nest helpers are the
 * same ones.
 */

import DashboardApi from './dashboard_api.js';

class TeammatesApi extends DashboardApi {
  /** GET /auth/teammates — `{ teammates, pending_stewards }` (server admins only). */
  async listTeammates() {
    return this.expectOk('GET', '/auth/teammates');
  }

  /** GET /admin/super-admins — `{ super_admins: [{ email, source, granted_by, granted_at, self }] }`. */
  async listSuperAdmins() {
    return this.expectOk('GET', '/admin/super-admins');
  }

  /** GET /auth/admin-status — `{ me: { email, name, is_admin }, … }`. */
  async adminStatus() {
    return this.expectOk('GET', '/auth/admin-status');
  }

  /** True when the caller may open the Teammates page. */
  async isServerAdmin() {
    const { data } = await this.request('GET', '/auth/admin-status');
    return data?.me?.is_admin === true;
  }
}

export default TeammatesApi;
