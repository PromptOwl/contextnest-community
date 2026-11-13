/**
 * Nest Settings Page Object Model
 *
 * Page under test: the Nest settings dialog (ui/src/components/NestSettingsModal.tsx),
 * opened from "Nest settings" in the nest's ⋯ menu. It holds the governance
 * settings — Stewardship & Approval Workflow, Auto-publish owner & admin
 * edits, Review prime documents only (with Prime tags), Always-include tags,
 * Creators review their own documents, Review SLA (hours), Record what people
 * and agents read, Require confirmation for agent writes (with "Keys that skip
 * the gate") — and the Systems panel (nest/SystemsPanel.tsx).
 *
 * Where the settings show up is covered too: the document page's status
 * badges, Publish / Submit for review / Save draft, the "Publish … (requires
 * approval)" dialog, the "Always include" and "Prime document" switches and
 * "Can approve:"; and the nest page's "Agent writes awaiting confirmation"
 * banner with its "Confirm write to this nest" dialog.
 *
 * Owners and nest admins open the dialog; a few switches are owner-only
 * (stewardship off, read recording off) or superadmin-only (agent writes).
 */

import logger from '../../helper/logger/logger.js';

class NestSettingsPage {
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
    this.nestMenu = page.getByTitle('More actions').first();
    this.nestSettingsItem = page.getByRole('menuitem', { name: 'Nest settings', exact: true });

