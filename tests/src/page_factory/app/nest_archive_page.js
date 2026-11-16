/**
 * Nest Archive Page Object Model
 *
 * Page under test: the nest page (ui/src/components/NestView.tsx) at
 * /nest/<id>, and the document view inside it (/nest/<id>?doc=<docId>).
 *
 * Archiving lives behind the nest page's More actions → Delete entry:
 * - the owner gets the Delete nest dialog (ui/src/components/DeleteNestDialog.tsx),
 *   whose "Archive instead" archives without the type-to-confirm;
 * - an editor gets "Request removal of …" (ui/src/components/governance/ReasonDialog.tsx),
 *   whose "Request archive" raises an archive request for an owner or admin.
 * A pending request shows as the "Archive requested" badge in the header; the
 * requester withdraws it by clicking the badge. The owner decides it in the
 * nest's Review Queue tab (ui/src/components/nest/ReviewTab.tsx).
 *
 * An archived nest is read-only: the write actions, the governance tabs and
 * the nest menu are withheld, and documents open without an editor.
 */

import logger from '../../helper/logger/logger.js';

class NestArchivePage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── Header (ui/src/components/NestPageHeader.tsx) ─────────────────────
    this.backToNests = page.getByTitle('Back to nests');
    // The innermost row holding the back button: name, badges and actions.
    this.header = this.main.locator('div.justify-between').filter({ has: this.backToNests }).last();
    this.moreActions = this.header.getByTitle('More actions');
    // A pending deletion or archive request on the nest.
    this.flagBadge = page.getByTestId('nest-deletion-flag');

    // ── Write actions (hidden on an archived nest) ────────────────────────
    this.connectButton = this.main.getByRole('button', { name: 'Connect', exact: true });
    this.addWithAiButton = this.main.getByRole('button', { name: 'Add with AI', exact: true });
    this.shareButton = this.main.getByRole('button', { name: 'Share', exact: true });
    this.newFolderButton = this.main.getByRole('button', { name: 'New Folder', exact: true });
    this.importButton = this.main.getByRole('button', { name: 'Import', exact: true });
    this.newDocumentButton = this.main.getByRole('button', { name: 'New Document', exact: true });

    // ── Delete nest dialog (owner) ────────────────────────────────────────
    this.deleteDialog = page.getByRole('dialog', { name: 'Delete nest' });
    this.deleteConfirmInput = page.locator('#delete-nest-confirm');
    this.deleteSubmit = this.deleteDialog.getByRole('button', { name: 'Delete nest' });
    this.archiveInstead = page.getByTestId('archive-nest');

    // ── Reason dialogs (request removal, reject, approve) ─────────────────
    this.requestDialog = page.getByRole('dialog').filter({ hasText: 'Request removal of' });
    this.rejectDialog = page.getByRole('dialog').filter({ hasText: 'Reject this request' });
    this.reasonInput = page.getByTestId('reason-dialog-input');
    this.reasonConfirm = page.getByTestId('reason-dialog-confirm');
    this.reasonSecondary = page.getByTestId('reason-dialog-secondary');

    // ── Review Queue tab ──────────────────────────────────────────────────
    this.requestRows = page.getByTestId('deletion-request-item');

    // ── Document view ─────────────────────────────────────────────────────
    this.editableContent = this.main.locator('[contenteditable="true"]');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open a nest's page. */
  async goto(nestId) {
    this._log(`Opening nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}`);
    await this.backToNests.waitFor({ state: 'visible' });
  }

  /** Open one document inside a nest. */
  async gotoDocument(nestId, docId) {
    this._log(`Opening document ${docId} in nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}?doc=${encodeURIComponent(docId)}`);
  }

  /** A nest tab, by the name it starts with (Review Queue carries a count). */
  tab(name) {
    return this.page.getByRole('tab', { name: new RegExp(`^${name}`) });
  }

  /** Text shown on the page (a document body, a document title). */
  text(value) {
    return this.main.getByText(value, { exact: true });
  }

  // ── Nest menu ───────────────────────────────────────────────────────────

  /**
   * Open More actions. The first click on a freshly loaded page can land
   * before the menu is wired, so it is retried until the items show.
   */
  async openMoreActions() {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.moreActions.click();
      const opened = await this.page
        .getByRole('menuitem')
        .first()
        .waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (opened) return;
      await this.page.keyboard.press('Escape');
    }
    throw new Error('The nest menu (More actions) did not open');
  }

  /** The nest menu's entries; empty when the nest page shows no menu. */
  async menuItems() {
    if ((await this.moreActions.count()) === 0) return [];
    await this.openMoreActions();
    const items = (await this.page.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
    await this.page.keyboard.press('Escape');
    await this.page.getByRole('menuitem').first().waitFor({ state: 'hidden' });
    return items;
  }

  /** Pick one entry of the nest menu. */
  async chooseMenu(name) {
    this._log(`Nest menu → ${name}`);
    await this.openMoreActions();
    await this.page.getByRole('menuitem', { name, exact: true }).click();
  }

  // ── Archive / request ───────────────────────────────────────────────────

  /** Editor: Delete → "Request removal of …" → reason → Request archive. */
  async requestArchive(reason) {
    this._log('Requesting an archive of the nest');
    await this.chooseMenu('Delete');
    await this.requestDialog.waitFor({ state: 'visible' });
    await this.reasonInput.fill(reason);
    await this.reasonSecondary.click();
    await this.requestDialog.waitFor({ state: 'hidden', timeout: 60_000 });
  }

  // ── Review Queue ────────────────────────────────────────────────────────

  /** Open the nest's Review Queue tab. */
  async openReviewQueue() {
    this._log('Opening the Review Queue tab');
    await this.tab('Review Queue').click();
  }

  /** The Review Queue row of one request, found by its reason. */
  requestRow(reason) {
    return this.requestRows.filter({ hasText: reason });
  }

  /** The confirm dialog that honouring an archive request opens. */
  approveDialog(nestName) {
    return this.page.getByRole('dialog').filter({ hasText: `Archive "${nestName}"?` });
  }

  /** Reject a request from its Review Queue row, with a note. */
  async rejectRequest(reason, note) {
    this._log('Rejecting an archive request');
    await this.requestRow(reason).getByRole('button', { name: 'Reject', exact: true }).click();
    await this.rejectDialog.waitFor({ state: 'visible' });
    await this.reasonInput.fill(note);
    await this.reasonConfirm.click();
    await this.rejectDialog.waitFor({ state: 'hidden', timeout: 60_000 });
  }

  /** Approve an archive request from its Review Queue row and confirm it. */
  async approveRequest(reason, nestName) {
    this._log('Approving an archive request');
    await this.requestRow(reason).getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = this.approveDialog(nestName);
    await dialog.waitFor({ state: 'visible' });
    await this.reasonConfirm.click();
    await dialog.waitFor({ state: 'hidden', timeout: 60_000 });
  }
}

export default NestArchivePage;
