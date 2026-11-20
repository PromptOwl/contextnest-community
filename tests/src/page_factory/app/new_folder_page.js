/**
 * New Folder Page Object Model
 *
 * Page under test: the "New folder" dialog on the nest page
 * (ui/src/components/NestView.tsx), opened by the New Folder button beside the
 * nest's tabs, and where a new folder shows up: the Documents tree
 * (ui/src/components/nest/DocumentsTab.tsx), the nest's home since po-1213
 * retired the Overview tab.
 *
 * The dialog checks the typed path as you type (ui/src/lib/folder-path.ts): a
 * blocking problem shows as an inline error and disables Create folder, and a
 * name that will be stored differently shows a "Will be created as …" preview.
 * In the Documents tree a folder header shows its name and, when it holds
 * documents, their count; a header with documents expands when clicked. An
 * empty folder's header does not expand: it opens as a card in the grid view
 * (⋯ → Show as grid), which scopes the list to it.
 */

import logger from '../../helper/logger/logger.js';
import { openMoreActions } from '../../lib/more_actions_menu.js';

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
    this.search = this.main.getByPlaceholder('Search title, tags, content…');

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

  /** Open a nest's page on Documents and wait for its search box. */
  async gotoNest(nestId) {
    this._log(`Opening nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}`);
    await this.search.waitFor({ state: 'visible', timeout: 60_000 });
  }

  /** A nest tab by its label (Documents, Instructions, …). */
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

  // ── Documents tree ──────────────────────────────────────────────────────

  /** A folder's header in the Documents tree, by its path ("team-notes", "alpha/sub"). */
  folderHeader(path) {
    return this.main.getByTestId(`folder-header-${path}`);
  }

  /** How many documents the header counts under the folder (0 when it shows no count). */
  async folderTotal(path) {
    const m = (await this.folderHeader(path).innerText()).match(/(\d+)\s*$/);
    return m ? Number(m[1]) : 0;
  }

  /** A document's row by its id ("nodes/alpha/alpha-one"). */
  row(id) {
    return this.main.getByTestId(`document-row-${id}`);
  }

  /** Click a folder header that holds documents, so its documents and subfolders show. */
  async expandFolder(path) {
    this._log(`Expanding ${path}`);
    await this.folderHeader(path).click();
  }

  /** Open a folder in the Documents tab (⋯ → Show as grid → its card), scoping the list to it. */
  async openFolder(label) {
    this._log(`Opening ${label}`);
    const grid = this.page.getByTestId('nest-view-grid');
    await openMoreActions(this.page, grid);
    await grid.click();
    await this.main.locator(`button[title="Open ${label}"]`).click();
  }

  /** A toast carrying `text`. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default NewFolderPage;
