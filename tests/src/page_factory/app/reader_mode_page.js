/**
 * Reader Mode Page Object Model
 *
 * Page under test: Public Docs Reader Mode. The owner, a nest admin or a server
 * admin turns it on from the "Reader: On / Off" button in the nest header,
 * which opens the "Public Docs Reader Mode" dialog (ui/src/components/NestView.tsx).
 *
 * With it on, a reader gets a docs view instead of the nest page:
 *   - a signed-in person who can only read the nest gets the in-app reader
 *     (ui/src/components/ReaderView.tsx): a page list with a search box, the
 *     open page, Previous / Next and "On this page" — no tabs, no editing;
 *   - a signed-out visitor to a Public nest is sent to the docs site at
 *     /d/<key>/ (src/site/render.ts): "Documentation" navigation, the page and
 *     a "Pages" pager.
 * Owners, editors and reviewers keep the full nest page.
 *
 * Since po-1213 the Reader button is gone from the header: the switch is the
 * "Reader mode: On / Off" item in the header's ⋯ menu, and a "Reader on" badge
 * shows while it is on. Overview is folded into Documents. The suite sets
 * `nestHome` (tests/src/lib/nest_home_probe.js) and the helpers below drive
 * whichever build the server under test runs.
 */

import logger from '../../helper/logger/logger.js';
import { openMoreActions } from '../../lib/more_actions_menu.js';

class ReaderModePage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── Nest page (the full view) ──────────────────────────────────────────
    this.backToNests = page.getByTitle('Back to nests');
    this.overviewTab = page.getByRole('tab', { name: 'Overview', exact: true });
    this.documentsTab = page.getByRole('tab', { name: 'Documents', exact: true });
    this.newDocumentButton = this.main.getByRole('button', { name: 'New Document', exact: true });
    this.noAccess = page.getByText(/doesn.t exist or you don.t have access/);

    // ── Reader button and dialog ───────────────────────────────────────────
    this.readerButton = page.getByTitle(/^Public Docs Reader Mode/);
    this.readerDialog = page.getByRole('dialog', { name: 'Public Docs Reader Mode' });
    this.readerSwitch = page.getByRole('switch', { name: 'Toggle Public Docs Reader Mode' });
    this.readerDone = this.readerDialog.getByRole('button', { name: 'Done', exact: true });
    // po-1213: the ⋯ menu item and the header badge that replace the button.
    this.moreActions = page.locator('button[title="More actions"]').first();
    this.readerMenuItem = page.getByTestId('nest-reader-mode');
    this.readerBadge = page.getByTestId('nest-reader-badge');
    /** Does the server under test ship po-1213? Set by the suite. */
    this.nestHome = false;

    // ── In-app docs reader (signed in, read-only) ──────────────────────────
    this.readerSearch = page.getByRole('textbox', { name: 'Search pages by title or tag' });
    this.readerPager = page.getByRole('navigation', { name: 'Previous and next pages' });
    this.readerOutline = page.getByRole('navigation', { name: 'On this page' });

    // ── Docs site (signed out, /d/<key>/) ──────────────────────────────────
    this.siteNav = page.getByRole('navigation', { name: 'Documentation' });
    this.sitePager = page.getByRole('navigation', { name: 'Pages' });

    // ── Login screen ───────────────────────────────────────────────────────
    this.loginEmail = page.getByTestId('login-email-input');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  /** Load a URL. A loaded shared server can abort the navigation; try once more. */
  async _open(url) {
    await this.page.goto(url).catch(async (err) => {
      if (!String(err).includes('ERR_ABORTED')) throw err;
      await this.page.goto(url);
    });
  }

  /** Open the nest page. */
  async gotoNest(nestId) {
    this._log(`Opening nest ${nestId}`);
    await this._open(`/nest/${nestId}`);
  }

  /** Close the ⋯ menu if it is open. */
  async _closeMenu() {
    const menu = this.page.locator('[role="menu"][data-state="open"]');
    if (await menu.isVisible()) {
      await this.page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
    }
  }

  /**
   * Open the nest page and wait for the Reader mode control (owner, nest admin
   * or server admin): the header button, or since po-1213 the ⋯ menu item.
   */
  async gotoAsManager(nestId) {
    await this.gotoNest(nestId);
    if (!this.nestHome) {
      await this.readerButton.waitFor({ state: 'visible', timeout: 60_000 });
      return;
    }
    await this.moreActions.waitFor({ state: 'visible', timeout: 60_000 });
    await openMoreActions(this.page, this.readerMenuItem);
    await this._closeMenu();
  }

  /** Reader mode as the manager's control shows it: "On" or "Off". */
  async readerState() {
    if (!this.nestHome) {
      const label = (await this.readerButton.innerText()).trim();
      return label.replace(/^Reader:\s*/, '');
    }
    await openMoreActions(this.page, this.readerMenuItem);
    const label = (await this.readerMenuItem.innerText()).trim();
    await this._closeMenu();
    return label.replace(/^Reader mode:\s*/, '');
  }

  /**
   * How many Reader mode controls this person gets: the header button, or
   * since po-1213 the ⋯ menu item and the "Reader on" badge.
   */
  async readerControlCount() {
    if (!this.nestHome) return this.readerButton.count();
    let count = await this.readerBadge.count();
    if (await this.moreActions.isVisible()) {
      await openMoreActions(this.page);
      count += await this.readerMenuItem.count();
      await this._closeMenu();
    }
    return count;
  }

  /** Open the dialog, flip the switch to `on`, wait for it to save and close the dialog. */
  async setReaderMode(on) {
    this._log(`Turning Reader mode ${on ? 'on' : 'off'}`);
    if (this.nestHome) {
      await openMoreActions(this.page, this.readerMenuItem);
      await this.readerMenuItem.click();
    } else {
      await this.readerButton.click();
    }
    await this.readerDialog.waitFor({ state: 'visible' });
    if ((await this.readerSwitch.getAttribute('aria-checked')) !== String(on)) {
      await this.readerSwitch.click();
    }
    await this.readerDialog
      .getByText(on ? 'Read-only visitors get the docs reader.' : 'Everyone gets the standard nest view.')
      .waitFor({ state: 'visible', timeout: 60_000 });
    // The switch is disabled while the change saves.
    for (let i = 0; i < 120 && !(await this.readerSwitch.isEnabled()); i++) {
      await this.page.waitForTimeout(500);
    }
    await this.readerDone.click();
    await this.readerDialog.waitFor({ state: 'hidden' });
  }
}

export default ReaderModePage;
