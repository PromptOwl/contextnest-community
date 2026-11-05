/**
 * New Folder Page Object Model
 *
 * Page under test: the "New folder" dialog on the nest page
 * (ui/src/components/NestView.tsx), opened by the New Folder button beside the
 * nest's tabs, and where a new folder shows up: the Overview's Contents tree
 * (ui/src/components/nest/OverviewTab.tsx) and the Documents tab.
 *
 * The dialog checks the typed path as you type (ui/src/lib/folder-path.ts): a
 * blocking problem shows as an inline error and disables Create folder, and a
 * name that will be stored differently shows a "Will be created as …" preview.
 * In the Contents tree a folder with documents expands in place; an empty one
 * opens in the Documents tab instead.
 */

import logger from '../../helper/logger/logger.js';

class NewFolderPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── Nest page ─────────────────────────────────────────────────────────
    this.newFolderButton = this.main.getByRole('button', { name: 'New Folder', exact: true });
    this.selectedTab = page.getByRole('tab', { selected: true }).first();
    this.contents = page.getByRole('navigation', { name: 'Contents' });

    // ── "New folder" dialog ───────────────────────────────────────────────
    this.dialog = page.getByRole('dialog', { name: 'New folder' });
    this.nameInput = this.dialog.getByPlaceholder('e.g. gtm/deals');
    this.createButton = this.dialog.getByRole('button', { name: 'Create folder', exact: true });
    this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });
    this.nameError = this.dialog.getByTestId('new-folder-error');
    this.namePreview = this.dialog.getByTestId('new-folder-preview');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open a nest's page on the Overview and wait for its Contents tree. */
  async gotoNest(nestId) {
    this._log(`Opening nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}`);
    await this.contents.waitFor({ state: 'visible' });
  }

  /** A nest tab by its label (Overview, Documents, …). */
  tab(name) {
    return this.page.getByRole('tab', { name, exact: true });
  }

  // ── Dialog ──────────────────────────────────────────────────────────────

  /** New Folder → the "New folder" dialog. */
  async openDialog() {
    this._log('Opening the New folder dialog');
    await this.newFolderButton.click();
    await this.dialog.waitFor({ state: 'visible' });
  }

  /** Replace whatever the name field holds with `name`. */
  async typeName(name) {
    await this.nameInput.fill(name);
  }

  /** Open the dialog, type `name`, click Create folder, and wait for it to close. */
  async createFolder(name) {
    this._log(`Creating folder ${name}`);
    await this.openDialog();
    await this.typeName(name);
    await this.createButton.click();
    await this.dialog.waitFor({ state: 'hidden', timeout: 60_000 });
  }

  // ── Contents tree ───────────────────────────────────────────────────────

  /** A folder's row in the Contents tree, by the name the tree shows. */
  folderRow(label) {
    return this.contents.getByRole('button', { name: label, exact: true });
  }

  /** The row's document count ("0 documents", "1 document"). */
  folderCount(label) {
    return this.folderRow(label).locator('xpath=..').locator('[aria-label$=" document"], [aria-label$=" documents"]');
  }

  /**
   * Expand a folder that holds documents. Only those rows expand; an empty
   * folder's row opens it in the Documents tab instead.
   */
  async expandFolder(label) {
    const row = this.folderRow(label);
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  }

  /** A toast carrying `text`. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default NewFolderPage;
