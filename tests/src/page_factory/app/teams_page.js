/**
 * Teams Page Object Model
 *
 * Page location: ui/src/pages/app/teams/page.tsx
 * Route: /teams (rail → Workspace → Teams)
 *
 * The caller's teams as a card grid: each card shows the team name, a member
 * count badge, who created it, and up to five members (each with a green
 * "registered" or red "invited" status icon) with the rest behind a
 * "+N more members" tooltip. "New Team" opens a create modal (name, optional
 * members). With the PromptOwl Teams feature on and a PromptOwl sign-in, the
 * list sits under a "ContextNest Teams" tab beside a "PromptOwl Teams" tab.
 *
 * The page carries no data-testids of its own (only the member input inside
 * the modals), so everything is addressed by role, accessible name or text.
 */

import logger from '../../helper/logger/logger.js';

class TeamsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail entry (ui/src/components/DocumentSidebar.tsx) ────────────────
    this.railItem = page.getByTestId('document-sidebar-dashboard-teams');

    // ── Page shell ────────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    this.newTeam = page.getByRole('button', { name: 'New Team', exact: true });
    this.loader = page.locator('main svg.animate-spin');
    this.emptyState = page.getByText('No teams yet. Create one to share a nest with a whole group at once.');
    this.errorAlert = page.locator('main [role="alert"]');

    // ── Cards ─────────────────────────────────────────────────────────────
    // A team card is the grid's direct child; its title is the h3.
    this.cards = page.locator('main div.grid > div').filter({ has: page.locator('h3') });

    // ── PromptOwl Teams feature (tabs) ────────────────────────────────────
    this.cnTab = page.getByRole('tab', { name: 'ContextNest Teams' });
    this.poTab = page.getByRole('tab', { name: 'PromptOwl Teams' });
    this.poIntro = page.getByText(/^Your PromptOwl teams\. Syncing one copies it here/);
    this.poEmpty = page.getByText("You're not in any teams in PromptOwl.");

    // ── Create modal ──────────────────────────────────────────────────────
    this.createDialog = page.getByRole('dialog', { name: 'New team' });
    this.createName = this.createDialog.getByPlaceholder('Team name (e.g. Platform)');
    this.createSubmit = this.createDialog.getByRole('button', { name: 'Create', exact: true });
    this.createCancel = this.createDialog.getByRole('button', { name: 'Cancel', exact: true });

    // Tooltips (Radix) render in a portal
    this.tooltip = page.getByRole('tooltip');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open Teams directly and wait for the page heading. */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to Teams`);
    await this.page.goto('/teams');
    await this.pageTitle.filter({ hasText: 'Teams' }).waitFor({ state: 'visible' });
  }

  /**
   * Open Teams (by URL, or by `open` — e.g. a rail click) and return the list
   * body the page itself received, so counts on screen are asserted against
   * exactly what was rendered.
   * @returns {Promise<{teams: any[]}>}
   */
  async gotoAndReadTeams(open = () => this.goto()) {
    const [response] = await Promise.all([
      this.page.waitForResponse((res) => {
        const url = new URL(res.url());
        return url.pathname === '/teams' && res.request().resourceType() !== 'document';
      }),
      open(),
    ]);
    const body = await response.json();
    await this.loader.waitFor({ state: 'hidden' }).catch(() => {});
    return body;
  }

  // ── Cards ───────────────────────────────────────────────────────────────

  /** One team card, located by its exact name. */
  card(name) {
    return this.cards.filter({ has: this.page.getByRole('heading', { name, exact: true }) });
  }

  /** The card's member count badge (right after the name). */
  cardCount(name) {
    return this.card(name).locator('h3').locator('xpath=following-sibling::div[1]');
  }

  /** The member lines shown on the card (the first five; not the overflow). */
  cardMembers(name) {
    return this.card(name).locator('div.flex.items-center.gap-2.text-sm');
  }

  /** One member line on a card, by email. */
  cardMember(name, email) {
    return this.cardMembers(name).filter({ hasText: email });
  }

  /** A member line's status icon: green = registered, red = invited. */
  memberStatus(name, email) {
    return this.cardMember(name, email).locator('svg').first();
  }

  /** The "+N more members" trigger on a card. */
  cardOverflow(name) {
    return this.card(name).getByRole('button', { name: /^\+\d+ more members?$/ });
  }

  cardEdit(name) {
    return this.card(name).getByRole('button', { name: 'Edit team', exact: true });
  }

  cardDelete(name) {
    return this.card(name).getByRole('button', { name: 'Delete team', exact: true });
  }

  // ── Create ──────────────────────────────────────────────────────────────

  /** Open the create modal. */
  async openCreate() {
    await this.newTeam.click();
    await this.createDialog.waitFor({ state: 'visible' });
  }

  /** A toast carrying the given text. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default TeamsPage;
