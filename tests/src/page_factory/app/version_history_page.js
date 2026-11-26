/**
 * Document Version History Page Object Model
 *
 * Under test: the "Version History" dialog (ui/src/components/governance/
 * VersionHistory.tsx, shown through VersionHistoryModal.tsx), the places that
 * open it — the document editor's ⋮ menu, a Documents-tab row's History
 * button and an HTML page's "Version history" button — the editor's Compare
 * menu with its inline diff (ui/src/components/DocumentEditor.tsx), and the
 * HTML page's "Viewing version N" banner (ui/src/components/ArtifactViewer.tsx).
 *
 * The dialog has few test ids, so most controls are found by their visible
 * names: version rows read "Version N", a row's restore icon is titled
 * "Restore this version" (or "Locked while awaiting steward review…" while a
 * review is pending), and the preview's buttons are Changes, Full content,
 * vs current, Restore and Back.
 */

import logger from '../../helper/logger/logger.js';

class VersionHistoryPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── Ways in ───────────────────────────────────────────────────────────
    this.documentMenu = page.getByTestId('document-editor-more');
    this.versionHistoryItem = page.getByRole('menuitem', { name: 'Version history', exact: true });
    this.htmlHistoryButton = page.locator('button[title="Version history"]');

    // ── The dialog ────────────────────────────────────────────────────────
    this.dialog = page.getByRole('dialog').filter({ hasText: 'Version History' });
    this.rows = this.dialog.locator('div[role="button"][tabindex="0"]').filter({ hasText: /^Version \d/ });
    this.discardButton = this.dialog.getByTestId('version-history-discard');
    this.neverPublishedHint = this.dialog.getByText('Never published — no approved version exists yet.');

    // The preview of one version.
    this.backButton = this.dialog.getByRole('button', { name: 'Back' });
    this.changesButton = this.dialog.getByRole('button', { name: 'Changes', exact: true });
    this.fullContentButton = this.dialog.getByRole('button', { name: 'Full content', exact: true });
    this.vsCurrentButton = this.dialog.getByRole('button', { name: 'vs current', exact: true });
    this.previewRestoreButton = this.dialog.getByRole('button', { name: 'Restore', exact: true });
    this.previewLockedButton = this.dialog.getByRole('button', { name: /Locked — review pending/ });
    this.viewRenderedButton = this.dialog.getByRole('button', { name: /View rendered/ });

    // ── Confirmations ─────────────────────────────────────────────────────
    this.discardDialog = page.getByRole('dialog').filter({ hasText: 'Discard the draft?' });
    this.discardConfirm = this.discardDialog.getByRole('button', { name: 'Discard draft', exact: true });

    // ── Compare (document editor header) ──────────────────────────────────
    this.compareButton = page.getByTestId('document-editor-compare');
    this.openMenu = page.locator('[role="menu"][data-state="open"]');
    this.inlineDiff = page.getByTestId('document-editor-inline-diff');
    this.sourceToggle = this.inlineDiff.getByRole('button', { name: 'Source', exact: true });
    this.renderedToggle = this.inlineDiff.getByRole('button', { name: 'Rendered', exact: true });
    this.exitDiffButton = this.inlineDiff.getByRole('button', { name: 'Exit diff' });
    this.exitCompareItem = this.openMenu.getByRole('menuitem', { name: /Exit compare/ });
    this.noEarlierVersionsItem = this.openMenu.getByRole('menuitem', { name: 'No earlier versions' });

    // ── Editing ───────────────────────────────────────────────────────────
    this.startEditButton = page.getByTestId('document-editor-start-edit');
    this.editableBody = this.main.locator('[contenteditable="true"]').first();

    // ── HTML page: the "Viewing version N" banner ──────────────────────────
    this.viewingBanner = page.getByText(/^Viewing version \d+/);
    this.backToCurrentButton = page.getByRole('button', { name: 'Back to current' });
    this.bannerRestoreButton = page.getByRole('button', { name: 'Restore this version', exact: true });
    this.bannerLockedButton = page.getByRole('button', { name: /Locked — review pending/ });
    this.frame = page.frameLocator('iframe').first();

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open a document (or HTML page) by its id and wait for its header. */
  async gotoDocument(nestId, nodeId) {
    this._log(`Opening ${nodeId} in nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}?doc=${encodeURIComponent(nodeId)}`, { waitUntil: 'domcontentloaded' });
    await this.documentMenu.or(this.htmlHistoryButton).first().waitFor({ state: 'visible', timeout: 60_000 });
  }

  /** Open the Documents tab and wait for a row. */
  async gotoDocuments(nestId, nodeId) {
    this._log(`Opening the Documents tab of nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}?tab=documents`, { waitUntil: 'domcontentloaded' });
    await this.row(nodeId).waitFor({ state: 'visible', timeout: 60_000 });
  }

  /** A Documents-tab row by its id. */
  row(nodeId) {
    return this.main.getByTestId(`document-row-${nodeId}`);
  }

  // ── Opening the history ─────────────────────────────────────────────────

  /** Wait until the dialog lists its versions. */
  async waitForDialog() {
    await this.dialog.waitFor({ state: 'visible', timeout: 30_000 });
    await this.rows.first().waitFor({ state: 'visible', timeout: 30_000 });
    return this.dialog;
  }

  /** The document's ⋮ menu items ("Version history", "Copy link", …). */
  async documentMenuItems() {
    await this.documentMenu.waitFor({ state: 'visible', timeout: 60_000 });
    await this.documentMenu.click();
    await this.openMenu.waitFor({ state: 'visible' });
    return (await this.openMenu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
  }

  /** ⋮ → Version history on the open document. */
  async openFromEditor() {
    this._log('Opening Version history from the document menu');
    await this.documentMenuItems();
    await this.versionHistoryItem.click();
    return this.waitForDialog();
  }

  /** The "Version history" button on an open HTML page. */
  async openFromHtmlPage() {
    this._log('Opening Version history on the HTML page');
    await this.htmlHistoryButton.waitFor({ state: 'visible', timeout: 60_000 });
    await this.htmlHistoryButton.click();
    return this.waitForDialog();
  }

  /** The History button on a Documents-tab row. */
  async openFromRow(nodeId) {
    this._log(`Opening History from the row of ${nodeId}`);
    await this.row(nodeId).hover();
    await this.row(nodeId).locator('button[title="History"]').click();
    return this.waitForDialog();
  }

  /** Close the dialog. */
  async close() {
    await this.page.keyboard.press('Escape');
    await this.dialog.waitFor({ state: 'hidden' });
  }

  // ── Rows and the preview ────────────────────────────────────────────────

  /** The row for version `n`. */
  versionRow(n) {
    return this.rows.filter({ hasText: new RegExp(`^Version ${n}(?!\\d)`) }).first();
  }

  /** The row's hover-revealed restore icon. */
  restoreIcon(n) {
    return this.versionRow(n).locator('button[title="Restore this version"]');
  }

  /** The row's restore icon while a review is pending. */
  lockedRestoreIcon(n) {
    return this.versionRow(n).locator('button[title^="Locked while awaiting steward review"]');
  }

  /** Open version `n`'s preview. */
  async openVersion(n) {
    this._log(`Opening Version ${n}`);
    await this.versionRow(n).click();
    await this.backButton.waitFor({ state: 'visible' });
  }

  /** The dialog's text, whitespace collapsed. */
  async dialogText() {
    return (await this.dialog.innerText()).replace(/\s+/g, ' ');
  }

  // ── Restore ─────────────────────────────────────────────────────────────

  /** The confirmation for restoring version `n` ("Restore Version N?" in the dialog, "Restore version N?" on the HTML banner). */
  restoreDialog(n) {
    return this.page.getByRole('dialog').filter({ hasText: new RegExp(`^Restore [Vv]ersion ${n}\\?`) });
  }

  /** Hover version `n`'s row and click its restore icon. */
  async clickRestoreIcon(n) {
    this._log(`Restore this version → Version ${n}`);
    await this.versionRow(n).hover();
    await this.restoreIcon(n).click();
    await this.restoreDialog(n).waitFor({ state: 'visible' });
  }

  /** Cancel the open restore confirmation. */
  async cancelRestore(n) {
    await this.restoreDialog(n).getByRole('button', { name: 'Cancel', exact: true }).click();
    await this.restoreDialog(n).waitFor({ state: 'hidden' });
  }

  /** Confirm the open restore confirmation. */
  async confirmRestore(n) {
    this._log(`Confirming Restore Version ${n}`);
    await this.restoreDialog(n).getByRole('button', { name: 'Restore', exact: true }).click();
    await this.restoreDialog(n).waitFor({ state: 'hidden', timeout: 60_000 });
  }

  // ── Compare ─────────────────────────────────────────────────────────────

  /** Open the Compare menu and return its items ("v2 taimur · 1m ago", …). */
  async openCompareMenu() {
    await this.compareButton.waitFor({ state: 'visible', timeout: 60_000 });
    await this.compareButton.click();
    await this.openMenu.waitFor({ state: 'visible' });
    await this.openMenu.getByText('Diff current against…').waitFor({ state: 'visible' });
    // The versions load when the menu opens; wait for them (or for "No earlier versions").
    await this.openMenu
      .getByRole('menuitem')
      .filter({ hasText: /^v\d|No earlier versions/ })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    return (await this.openMenu.getByRole('menuitem').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  }

  /** Pick version `n` in the open Compare menu and wait for the inline diff. */
  async compareWith(n) {
    this._log(`Compare → v${n}`);
    await this.openMenu.getByRole('menuitem').filter({ hasText: new RegExp(`^v${n}(?!\\d)`) }).first().click();
    await this.inlineDiff.waitFor({ state: 'visible', timeout: 30_000 });
    await this.inlineDiff.getByText(new RegExp(`Diff: v${n} → current`)).waitFor({ state: 'visible', timeout: 30_000 });
    // The header shows first; the compared body is fetched after it.
    await this.inlineDiff.getByText(/Loading version/).waitFor({ state: 'hidden', timeout: 60_000 });
  }

  /** The inline diff's text, whitespace collapsed. */
  async diffText() {
    return (await this.inlineDiff.innerText()).replace(/\s+/g, ' ');
  }

  // ── Editing ─────────────────────────────────────────────────────────────

  /** Put the open document into edit mode and type `text` at the end, without saving. */
  async typeUnsaved(text) {
    this._log(`Typing without saving: ${text}`);
    if (await this.startEditButton.isVisible().catch(() => false)) {
      await this.startEditButton.click({ timeout: 5_000 }).catch(() => {});
    }
    await this.editableBody.waitFor({ state: 'visible', timeout: 30_000 });
    await this.editableBody.click();
    await this.page.keyboard.press('Control+End');
    await this.page.keyboard.type(` ${text}`);
  }

  // ── Toasts ──────────────────────────────────────────────────────────────

  /** A toast carrying `text`. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default VersionHistoryPage;
