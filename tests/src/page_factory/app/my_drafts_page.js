/**
 * My Drafts Page Object Model
 *
 * Page location: ui/src/pages/app/my-drafts/page.tsx
 * Route: /my-drafts (rail → Work → My Drafts)
 *
 * My Drafts lists every document the caller started and never handed off —
 * unsubmitted drafts, and drafts that came back rejected — across every nest
 * they can see. It has a search box and a sort control (both server-side), a
 * batch bar over the rows (bulk submit / bulk discard), a pager, and opens two
 * dialogs: the governance SubmitForReviewModal and a discard confirmation.
 *
 * The page carries its own `data-testid`s for the search box, the sort
 * buttons, the batch bar and the discard actions; everything else is
 * addressed by role, accessible name or visible text, as in my_work_page.js.
 */

import logger from '../../helper/logger/logger.js';

/** Escape a string for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class MyDraftsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail entry (ui/src/components/DocumentSidebar.tsx) ────────────────
    this.railItem = page.getByTestId('document-sidebar-dashboard-my-drafts');
    // The count pill only renders when there is at least one draft.
    this.railBadge = this.railItem.locator('span.rounded-full');

    // ── Page shell ────────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    // The page's own root — rows are scoped to it so the rail never matches.
    this.root = page
      .locator('div.space-y-4')
      .filter({ has: this.pageTitle })
      .last();
    this.loader = page.getByText('Loading your drafts…');
    this.emptyState = page.getByText(
      "No unsubmitted drafts — everything you've written is in review or approved."
    );
    this.noMatchState = this.root.getByText(/^No drafts match ".*"\.$/);

    // ── Find and order ────────────────────────────────────────────────────
    this.search = page.getByTestId('drafts-search');
    this.sortGroup = page.getByRole('group', { name: 'Sort drafts' });
    this.sortUpdated = page.getByTestId('drafts-sort-updated');
    this.sortTitle = page.getByTestId('drafts-sort-title');

    // ── Rows ──────────────────────────────────────────────────────────────
    // Every draft row is a `group` row; the batch bar is not.
    this.rows = this.root.locator('div.group');
    this.rowTitles = this.rows.locator('button.text-left span.font-medium');

    // ── Batch bar (only when the page holds more than one draft) ──────────
    this.selectAll = page.getByTestId('drafts-select-all');
    this.selectAllLabel = this.root.getByText(/^Select all \d+ on this page$/);
    this.selectedLabel = this.root.getByText(/^\d+ selected$/);
    this.bulkSubmit = page.getByTestId('drafts-bulk-submit');
    this.bulkDiscard = page.getByTestId('drafts-bulk-discard');
    this.clearSelection = this.root.getByRole('button', { name: 'Clear', exact: true });

    // ── Pager ─────────────────────────────────────────────────────────────
    this.prevPage = this.root.getByRole('button', { name: 'Prev' });
    this.nextPage = this.root.getByRole('button', { name: 'Next' });
    this.pageIndicator = this.root.getByText(/^Page \d+ of \d+$/);

    // ── SubmitForReviewModal (ui/src/components/governance/SubmitForReviewModal.tsx)
    this.submitDialog = page.getByRole('dialog', { name: /^Publish .* \(requires approval\)$/ });
    this.submitPriority = page.locator('#priority');
    this.submitNote = page.locator('#note');
    this.submitError = this.submitDialog.getByRole('alert');
    this.submitConfirm = this.submitDialog.getByRole('button', {
      name: 'Submit for approval',
      exact: true,
    });
    this.submitCancel = this.submitDialog.getByRole('button', { name: 'Cancel', exact: true });

    // ── Discard confirmation (AlertDialog in page.tsx) ────────────────────
    this.discardDialog = page.getByRole('alertdialog');
    this.discardConfirm = page.getByTestId('drafts-discard-confirm');
    this.discardCancel = this.discardDialog.getByRole('button', { name: 'Cancel', exact: true });

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /**
   * Open My Drafts directly and wait for the list read to land.
   * @param {{settle?: boolean}} [opts] - `settle: false` returns as soon as
   *   the page heading renders.
   */
  async goto({ settle = true } = {}) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to My Drafts`);
    await this.page.goto('/my-drafts');
    await this.pageTitle.waitFor({ state: 'visible' });
    if (settle) await this.loader.waitFor({ state: 'hidden' });
  }

  /** Open My Drafts from the rail, the way a person gets there. */
  async openFromRail() {
    logger.info('Opening My Drafts from the rail');
    await this.railItem.click();
    await this.pageTitle.filter({ hasText: 'My Drafts' }).waitFor({ state: 'visible' });
  }

  /**
   * Resolve on the page's next list read (the rail badge's `?limit=1` read
   * is not one), optionally only one carrying the given search text.
   * @param {{q?: string}} [opts]
   */
  waitForList({ q } = {}) {
    return this.page.waitForResponse((res) => {
      const url = new URL(res.url());
      if (url.pathname !== '/me/drafts' || url.searchParams.has('limit')) return false;
      return q === undefined || url.searchParams.get('q') === q;
    });
  }

  /**
   * Type into the search box one key at a time, as a person does, and wait
   * for the (debounced) read that carries the whole query.
   * @param {string} text
   * @returns {Promise<{drafts: any[], pagination: any}>} The body the page rendered
   */
  async searchFor(text) {
    logger.info(`Searching drafts for "${text}"`);
    const landed = this.waitForList({ q: text.trim() });
    await this.search.fill('');
    // Typed in one burst: on a loaded shared server the browser can stall
    // between spaced-out keys long enough for the debounce to fire mid-word.
    await this.search.pressSequentially(text, { delay: 0 });
    const body = await (await landed).json();
    await this.loader.waitFor({ state: 'hidden' });
    return body;
  }

  // ── Rows ────────────────────────────────────────────────────────────────

  /** One draft row, located by its (unique) title. */
  row(title) {
    return this.rows.filter({ hasText: title });
  }

  /** The row's status badge: Draft / Rejected. */
  rowBadge(title) {
    return this.row(title).locator('span.uppercase').first();
  }

  /** The row's title button — opens the document. */
  rowOpen(title) {
    return this.row(title).locator('button.text-left');
  }

  /** The line under the title: "<nest>[ / <folder>] · edited <when>". */
  rowLocation(title) {
    return this.rowOpen(title).locator('span.text-xs');
  }

  /** The row's selection checkbox (only when the page holds 2+ drafts). */
  rowCheckbox(title) {
    return this.row(title).getByRole('checkbox', { name: `Select ${title}`, exact: true });
  }

  /**
   * The row's Submit for review. `exact` matters: the title button is named
   * after the document, so a title containing "submit" would match too.
   */
  rowSubmit(title) {
    return this.row(title).getByRole('button', { name: 'Submit for review', exact: true });
  }

  /** The row's discard (trash) button. */
  rowDiscard(title) {
    return this.row(title).getByTestId('draft-discard');
  }

  /** Every row title on the page, top to bottom. */
  async titlesInOrder() {
    return this.rowTitles.allTextContents();
  }

  // ── SubmitForReviewModal ────────────────────────────────────────────────

  /**
   * The submit dialog, located by its exact title.
   * @param {string} title - e.g. `Publish “Doc” (requires approval)`
   */
  submitDialogTitled(title) {
    return this.page.getByRole('dialog', { name: new RegExp(`^${escapeRegExp(title)}$`) });
  }

  /**
   * Pick a priority in the dialog's Radix select.
   * @param {'Low'|'Normal'|'High'|'Urgent'} label
   */
  async choosePriority(label) {
    await this.submitPriority.click();
    await this.page.getByRole('option', { name: label, exact: true }).click();
  }

  // ── Toasts ──────────────────────────────────────────────────────────────

  /** A toast carrying the given text. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default MyDraftsPage;
