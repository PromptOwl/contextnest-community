/**
 * Collaborators Page Object Model
 *
 * Page under test: the nest page's Collaborators tab at
 * /nest/<id>?tab=collaborators (ui/src/components/nest/CollaboratorsTab.tsx).
 * It holds the visibility control (NestVisibilityControl), API-only access
 * (HeadlessAccessPanel) and the roster (CollaboratorManager): add a person or
 * a team, change a person's role, remove them, and — with stewardship on —
 * the Reviewer switch.
 *
 * Owners and admins get the whole tab. An editor gets only the add form, with
 * everyone's role shown read-only. A viewer doesn't get the tab at all.
 */

import logger from '../../helper/logger/logger.js';

class CollaboratorsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── Nest page ──────────────────────────────────────────────────────────
    this.backToNests = page.getByTitle('Back to nests');
    this.collaboratorsTab = page.getByRole('tab', { name: 'Collaborators', exact: true });
    this.overviewTab = page.getByRole('tab', { name: 'Overview', exact: true });
    this.newDocumentButton = this.main.getByRole('button', { name: 'New Document', exact: true });
    this.requestEditAccess = this.main.getByRole('button', { name: 'Request edit access' });
    this.editableBody = this.main.locator('[contenteditable="true"]');
    // Document page (ui/src/components/DocumentEditor.tsx)
    this.editButton = page.getByTestId('document-editor-start-edit');
    this.documentMenu = page.getByTestId('document-editor-more');
    this.saveButton = page.getByTestId('document-editor-save');
    this.noAccess = page.getByText(/doesn.t exist or you don.t have access/);
    this.moreActions = page.getByTitle('More actions').first();
    this.requestRemovalDialog = page.getByRole('dialog').filter({ hasText: 'Request removal of' });
    this.deleteNestDialog = page.getByRole('dialog', { name: 'Delete nest' });

    // ── Visibility ─────────────────────────────────────────────────────────
    this.visibilitySelect = page.getByRole('combobox', { name: 'Nest visibility' });
    this.visibilityDialog = page.getByRole('alertdialog');

    // ── API-only access ────────────────────────────────────────────────────
    this.headlessPanel = page.getByTestId('headless-access-panel');
    this.headlessSwitch = page.locator('#headless-switch');
    this.headlessReason = this.headlessPanel.locator('p.text-amber-600');
    this.keyLabelInput = page.getByPlaceholder('Who is this key for? e.g. Acme Corp');
    this.createKeyButton = page.getByRole('button', { name: 'Create key', exact: true });
    this.freshKey = this.headlessPanel.locator('pre');
    this.revokeConfirm = page.getByTestId('revoke-key-confirm');

    // ── Add a person / team ────────────────────────────────────────────────
    this.personInput = page.getByTestId('collab-person-input');
    this.addForm = page.locator('form').filter({ has: this.personInput });
    this.roleSelect = this.addForm.getByRole('combobox').last();
    this.addButton = this.addForm.getByRole('button', { name: 'Add', exact: true });
    this.inviteReviewer = page.getByTestId('collab-invite-reviewer');
    this.personMode = page.getByRole('button', { name: 'Person', exact: true });
    this.teamMode = page.getByRole('button', { name: 'Team', exact: true });
    this.teamSelect = page.getByTestId('collab-team-select');
    this.shareTeamButton = page
      .locator('div.flex-col')
      .filter({ has: this.teamSelect })
      .last()
      .getByRole('button', { name: 'Share', exact: true });
    this.teamsWithAccess = page.getByText('Teams with access', { exact: true });

    // ── People with access ─────────────────────────────────────────────────
    this.peopleWithAccess = page.getByText('People with access', { exact: true });
    this.rows = page.locator('[data-testid^="collaborator-row-"]');
    this.removeDialog = page.getByRole('alertdialog');
    this.removeConfirm = page.getByTestId('remove-collaborator-confirm');
    // Asked first when a change moves someone to a paid role (BillingConfirmDialog).
    this.billingDialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).filter({ hasText: 'This raises what someone is billed' });
    this.billingConfirm = this.billingDialog.getByRole('button', { name: 'Confirm and save' });
    this.errorAlert = this.main.locator('[role="alert"]');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /** Load a URL. A loaded shared server can abort the navigation; try once more. */
  async _open(url) {
    await this.page.goto(url).catch(async (err) => {
      if (!String(err).includes('ERR_ABORTED')) throw err;
      await this.page.goto(url);
    });
  }

  /** Open a nest's Collaborators tab and wait for the roster. */
  async goto(nestId) {
    this._log(`Opening the Collaborators tab of nest ${nestId}`);
    await this._open(`/nest/${nestId}?tab=collaborators`);
    await this.peopleWithAccess.waitFor({ state: 'visible' });
  }

  /** Follow a Collaborators link, without waiting for the tab (it may be withheld). */
  async gotoLink(nestId) {
    this._log(`Following a Collaborators link to nest ${nestId}`);
    await this._open(`/nest/${nestId}?tab=collaborators`);
    await this.backToNests.waitFor({ state: 'visible' });
  }

  /** Open the nest page. */
  async gotoNest(nestId) {
    await this._open(`/nest/${nestId}`);
  }

  /** Open one document of a nest. */
  async gotoDocument(nestId, docId) {
    await this._open(`/nest/${nestId}?doc=${encodeURIComponent(docId)}`);
  }

  /** The entries of the open document's actions menu. */
  async documentMenuItems() {
    await this.documentMenu.click();
    const items = (await this.page.getByRole('menuitem').allInnerTexts()).map((i) => i.trim());
    await this.page.keyboard.press('Escape');
    return items;
  }

  // ── People ─────────────────────────────────────────────────────────────────

  /** One person's row in People with access. */
  row(email) {
    return this.rows.filter({ hasText: email });
  }

  /** The role menu on a person's row (owners and admins only). */
  rowRole(email) {
    return this.row(email).getByRole('combobox');
  }

  /** The Remove access button on a person's row. */
  rowRemove(email) {
    return this.row(email).getByTitle('Remove access');
  }

  /** The Reviewer switch on a person's row (stewardship on). */
  rowReviewer(email) {
    return this.row(email).locator('[data-testid^="collaborator-reviewer-"]');
  }

  /** The roles the add form offers. */
  async grantableRoles() {
    await this.roleSelect.click();
    const roles = (await this.page.getByRole('option').allInnerTexts()).map((r) => r.trim());
    await this.page.keyboard.press('Escape');
    return roles;
  }

  /** Fill the add form and submit it. */
  async addPerson(email, roleLabel = 'Viewer') {
    this._log(`Adding ${email} as ${roleLabel}`);
    if (roleLabel !== 'Viewer') {
      await this.roleSelect.click();
      await this.page.getByRole('option', { name: roleLabel, exact: true }).click();
    }
    await this.personInput.fill(email);
    await this.addButton.click();
  }

  /** Change a person's role from their row. */
  async changeRole(email, roleLabel) {
    this._log(`Changing ${email} to ${roleLabel}`);
    await this.rowRole(email).click();
    await this.page.getByRole('option', { name: roleLabel, exact: true }).click();
  }

  // ── Teams ──────────────────────────────────────────────────────────────────

  /** Share the nest with a team through the Team mode of the add form. */
  async shareTeam(teamName) {
    this._log(`Sharing with team ${teamName}`);
    await this.teamMode.click();
    await this.teamSelect.click();
    await this.page.getByRole('option', { name: teamName }).click();
    await this.shareTeamButton.click();
  }

  /** A team's row under Teams with access. */
  teamRow(teamName) {
    return this.page
      .locator('div.flex.items-center')
      .filter({ hasText: teamName })
      .filter({ has: this.page.getByTitle('Unshare team') })
      .last();
  }

  // ── Visibility ─────────────────────────────────────────────────────────────

  /** Choose a visibility tier from the menu (Private, Organization, Public). */
  async chooseVisibility(label) {
    this._log(`Choosing visibility ${label}`);
    await this.visibilitySelect.click();
    await this.page.getByRole('option', { name: label, exact: true }).click();
  }

  /** The tiers the visibility menu offers. */
  async visibilityOptions() {
    await this.visibilitySelect.click();
    const options = (await this.page.getByRole('option').allInnerTexts()).map((o) => o.trim());
    await this.page.keyboard.press('Escape');
    return options;
  }

  // ── API-only access ────────────────────────────────────────────────────────

  /** Turn API-only access on and wait for the key form. */
  async enableApiOnly() {
    this._log('Turning API-only access on');
    await this.headlessSwitch.click();
    await this.keyLabelInput.waitFor({ state: 'visible', timeout: 60_000 });
  }

  /**
   * Create a key and read it from the one-time panel.
   * @returns {Promise<string>} The key
   */
  async createKey(label) {
    this._log(`Creating API-only key "${label}"`);
    await this.keyLabelInput.fill(label);
    await this.createKeyButton.click();
    await this.freshKey.waitFor({ state: 'visible', timeout: 60_000 });
    const key = (await this.freshKey.innerText()).match(/cnst_[A-Za-z0-9_-]+/)?.[0];
    if (!key) throw new Error('The new key was not shown');
    return key;
  }

  /** Revoke a key from its row. */
  async revokeKey(label) {
    this._log(`Revoking API-only key "${label}"`);
    await this.page.getByRole('button', { name: `Revoke ${label}`, exact: true }).click();
    await this.revokeConfirm.click();
  }
}

export default CollaboratorsPage;
