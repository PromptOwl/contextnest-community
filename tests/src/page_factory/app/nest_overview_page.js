/**
 * Nest Overview Page Object Model
 *
 * Page under test: the nest's Overview tab (ui/src/components/nest/OverviewTab.tsx,
 * rules in ui/src/lib/nest-overview.ts). It shows the nest description, a facts
 * line (documents, folders, edited this week and, on a governed nest, AI ready
 * and pending review), the Contents tree and a Recently edited card. A nest with
 * neither documents nor folders shows "Add the first page" instead.
 *
 * In the Contents tree a folder with documents expands in place; an empty one
 * opens in the Documents tab. A folder row's actions (New document in, Open in
 * Documents, Delete) show on hover. Past 5 documents a group ends in "View all N".
 */

import logger from '../../helper/logger/logger.js';

class NestOverviewPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');
    this.selectedTab = page.getByRole('tab', { selected: true }).first();

    // ── Overview ──────────────────────────────────────────────────────────
    this.overview = this.main.locator('section[aria-labelledby="nest-overview-heading"]');
    this.facts = this.main.getByTestId('nest-overview-facts');
    this.contents = page.getByRole('navigation', { name: 'Contents' });
    this.recent = this.main.locator('aside[aria-labelledby="nest-overview-recent"]');

    // ── Empty nest ────────────────────────────────────────────────────────
    this.emptyDescription = this.main.getByTestId('nest-overview-description');
    this.emptyHeading = this.overview.getByRole('heading', { name: 'Add the first page' });
    this.dropHint = this.overview.getByText('You can also drop files anywhere on this page.');

    // ── Where the Overview's actions lead ─────────────────────────────────
    this.documentRows = this.main.locator('[data-testid^="document-row-"]');
    this.allDocumentsCrumb = this.main.getByRole('button', { name: 'All documents', exact: true });
    this.editorTitle = this.main.getByPlaceholder('Untitled');
    this.importDialog = page.getByRole('dialog', { name: 'Import into this nest' });
    this.addWithAiDialog = page.getByRole('dialog', { name: /^Generate & add context to / });
    this.dialogConfirm = page.getByTestId('reason-dialog-confirm');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open a nest's page and wait for its Overview (the Contents tree or the empty-nest options). */
  async gotoNest(nestId) {
    this._log(`Opening nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}`);
    await this.overview.waitFor({ state: 'visible', timeout: 60_000 });
  }

  /** A nest tab by its label (Overview, Documents, …). */
  tab(name) {
    return this.page.getByRole('tab', { name, exact: true });
  }

  // ── Facts line ──────────────────────────────────────────────────────────

  /** The facts, one entry each ("6 documents", "3 folders", …). */
  async factTexts() {
    return (await this.facts.locator(':scope > *').allInnerTexts()).map((t) => t.trim());
  }

  /** A fact that is a link (e.g. "1 pending review"). */
  factLink(text) {
    return this.facts.getByRole('button', { name: text, exact: true });
  }

  // ── Contents tree ───────────────────────────────────────────────────────

  /** A folder's row, by the name the tree shows ("Guides"). */
  folderRow(label) {
    return this.contents.getByRole('button', { name: label, exact: true });
  }

  /** The row's document count ("4 documents"). */
  folderCount(label) {
    return this.folderRow(label).locator('xpath=..').locator('[aria-label$=" document"], [aria-label$=" documents"]');
  }

  /** A document's row, by its title. */
  docRow(title) {
    return this.contents.locator(`button[title="${title}"]`);
  }

  /** The type label on a document's row ("HTML", "Agent", "Skill"). */
  typeLabel(title) {
    return this.docRow(title).locator('span.uppercase');
  }

  /** The "View all N" row that ends a capped group. */
  viewAllRow() {
    return this.contents.getByRole('button', { name: /^View all \d+$/ });
  }

  /** A folder row action by its label ("Open Guides in Documents"). */
  folderAction(action) {
    return this.contents.getByRole('button', { name: action, exact: true });
  }

  /** Hover a folder's row and click one of its actions. */
  async clickFolderAction(label, action) {
    this._log(`${label}: ${action}`);
    await this.folderRow(label).hover();
    await this.folderAction(action).click();
  }

  /** Open a folder that holds documents (an empty folder's row opens Documents instead). */
  async expandFolder(label) {
    const row = this.folderRow(label);
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  }

  // ── Recently edited ─────────────────────────────────────────────────────

  /** The documents in the Recently edited card, top to bottom. */
  recentItems() {
    return this.recent.getByRole('button');
  }

  /** Their titles, top to bottom. */
  async recentTitles() {
    return this.recentItems().evaluateAll((items) => items.map((b) => b.getAttribute('title')));
  }

  // ── Empty nest ──────────────────────────────────────────────────────────

  /** One of the empty nest's options ("New document", "Import files", "Add with AI"). */
  emptyAction(title) {
    return this.overview.getByRole('button', { name: title });
  }

  // ── Delete folder ───────────────────────────────────────────────────────

  /** The delete dialog for a folder ('Delete "Notes"?'). */
  deleteDialog(label) {
    return this.page.getByRole('dialog', { name: `Delete "${label}"?` });
  }

  /** A toast carrying `text`. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default NestOverviewPage;
