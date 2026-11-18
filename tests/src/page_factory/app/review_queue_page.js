/**
 * Review Queue Page Object Model — review in My Work
 *
 * Page under test: My Work at /my-work (ui/src/pages/app/my-work/page.tsx).
 * Since #582 the nest page has no Review Queue tab: every change waiting on
 * the caller is listed in My Work, across nests, and clicking a review row
 * opens the review pane beside the list (ui/src/components/MyWorkReviewPane.tsx,
 * which renders ui/src/components/governance/ReviewPane.tsx). An old link to a
 * nest's Review tab — /nest/<id>?tab=review[&review=<nodeId>] — lands on My
 * Work with that change open (the "The review queue is My Work now" effect in
 * ui/src/App.tsx).
 *
 * My Work spans every nest the caller can see, and the accounts are shared
 * with other suites, so everything here is scoped to one nest: `goto(nest)`
 * narrows the page with the nest filter when it is offered, and the row
 * locators only match rows that name the nest ("in <nest> · …").
 *
 * Also here, because the old tab's features moved to them:
 * - the nest's "Your Review Queue" stat card, on the Documents tab
 *   (ui/src/components/NestView.tsx), which now opens My Work;
 * - the nest's Activity tab (ui/src/components/ActivityLogPanel.tsx), which
 *   lists what agents changed;
 * - the My Work count in the header ribbon (ui/src/components/HeaderRibbon.tsx),
 *   which turns red for an urgent review.
 *
 * My Work's rows carry no data-testids; like my_work_page.js, rows are found
 * by their kind badge (span.uppercase) and text.
 */

import logger from '../../helper/logger/logger.js';

