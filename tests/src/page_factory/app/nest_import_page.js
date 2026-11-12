/**
 * Nest Import Page Object Model
 *
 * Page under test: the nest page's Import button and its "Import into this
 * nest" dialog (ui/src/components/NestView.tsx). The dialog offers Files,
 * Upload PDF and Whole vault; each opens a file chooser, and every chosen
 * file becomes its own document in the nest. A single imported document
 * opens straight away; several leave you on the nest. The outcome is a
 * toast: "Added N items", "(skipped N unsupported)", or the reason a file was
 * refused.
 *
 * Not to be confused with the dashboard's Import Folder (a new nest from a
 * folder), which has its own suite.
 */

import logger from '../../helper/logger/logger.js';

class NestImportPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── Nest page ─────────────────────────────────────────────────────────
    this.importButton = page.getByTestId('nest-import-files');
    this.contents = page.getByRole('navigation', { name: 'Contents' });

    // ── "Import into this nest" dialog ────────────────────────────────────
    this.dialog = page.getByRole('dialog', { name: 'Import into this nest' });
    this.filesOption = this.dialog.getByRole('button', { name: /^Files/ });
    this.uploadPdfOption = this.dialog.getByRole('button', { name: /^Upload PDF/ });
    this.wholeVaultOption = this.dialog.getByRole('button', { name: /^Whole vault/ });

    // An opened document's title field.
    this.titleInput = this.main.getByPlaceholder('Untitled');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open a nest's page and wait for its tabs. */
  async gotoNest(nestId) {
    this._log(`Opening nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}`);
    await this.tab('Documents').waitFor({ state: 'visible' });
  }

  /** A nest tab by its label (Overview, Documents, …). */
  tab(name) {
    return this.page.getByRole('tab', { name, exact: true });
  }

  // ── Import ──────────────────────────────────────────────────────────────

  /** Import → the "Import into this nest" dialog. */
  async openImport() {
    this._log('Opening the Import dialog');
    await this.importButton.click();
    await this.dialog.waitFor({ state: 'visible' });
  }

  /**
   * Import → `option` (one of the dialog's option buttons) → choose `files`
   * in the file chooser it opens: file payloads, or a folder path for Whole
   * vault.
   */
  async importVia(option, files) {
    await this.openImport();
    const [chooser] = await Promise.all([this.page.waitForEvent('filechooser'), option.click()]);
    await chooser.setFiles(files);
  }

  /** Import → Files → `files`. */
  async importFiles(files) {
    this._log(`Importing ${files.map((f) => f.name).join(', ')}`);
    await this.importVia(this.filesOption, files);
  }

  /** Import → Upload PDF → `files`. */
  async uploadPdf(files) {
    this._log(`Uploading ${files.map((f) => f.name).join(', ')}`);
    await this.importVia(this.uploadPdfOption, files);
  }

  /** Import → Whole vault → the folder at `dir`. */
  async importVault(dir) {
    this._log(`Importing the vault at ${dir}`);
    await this.importVia(this.wholeVaultOption, dir);
  }

  // ── Results ─────────────────────────────────────────────────────────────

  /** A folder's row in the Overview's Contents tree. */
  folderRow(label) {
    return this.contents.getByRole('button', { name: label, exact: true });
  }

  /** A toast carrying `text`. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default NestImportPage;
