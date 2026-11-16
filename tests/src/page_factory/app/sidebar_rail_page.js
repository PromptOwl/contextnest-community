/**
 * Sidebar Rail Page Object Model
 *
 * Page location: ui/src/components/DocumentSidebar.tsx (AppPagesNav) — the
 * dashboard rail, built from the page registry in ui/src/lib/pages.ts
 * (`appRail(caps)`).
 *
 * The rail has one ungrouped row on top (Nests) and four collapsible groups:
 * Work, Workspace, Admin and Help. Which rows show depends on the caller and
 * the server: Admin rows need a server admin, the Message log a superadmin,
 * Connected apps needs MCP sign-in (`/health` mcp_oauth_enabled) and Stream
 * the experimental document stream (`/health` experimental.doc_stream). The
 * row for the page on screen carries aria-current="page". A group folds on
 * click and is remembered per browser; the rail itself can be hidden with
 * "Hide sidebar" and brought back with the header's "Show sidebar".
 */

import logger from '../../helper/logger/logger.js';

/** Every rail row the registry can produce, in rail order, with its group and path. */
export const RAIL_PAGES = [
  { id: 'nests', label: 'Nests', group: null, path: '/' },
  { id: 'my-work', label: 'My Work', group: 'work', path: '/my-work' },
  { id: 'my-drafts', label: 'My Drafts', group: 'work', path: '/my-drafts' },
  { id: 'stream', label: 'Stream', group: 'work', path: '/stream' },
  { id: 'teams', label: 'Teams', group: 'workspace', path: '/teams' },
  { id: 'api-keys', label: 'API keys', group: 'workspace', path: '/api-keys' },
  { id: 'connected-apps', label: 'Connected apps', group: 'workspace', path: '/connected-apps' },
  { id: 'teammates', label: 'Teammates', group: 'admin', path: '/teammates' },
  { id: 'settings', label: 'Server settings', group: 'admin', path: '/settings' },
  { id: 'trace', label: 'Activity trace', group: 'admin', path: '/trace' },
  { id: 'messages', label: 'Message log', group: 'admin', path: '/messages' },
  { id: 'guide', label: 'How it works', group: 'help', path: '/guide' },
];

/** The rail's groups, in order. */
export const RAIL_GROUPS = ['work', 'workspace', 'admin', 'help'];

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
    this.nav = page.getByTestId('document-sidebar-dashboard');
    this.hideSidebar = page.getByTestId('document-sidebar-collapse');

    // ── Header (ui/src/App.tsx) ───────────────────────────────────────────
    this.showSidebar = page.getByTestId('nest-sidebar-expand');
    this.userMenu = page.getByTestId('user-menu-trigger');
  }

  /** Open the dashboard and wait for the rail. */
  async goto(path = '/') {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Opening ${path} for the sidebar rail`);
    await this.page.goto(path);
    await this.waitLoaded();
  }

  async waitLoaded() {
    await this.userMenu.waitFor({ state: 'visible' });
    await this.nav.waitFor({ state: 'visible' });
  }

  /** A rail row by page id ("my-work", "settings", …). */
  row(id) {
    return this.page.getByTestId(`document-sidebar-dashboard-${id}`);
  }

  /** A group's header button by group id ("work", "admin", …). */
  group(id) {
    return this.page.getByTestId(`document-sidebar-group-${id}`);
  }

  /** Ids of the rail rows currently rendered, top to bottom. */
  async rowIds() {
    return this.nav
      .locator('[data-testid^="document-sidebar-dashboard-"]')
      .evaluateAll((els) => els.map((e) => e.dataset.testid.replace('document-sidebar-dashboard-', '')));
  }

  /** Ids of the groups currently rendered, top to bottom. */
  async groupIds() {
    return this.nav
      .locator('[data-testid^="document-sidebar-group-"]')
      .evaluateAll((els) => els.map((e) => e.dataset.testid.replace('document-sidebar-group-', '')));
  }

  /** Open a group if it is folded, so its rows can be clicked. */
  async expandGroup(id) {
    const header = this.group(id);
    if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
  }

  /** Click a rail row, opening its group first. */
  async openRow(page) {
    logger.info(`Opening "${page.label}" from the rail`);
    if (page.group) await this.expandGroup(page.group);
    await this.row(page.id).click();
  }
}

export default SidebarRailPage;
