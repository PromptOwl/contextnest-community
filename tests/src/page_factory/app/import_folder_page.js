/**
 * Import Folder Page Object Model
 *
 * Dialog under test: ui/src/components/ImportFolderModal.tsx ("Import into a
 * new nest"), opened by the Nests page's "Import Folder" button
 * (ui/src/pages/app/nests/page.tsx).
 *
 * Two sources: "Folder" (a folder from the user's computer) and "File / .zip"
 * (a nest .zip, or loose markdown / text files). After a pick the dialog shows
 * "<name> — N documents · M files scanned" and fills Nest name with the
 * folder, the zip or "Imported". Import uploads the files into a new nest.
 *
 * "Choose folder" opens the system folder picker in Chromium
 * (window.showDirectoryPicker), which a test can't drive. `useFolderInput()`
 * removes that picker in this browser only, so the dialog falls back to its
 * own folder <input>, which Playwright fills through the file chooser.
 */

import logger from '../../helper/logger/logger.js';

class ImportFolderPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Nests page (ui/src/pages/app/nests/page.tsx) ──────────────────────
    this.importFolderButton = page.getByRole('button', { name: 'Import Folder' });
    this.userMenu = page.getByTestId('user-menu-trigger');

    // ── Dialog (ui/src/components/ImportFolderModal.tsx) ──────────────────
    this.dialog = page.getByRole('dialog', { name: 'Import into a new nest' });
    this.folderSource = this.dialog.getByRole('radio', { name: 'Folder' });
    this.fileSource = this.dialog.getByRole('radio', { name: 'File / .zip' });
    this.chooseFolderButton = this.dialog.getByRole('button', { name: 'Choose folder' });
    this.chooseFilesButton = this.dialog.getByRole('button', { name: 'Choose .zip or files' });
    // "<name> — N documents · M files scanned", shown once something is picked.
    this.summary = this.dialog.locator('p').filter({ hasText: /scanned/ });
    this.nameInput = this.dialog.getByRole('textbox');
    this.importButton = this.dialog.getByRole('button', { name: 'Import', exact: true });
    this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });
    this.error = this.dialog.locator('p.text-destructive');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  /**
   * Make "Choose folder" use the dialog's own folder <input> instead of the
   * system picker. Call before the page loads (it's an init script).
   */
  async useFolderInput() {
    await this.page.addInitScript(() => {
      try {
        window.showDirectoryPicker = undefined;
      } catch {
        // Not writable here — the dialog then uses the system picker.
      }
    });
  }

  /** Open the Nests page. */
  async goto() {
    this._log('Opening the Nests page');
    await this.page.goto('/');
    await this.userMenu.waitFor({ state: 'visible' });
    await this.importFolderButton.waitFor({ state: 'visible' });
  }

  /** Open the Import Folder dialog from the Nests page. */
  async open() {
    this._log('Opening the Import Folder dialog');
    await this.importFolderButton.click();
    await this.dialog.waitFor({ state: 'visible' });
  }

  /** Folder source → "Choose folder" → pick `dir` (an absolute path). */
  async chooseFolder(dir) {
    this._log(`Choosing folder ${dir}`);
    if (!(await this.folderSource.isChecked())) await this.folderSource.check();
    const [chooser] = await Promise.all([this.page.waitForEvent('filechooser'), this.chooseFolderButton.click()]);
    await chooser.setFiles(dir);
    await this.summary.waitFor({ state: 'visible' });
  }

  /**
   * File / .zip source → "Choose .zip or files" → pick `files` (paths, or
   * `{ name, mimeType, buffer }` payloads).
   */
  async chooseFiles(files) {
    this._log('Choosing files for File / .zip');
    if (!(await this.fileSource.isChecked())) await this.fileSource.check();
    const [chooser] = await Promise.all([this.page.waitForEvent('filechooser'), this.chooseFilesButton.click()]);
    await chooser.setFiles(files);
    await this.summary.waitFor({ state: 'visible' });
  }

  /** The summary line with whitespace folded. */
  async summaryText() {
    return (await this.summary.innerText()).replace(/\s+/g, ' ').trim();
  }

  /** Click Import and wait until the dialog closes or shows a message. */
  async submit() {
    this._log('Importing');
    await this.importButton.click();
    await Promise.race([
      this.dialog.waitFor({ state: 'detached', timeout: 90_000 }),
      this.error.waitFor({ state: 'visible', timeout: 90_000 }),
    ]);
  }
}

export default ImportFolderPage;
