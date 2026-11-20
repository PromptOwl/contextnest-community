/**
 * Stewards Page Object Model
 *
 * Page under test: assigning stewards on a nest — the "Assign Steward" entry
 * in the nest's ⋯ menu, the Stewards tab (ui/src/components/nest/StewardsTab.tsx
 * and governance/StewardList.tsx) with its owner row, scope and role filters
 * and each row's ⋮ menu (Edit Role, Remove), the "Assign Context Steward" /
 * "Edit steward" dialog (governance/StewardModal.tsx), the billing
 * confirmation a paid role raises, and the "Remove this steward?" confirmation.
 *
 * What a steward can then do is read on the document page: the Approve and
 * Reject buttons with their dialogs (governance/ReviewActions.tsx), the edit
 * surface, the status badges and the document's Activity panel.
 *
 * Only the nest owner and nest admins manage stewards, and only while
 * stewardship is on and the nest isn't archived.
 */

import logger from '../../helper/logger/logger.js';

class StewardsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── Nest page ──────────────────────────────────────────────────────────
    this.tabs = page.getByRole('tab');
    this.stewardsTab = page.getByRole('tab', { name: /^Stewards/ });
    this.nestMenu = page.getByTitle('More actions').first();
    this.assignStewardItem = page.getByRole('menuitem', { name: 'Assign Steward', exact: true });

    // ── Stewards tab ───────────────────────────────────────────────────────
    this.stewardsTitle = this.main.getByText('Stewards', { exact: true });
    this.ownerRow = page.getByTestId('steward-owner-row');
    this.emptyRoster = this.main.getByText(/No delegated stewards yet/);
    this.assignFirstButton = this.main.getByRole('button', { name: 'Assign your first steward' });
    this.roleFilter = this.main.getByRole('combobox').last();
    this.rosterRows = this.main.locator('div.p-2.rounded-lg.border.bg-card');

    // ── Assign / Edit dialog ───────────────────────────────────────────────
    this.assignDialog = page.getByRole('dialog').filter({ hasText: 'Assign Context Steward' });
    this.editDialog = page.getByRole('dialog').filter({ hasText: 'Edit steward' });
    this.emailInput = page.getByTestId('steward-email-input');
    this.tagSelect = page.getByTestId('steward-tag-select');
    this.documentSelect = page.getByTestId('steward-document-select');
    this.ownerNote = page.getByText(/already holds full\s+stewardship authority/);

    // ── Billing confirmation (a free account moved to a paid role) ─────────
    this.billingDialog = page.getByRole('alertdialog').filter({ hasText: 'This raises what someone is billed' });
    this.billingConfirm = this.billingDialog.getByRole('button', { name: 'Confirm and save', exact: true });
    this.billingCancel = this.billingDialog.getByRole('button', { name: 'Cancel', exact: true });

    // ── Remove confirmation ────────────────────────────────────────────────
    this.removeDialog = page
      .getByRole('alertdialog')
      .or(page.getByRole('dialog'))
      .filter({ hasText: 'Remove this steward?' });
    this.removeConfirm = this.removeDialog.getByRole('button', { name: 'Remove steward', exact: true });
    this.removeCancel = this.removeDialog.getByRole('button', { name: 'Cancel', exact: true });

    // ── Document page ──────────────────────────────────────────────────────
    this.documentMenu = page.getByTestId('document-editor-more');
    this.editButton = page.getByTestId('document-editor-start-edit');
    this.editableBody = page.locator('[contenteditable="true"]');
    this.approveButton = this.main.getByRole('button', { name: 'Approve', exact: true });
    this.rejectButton = this.main.getByRole('button', { name: 'Reject', exact: true });
    this.saveDraftButton = page.getByRole('button', { name: 'Save draft', exact: true });
    this.approveDialog = page.getByRole('dialog').filter({ hasText: 'Approve Document' });
    this.rejectDialog = page.getByRole('dialog').filter({ hasText: 'Reject Document' });
    this.cantApproveOwn = page.getByText(/can't approve your own changes/);
    this.publishedBadge = page.getByText('Published', { exact: true }).first();
    this.rejectedBadge = page.getByText('Rejected', { exact: true }).first();

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /**
   * Open the nest page and wait for its tabs and its settings. The ⋯ menu and
   * the Stewards tab depend on "stewardship on", which arrives with the
   * settings read after the page first draws; reading them earlier sees the
   * nest as ungoverned.
   */
  async gotoNest(nestId) {
    this._log(`Opening nest ${nestId}`);
    const settings = this.page
      .waitForResponse(
        (r) => r.url().endsWith(`/nests/${nestId}/settings`) && r.request().method() === 'GET',
        { timeout: 30_000 }
      )
      .catch(() => null);
    await this.page.goto(`/nest/${nestId}`);
    await this.tabs.first().waitFor({ state: 'visible' });
    await settings;
    await this.page.waitForTimeout(500);
  }

  /** The nest page's tab names, left to right (counts stripped). */
  async tabNames(nestId) {
    await this.gotoNest(nestId);
    return (await this.tabs.allInnerTexts()).map((t) => t.split('\n')[0].trim());
  }

  /** Open the Stewards tab and wait for the roster (or its empty state). */
  async gotoStewards(nestId) {
    this._log(`Opening the Stewards tab of nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}?tab=stewards`);
    await this.ownerRow.or(this.emptyRoster).first().waitFor({ state: 'visible' });
  }

  /** Open one document and wait for it to load. */
  async gotoDocument(nestId, nodeId) {
    this._log(`Opening ${nodeId}`);
    await this.page.goto(`/nest/${nestId}?doc=${encodeURIComponent(nodeId)}`);
    await this.documentMenu.waitFor({ state: 'visible' });
    await this.page.getByText('Loading document...').waitFor({ state: 'hidden' }).catch(() => {});
  }

  // ── Nest ⋯ menu ────────────────────────────────────────────────────────────

  /** The entries of the nest's ⋯ menu, or [] when the nest offers no menu. */
  async nestMenuItems(nestId) {
    await this.gotoNest(nestId);
    if (!(await this.nestMenu.isVisible())) return [];
    await this.openNestMenu();
    const items = (await this.page.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
    await this.page.keyboard.press('Escape');
    return items;
  }

  /** Open the nest's ⋯ menu. The header can re-render as the nest loads, so retry. */
  async openNestMenu() {
    for (let i = 0; i < 4; i++) {
      await this.nestMenu.click();
      if (await this.page.getByRole('menuitem').first().isVisible().catch(() => false)) return;
      await this.page.waitForTimeout(800);
    }
  }

  /** Open "Assign Context Steward" from the nest's ⋯ menu. */
  async openAssignFromMenu(nestId) {
    this._log('Opening ⋯ → Assign Steward');
    await this.gotoNest(nestId);
    await this.nestMenu.waitFor({ state: 'visible' });
    await this.openNestMenu();
    await this.assignStewardItem.click();
    await this.assignDialog.waitFor({ state: 'visible' });
  }

  // ── Assign / Edit dialog ───────────────────────────────────────────────────

  /** The Scope dropdown of a dialog (shows Tag, Document or Entire Nest). */
  scopeSelect(dialog = this.assignDialog) {
    return dialog.getByRole('combobox').filter({ hasText: /^(Tag|Document|Entire Nest)$/ });
  }

  /** The Role dropdown of a dialog. */
  roleSelect(dialog = this.assignDialog) {
    return dialog.getByRole('combobox').filter({ hasText: /can approve|can edit|read-only/ });
  }

  /** The error shown at the top of a dialog. */
  dialogError(dialog = this.assignDialog) {
    return dialog.getByRole('alert');
  }

  /** Pick a scope: 'Entire Nest', 'Tag' or 'Document'. */
  async chooseScope(label, dialog = this.assignDialog) {
    await this.scopeSelect(dialog).click();
    await this.page.getByRole('option', { name: label, exact: true }).click();
  }

  /** Pick a role: 'Viewer', 'Editor' or 'Reviewer'. */
  async chooseRole(label, dialog = this.assignDialog) {
    await this.roleSelect(dialog).click();
    await this.page.getByRole('option', { name: new RegExp(`^${label} — `) }).click();
  }

  /** Pick the tag (`#qa`) or document (its title) a steward governs. */
  async chooseTarget(scope, label) {
    await (scope === 'Tag' ? this.tagSelect : this.documentSelect).click();
    await this.page.getByRole('option', { name: label, exact: true }).first().click();
  }

  /**
   * Fill the Assign dialog: scope (and its target), role and email. Leaves it
   * open; `assign()` submits it.
   */
  async fillAssign({ email, scope = 'Entire Nest', target, role = 'Reviewer' }) {
    await this.chooseScope(scope);
    if (target) await this.chooseTarget(scope, target);
    await this.chooseRole(role);
    await this.emailInput.fill(email);
  }

  /** Click Assign Steward in the open dialog. */
  async submitAssign() {
    await this.assignDialog.getByRole('button', { name: 'Assign Steward', exact: true }).click();
  }

  /** Open the Assign dialog, fill it and submit it. */
  async assign(nestId, spec) {
    this._log(`Assigning ${spec.email} as ${spec.role ?? 'Reviewer'} (${spec.scope ?? 'Entire Nest'})`);
    await this.openAssignFromMenu(nestId);
    await this.fillAssign(spec);
    await this.submitAssign();
  }

  // ── Stewards list ──────────────────────────────────────────────────────────

  /** A steward's row in the list, by email. */
  stewardRow(email) {
    return this.main.locator('div.p-2.rounded-lg.border.bg-card').filter({ hasText: email });
  }

  /** A scope filter button: 'All', 'Document', 'Tag' or 'Nest'. */
  scopeFilter(label) {
    return this.main.getByRole('button', { name: label, exact: true });
  }

  /** Pick a role filter: 'All', 'Viewer', 'Editor' or 'Reviewer'. */
  async filterByRole(label) {
    await this.roleFilter.click();
    await this.page.getByRole('option', { name: label, exact: true }).click();
  }

  /** Open a steward row's ⋮ menu and pick 'Edit Role' or 'Remove'. */
  async rowAction(email, action) {
    this._log(`${action} ${email}`);
    await this.stewardRow(email).getByRole('button').last().click();
    await this.page.getByRole('menuitem', { name: action, exact: true }).click();
  }

  // ── Document page ──────────────────────────────────────────────────────────

  /** Switch the open document into edit mode (when it isn't already) and type. */
  async typeInDocument(text) {
    if (await this.editButton.count()) await this.editButton.click();
    await this.editableBody.first().click();
    await this.page.keyboard.press('Control+End');
    await this.page.keyboard.type(` ${text}`);
  }

  /** Open the document's Activity panel, return its text, and close it. */
  async activityText() {
    await this.documentMenu.click();
    await this.page.getByRole('menuitem', { name: 'Activity', exact: true }).click();
    const panel = this.page.getByRole('dialog', { name: /^Activity for / });
    await panel.getByText(/Created|Rejected|Approved|Read/).first().waitFor({ state: 'visible' });
    const text = (await panel.innerText()).replace(/\s+/g, ' ');
    await panel.getByTestId('activity-log-close').click();
    await panel.waitFor({ state: 'hidden' });
    return text;
  }
}

export default StewardsPage;
