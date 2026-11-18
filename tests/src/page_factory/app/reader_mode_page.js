/**
 * Reader Mode Page Object Model
 *
 * Page under test: Public Docs Reader Mode. The owner, a nest admin or a server
 * admin turns it on from the "Reader mode: On / Off" button
 * (`nest-settings-reader`) under "Review and access" on the nest's Settings
 * tab, which opens the "Public Docs Reader Mode" dialog
 * (ui/src/components/NestView.tsx). Before #582 the button sat in the nest
 * header as "Reader: On / Off".
 *
 * With it on, a reader gets a docs view instead of the nest page:
 *   - a signed-in person who can only read the nest gets the in-app reader
 *     (ui/src/components/ReaderView.tsx): a page list with a search box, the
 *     open page, Previous / Next and "On this page" — no tabs, no editing;
 *   - a signed-out visitor to a Public nest is sent to the docs site at
 *     /d/<key>/ (src/site/render.ts): "Documentation" navigation, the page and
 *     a "Pages" pager.
 * Owners, editors and reviewers keep the full nest page.
 */

import logger from '../../helper/logger/logger.js';

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
    // New document lives in the app top bar since #582 (ui/src/components/TopBarTools.tsx).
    this.newDocumentButton = page.getByTestId('top-bar-new-document');
    this.settingsTab = page.getByTestId('nest-settings-tab');
    this.noAccess = page.getByText(/doesn.t exist or you don.t have access/);

    // ── Reader button (Settings tab) and dialog ────────────────────────────
    this.readerButton = page.getByTestId('nest-settings-reader');
    this.readerDialog = page.getByRole('dialog', { name: 'Public Docs Reader Mode' });
    this.readerSwitch = page.getByRole('switch', { name: 'Toggle Public Docs Reader Mode' });
    this.readerDone = this.readerDialog.getByRole('button', { name: 'Done', exact: true });

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

  /** Open the nest page on its Settings tab, where the Reader button is. */
  async gotoSettings(nestId) {
    this._log(`Opening the Settings tab of nest ${nestId}`);
    await this.gotoNest(nestId);
    await this.settingsTab.click();
    await this.page.getByRole('heading', { name: 'Fields and task rules' }).waitFor({ state: 'visible' });
  }

  /**
   * Open the nest's Settings tab and wait for the Reader button (owner, nest
   * admin or server admin).
   */
  async gotoAsManager(nestId) {
    await this.gotoSettings(nestId);
    await this.readerButton.waitFor({ state: 'visible', timeout: 60_000 });
  }

  /** The Reader button's label: "Reader mode: On" or "Reader mode: Off". */
  async readerLabel() {
    return (await this.readerButton.innerText()).trim();
  }

  /** Open the dialog, flip the switch to `on`, wait for it to save and close the dialog. */
  async setReaderMode(on) {
    this._log(`Turning Reader mode ${on ? 'on' : 'off'}`);
    await this.readerButton.click();
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
