/**
 * Review Queue Page Object Model
 *
 * Page under test: the nest page's Review Queue tab at /nest/<id>?tab=review
 * (ui/src/components/nest/ReviewTab.tsx). It holds the filter chips, the
 * caller's own submissions, deletion requests, the bulk bar and the queue
 * (ui/src/components/governance/ReviewQueue.tsx). Clicking a row opens the
 * review pane beside the queue and adds `?review=<nodeId>` to the URL
 * (ui/src/components/governance/ReviewPane.tsx).
 *
 * The All chip lists changes and comments newest first; the Changes chip keeps
 * the server's order, which is by priority.
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

    // ── Nest page ──────────────────────────────────────────────────────────
    this.backToNests = page.getByTitle('Back to nests');
    this.reviewTab = page.getByRole('tab', { name: /^Review Queue/ });
    this.statCard = page.getByTestId('nest-stat-review');
    this.statCount = this.statCard.locator('.text-3xl');

    // ── Filter chips ───────────────────────────────────────────────────────
    this.chips = page.getByTestId('feed-filter-chips');
    this.allChip = page.getByTestId('feed-filter-all');
    this.changesChip = page.getByTestId('feed-filter-changes');
    this.commentsChip = page.getByTestId('feed-filter-comments');
    this.agentsChip = page.getByTestId('feed-filter-agents');

    // ── Queue ──────────────────────────────────────────────────────────────
    this.rows = page.getByTestId('review-queue-row');
    this.commentRows = page.getByTestId('feed-comment-item');
    this.emptyState = page.getByText('Nothing needs your review', { exact: true });
    this.nothingForYou = page.getByText(/pending reviews? in this nest, but/);

    // ── Submitted by you ───────────────────────────────────────────────────
    this.submittedHeading = page.getByText('Submitted by you — awaiting review', { exact: true });
    this.awaitingBadge = page.getByText('Awaiting review', { exact: true });
    this.withdrawButton = page.getByRole('button', { name: 'Withdraw', exact: true });

    // ── Review pane ────────────────────────────────────────────────────────
    this.pane = page.getByTestId('review-pane');
    this.paneActions = page.getByTestId('review-pane-actions');
    this.readOnlyNote = page.getByTestId('review-pane-readonly');
    this.staleBanner = page.getByTestId('review-pane-stale');
    this.previewTab = page.getByTestId('review-pane-tab-preview');
    this.changesTab = page.getByTestId('review-pane-tab-changes');
    this.publishedTab = page.getByTestId('review-pane-tab-published');
    this.approveButton = page.getByTestId('review-pane-approve');
    this.approveWithComment = page.getByRole('button', { name: 'Approve with a comment', exact: true });
    this.requestChangesButton = page.getByTestId('review-pane-request-changes');
    this.noteInput = page.getByTestId('review-pane-note-input');

    // ── Bulk bar ───────────────────────────────────────────────────────────
    this.selectAll = page.getByTestId('review-queue-select-all');
    this.oneSelected = page.getByText('1 selected', { exact: true });
    this.bulkApprove = page.getByTestId('bulk-approve');
    this.bulkReject = page.getByTestId('bulk-reject');
    this.reasonDialog = page.getByRole('dialog');
    this.reasonInput = page.getByTestId('reason-dialog-input');
    this.reasonConfirm = page.getByTestId('reason-dialog-confirm');

    // ── Deletion requests ──────────────────────────────────────────────────
    this.deletionRows = page.getByTestId('deletion-request-item');

    // ── Agent activity ─────────────────────────────────────────────────────
    this.agentPanel = page.getByTestId('agent-activity-panel');
    this.agentRows = page.getByTestId('agent-activity-item');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /** Open a nest's Review Queue tab and wait for the chips. */
  async goto(nestId) {
    this._log(`Opening the Review Queue of nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}?tab=review`);
    await this.chips.waitFor({ state: 'visible' });
  }

  /** Open the nest page on a Review Queue link, without waiting for the tab. */
  async gotoLink(nestId) {
    this._log(`Following a Review Queue link to nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}?tab=review`);
    await this.backToNests.waitFor({ state: 'visible' });
  }

  /** Open a shared `?review=` link to one change. */
  async gotoReview(nestId, nodeId) {
    this._log(`Opening the review link for ${nodeId}`);
    await this.page.goto(`/nest/${nestId}?tab=review&review=${encodeURIComponent(nodeId)}`);
    await this.chips.waitFor({ state: 'visible' });
  }

  // ── Queue ──────────────────────────────────────────────────────────────────

  /** One change row, by its document title. */
  row(title) {
    return this.rows.filter({ hasText: title });
  }

  /** One comment row, by the comment's text. */
  commentRow(text) {
    return this.commentRows.filter({ hasText: text });
  }

  /** Tick one change row's checkbox. */
  async selectRow(title) {
    await this.row(title).getByTestId('review-queue-select').click();
  }

  /**
   * Wait until the queue and deletion requests have loaded. They arrive
   * together, and the stat card shows a skeleton until then, so a check that
   * something is absent can't pass just because it hasn't loaded yet.
   */
  async waitForQueueLoaded() {
    await this.statCount.filter({ hasText: /^\d+$/ }).waitFor({ state: 'visible' });
  }

  /** The Changes chip's number, and the Review Queue tab's badge. */
  async counts() {
    const chip = (await this.changesChip.innerText()).match(/\((\d+)\)/)?.[1] ?? null;
    const tab = (await this.reviewTab.innerText()).match(/\d+/)?.[0] ?? null;
    return { chip, tab };
  }

  /** Open a change in the review pane. */
  async openRow(title) {
    this._log(`Opening "${title}" in the review pane`);
    await this.row(title).click();
    await this.pane.waitFor({ state: 'visible' });
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

  /** Approve with a comment, from the open pane. */
  async approveWith(comment) {
    await this.approveWithComment.click();
    await this.noteInput.fill(comment);
    await this.approveButton.click();
  }

  /** Request changes with a reason, from the open pane. */
  async requestChanges(reason) {
    await this.requestChangesButton.click();
    await this.noteInput.fill(reason);
    await this.requestChangesButton.click();
  }

  // ── Deletion requests ──────────────────────────────────────────────────────

  /** One deletion request row, by the reason it was raised with. */
  deletionRow(reason) {
    return this.deletionRows.filter({ hasText: reason });
  }

  /** Delete the document in a deletion request. */
  async deleteFromRequest(reason) {
    this._log('Deleting the flagged document');
    await this.deletionRow(reason).getByRole('button', { name: 'Delete', exact: true }).click();
    await this.reasonConfirm.click();
  }
}

export default ReviewQueuePage;