    // ── Nest settings dialog ───────────────────────────────────────────────
    this.dialog = page.getByRole('dialog').filter({ hasText: 'Settings:' });
    this.saveButton = this.dialog.getByRole('button', { name: 'Save Settings', exact: true });
    this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });
    this.alwaysIncludeInput = page.getByTestId('nest-settings-always-include-tags');
    this.primeTagsInput = this.dialog.getByPlaceholder('prime-document, messaging-architecture');
    this.slaInput = this.dialog.getByPlaceholder('Off');
    this.slaError = this.dialog.locator('#review-sla-error');
    this.primeSection = this.dialog.getByText('Review prime documents only', { exact: true });
    this.creatorSection = this.dialog.getByText('Creators review their own documents', { exact: true });
    this.slaSection = this.dialog.getByText('Review SLA (hours)', { exact: true });
    this.disableWarning = this.dialog.getByText('Disabling stewardship removes governance.');
    this.disableAck = this.dialog.getByText('I understand this will remove all stewards.');
    this.noEffectNote = this.dialog.getByText('No effect right now.');
    this.superadminNote = this.dialog.getByText(/Ask a superadmin to change it\./);
    this.keysList = this.dialog.getByText(/Keys that skip the gate/).locator('xpath=..');

    // ── Systems panel (inside the dialog) ──────────────────────────────────
    this.systemName = this.dialog.getByPlaceholder('System name, e.g. GitHub sync');
    this.systemAccess = this.dialog.getByRole('combobox', { name: 'Access' });
    this.systemCreate = page.getByTestId('system-create');
    this.freshKey = this.dialog.locator('pre.font-mono');
    this.freshKeyNotice = this.dialog.getByText(/It won't be shown again/);
    this.freshKeyDone = this.dialog.getByRole('button', { name: 'Done', exact: true });
    this.revokeSystemDialog = page.getByRole('alertdialog').filter({ hasText: 'Revoke system?' });

    // ── Document page ──────────────────────────────────────────────────────
    this.documentMenu = page.getByTestId('document-editor-more');
    this.editButton = page.getByTestId('document-editor-start-edit');
    this.editableBody = page.locator('[contenteditable="true"]');
    this.draftBadge = page.getByText('Draft', { exact: true }).first();
    this.publishedBadge = page.getByText('Published', { exact: true }).first();
    this.autoPublishedBadge = page.getByText('Auto-published', { exact: true }).first();
    this.publishButton = page.getByRole('button', { name: 'Publish', exact: true });
    this.submitButton = page.getByRole('button', { name: 'Submit for review', exact: true });
    this.saveDraftButton = page.getByRole('button', { name: 'Save draft', exact: true });
    this.submitDialog = page.getByRole('dialog').filter({ hasText: '(requires approval)' });
    this.submitForApproval = this.submitDialog.getByRole('button', { name: 'Submit for approval', exact: true });
    this.alwaysIncludeSwitch = page.getByRole('switch', { name: /Always include/ }).first();
    this.primeSwitch = page.getByRole('switch', { name: /Prime document/ }).first();
    this.alwaysIncludedPrimeNote = page.getByText(/Prime because it is always-included/);
    this.approvers = page.getByTestId('document-editor-approvers');
    this.approveButton = this.main.getByRole('button', { name: 'Approve', exact: true });

    // ── Held agent writes (nest page) ──────────────────────────────────────
    this.pushBanner = page.locator('div.border-amber-300').filter({ hasText: 'Agent writes awaiting confirmation' }).first();
    this.confirmDialog = page.getByRole('dialog').filter({ hasText: 'Confirm write' });
    this.alwaysAllow = this.confirmDialog.getByRole('checkbox');
    this.confirmWrite = this.confirmDialog.getByRole('button', { name: /Confirm write/ });
    this.rejectWrite = this.confirmDialog.getByRole('button', { name: /Reject/ });

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /**
   * Open the nest page and wait for its tabs and its settings. The ⋯ menu
   * depends on the settings read that lands after the page first draws.
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

  /** Open one document and wait for it to load. */
  async gotoDocument(nestId, nodeId) {
    this._log(`Opening ${nodeId}`);
    await this.page.goto(`/nest/${nestId}?doc=${encodeURIComponent(nodeId)}`);
    await this.documentMenu.waitFor({ state: 'visible' });
    await this.page.getByText('Loading document...').waitFor({ state: 'hidden' }).catch(() => {});
  }

  // ── Nest ⋯ menu ────────────────────────────────────────────────────────────

  /** Open the nest's ⋯ menu. The header can re-render as the nest loads, so retry. */
  async openNestMenu() {
    for (let i = 0; i < 4; i++) {
      await this.nestMenu.click();
      if (await this.page.getByRole('menuitem').first().isVisible().catch(() => false)) return;
      await this.page.waitForTimeout(800);
    }
  }

  /** The entries of the nest's ⋯ menu, or [] when the nest offers no menu. */
  async nestMenuItems(nestId) {
    await this.gotoNest(nestId);
    if (!(await this.nestMenu.isVisible())) return [];
    await this.openNestMenu();
    const items = (await this.page.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
    await this.page.keyboard.press('Escape');
    return items;
  }

  /**
   * Open the Nest settings dialog from the nest's ⋯ menu. The dialog takes its
   * starting values from the nest page's own settings read; opened before that
   * lands, it shows the defaults (stewardship off). So it is checked against
   * the saved settings and reopened until it shows them.
   */
  async open(nestId) {
    this._log('Opening ⋯ → Nest settings');
    await this.gotoNest(nestId);
    await this.nestMenu.waitFor({ state: 'visible' });
    const res = await this.page.request.get(`/nests/${nestId}/settings`);
    const savedOn = String(Boolean(((await res.json().catch(() => ({}))) ?? {}).stewardship_enabled));
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.openNestMenu();
      await this.nestSettingsItem.click();
      await this.dialog.waitFor({ state: 'visible' });
      if ((await this.switchFor('Stewardship & Approval Workflow').getAttribute('aria-checked')) === savedOn) return;
      await this.cancelButton.click();
      await this.dialog.waitFor({ state: 'hidden' });
      await this.page.waitForTimeout(1000);
    }
  }

  // ── Dialog ─────────────────────────────────────────────────────────────────

  /** The switch of the setting whose row is labelled `label`. */
  switchFor(label) {
    return this.dialog.locator('div.rounded-lg.border').filter({ hasText: label }).getByRole('switch').first();
  }

  /** Flip a setting's switch to `on` (true/false), whatever it shows now. */
  async setSwitch(label, on) {
    const sw = this.switchFor(label);
    if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
  }

  /** The error banner at the top of the dialog. */
  dialogError() {
    return this.dialog.getByRole('alert').filter({ hasNotText: 'Disabling stewardship removes governance.' });
  }

  /** Click Save Settings and wait for the dialog to close. */
  async save() {
    this._log('Saving Nest settings');
    await this.saveButton.click();
    await this.dialog.waitFor({ state: 'hidden', timeout: 60_000 });
  }

  /** Open the dialog, change the given switches (label → on/off), and save. */
  async change(nestId, switches) {
    await this.open(nestId);
    for (const [label, on] of Object.entries(switches)) await this.setSwitch(label, on);
    await this.save();
  }

  // ── Systems ────────────────────────────────────────────────────────────────

  /** Create a System from the open dialog; returns the key it shows once. */
  async createSystem(name, access = 'Read') {
    this._log(`Creating System "${name}" (${access})`);
    await this.systemName.fill(name);
    await this.systemAccess.click();
    await this.page.getByRole('option', { name: access, exact: true }).click();
    await this.systemCreate.click();
    await this.freshKey.first().waitFor({ state: 'visible', timeout: 30_000 });
    return (await this.freshKey.first().innerText()).trim();
  }

  /** A System's row in the panel. */
  systemRow(name) {
    return this.dialog.locator('li').filter({ hasText: name }).first();
  }

  rotateButton(name) {
    return this.dialog.getByRole('button', { name: `Rotate ${name}'s key`, exact: true });
  }

  revokeButton(name) {
    return this.dialog.getByRole('button', { name: `Revoke ${name}`, exact: true });
  }

  addNestSelect(name) {
    return this.dialog.getByRole('combobox', { name: `Add a nest to ${name}` });
  }

  removeNestButton(name, nestName) {
    return this.dialog.getByRole('button', { name: `Remove ${name} from ${nestName}`, exact: true });
  }

  // ── Document page ──────────────────────────────────────────────────────────

  /** Switch the open document into edit mode (when it isn't already) and type. */
  async typeInDocument(text) {
    if (await this.editButton.count()) await this.editButton.click();
    await this.editableBody.first().click();
    await this.page.keyboard.press('Control+End');
    await this.page.keyboard.type(` ${text}`);
  }

  /** Submit the open document for review through the approval dialog. */
  async submitForReview() {
    await this.submitButton.click();
    await this.submitDialog.waitFor({ state: 'visible' });
    await this.submitForApproval.click();
    await this.submitDialog.waitFor({ state: 'hidden', timeout: 60_000 });
  }

  // ── Held agent writes ──────────────────────────────────────────────────────

  /**
   * Open the nest page and the first held agent write from its banner, and
   * wait for the dialog to load what is about to be written.
   */
  async openHeldWrite(nestId) {
    await this.gotoNest(nestId);
    await this.pushBanner.waitFor({ state: 'visible', timeout: 60_000 });
    await this.pushBanner.locator('button').first().click();
    await this.confirmDialog.waitFor({ state: 'visible' });
    await this.confirmDialog.getByText('Loading…').waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
  }

  // ── Activity panel ─────────────────────────────────────────────────────────

  /**
   * Open the open document's Activity panel, return its text, and close it.
   * Waits for the entries themselves (every document has a "Created" one) —
   * the header repeats the document's title, which can contain any word.
   */
  async activityText() {
    await this.documentMenu.click();
    await this.page.getByRole('menuitem', { name: 'Activity', exact: true }).click();
    const panel = this.page.getByRole('dialog', { name: /^Activity for / });
    await panel.getByText(/^Created\b/).first().waitFor({ state: 'visible', timeout: 60_000 });
    const text = (await panel.innerText()).replace(/\s+/g, ' ');
    await panel.getByTestId('activity-log-close').click();
    await panel.waitFor({ state: 'hidden' });
    return text;
  }
}

export default NestSettingsPage;
