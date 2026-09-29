/**
 * App Shell Page Object Model
 *
 * Page location: ui/src/App.tsx
 *
 * Covers the chrome shared by every authenticated view: the header
 * breadcrumb, global search, sidebar rail and the user menu (account /
 * logout). Individual pages get their own page objects; this one is for
 * everything around them.
 */

import logger from '../../helper/logger/logger.js';

class AppShellPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // Header chrome (ui/src/App.tsx)
    this.breadcrumb = page.getByTestId('header-breadcrumb');
    this.globalSearchTrigger = page.getByTestId('global-search-trigger');
    this.sidebarExpand = page.getByTestId('nest-sidebar-expand');

    // User menu
    this.userMenuTrigger = page.getByTestId('user-menu-trigger');
    this.userMenuAccount = page.getByTestId('user-menu-account');
    this.userMenuLogout = page.getByTestId('user-menu-logout');
  }

  /**
   * Navigate to the app root (nests dashboard for an authenticated session)
   */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to app root`);
    await this.page.goto('/');
    await this.userMenuTrigger.waitFor({ state: 'visible' });
    logger.info('App shell loaded');
  }

  /**
   * Whether the authenticated app shell is rendered (vs the login screen)
   * @returns {Promise<boolean>}
   */
  async isLoggedIn() {
    try {
      return await this.userMenuTrigger.isVisible({ timeout: 5000 });
    } catch (_) {
      return false;
    }
  }

  /**
   * Open the user menu dropdown
   */
  async openUserMenu() {
    logger.info('Opening user menu');
    await this.userMenuTrigger.click();
    await this.userMenuLogout.waitFor({ state: 'visible' });
  }

  /**
   * Log out via the user menu. Afterwards the login screen renders again.
   */
  async logout() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Logging out`);
    await this.openUserMenu();
    await this.userMenuLogout.click();
    logger.info('Logged out');
  }
}

export default AppShellPage;
