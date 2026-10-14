/**
 * Teammates Page Object Model
 *
 * Page location: ui/src/pages/app/teammates/page.tsx
 * Route: /teammates (rail → Admin → Teammates, server admins only)
 *
 * The server's people: an "All Users" card with a search box, an
 * All / Superadmins / Members filter and one row per user (name or email,
 * You / Admin / Invited badges, "<n> keys · last active <when>", and the
 * row actions Grant superadmin, Revoke superadmin, Reset password and
 * Remove). "Invite Teammate" opens the Add Teammate modal; its result modal
 * shows the one-time temporary password and offers to share a nest. When
 * steward emails have no account yet, a "Stewards without server access" card
 * lists them with an Invite button.
 *
 * The page carries no data-testids of its own, so everything is addressed by
 * role, accessible name or text.
 */

import logger from '../../helper/logger/logger.js';

/** Escape a string for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class TeammatesPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail entry (ui/src/components/DocumentSidebar.tsx) ────────────────
    this.railItem = page.getByTestId('document-sidebar-dashboard-teammates');

    // ── Page shell ────────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    this.inviteButton = page.getByRole('button', { name: 'Invite Teammate', exact: true });
    this.errorAlert = page.locator('main [role="alert"]').first();

    // ── All Users card ────────────────────────────────────────────────────
    this.loader = page.locator('main svg.animate-spin').first();
    this.searchInput = page.getByPlaceholder('Search by name or email…');
    this.filterAll = page.getByRole('button', { name: 'All', exact: true });
    this.filterSuperadmins = page.getByRole('button', { name: 'Superadmins', exact: true });
    this.filterMembers = page.getByRole('button', { name: 'Members', exact: true });
    this.noMatch = page.getByText('No users match your filters.');
    this.emptyState = page.getByText('No teammates yet. Click "Invite Teammate" to add one.');
    // A user row: the bordered row that holds an avatar and an email line
    // (pending-steward rows look alike but sit on bg-background).
    this.rows = page
      .locator('main div.flex.items-center.gap-3.p-3.rounded-lg.border:not(.bg-background)')
      .filter({ has: page.locator('div.text-xs.text-muted-foreground') });

    // ── Stewards without server access ────────────────────────────────────
    this.pendingHeading = page.getByText('Stewards without server access', { exact: true });

    // ── Add Teammate modal ────────────────────────────────────────────────
    this.inviteDialog = page.getByRole('dialog', { name: 'Add Teammate' });
    this.inviteEmail = this.inviteDialog.getByPlaceholder('jane@acme.com');
    this.inviteSubmit = this.inviteDialog.getByRole('button', { name: 'Add teammate', exact: true });
    this.inviteCancel = this.inviteDialog.getByRole('button', { name: 'Cancel', exact: true });

    // ── Invite result modal (NewKeyModal) ─────────────────────────────────
    this.resultDialog = page.getByRole('dialog', { name: /^Teammate added: / });
    this.resultPassword = this.resultDialog.locator('code.font-mono');
    this.resultDone = this.resultDialog.getByRole('button', { name: 'Done', exact: true });
    this.shareNestSelect = this.resultDialog.getByRole('combobox', { name: 'Nest to share' });
    this.shareLevelSelect = this.resultDialog.getByRole('combobox', { name: 'Access level' });
    this.shareButton = this.resultDialog.getByRole('button', { name: 'Share', exact: true });

    // ── Reset password panel (a plain overlay, not a Radix dialog) ────────
    this.resetPanel = page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Temporary password' }) });
    this.resetPassword = this.resetPanel.locator('code.font-mono');
    this.resetCopy = this.resetPanel.getByRole('button', { name: /^(Copy|Copied)$/ });
    this.resetDone = this.resetPanel.getByRole('button', { name: 'Done', exact: true });

    // ── Confirm dialogs ───────────────────────────────────────────────────
    this.grantDialog = page.getByRole('dialog', { name: /^Grant superadmin to / });
    this.revokeDialog = page.getByRole('dialog', { name: /^Revoke superadmin from / });
    this.removeDialog = page.getByRole('dialog', { name: /^Remove .+\?$/ });

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open Teammates directly and wait for the page heading. */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to Teammates`);
    await this.page.goto('/teammates');
    await this.pageTitle.filter({ hasText: 'Teammates' }).waitFor({ state: 'visible' });
  }

  /**
   * Open Teammates (by URL, or by `open` — e.g. a rail click) and return the
   * list body the page itself received (`GET /auth/teammates`).
   * @returns {Promise<{teammates: any[], pending_stewards: string[]}>}
   */
  async gotoAndReadTeammates(open = () => this.goto()) {
    const [response] = await Promise.all([
      this.page.waitForResponse((res) => {
        const url = new URL(res.url());
        return url.pathname === '/auth/teammates' && res.request().method() === 'GET';
      }),
      open(),
    ]);
    const body = await response.json();
    await this.loader.waitFor({ state: 'hidden' }).catch(() => {});
    return body;
  }

  // ── Rows ────────────────────────────────────────────────────────────────

  /** One user row, located by the email on its detail line. */
  row(email) {
    return this.rows.filter({
      has: this.page.locator('div.text-xs.text-muted-foreground > span', { hasText: new RegExp(`^${escapeRegExp(email)}$`, 'i') }),
    });
  }

  /** The row's name line (name, or the email when there is no name). */
  rowName(email) {
    return this.row(email).locator('span.font-medium').first();
  }

  /** A badge on the row: 'You', 'Admin' or 'Invited'. */
  rowBadge(email, label) {
    return this.row(email).locator('div.flex.items-center.gap-2 > div, div.flex.items-center.gap-2 > span').filter({ hasText: new RegExp(`^${label}$`) });
  }

  /** The row's "<email> · <n> keys · last active <when>" line. */
  rowMeta(email) {
    return this.row(email).locator('div.text-xs.text-muted-foreground');
  }

  rowGrant(email) {
    return this.row(email).getByRole('button', { name: 'Grant superadmin', exact: true });
  }

  rowRevoke(email) {
    return this.row(email).getByRole('button', { name: 'Revoke superadmin', exact: true });
  }

  rowReset(email) {
    return this.row(email).getByRole('button', { name: 'Reset password', exact: true });
  }

  rowRemove(email) {
    return this.row(email).getByRole('button', { name: 'Remove', exact: true });
  }

  // ── Stewards without server access ──────────────────────────────────────

  /** One pending-steward row, by email. */
  pendingRow(email) {
    return this.page.locator('main div.flex.items-center.gap-3.p-3.rounded-lg.border.bg-background').filter({ hasText: email });
  }

  pendingInvite(email) {
    return this.pendingRow(email).getByRole('button', { name: 'Invite', exact: true });
  }

  // ── Invite ──────────────────────────────────────────────────────────────

  /** Open the Add Teammate modal from the page header. */
  async openInvite() {
    await this.inviteButton.click();
    await this.inviteDialog.waitFor({ state: 'visible' });
  }

  /** A toast carrying the given text. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default TeammatesPage;
