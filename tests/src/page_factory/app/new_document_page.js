/**
 * New Document Page Object Model
 *
 * Page under test: the document editor (ui/src/components/DocumentEditor.tsx)
 * opened for a new document from the nest page (ui/src/components/NestView.tsx):
 * the header's New Document button, a folder row's "New document in <folder>"
 * on the Overview (ui/src/components/nest/OverviewTab.tsx) and "New here" in a
 * folder opened in the Documents tab (ui/src/components/nest/DocumentsTab.tsx).
 *
 * A new document needs a title and content before its save button enables.
 * The button reads Publish when the save goes live, and Save draft when the
 * nest's stewardship holds it for review. Leaving with unsaved changes opens
 * the "Unsaved changes" dialog (Cancel / Discard / Save & leave).
 */

import logger from '../../helper/logger/logger.js';

class NewDocumentPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── App header + nest page ────────────────────────────────────────────
    this.breadcrumb = page.getByTestId('header-breadcrumb');
    // Exact: the empty Overview offers a "New document" card of its own.
    this.newDocumentButton = this.main.getByRole('button', { name: 'New Document', exact: true }).first();
    this.selectedTab = page.getByRole('tab', { selected: true }).first();
    this.contents = page.getByRole('navigation', { name: 'Contents' });
    this.newHereButton = this.main.getByRole('button', { name: 'New here' });

    // ── Editor (new document) ─────────────────────────────────────────────
    this.titleInput = this.main.getByPlaceholder('Untitled');
    this.tagInput = this.main.getByPlaceholder('Add a tag…');
    this.body = this.main.locator('[contenteditable="true"]').first();
    this.folderField = this.main.getByTestId('document-editor-folder-input');
    this.folderPicker = this.main.getByTestId('folder-step-picker');
    this.folderMenu = page.getByRole('menu');
    this.newSubfolderInput = page.getByPlaceholder('New subfolder…');
    this.typePicker = this.main.getByRole('radiogroup', { name: 'Document type' });
    this.markdownButton = this.main.getByRole('button', { name: 'Markdown', exact: true });
    this.richEditorButton = this.main.getByRole('button', { name: 'Rich editor', exact: true });
    this.markdownSource = this.main.locator('textarea').filter({ visible: true }).first();
    this.publishButton = this.main.getByRole('button', { name: 'Publish', exact: true });
    this.saveDraftButton = this.main.getByRole('button', { name: 'Save draft', exact: true });
    this.backButton = this.main.getByRole('button', { name: 'Back to documents' });
    this.errorAlert = this.main.getByRole('alert');

    // ── Dialogs ───────────────────────────────────────────────────────────
    this.leaveDialog = page.getByRole('dialog', { name: 'Unsaved changes' });
    this.switchTypeDialog = page.getByRole('dialog', { name: /^Switch to / });

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open a nest's page and wait for its header actions. */
  async gotoNest(nestId) {
    this._log(`Opening nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}`);
    await this.newDocumentButton.waitFor({ state: 'visible' });
  }

  /** Header → New Document, and wait for the blank editor. */
  async openNewDocument() {
    this._log('Opening a new document');
    await this.newDocumentButton.click();
    await this.titleInput.waitFor({ state: 'visible' });
  }

  /** A nest tab by its label (Overview, Documents, …). */
  tab(name) {
    return this.page.getByRole('tab', { name, exact: true });
  }

  /**
   * One of a folder row's hover actions in the Overview's Contents
   * ("New document in Alpha", "Open Alpha in Documents").
   */
  async contentsFolderAction(folderLabel, actionLabel) {
    const row = this.contents.getByRole('button', { name: folderLabel, exact: true });
    await row.hover();
    await this.contents.getByRole('button', { name: actionLabel, exact: true }).click();
  }

  // ── Editing ─────────────────────────────────────────────────────────────

  /** Click into the body and type `text`. */
  async typeBody(text) {
    await this.body.click();
    await this.page.keyboard.type(text);
  }

  /** Title, then body — the two fields Publish waits for. */
  async fillDocument(title, body) {
    await this.titleInput.fill(title);
    await this.typeBody(body);
  }

  /** Add a tag through the tag field. */
  async addTag(tag) {
    await this.tagInput.fill(tag);
    await this.tagInput.press('Enter');
  }

  /**
   * The save button's hint. It sits on a wrapper, not the button: a disabled
   * button takes no pointer events, so the tooltip lives one level up.
   */
  async saveHint(button = this.publishButton) {
    return button.locator('xpath=..').getAttribute('title');
  }

  /** The editor's Folder field as one line ("Root / Alpha / Specs"). */
  async folderPath() {
    return (await this.folderField.innerText()).replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ').trim();
  }

  /** The labels the Type picker offers, in order. */
  async typeOptions() {
    return (await this.typePicker.getByRole('radio').allInnerTexts()).map((t) => t.trim());
  }

  /** The type the picker has selected. */
  async selectedType() {
    return (await this.typePicker.getByRole('radio', { checked: true }).innerText()).trim();
  }

  /** Choose a type in the Type picker. */
  async chooseType(label) {
    this._log(`Choosing type ${label}`);
    await this.typePicker.getByRole('radio', { name: label, exact: true }).click();
  }

  /**
   * Open the folder picker's menu. A menu that is still closing swallows the
   * click that would reopen it, so wait it out and click again if needed.
   */
  async openFolderPicker() {
    await this.folderMenu.waitFor({ state: 'hidden' });
    await this.folderPicker.click();
    const opened = await this.folderMenu
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) await this.folderPicker.click();
    await this.folderMenu.waitFor({ state: 'visible' });
  }

  /** Folder picker → an existing folder. */
  async pickFolder(label) {
    this._log(`Choosing folder ${label}`);
    await this.openFolderPicker();
    await this.folderMenu.getByRole('menuitem', { name: label, exact: true }).click();
    await this.folderMenu.waitFor({ state: 'hidden' });
  }

  /**
   * Folder picker → "New subfolder…" under the folder shown now. Enter files
   * the document there but leaves the menu open, so Escape closes it.
   */
  async createSubfolder(name) {
    this._log(`Creating subfolder ${name}`);
    await this.openFolderPicker();
    await this.newSubfolderInput.fill(name);
    await this.newSubfolderInput.press('Enter');
    await this.page.keyboard.press('Escape');
    await this.folderMenu.waitFor({ state: 'hidden' });
  }

  // ── Leaving ─────────────────────────────────────────────────────────────

  /**
   * Back arrow → the "Unsaved changes" dialog. A first click can be lost
   * while the body has focus and the page is scrolled (CN-CREATE-017 checks
   * that case on its own), so this clicks once more if the dialog stays shut.
   */
  async requestLeave() {
    this._log('Leaving the document through the back arrow');
    await this.backButton.click();
    const opened = await this.leaveDialog
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) await this.backButton.click();
    await this.leaveDialog.waitFor({ state: 'visible' });
  }

  /** A toast carrying `text`. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default NewDocumentPage;