class ReviewQueuePage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    /** The nest the page is scoped to; set by goto / gotoLink / gotoReview. */
    this.nestName = null;

    // ── My Work shell ──────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    // The page's own root — rows are scoped to it so nothing else matches.
    this.root = page.locator('div.space-y-4').filter({ has: this.pageTitle }).last();
    this.loader = page.getByText('Loading your work…');
    this.chips = page.getByTestId('my-work-filter-chips');
    this.nestFilter = page.getByTestId('my-work-nest-filter');
    this.allChip = page.getByTestId('my-work-chip-all');
    this.reviewsChip = page.getByTestId('my-work-chip-reviews');
    this.requestsChip = page.getByTestId('my-work-chip-requests');
    this.waitingChip = page.getByTestId('my-work-chip-waiting');
    this.nothingHere = this.root.getByText('Nothing here.', { exact: true });

    // ── Header ribbon ──────────────────────────────────────────────────────
    this.ribbonMyWork = page.getByTestId('header-ribbon-my-work');
    this.ribbonCount = this.ribbonMyWork.locator('span.rounded-full');

    // ── Nest page: Documents tab stat card, Activity tab ───────────────────
    this.statCard = page.getByTestId('nest-stat-review');
    this.statCount = this.statCard.locator('.text-3xl');
    this.statNote = page.getByTestId('nest-stat-review-note');
    this.activityPanel = page.getByTestId('activity-log-panel');
    this.activityRows = page.getByTestId('activity-log-row');
    this.activityAgentFilter = page.getByTestId('activity-log-agent');

    // ── Review pane ────────────────────────────────────────────────────────
    this.paneColumn = page.getByTestId('my-work-review-pane');
    this.pane = page.getByTestId('review-pane');
    this.paneNote = page.getByTestId('review-pane-note');
    this.paneActions = page.getByTestId('review-pane-actions');
    this.readOnlyNote = page.getByTestId('review-pane-readonly');
    this.notWaiting = this.paneColumn.getByText('This change is no longer waiting for review.', { exact: true });
    this.previewTab = page.getByTestId('review-pane-tab-preview');
    this.changesTab = page.getByTestId('review-pane-tab-changes');
    this.publishedTab = page.getByTestId('review-pane-tab-published');
    this.approveButton = page.getByTestId('review-pane-approve');
    this.addComment = this.paneActions.getByRole('button', { name: 'Add a comment', exact: true });
    this.requestChangesButton = page.getByTestId('review-pane-request-changes');
    this.rejectButton = page.getByTestId('review-pane-reject');
    this.noteInput = page.getByTestId('review-pane-note-input');

    // ── Batch bar (My Work's own data-testids) ─────────────────────────────
    this.bulkApprove = page.getByTestId('work-bulk-approve');
    this.bulkReject = page.getByTestId('work-bulk-reject');
    this.selectedLabel = this.root.getByText(/^\d+ selected$/);
    this.reasonInput = page.getByTestId('reason-dialog-input');
    this.reasonConfirm = page.getByTestId('reason-dialog-confirm');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /** Wait for My Work's heading and for its inbox read to land. */
  async _settle() {
    await this.pageTitle.filter({ hasText: 'My Work' }).waitFor({ state: 'visible' });
    await this.loader.waitFor({ state: 'hidden' });
  }

  /**
   * Narrow My Work to one nest. The filter only renders when the inbox spans
   * two nests or more; with one, the page already shows only that nest.
   */
  async _focus(nest) {
    this.nestName = nest.name;
    if ((await this.nestFilter.count()) === 0) return;
    const offered = await this.nestFilter.locator(`option[value="${nest.id}"]`).count();
    if (offered) await this.nestFilter.selectOption(nest.id);
  }

  /**
   * Open My Work, scoped to a nest.
   * @param {{id: string, name: string}} nest
   */
  async goto(nest) {
    this._log(`Opening My Work for nest ${nest.name}`);
    await this.page.goto('/my-work');
    await this._settle();
    await this._focus(nest);
  }

  /**
   * Follow an old link to a nest's Review Queue tab; it lands on My Work.
   * @param {{id: string, name: string}} nest
   */
  async gotoLink(nest) {
    this._log(`Following a Review Queue link to nest ${nest.name}`);
    await this.page.goto(`/nest/${nest.id}?tab=review`);
    await this._settle();
    await this._focus(nest);
  }

  /**
   * Open a shared `?review=` link to one change; it lands on My Work with the
   * change open beside the list (or the pane's "no longer waiting" note).
   * @param {{id: string, name: string}} nest
   * @param {string} nodeId
   */
  async gotoReview(nest, nodeId) {
    this._log(`Opening the review link for ${nodeId}`);
    this.nestName = nest.name;
    await this.page.goto(`/nest/${nest.id}?tab=review&review=${encodeURIComponent(nodeId)}`);
    await this._settle();
    await this.paneColumn.waitFor({ state: 'visible' });
  }

  /** The nest's Documents tab, once the stat cards have their numbers. */
  async gotoDocuments(nestId) {
    this._log(`Opening the Documents tab of nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}?tab=documents`);
    await this.statCount.filter({ hasText: /^\d+$/ }).waitFor({ state: 'visible' });
  }

  /** The nest's Activity tab. */
  async gotoActivity(nestId) {
    this._log(`Opening the Activity tab of nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}?tab=activity`);
    await this.activityPanel.waitFor({ state: 'visible' });
  }

  // ── Rows ───────────────────────────────────────────────────────────────────

  /** Every inbox row (it leads with a kind badge) in the focused nest. */
  get inboxRows() {
    return this.root
      .locator('div.group')
      .filter({ has: this.page.locator('span.uppercase') })
      .filter({ hasText: `in ${this.nestName} ·` });
  }

  /** The review rows waiting on the caller in the focused nest. */
  get rows() {
    return this.inboxRows.filter({
      has: this.page.locator('span.uppercase', { hasText: /^review$/i }),
    });
  }

  /** "Waiting on others" rows (no kind badge) in the focused nest. */
  get waitingRows() {
    return this.root
      .locator('div.group')
      .filter({ hasNot: this.page.locator('span.uppercase') })
      .filter({ hasText: `in ${this.nestName} ·` });
  }

  /** @mentions of the caller in the focused nest (My Work's Mentions block). */
  get mentionRows() {
    return this.page.getByTestId('my-work-mention').filter({ hasText: this.nestName });
  }

  /** One review row, by its document title. */
  row(title) {
    return this.rows.filter({ hasText: title });
  }

  /** One request row (deletion / archive / access), by its reason. */
  requestRow(reason) {
    return this.inboxRows.filter({ hasText: reason });
  }

  /** One "Waiting on others" row, by its title. */
  waitingRow(title) {
    return this.waitingRows.filter({ hasText: title });
  }

  /** One mention row, by the comment's text. */
  mentionRow(text) {
    return this.mentionRows.filter({ hasText: text });
  }

  /** Tick one review row's checkbox. */
  async selectRow(title) {
    await this.row(title).locator('button[role="checkbox"]').click();
  }

  /** The number on a chip: "Reviews (2)" → "2". */
  async chipCount(chip) {
    return (await chip.innerText()).match(/\((\d+)\)/)?.[1] ?? null;
  }

  /** Open a change in the review pane. */
  async openRow(title) {
    this._log(`Opening "${title}" in the review pane`);
    await this.row(title).locator('button.text-left').click();
    await this.pane.filter({ hasText: title }).waitFor({ state: 'visible' });
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

  /** Approve with a comment, from the open pane. */
  async approveWith(comment) {
    await this.addComment.click();
    await this.noteInput.fill(comment);
    await this.approveButton.click();
  }

  /** Request changes with a reason, from the open pane. */
  async requestChanges(reason) {
    await this.requestChangesButton.click();
    await this.noteInput.fill(reason);
    await this.requestChangesButton.click();
  }

  // ── Requests ───────────────────────────────────────────────────────────────

  /** Delete the document a deletion request names. */
  async deleteFromRequest(reason) {
    this._log('Deleting the flagged document');
    await this.requestRow(reason).getByRole('button', { name: 'Delete', exact: true }).click();
    await this.reasonConfirm.click();
  }
}

export default ReviewQueuePage;
