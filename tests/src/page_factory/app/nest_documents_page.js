/**
 * Nest Documents Page Object Model
 *
 * Page under test: the nest's Documents tab (ui/src/components/nest/DocumentsTab.tsx,
 * with the bulk bar in ui/src/components/nest/BulkSelectionBar.tsx). It has a
 * search box, filters (status on a governed nest, type when there is more than
 * one, author when there is more than one, last edited), a sort, list and card
 * views, saved filters, a tag bar, the folder tree with its header actions,
 * per-document actions and multi-select bulk actions.
 *
 * Folder headers carry no expanded state: a folder's documents show once its
 * header is clicked. Row and folder actions show on hover. Tags show with "#".
 */

import logger from '../../helper/logger/logger.js';

class NestDocumentsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── Toolbar ───────────────────────────────────────────────────────────
    this.search = this.main.getByPlaceholder('Search title, tags, content…');
    this.typeFilter = this.main.locator('button[title="Filter by type"]');
    this.statusFilter = this.main.getByRole('combobox').filter({ hasText: /^(All Status|Draft|Pending|Published|Rejected)$/ });
    this.sortSelect = this.main.locator('button[title="Sort documents"]');
    this.listViewButton = this.main.locator('button[title="List view"]');
    this.cardViewButton = this.main.locator('button[title="Card view"]');

    // ── Active filters, saved filters, tag bar ────────────────────────────
    this.removeFilterButtons = this.main.locator('button[title="Remove this filter"]');
    this.clearAllButton = this.main.getByRole('button', { name: 'Clear all', exact: true });
    this.saveFilterButton = this.main.getByRole('button', { name: 'Save filter', exact: true });
    this.saveFilterDialog = page.getByRole('dialog', { name: 'Save this filter' });
    this.saveFilterName = this.saveFilterDialog.getByPlaceholder('Filter name (e.g. My drafts)');
    this.removeTagFiltersButton = this.main.locator('button[title="Remove tag filters"]');

    // ── List ──────────────────────────────────────────────────────────────
    this.rows = this.main.locator('[data-testid^="document-row-"]');
    this.folderHeaders = this.main.locator('[data-testid^="folder-header-"]');
    this.selectAll = this.main.getByTestId('select-all-docs');
    this.rowCheckboxes = this.rows.locator('[role="checkbox"]');

    // ── Bulk bar and its dialog (ui/src/components/nest/BulkSelectionBar.tsx) ──
    this.bulkBar = page.getByTestId('bulk-bar');
    this.bulkMove = page.getByTestId('bulk-move');
    this.bulkTag = page.getByTestId('bulk-tag');
    this.bulkDelete = page.getByTestId('bulk-delete');
    this.bulkMoveSelect = page.getByTestId('bulk-move-select');
    this.bulkAddTags = page.getByTestId('bulk-add-tags');
    this.bulkConfirm = page.getByTestId('bulk-confirm');

    // ── Dialogs ───────────────────────────────────────────────────────────
    this.moveDialog = page.getByRole('dialog', { name: 'Move to folder' });
    this.renameDialog = page.getByRole('dialog', { name: /^Rename or move/ });
    this.renameName = page.locator('#folder-move-name');
    this.submitDialog = page.getByRole('dialog', { name: /\(requires approval\)$/ });
    this.reasonInput = page.getByTestId('reason-dialog-input');
    this.reasonConfirm = page.getByTestId('reason-dialog-confirm');
    this.editorTitle = this.main.getByPlaceholder('Untitled');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open a nest's page on the Documents tab and wait for its search box. */
  async gotoDocuments(nestId) {
    this._log(`Opening the Documents tab of nest ${nestId}`);
    // Ready means the tab can be clicked; dev's full "load" event can lag far behind.
    await this.page.goto(`/nest/${nestId}`, { waitUntil: 'domcontentloaded' });
    await this.page.getByRole('tab', { name: 'Documents', exact: true }).click({ timeout: 60_000 });
    await this.search.waitFor({ state: 'visible', timeout: 60_000 });
  }

  // ── Toolbar ─────────────────────────────────────────────────────────────

  /** Open a select (type, status, sort) and pick an option by its label. */
  async choose(trigger, option) {
    await trigger.click();
    await this.page.getByRole('option', { name: option, exact: true }).click();
  }

  /** The active filter chips ("Search: Beta", "Type: Artifact", …). */
  async activeChips() {
    return (await this.removeFilterButtons.locator('xpath=..').allInnerTexts()).map((t) => t.trim());
  }

  /** A tag in the tag bar ("finance" → "#finance"). */
  tagFilter(tag) {
    return this.main.locator(`button[title="Filter by #${tag}"]`).first();
  }

  /** A saved filter's chip, and its delete button. */
  savedFilter(name) {
    return this.main.locator(`button[title='Apply saved filter "${name}"']`);
  }

  deleteSavedFilter(name) {
    return this.main.locator(`button[title='Delete saved filter "${name}"']`);
  }

  /** Save the current filters under `name`. */
  async saveFilter(name) {
    this._log(`Saving filter ${name}`);
    await this.saveFilterButton.click();
    await this.saveFilterName.fill(name);
    await this.saveFilterDialog.getByRole('button', { name: 'Save filter', exact: true }).click();
    await this.saveFilterDialog.waitFor({ state: 'hidden' });
  }

  // ── List ────────────────────────────────────────────────────────────────

  /** The ids of the listed documents, top to bottom ("nodes/guides/gamma-guide"). */
  async rowIds() {
    return this.rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('document-row-', '')));
  }

  /** The ids of the listed documents whose box is ticked. */
  async tickedIds() {
    return this.rows.evaluateAll((els) =>
      els
        .filter((e) => e.querySelector('[role="checkbox"][data-state="checked"]'))
        .map((e) => e.getAttribute('data-testid').replace('document-row-', ''))
    );
  }

  /** A document's row by its id ("nodes/alpha-plan"). */
  row(id) {
    return this.main.getByTestId(`document-row-${id}`);
  }

  /** The titles of a row's action buttons ("Edit", "History", …), hovering it first. */
  async rowActionTitles(id) {
    await this.row(id).hover();
    return this.row(id).locator('button[title]').evaluateAll((b) => b.map((x) => x.title).filter((t) => !t.startsWith('Filter by #')));
  }

  /** Hover a row and click one of its actions by title ("Edit", "History"). */
  async clickRowAction(id, title) {
    this._log(`${id}: ${title}`);
    await this.row(id).hover();
    await this.row(id).locator(`button[title="${title}"]`).click();
  }

  /** The row's Move / Delete buttons (hover-revealed, so clicked with force). */
  moveButton(id) {
    return this.main.getByTestId(`move-node-${id}`);
  }

  deleteButton(id) {
    return this.main.getByTestId(`delete-node-${id}`);
  }

  // ── Folders ─────────────────────────────────────────────────────────────

  /** A folder's header by its path ("guides", "guides/advanced"). */
  folderHeader(path) {
    return this.main.getByTestId(`folder-header-${path}`);
  }

  /** The labels of a folder header's actions ("Rename or move Guides", …), hovering it first. */
  async folderActionLabels(path) {
    await this.folderHeader(path).hover();
    return this.folderHeader(path)
      .locator('xpath=..')
      .locator('button[title], button[aria-label]')
      .evaluateAll((b) => b.map((x) => x.getAttribute('aria-label') || x.title));
  }

  /** Hover a folder header and click one of its actions by label. */
  async clickFolderAction(path, label) {
    this._log(`${path}: ${label}`);
    await this.folderHeader(path).hover();
    await this.folderHeader(path).locator('xpath=..').locator(`button[aria-label="${label}"], button[title="${label}"]`).first().click();
  }

  /** A folder's select box (shown once the folder is open). */
  selectFolder(path) {
    return this.main.getByTestId(`select-folder-${path}`);
  }

  // ── Dialogs ─────────────────────────────────────────────────────────────

  /** The delete confirmation for a document ('Delete "Alpha Plan"?'). */
  deleteDialog(title) {
    return this.page.getByRole('dialog', { name: `Delete "${title}"?` });
  }

  /** The deletion request an editor gets instead ('Request deletion of "Alpha Plan"'). */
  requestDeletionDialog(title) {
    return this.page.getByRole('dialog', { name: `Request deletion of "${title}"` });
  }

  /** The version history dialog for a document. */
  historyDialog(title) {
    return this.page.getByRole('dialog').filter({ hasText: 'Version History' }).filter({ hasText: title });
  }

  /** A toast carrying `text`. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default NestDocumentsPage;
