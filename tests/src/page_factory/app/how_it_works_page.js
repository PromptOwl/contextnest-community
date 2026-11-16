/**
 * How It Works Page Object Model
 *
 * Page location: ui/src/pages/app/guide/page.tsx (+ help-topics.ts)
 * Route: /guide (rail → Help → How it works, every signed-in user)
 *
 * A text-only tour of the app in the order the sidebar shows it. One section
 * per <h2>; the only controls are the "Manage keys" button in the Workspace
 * section. The header around it carries the Docs button the page points to,
 * the breadcrumb, and the shortcuts the page names (Ctrl / ⌘ K, ?).
 *
 * The page carries no data-testids of its own, so it is addressed by role,
 * heading and text.
 */

import logger from '../../helper/logger/logger.js';

/** Section headings, in the order the page shows them. */
export const GUIDE_SECTIONS = [
  'What this is',
  'Nests',
  'Inviting someone',
  'Documents',
  'Review',
  'Views inside a nest',
  'Workspace',
  'Admin',
  'Updating',
  'Single sign-on (OIDC)',
  'Account',
];

export const GUIDE_DESCRIPTION = 'A tour of the app, page by page. Agent setup (API, MCP, CLI) is on the Docs page in the header.';

class HowItWorksPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail (ui/src/components/DocumentSidebar.tsx) ──────────────────────
    this.helpGroup = page.getByTestId('document-sidebar-group-help');
    this.railItem = page.getByTestId('document-sidebar-dashboard-guide');
    /** The rail item inside the Help group's own block. */
    this.railItemInHelp = this.helpGroup.locator('xpath=..').getByTestId('document-sidebar-dashboard-guide');

    // ── Header (ui/src/App.tsx) ───────────────────────────────────────────
    this.breadcrumb = page.getByTestId('header-breadcrumb');
    this.docsButton = page.getByRole('button', { name: 'Docs', exact: true });
    this.search = page.getByPlaceholder('Search nests and documents…');
    this.shortcutsDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Keyboard shortcuts' }) });

    // ── Page ──────────────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    this.sections = page.locator('main h2');
    this.manageKeys = page.locator('main').getByRole('button', { name: 'Manage keys', exact: true });
  }

  /** Open How it works directly and wait for its sections. */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Opening How it works`);
    await this.page.goto('/guide');
    await this.waitLoaded();
  }

  async waitLoaded() {
    await this.pageTitle.filter({ hasText: 'How it works' }).waitFor({ state: 'visible' });
    await this.sections.first().waitFor({ state: 'visible' });
  }

  /** A section by its heading. */
  section(title) {
    return this.page.locator('main section').filter({ has: this.page.locator('h2', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
  }

  /** Breadcrumb parts, in order ("Home", "How it works"). */
  async crumbs() {
    const text = (await this.breadcrumb.innerText()).split(/\n|›|>|\//).map((s) => s.trim()).filter(Boolean);
    return text;
  }
}

export default HowItWorksPage;
