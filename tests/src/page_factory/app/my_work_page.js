/**
 * My Work Page Object Model
 *
 * Page location: ui/src/pages/app/my-work/page.tsx
 * Route: /my-work (rail → Work → My Work)
 *
 * My Work is the cross-nest inbox: the notifications strip, the reviews and
 * deletion/archive requests waiting on the caller (with a batch bar over the
 * reviews), "Waiting on others" for what the caller handed off, and the pager.
 * It opens two dialogs of its own — ReviewActions (approve / reject one
 * review) and the governance ReasonDialog (requests and batch decisions).
 *
 * The page carries three `data-testid`s (the batch bar's); everything else is
 * addressed by role, accessible name or visible text, as in nests_page.js.
 */

import logger from '../../helper/logger/logger.js';

/** Escape a string for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class MyWorkPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail entry (ui/src/components/DocumentSidebar.tsx) ────────────────
    this.railItem = page.getByTestId('document-sidebar-dashboard-my-work');
    // The count pill only renders when something is pending.
    this.railBadge = this.railItem.locator('span.rounded-full');

    // ── Page shell ────────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    // The page's own root — rows are scoped to it so the rail never matches.
    this.root = page
      .locator('div.space-y-4')
      .filter({ has: this.pageTitle })
      .last();
    this.loader = page.getByText('Loading your work…');
    this.emptyState = page.getByText("You're all caught up — nothing waiting on you.");

    // ── Notifications strip ───────────────────────────────────────────────
    this.markAllRead = page.getByRole('button', { name: 'Mark all read' });
    this.notificationsStrip = page.locator('div.rounded-lg').filter({ has: this.markAllRead });
    // "(N)" beside the heading — how many unread notifications were fetched.
    this.notificationsCount = this.notificationsStrip.locator('span.text-muted-foreground').first();
    this.notificationRows = this.notificationsStrip.locator('div.divide-y > div');
    this.showAllNotifications = this.notificationsStrip.getByRole('button', {
      name: /^Show all \(\d+\)$/,
    });
    this.showLessNotifications = this.notificationsStrip.getByRole('button', {
      name: 'Show less',
    });

    // ── Inbox: reviews, then requests ─────────────────────────────────────
    // Every inbox row leads with its kind badge; "Waiting on others" rows
    // don't have one, which is what tells the two lists apart.
    this.kindBadges = this.root.locator('span.uppercase');
    this.inboxRows = this.root.locator('div.group').filter({ has: page.locator('span.uppercase') });
    this.requestsDivider = this.root.getByText(/^\d+ requests? · approve or reject each one$/);

    // Batch bar (the page's own data-testids)
    this.selectAll = page.getByTestId('work-select-all');
    this.bulkApprove = page.getByTestId('work-bulk-approve');
    this.bulkReject = page.getByTestId('work-bulk-reject');
    this.clearSelection = this.root.getByRole('button', { name: 'Clear', exact: true });
    this.selectAllLabel = this.root.getByText(/^Select all \d+ reviews$/);
    this.selectedLabel = this.root.getByText(/^\d+ selected$/);
    this.capWarning = this.root.getByText(/^Up to \d+ per nest — deselect \d+\.$/);

    // ── Waiting on others ─────────────────────────────────────────────────
    this.waitingHeading = page.getByRole('heading', { name: 'Waiting on others' });
    // The count pill sits beside the heading.
    this.waitingCount = this.waitingHeading.locator('xpath=following-sibling::span[1]');
    this.waitingRows = this.root
      .locator('div.group')
      .filter({ hasNot: page.locator('span.uppercase') });

    // ── Pager ─────────────────────────────────────────────────────────────
    this.prevPage = this.root.getByRole('button', { name: 'Prev' });
    this.nextPage = this.root.getByRole('button', { name: 'Next' });
    this.pageIndicator = this.root.getByText(/^Page \d+ of \d+$/);

    // ── ReviewActions dialog (ui/src/components/governance/ReviewActions.tsx)
    this.approveDialog = page.getByRole('dialog', { name: 'Approve Document' });
    this.rejectDialog = page.getByRole('dialog', { name: 'Reject Document' });
    this.reviewDialog = this.approveDialog.or(this.rejectDialog);
    this.reviewNote = page.locator('#review-note');
    this.reviewNoteLabel = page.locator('label[for="review-note"]');
    this.reviewError = this.reviewDialog.getByRole('alert');
    this.reviewCancel = this.reviewDialog.getByRole('button', { name: 'Cancel', exact: true });

    // ── ReasonDialog (ui/src/components/governance/ReasonDialog.tsx) ──────
    this.reasonInput = page.getByTestId('reason-dialog-input');
    this.reasonConfirm = page.getByTestId('reason-dialog-confirm');
    this.reasonLabel = page.locator('label[for="reason-dialog-input"]');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /**
   * Open My Work directly and wait for the inbox read to land.
   * @param {{settle?: boolean}} [opts] - `settle: false` returns as soon as
   *   the page heading renders, for observing the loading state.
   */
  async goto({ settle = true } = {}) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to My Work`);
    await this.page.goto('/my-work');
    await this.pageTitle.waitFor({ state: 'visible' });
    if (settle) await this.loader.waitFor({ state: 'hidden' });
  }

  /**
   * Open My Work and return the inbox body the page itself received — the
   * counts on screen are asserted against exactly what was rendered, not a
   * second read that another suite could have moved in between.
   * @returns {Promise<{items: any[], waiting: any[], notifications: any[], pagination: any}>}
   */
  async gotoAndReadWork() {
    const [response] = await Promise.all([
      this.page.waitForResponse((res) => {
        const url = new URL(res.url());
        // The page's own read — the rail badge asks for `?limit=1`.
        return url.pathname === '/me/work' && !url.searchParams.has('limit');
      }),
      this.goto({ settle: false }),
    ]);
    const work = await response.json();
    await this.loader.waitFor({ state: 'hidden' });
    return work;
  }

  /** Open My Work from the rail, the way a person gets there. */
  async openFromRail() {
    logger.info('Opening My Work from the rail');
    await this.railItem.click();
    await this.pageTitle.filter({ hasText: 'My Work' }).waitFor({ state: 'visible' });
  }

  // ── Notifications ───────────────────────────────────────────────────────

  /** One notification row, located by (part of) its message. */
  notificationRow(text) {
    return this.notificationRows.filter({ hasText: text });
  }

  /** The row's own button — opens the document (or nest) it is about. */
  notificationOpen(text) {
    return this.notificationRow(text).getByRole('button').first();
  }

  /** The per-row dismiss. */
  notificationMarkRead(text) {
    return this.notificationRow(text).getByRole('button', { name: 'Mark as read' });
  }

  // ── Inbox rows ──────────────────────────────────────────────────────────

  /**
   * One inbox row (review or request), located by text it carries — its
   * title, or a request's reason when the title isn't unique enough.
   */
  workRow(text) {
    return this.inboxRows.filter({ hasText: text });
  }

  /** The row's kind badge: Review / Deletion / Archive. */
  rowKind(text) {
    return this.workRow(text).locator('span.uppercase').first();
  }

  /**
   * The row's title button — "<title> in <nest> · <requester> · <time>" — which
   * opens the document, or the nest for a folder/nest request.
   */
  rowOpen(text) {
    return this.workRow(text).locator('button.text-left');
  }

  /**
   * The row's selection checkbox. Located by CSS, not role: on a request row
   * it is kept in the column but hidden, and a role query skips hidden nodes.
   */
  rowCheckbox(text) {
    return this.workRow(text).locator('button[role="checkbox"]');
  }

  /**
   * Row actions. `exact` matters: the row's title button is named after the
   * document, so a title that merely contains "approve" or "delete" would
   * match a substring query as well as the action itself.
   */
  rowApprove(text) {
    return this.workRow(text).getByRole('button', { name: 'Approve', exact: true });
  }

  rowReject(text) {
    return this.workRow(text).getByRole('button', { name: 'Reject', exact: true });
  }

  rowDelete(text) {
    return this.workRow(text).getByRole('button', { name: 'Delete', exact: true });
  }

  /** Every enabled (i.e. review-row) checkbox in the inbox. */
  get reviewCheckboxes() {
    return this.inboxRows.locator('button[role="checkbox"]:not([disabled])');
  }

  /**
   * The inbox as it reads top to bottom: each row's kind, with the requests
   * divider in place — e.g. ['Review', 'Review', 'divider', 'Deletion'].
   * @returns {Promise<string[]>}
   */
  async inboxLayout() {
    // The list is the divider's parent when there are requests, else the
    // first row's.
    const anchor = (await this.requestsDivider.count())
      ? this.requestsDivider
      : this.inboxRows.first();
    return anchor.locator('xpath=..').evaluate((list) =>
      [...list.children]
        .map((child) => {
          const badge = child.querySelector('span.uppercase');
          if (badge) return badge.textContent.trim();
          return /approve or reject each one/.test(child.textContent) ? 'divider' : null;
        })
        .filter(Boolean)
    );
  }

  // ── ReviewActions dialog ────────────────────────────────────────────────

  /**
   * Open the approve dialog for a review row.
   * @param {string} title
   */
  async openApprove(title) {
    logger.info(`Opening approve dialog: ${title}`);
    await this.rowApprove(title).click();
    await this.approveDialog.waitFor({ state: 'visible' });
  }

  /**
   * Open the reject dialog for a review row.
   * @param {string} title
   */
  async openReject(title) {
    logger.info(`Opening reject dialog: ${title}`);
    await this.rowReject(title).click();
    await this.rejectDialog.waitFor({ state: 'visible' });
  }

  /** The approve dialog's own confirm button. */
  get approveConfirm() {
    return this.approveDialog.getByRole('button', { name: 'Approve', exact: true });
  }

  /** The reject dialog's own confirm button. */
  get rejectConfirm() {
    return this.rejectDialog.getByRole('button', { name: 'Reject', exact: true });
  }

  // ── ReasonDialog ────────────────────────────────────────────────────────

  /**
   * The ReasonDialog, located by its title (which names the subject).
   * @param {string|RegExp} title
   */
  reasonDialog(title) {
    return this.page.getByRole('dialog', {
      name: typeof title === 'string' ? new RegExp(`^${escapeRegExp(title)}$`) : title,
    });
  }

  // ── Waiting on others ───────────────────────────────────────────────────

  /** One "Waiting on others" row, located by its title. */
  waitingRow(text) {
    return this.waitingRows.filter({ hasText: text });
  }

  waitingWithdraw(text) {
    return this.waitingRow(text).getByRole('button', { name: 'Withdraw', exact: true });
  }

  // ── Toasts ──────────────────────────────────────────────────────────────

  /** A toast carrying the given text. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default MyWorkPage;
