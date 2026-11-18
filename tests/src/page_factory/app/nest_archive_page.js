/**
 * Nest Archive Page Object Model
 *
 * Page under test: the nest page (ui/src/components/NestView.tsx) at
 * /nest/<id>, and the document view inside it (/nest/<id>?doc=<docId>).
 *
 * Archiving lives in the nest's Settings tab → Danger zone (Delete nest, or
 * Request deletion for an editor):
 * - the owner gets the Delete nest dialog (ui/src/components/DeleteNestDialog.tsx),
 *   whose "Archive instead" archives without the type-to-confirm;
 * - an editor gets "Request removal of …" (ui/src/components/governance/ReasonDialog.tsx),
 *   whose "Request archive" raises an archive request for an owner or admin.
 * A pending request shows as the "Archive requested" badge in the header; the
 * requester withdraws it by clicking the badge. The owner decides it in the
 * My Work inbox (ui/src/pages/app/my-work/page.tsx), the one review queue
 * for every nest.
 *
 * An archived nest is read-only: the write actions, the governance tabs and
 * the Settings actions are withheld, and documents open without an editor.
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
    // Settings tab (ui/src/components/NestView.tsx): the nest's own actions.
    this.settingsDelete = page.getByTestId('nest-settings-delete');
    this.settingsGovernance = page.getByTestId('nest-settings-governance');
    // A pending deletion or archive request on the nest.
    this.flagBadge = page.getByTestId('nest-deletion-flag');

    // ── Write actions (hidden on an archived nest) ────────────────────────
    this.connectButton = this.page.getByTestId('top-bar-connect');
    this.addWithAiButton = this.main.getByRole('button', { name: 'Add with AI', exact: true });
    this.shareButton = this.main.getByRole('button', { name: 'Invite', exact: true });
    this.newFolderButton = this.main.getByRole('button', { name: 'New Folder', exact: true });
    this.importButton = this.page.getByTestId('top-bar-new-document');
    this.newDocumentButton = this.page.getByTestId('top-bar-new-document');

    // ── Delete nest dialog (owner) ────────────────────────────────────────
    this.deleteDialog = page.getByRole('dialog', { name: 'Delete nest' });
    this.deleteConfirmInput = page.locator('#delete-nest-confirm');
    this.deleteSubmit = this.deleteDialog.getByRole('button', { name: 'Delete nest' });
    this.archiveInstead = page.getByTestId('archive-nest');

    // ── Reason dialogs (request removal, reject, approve) ─────────────────
    this.requestDialog = page.getByRole('dialog').filter({ hasText: 'Request removal of' });
    // "Reject this request" in the nest's Review Queue; My Work says "Reject this archive request".
    this.rejectDialog = page.getByRole('dialog').filter({ hasText: /Reject this (archive )?request/ });
    this.reasonInput = page.getByTestId('reason-dialog-input');
    this.reasonConfirm = page.getByTestId('reason-dialog-confirm');
    this.reasonSecondary = page.getByTestId('reason-dialog-secondary');

    // ── My Work inbox rows (one per request, across nests) ────────────────
    this.requestRows = page
      .locator('main div.group')
      .filter({ has: page.locator('span.uppercase') });

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

  /** A nest tab, by the name it starts with . */
  tab(name) {
    return this.page.getByRole('tab', { name: new RegExp(`^${name}`) });
  }

  /** Text shown on the page (a document body, a document title). */
  text(value) {
    return this.main.getByText(value, { exact: true });
  }

  // ── Settings tab ────────────────────────────────────────────────────────

  /** Open the nest's Settings tab. */
  async openSettings() {
    this._log('Opening the Settings tab');
    await this.tab('Settings').click();
  }

  /**
   * The write actions the Settings tab offers right now, by name. Empty when
   * the nest has none (an archived nest, or an editor with a request pending).
   */
  async settingsActions() {
    if ((await this.tab('Settings').count()) === 0) return [];
    await this.openSettings();
    const found = [];
    if (await this.settingsGovernance.count()) found.push('Edit review settings');
    if (await this.settingsDelete.count()) found.push('Delete');
    return found;
  }

  /** Start the delete / request-removal flow from the Danger zone. */
  async startDelete() {
    this._log('Settings → Delete');
    await this.openSettings();
    await this.settingsDelete.click();
  }

  // ── Archive / request ───────────────────────────────────────────────────

  /** Editor: Delete → "Request removal of …" → reason → Request archive. */
  async requestArchive(reason) {
    this._log('Requesting an archive of the nest');
    await this.startDelete();
    await this.requestDialog.waitFor({ state: 'visible' });
    await this.reasonInput.fill(reason);
    await this.reasonSecondary.click();
    await this.requestDialog.waitFor({ state: 'hidden', timeout: 60_000 });
  }

  // ── My Work ─────────────────────────────────────────────────────────────

  /** Open My Work, where every nest's requests are decided. */
  async openReviewQueue() {
    this._log('Opening My Work');
    await this.page.goto('/my-work');
    await this.page.getByTestId('my-work-filter-chips').waitFor({ state: 'visible' });
  }

  /** The My Work row of one request, found by its reason. */
  requestRow(reason) {
    return this.requestRows.filter({ hasText: reason });
  }

  /** A My Work row's kind badge: "Archive" or "Deletion". */
  requestKind(reason) {
    return this.requestRow(reason).locator('span.uppercase').first();
  }

  /** The confirm dialog that honouring an archive request opens. */
  approveDialog(nestName) {
    return this.page.getByRole('dialog').filter({ hasText: `Archive "${nestName}"?` });
  }

  /** Reject a request from its My Work row, with a note. */
  async rejectRequest(reason, note) {
    this._log('Rejecting an archive request');
    await this.requestRow(reason).getByRole('button', { name: 'Reject', exact: true }).click();
    await this.rejectDialog.waitFor({ state: 'visible' });
    await this.reasonInput.fill(note);
    await this.reasonConfirm.click();
    await this.rejectDialog.waitFor({ state: 'hidden', timeout: 60_000 });
  }

  /** Approve an archive request from its My Work row and confirm it. */
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
