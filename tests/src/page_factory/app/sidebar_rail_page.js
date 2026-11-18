/**
 * Sidebar Rail Page Object Model — the app's navigation since #582
 *
 * #582 (Review flow) split the old four-group rail (Work / Workspace / Admin /
 * Help) into three places:
 *
 * - The left rail (ui/src/components/DocumentSidebar.tsx): brand, "Hide
 *   sidebar", the "work" pages that are not in the header (Stream, Control
 *   room, when the server shows them), "All nests", the nest list, and the
 *   footer (Docs, the account menu). My Work and My Drafts are rail rows too,
 *   but only below the md breakpoint (the phone drawer).
 * - The header ribbon (ui/src/components/HeaderRibbon.tsx, nav "Workspace"):
 *   My Work and My Drafts, from tablet width up.
 * - Workspace settings (ui/src/components/SettingsShell.tsx): a page with its
 *   own left nav, opened from the account menu's "Settings". It lists Teams
 *   and API keys for everyone, Connected apps when MCP sign-in is on
 *   (`/health` mcp_oauth_enabled), Teammates / Server settings / Activity
 *   trace for admins, and the Message log for superadmins.
 *
 * Help ("How it works") is the account menu's "Help". The item for the page
 * on screen carries aria-current="page". The rail can be hidden with "Hide
 * sidebar" and brought back with the header's "Show sidebar".
 */

import logger from '../../helper/logger/logger.js';

/** Rail rows (ui/src/pages/app/<id>/meta.ts, group "work"). */
export const RAIL_PAGES = [
  { id: 'my-work', label: 'My Work', path: '/my-work', phoneOnly: true },
  { id: 'my-drafts', label: 'My Drafts', path: '/my-drafts', phoneOnly: true },
  { id: 'stream', label: 'Stream', path: '/stream' },
  { id: 'control-room', label: 'Control room', path: '/control-room' },
];

/** Header ribbon items (ui/src/lib/header-ribbon.ts). */
export const RIBBON_ITEMS = [
  { id: 'my-work', label: 'My Work', path: '/my-work' },
  { id: 'my-drafts', label: 'My Drafts', path: '/my-drafts' },
];

/** Workspace settings pages, in nav order, with who sees them. */
export const SETTINGS_PAGES = [
  { id: 'teams', label: 'Teams', path: '/teams', admin: false },
  { id: 'api-keys', label: 'API keys', path: '/api-keys', admin: false },
  { id: 'connected-apps', label: 'Connected apps', path: '/connected-apps', admin: false, needs: 'mcp' },
  { id: 'teammates', label: 'Teammates', path: '/teammates', admin: true },
  { id: 'settings', label: 'Server settings', path: '/settings', admin: true },
  { id: 'trace', label: 'Activity trace', path: '/trace', admin: true },
  { id: 'messages', label: 'Message log', path: '/messages', admin: true, needs: 'superadmin' },
];

/** The admin-only settings pages every server admin sees. */
export const ADMIN_SETTINGS_IDS = ['teammates', 'settings', 'trace'];

class SidebarRailPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail (ui/src/components/DocumentSidebar.tsx) ──────────────────────
    this.sidebar = page.getByTestId('document-sidebar');
    this.hideSidebar = page.getByTestId('document-sidebar-collapse');
    this.allNests = page.getByTestId('document-sidebar-all-nests');

    // ── Header (ui/src/App.tsx, HeaderRibbon.tsx) ─────────────────────────
    this.showSidebar = page.getByTestId('nest-sidebar-expand');
    this.ribbon = page.getByTestId('header-ribbon');
    this.userMenu = page.getByTestId('user-menu-trigger');
    this.userMenuSettings = page.getByTestId('user-menu-settings');
    this.userMenuHelp = page.getByTestId('user-menu-help');

    // ── Workspace settings (ui/src/components/SettingsShell.tsx) ──────────
    this.settingsNav = page.getByTestId('settings-nav');
  }

  /** Open a page and wait for the app shell and the rail. */
  async goto(path = '/') {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Opening ${path} for the sidebar rail`);
    await this.page.goto(path);
    await this.waitLoaded();
  }

  async waitLoaded() {
    await this.userMenu.waitFor({ state: 'visible' });
    await this.allNests.waitFor({ state: 'visible' });
  }

  /** A rail row by page id ("stream", "my-work", …). */
  row(id) {
    return this.page.getByTestId(`document-sidebar-dashboard-${id}`);
  }

  /** A header ribbon item ("my-work", "my-drafts"). */
  ribbonItem(id) {
    return this.page.getByTestId(`header-ribbon-${id}`);
  }

  /** A Workspace settings nav item by page id ("teams", "trace", …). */
  settingsItem(id) {
    return this.page.getByTestId(`settings-nav-${id}`);
  }

  /** Every visible navigation item marked as the current page. */
  currentItems() {
    return this.page
      .locator(
        '[data-testid^="document-sidebar-"][aria-current="page"], [data-testid^="header-ribbon-"][aria-current="page"], [data-testid^="settings-nav-"][aria-current="page"]'
      )
      .filter({ visible: true });
  }

  /** Ids of the Workspace settings nav items, top to bottom. */
  async settingsIds() {
    return this.settingsNav
      .locator('[data-testid^="settings-nav-"]')
      .evaluateAll((els) => els.map((e) => e.dataset.testid.replace('settings-nav-', '')));
  }

  /** Account menu → Settings: the Workspace settings page. */
  async openSettings() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Opening Workspace settings from the account menu`);
    await this.userMenu.click();
    await this.userMenuSettings.click();
    await this.settingsNav.waitFor({ state: 'visible' });
  }

  /** Account menu → Help: How it works. */
  async openHelp() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Opening Help from the account menu`);
    await this.userMenu.click();
    await this.userMenuHelp.click();
  }
}

export default SidebarRailPage;
