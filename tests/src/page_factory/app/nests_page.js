/**
 * Nests Dashboard Page Object Model
 *
 * Page location: ui/src/pages/app/nests/page.tsx
 * Route: / (default authenticated landing page)
 *
 * The nests dashboard is the Community Dashboard: the server-info banner, the
 * whole-brain "Connect all my nests" strip, the create/import actions, the
 * nest-card grid with its filter/scope/sort controls, pending invites,
 * unsynced-folder cards, and the archived list behind a switch.
 *
 * Only a handful of elements carry `data-testid` (see tests/TEST_IDS.md); the
 * rest are addressed by role, accessible name or the `aria-label` the UI
 * already puts on every card action — stable contracts that don't need the UI
 * touched to be testable.
 */

import logger from '../../helper/logger/logger.js';

class NestsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // Always-present page heading (ui/src/components/ui/page-title.tsx)
    this.pageTitle = page.getByTestId('page-title');

    // ── Server info banner ────────────────────────────────────────────────
    this.serverBanner = page
      .locator('div')
      .filter({ has: page.getByText('Your Community Server', { exact: true }) })
      .last();
    this.serverUrlCode = this.serverBanner.locator('code').first();
    // CopyInline (page.tsx) — an icon-only button beside the URL, no label.
    this.copyServerUrl = this.serverBanner.locator('button').first();
    this.nestCountStat = page
      .locator('div')
      .filter({ has: page.getByText('Nests', { exact: true }) })
      .last();
    this.bannerCounts = page.locator('div.text-2xl.font-bold');
    this.bannerNestCount = this.bannerCounts.nth(0);
    this.bannerDocumentCount = this.bannerCounts.nth(1);
    // CountSkeleton (ui/src/components/ui/count-skeleton.tsx)
    this.countSkeletons = page.locator('span.animate-pulse');
    // Grid loader — the plain "Loading..." block the nest grid shows cold.
    this.gridLoader = page.getByText('Loading...', { exact: true });

    // ── Whole-brain bar (ui/src/components/AllNestsBar.tsx) ───────────────
    this.wholeBrainBar = page.getByRole('heading', { name: 'Your whole brain' });
    this.wholeBrainSummary = page.getByText(/nests? · .* documents? — connect an AI/);
    this.connectAllButton = page.getByRole('button', { name: 'Connect all my nests' });
    this.connectDialog = page.getByRole('dialog', { name: 'Connect all my nests' });
    this.connectEndpoint = this.connectDialog.locator('code').first();
    this.copyEndpointButton = this.connectDialog.getByRole('button', { name: 'Copy endpoint' });
    this.copyPromptButton = this.connectDialog.getByRole('button', {
      name: /Copy "chat with all my nests"/,
    });
    this.manageKeysButton = this.connectDialog.getByRole('button', { name: 'Manage API keys' });

    // ── Header actions ────────────────────────────────────────────────────
    // exact: a nest card is a role=button named after the nest, so a nest
    // called "Nest new" also matches a substring query.
    this.newNestButton = page.getByRole('button', { name: 'New Nest', exact: true });
    this.importFolderButton = page.getByRole('button', { name: 'Import Folder' });

    // ── Create-nest dialog ────────────────────────────────────────────────
    this.createDialog = page.getByRole('dialog', { name: 'New nest' });
    this.createNameInput = this.createDialog.getByPlaceholder('Team Knowledge');
    this.createDescInput = this.createDialog.getByPlaceholder(
      'Shared docs for the engineering team'
    );
    this.createSubmit = this.createDialog.getByRole('button', { name: 'Create Nest' });
    this.createCancel = this.createDialog.getByRole('button', { name: 'Cancel' });
    this.createError = this.createDialog.locator('p.text-destructive');

    // ── Import-folder modal (ui/src/components/ImportFolderModal.tsx) ─────
    this.importDialog = page.getByRole('dialog', { name: 'Import into a new nest' });

    // ── Filter / sort controls ────────────────────────────────────────────
    // NOTE: the filter bar renders whatever the nest count, but only while
    // archived is off — use pageTitle as the loaded-landmark, not these.
    this.filterInput = page.getByTestId('nest-filter-input');
    this.scopeSelect = page.getByTestId('nest-scope-select');
    this.sortSelect = page.getByTestId('nest-sort-select');
    this.clearFilters = page.getByTestId('nest-clear-filters');
    this.filterSummary = page.getByText(/^\d+ of \d+$/).first();

    // ── Grid empty states ─────────────────────────────────────────────────
    this.noMatchesState = page.getByText('Nothing matches this filter');
    // Two buttons carry this label when the grid is empty — the ghost one in
    // the filter bar and the empty state's own CTA, which comes later in the
    // DOM. This is the empty state's.
    this.clearFiltersCta = page.getByRole('button', { name: 'Clear filters' }).last();
    this.noNestsState = page.getByText('No nests yet');
    this.createFirstNestButton = page.getByRole('button', { name: 'Create First Nest' });
    this.askAdminState = page.getByText("You don't have access to any nests yet.");
    this.discoveredState = page.getByText('No nests of your own yet');
    this.browseDiscovered = page.getByTestId('nest-browse-discovered');
    this.showMore = page.getByTestId('nest-show-more');

    // ── Pending invites ───────────────────────────────────────────────────
    this.pendingInvitesCard = page
      .locator('div')
      .filter({ has: page.getByText('Pending invites', { exact: true }) })
      .last();

    // ── Archived section ──────────────────────────────────────────────────
    this.archivedSwitch = page.getByTestId('nest-archived-switch');
    this.archivedSection = page.getByTestId('archived-nests');
    this.archivedFilterInput = page.getByTestId('archived-filter-input');
    this.archivedSortSelect = page.getByTestId('archived-sort-select');
    this.archivedClearFilter = page.getByTestId('archived-clear-filter');
    this.archivedEmptyState = page.getByText('No archived nests');
    this.archivedLoader = page.getByText('Loading archived nests…');

    // ── Dialogs opened from a card ────────────────────────────────────────
    this.renameDialog = page.getByRole('dialog', { name: 'Rename nest' });
    this.renameNameInput = page.locator('#rename-nest-name');
    this.renameDescInput = page.locator('#rename-nest-description');
    this.renameSave = this.renameDialog.getByRole('button', { name: 'Save' });
    this.renameCancel = this.renameDialog.getByRole('button', { name: 'Cancel' });
    this.renameError = this.renameDialog.getByRole('alert');

    this.deleteDialog = page.getByRole('dialog', { name: 'Delete nest' });
    this.deleteConfirmInput = page.locator('#delete-nest-confirm');
    this.deleteSubmit = this.deleteDialog.getByRole('button', { name: 'Delete nest' });
    this.deleteCancel = this.deleteDialog.getByRole('button', { name: 'Cancel' });
    this.archiveInstead = page.getByTestId('archive-nest');
    this.importedFolderNotice = this.deleteDialog.getByText(
      /Your original imported folder is not affected/
    );

    // ReasonDialog (ui/src/components/governance) — an editor's request-removal
    this.reasonDialog = page.getByRole('dialog').filter({ hasText: 'Request removal of' });
    this.reasonInput = page.getByTestId('reason-dialog-input');
    this.reasonConfirm = page.getByTestId('reason-dialog-confirm');
    this.reasonSecondary = page.getByTestId('reason-dialog-secondary');

    this.restoreDialog = page.getByRole('alertdialog').filter({ hasText: /^Restore/ });
    this.restoreConfirm = this.restoreDialog.getByRole('button', { name: 'Restore nest' });
    this.restoreCancel = this.restoreDialog.getByRole('button', { name: 'Cancel' });

    this.discardFolderDialog = page.getByRole('dialog', { name: 'Delete folder' });
    this.discardFolderConfirm = this.discardFolderDialog.getByRole('button', {
      name: 'Delete folder',
    });
    this.discardFolderCancel = this.discardFolderDialog.getByRole('button', { name: 'Cancel' });

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /**
   * Navigate to the nests dashboard (authenticated root)
   */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to nests dashboard`);
    await this.page.goto('/');
    await this.pageTitle.waitFor({ state: 'visible' });
    logger.info('Nests dashboard loaded');
  }

  /**
   * Reload the dashboard and wait for it to settle.
   */
  async reload() {
    await this.page.reload();
    await this.pageTitle.waitFor({ state: 'visible' });
  }

  /**
   * Whether the dashboard has rendered
   * @returns {Promise<boolean>}
   */
  async isLoaded() {
    try {
      return await this.pageTitle.isVisible({ timeout: 5000 });
    } catch (_) {
      return false;
    }
  }

  // ── Nest cards ──────────────────────────────────────────────────────────

  /** The card grid's nest headings, in render order. */
  get nestCardHeadings() {
    return this.page.locator('div[role="button"][tabindex="0"] h3');
  }

  /**
   * One nest card, located by its exact heading text.
   * @param {string} name
   */
  nestCard(name) {
    return this.page
      .locator('div[role="button"][tabindex="0"]')
      .filter({ has: this.page.getByRole('heading', { level: 3, name, exact: true }) });
  }

  /** The heading inside a nest card — carries the full name in `title`. */
  nestCardName(name) {
    return this.nestCard(name).locator('h3').first();
  }

  /** The description paragraph inside a nest card — truncated, full in `title`. */
  nestCardDescription(name) {
    return this.nestCard(name).locator('p[title]').first();
  }

  /**
   * Per-card actions are labelled with the nest name, so they're unambiguous —
   * but `exact` matters: the card wrapper is itself a `role="button"` whose
   * computed name concatenates the heading and every inner aria-label, so a
   * substring match would resolve to the card as well as the icon.
   */
  renameIcon(name) {
    return this.page.getByRole('button', { name: `Rename nest ${name}`, exact: true });
  }

  deleteIcon(name) {
    return this.page.getByRole('button', { name: `Delete nest ${name}`, exact: true });
  }

  requestRemovalIcon(name) {
    return this.page.getByRole('button', {
      name: `Request removal of nest ${name}`,
      exact: true,
    });
  }

  pinIcon(name) {
    return this.page.getByRole('button', { name: `Pin nest ${name}`, exact: true });
  }

  unpinIcon(name) {
    return this.page.getByRole('button', { name: `Unpin nest ${name}`, exact: true });
  }

  /** Either state of the bookmark button, for asserting presence regardless. */
  pinToggle(name) {
    return this.pinIcon(name).or(this.unpinIcon(name));
  }

  /** A badge or chip rendered inside a nest card ("Imported", "Viewer", …). */
  cardBadge(name, label) {
    return this.nestCard(name).getByText(label, { exact: true });
  }

  /** "Shared by <owner>" provenance line on a shared nest card. */
  sharedByLine(name) {
    return this.nestCard(name).getByText(/Shared by/);
  }

  /** "Imported by you · <date>" provenance line on an imported nest card. */
  importedByLine(name) {
    return this.nestCard(name).getByText(/Imported by/);
  }

  /** Collaborator / steward overflow chip ("+1"). */
  overflowChip(name, count) {
    return this.nestCard(name).getByText(`+${count}`, { exact: true });
  }

  /**
   * Names of every nest card currently rendered, in grid order.
   * @returns {Promise<string[]>}
   */
  async visibleNestNames() {
    return (await this.nestCardHeadings.allTextContents()).map((t) => t.trim());
  }

  /** How many nest cards are rendered. */
  async nestCardCount() {
    return this.nestCardHeadings.count();
  }

  /**
   * Open a nest by card click. The SPA navigates to /nest/<id>.
   * @param {string} name
   */
  async openNest(name) {
    logger.info(`Opening nest: ${name}`);
    await this.nestCard(name).click();
  }

  /**
   * Open a nest from the keyboard — the card is a focusable role="button"
   * that handles Enter and Space.
   * @param {string} name
   * @param {'Enter'|' '} [key]
   */
  async openNestWithKeyboard(name, key = 'Enter') {
    logger.info(`Opening nest with ${key === ' ' ? 'Space' : 'Enter'}: ${name}`);
    const card = this.nestCard(name);
    await card.focus();
    await card.press(key);
  }

  // ── Create / import ─────────────────────────────────────────────────────

  /** Open the New Nest dialog. */
  async openCreateDialog() {
    await this.newNestButton.click();
    await this.createDialog.waitFor({ state: 'visible' });
  }

  /**
   * Fill the create form without submitting — for the validation cases.
   * @param {string} name
   * @param {string} [description]
   */
  async fillCreateForm(name, description = '') {
    await this.createNameInput.fill(name);
    if (description) await this.createDescInput.fill(description);
  }

  /**
   * Create a nest through the dialog. The app opens the new nest on success.
   * @param {string} name
   * @param {string} [description]
   */
  async createNest(name, description = '') {
    logger.info(`Creating nest via dialog: ${name}`);
    await this.openCreateDialog();
    await this.fillCreateForm(name, description);
    await this.createSubmit.click();
  }

  /** Open the Import Folder modal. */
  async openImportDialog() {
    await this.importFolderButton.click();
    await this.importDialog.waitFor({ state: 'visible' });
  }

  // ── Filter / scope / sort ───────────────────────────────────────────────

  /**
   * Filter the nest list by name or description
   * @param {string} text - Filter text
   */
  async filterByName(text) {
    logger.info(`Filtering nests by: ${text}`);
    await this.filterInput.fill(text);
  }

  /**
   * Pick an access scope.
   * @param {'mine'|'all'|'owned'|'shared'|'org'|'public'|'synced'|'unsynced'} value
   */
  async selectScope(value) {
    logger.info(`Selecting nest scope: ${value}`);
    await this.scopeSelect.selectOption(value);
  }

  /**
   * Pick a sort order.
   * @param {'activity'|'name'} value
   */
  async selectSort(value) {
    logger.info(`Selecting nest sort: ${value}`);
    await this.sortSelect.selectOption(value);
  }

  /** The scope the select currently holds. */
  async currentScope() {
    return this.scopeSelect.inputValue();
  }

  /** The sort the select currently holds. */
  async currentSort() {
    return this.sortSelect.inputValue();
  }

  // ── Card actions ────────────────────────────────────────────────────────

  /**
   * Rename a nest from its card.
   * @param {string} name - Current name
   * @param {string} newName
   */
  async renameNest(name, newName) {
    logger.info(`Renaming nest ${name} → ${newName}`);
    await this.renameIcon(name).click();
    await this.renameDialog.waitFor({ state: 'visible' });
    await this.renameNameInput.fill(newName);
    await this.renameSave.click();
    await this.renameDialog.waitFor({ state: 'hidden' });
  }

  /**
   * Pin a nest from its card (bookmark button).
   * @param {string} name
   */
  async pinNest(name) {
    logger.info(`Pinning nest: ${name}`);
    await this.pinIcon(name).click();
  }

  /**
   * Unpin a nest from its card.
   * @param {string} name
   */
  async unpinNest(name) {
    logger.info(`Unpinning nest: ${name}`);
    await this.unpinIcon(name).click();
  }

  /**
   * Open the delete dialog from a nest card.
   * @param {string} name
   */
  async openDeleteDialog(name) {
    await this.deleteIcon(name).click();
    await this.deleteDialog.waitFor({ state: 'visible' });
  }

  /**
   * Delete a nest through the type-to-confirm dialog.
   * @param {string} name
   */
  async deleteNest(name) {
    logger.info(`Deleting nest: ${name}`);
    await this.openDeleteDialog(name);
    await this.deleteConfirmInput.fill(name);
    await this.deleteSubmit.click();
    await this.deleteDialog.waitFor({ state: 'hidden' });
  }

  /**
   * Archive a nest from the delete dialog's "Archive instead" action.
   * @param {string} name
   */
  async archiveNest(name) {
    logger.info(`Archiving nest: ${name}`);
    await this.openDeleteDialog(name);
    await this.archiveInstead.click();
    await this.deleteDialog.waitFor({ state: 'hidden' });
  }

  // ── Archived list ───────────────────────────────────────────────────────

  /**
   * Flip the Archived switch on or off.
   * @param {boolean} on
   */
  async toggleArchived(on) {
    const checked = (await this.archivedSwitch.getAttribute('data-state')) === 'checked';
    if (checked !== on) {
      logger.info(`Toggling archived view ${on ? 'on' : 'off'}`);
      await this.archivedSwitch.click();
    }
    if (on) await this.archivedSection.waitFor({ state: 'visible' });
  }

  /** One row of the archived list, located by the nest name it carries. */
  archivedRow(name) {
    return this.archivedSection
      .locator('div[role="button"][tabindex="0"]')
      .filter({ hasText: name });
  }

  /** Restore button on an archived row (owner only). */
  archivedRestore(name) {
    return this.archivedRow(name).getByTestId('restore-nest');
  }

  /** Delete (bin) button on an archived row (owner only). */
  archivedDelete(name) {
    return this.archivedRow(name).locator('button').last();
  }

  /** Names in the archived list, in render order. */
  async archivedNames() {
    const rows = this.archivedSection.locator('div[role="button"][tabindex="0"] div.font-medium');
    return (await rows.allTextContents()).map((t) => t.trim());
  }

  /**
   * Restore an archived nest through its confirmation dialog.
   * @param {string} name
   */
  async restoreNest(name) {
    logger.info(`Restoring archived nest: ${name}`);
    await this.archivedRestore(name).click();
    await this.restoreDialog.waitFor({ state: 'visible' });
    await this.restoreConfirm.click();
    await this.restoreDialog.waitFor({ state: 'hidden' });
  }

  // ── Pending invites ─────────────────────────────────────────────────────

  /**
   * One pending-invite row, located by nest name. The row's text also carries
   * the invite message and both buttons, so the name is matched as a substring
   * — AUTO_ names are unique enough for that to be unambiguous.
   */
  inviteRow(name) {
    return this.pendingInvitesCard
      .locator('div.rounded-md.border')
      .filter({ hasText: name })
      .first();
  }

  inviteAccept(name) {
    return this.inviteRow(name).getByRole('button', { name: 'Accept' });
  }

  inviteDecline(name) {
    return this.inviteRow(name).getByRole('button', { name: 'Decline' });
  }

  // ── Unsynced folders ────────────────────────────────────────────────────

  /**
   * One unsynced-folder card. Matched by the folder path it prints plus the
   * Sync action, so it never collides with an anonymous nest's dashed card.
   * @param {string} folderName - The folder's `name` (path) as the card shows it
   */
  unsyncedCard(folderName) {
    return this.page
      .locator('div.border-dashed')
      .filter({ hasText: folderName })
      .filter({ has: this.page.getByRole('button', { name: /Sync/ }) });
  }

  unsyncedSync(folderName) {
    return this.unsyncedCard(folderName).getByRole('button', { name: /Sync/ });
  }

  unsyncedDelete(folderName) {
    return this.unsyncedCard(folderName).getByRole('button', { name: 'Delete' });
  }

  /** Inline error shown on an unsynced card when a sync or delete fails. */
  unsyncedError(folderName) {
    return this.unsyncedCard(folderName).getByRole('alert');
  }
}

export default NestsPage;
