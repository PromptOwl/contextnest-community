/**
 * Server Settings Page Object Model
 *
 * Page location: ui/src/pages/app/settings/page.tsx
 * Route: /settings (rail → Admin → Server settings, server admins only)
 *
 * One global draft for every server-wide option: edits stay local, the title
 * row shows "Unsaved changes" with Discard / Save changes, and each tab with an
 * edited field carries a small dot. Tabs: Basic, Features, Single sign-on
 * (only while OIDC or agent token exchange is on), Hootie, Notifications,
 * Community sites, Connecting agents, Network & status, License. Community
 * sites are their own resource and save immediately; everything else goes out
 * in one `PATCH /admin/settings` on Save.
 *
 * The page carries almost no data-testids, so cards are found by their title
 * and controls by role, accessible name, placeholder or text.
 */

import logger from '../../helper/logger/logger.js';

class ServerSettingsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail entry (ui/src/components/DocumentSidebar.tsx) ────────────────
    this.railItem = page.getByTestId('document-sidebar-dashboard-settings');

    // ── Page shell ────────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    this.loading = page.getByText('Loading settings…');
    this.unsaved = page.getByText('Unsaved changes', { exact: true });
    this.saveButton = page.getByRole('button', { name: 'Save changes', exact: true }).first();
    this.discardButton = page.getByRole('button', { name: 'Discard', exact: true });
    this.saveError = page.getByRole('alert').filter({ hasText: "Couldn't save settings" });
    this.tabList = page.getByRole('tablist').first();

    // ── Basic ─────────────────────────────────────────────────────────────
    this.communityName = page.locator('#community-name');
    this.publicBaseUrl = page.locator('#public-base-url');

    // ── Hootie ────────────────────────────────────────────────────────────
    this.gatewayUrl = page.locator('#anthropic-base-url');
    this.gatewayKey = page.locator('#anthropic-api-key');
    this.gatewayStatus = page.getByTestId('settings-gateway-status');
    this.anthropicProvider = page.getByTestId('settings-provider-claude');
    this.hootieSwitch = page.getByTestId('settings-hootie-enabled');

    // ── Notifications ─────────────────────────────────────────────────────
    this.slackUrl = page.getByPlaceholder('https://hooks.slack.com/services/…');
    this.teamsUrl = page.getByPlaceholder('https://….logic.azure.com/workflows/…');
    this.smtpRadio = page.getByRole('radio', { name: 'SMTP', exact: true });
    this.sesRadio = page.getByRole('radio', { name: 'AWS SES', exact: true });
    this.smtpUrl = page.getByPlaceholder('smtps://user:pass@smtp.example.com:465');
    this.sesRegion = page.getByPlaceholder('AWS region — us-east-1');
    this.sesAccessKeyId = page.getByPlaceholder("Access key ID — leave empty to use the server's IAM role");
    this.sesSecret = page.locator('input[placeholder^="Secret access key"]');
    this.emailFrom = page.getByPlaceholder('From — nest@yourcompany.com');
    this.emailTo = page.getByPlaceholder('To — team@yourcompany.com, ops@yourcompany.com');

    // ── Single sign-on ────────────────────────────────────────────────────
    this.oidcNotReady = page.getByRole('alert').filter({ hasText: 'Enabled but not configured' });
    this.googleSso = page.getByTestId('settings-sso-google');
    this.enterpriseSso = page.getByTestId('settings-sso-enterprise');
    this.googleCard = page.getByTestId('settings-sso-google');
    this.enterpriseCard = page.getByTestId('settings-sso-enterprise');
    this.googleSwitch = page.getByRole('switch', { name: 'Use Google sign-in', exact: true });
    this.enterpriseSwitch = page.getByRole('switch', { name: 'Use an enterprise identity provider', exact: true });
    this.ssoLocked = page.getByTestId('settings-sso-locked');
    this.entraTenant = page.locator('#entra-tenant');
    this.issuerInput = page.getByPlaceholder('https://login.microsoftonline.com/{tenant}/v2.0 or https://acme.okta.com');
    this.clientId = page.getByPlaceholder('Application (client) ID from your IdP app registration');
    this.clientSecret = page.locator('input[placeholder="Paste to set or replace"]').first();
    this.allowedDomains = page.getByPlaceholder('acme.com, contractors.acme.com — empty allows any');
    this.exchangeNotReady = page.getByRole('alert').filter({ hasText: 'Enabled but not ready' });
    this.exchangeBlocked = page.getByRole('alert').filter({ hasText: 'Blocked: with auto-provision on' });
    this.signingSecret = page.getByPlaceholder('Paste to set or replace (16+ characters)');
    this.msClientId = page.getByPlaceholder('Entra app (client) ID — the token audience');
    this.msTenantId = page.getByPlaceholder('Directory (tenant) ID — builds the issuer');
    this.googleClientId = page.getByPlaceholder('Google OAuth client ID — the token audience');

    // ── Community sites ───────────────────────────────────────────────────
    this.addSiteButton = page.getByRole('button', { name: 'Add site', exact: true }).first();
    this.siteDialog = page.getByRole('dialog').filter({ has: page.locator('#site-name') });
    this.siteName = page.locator('#site-name');
    this.siteUrl = page.locator('#site-url');
    this.siteSecret = page.locator('#site-secret');
    this.siteActive = page.locator('#site-active');
    this.sitesEmpty = page.getByText('No community sites configured yet.', { exact: false });

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open Server settings directly and wait for the tabs. */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to Server settings`);
    await this.page.goto('/settings');
    await this.pageTitle.filter({ hasText: 'Server settings' }).waitFor({ state: 'visible' });
    await this.tabList.waitFor({ state: 'visible' });
  }

  /** A settings tab, by its label ("Basic", "Features", "Single sign-on", …). */
  tab(label) {
    return this.tabList.getByRole('tab', { name: new RegExp(`^${label}`) });
  }

  async openTab(label) {
    const tab = this.tab(label);
    await tab.click();
    await tab.and(this.page.locator('[aria-selected="true"]')).waitFor({ state: 'visible' });
  }

  /** The unsaved-changes dot on a tab. */
  tabDot(label) {
    return this.tab(label).locator('[aria-label="unsaved changes"]');
  }

  // ── Cards ───────────────────────────────────────────────────────────────

  /** A card, by its exact title. */
  card(title) {
    return this.page
      .locator('div.rounded-lg.border.bg-card')
      .filter({ has: this.page.locator('h3', { hasText: new RegExp(`^\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }) })
      .first();
  }

  /** The first switch in a card. */
  cardSwitch(title) {
    return this.card(title).getByRole('switch').first();
  }

  /** A switch on the row whose label contains `text` (inside `cardTitle`). */
  rowSwitch(cardTitle, text) {
    return this.card(cardTitle).locator('div.flex.items-center, div.flex.items-start').filter({ hasText: text }).getByRole('switch').first();
  }

  /** A sign-in option button ("Everyone", "Invite only", "Admins only", "Off") in a card. */
  option(cardTitle, label) {
    return this.card(cardTitle).getByRole('button', { name: new RegExp(`^${label}`) });
  }

  /** "Send test" in the Slack or Teams card. */
  sendTest(cardTitle) {
    return this.card(cardTitle).getByRole('button', { name: 'Send test' });
  }

  // ── Community sites ─────────────────────────────────────────────────────

  siteRow(name) {
    return this.card('Official community sites').locator('div.flex.items-center.justify-between.gap-3.py-3').filter({ hasText: name });
  }

  siteSwitch(name) {
    return this.page.getByRole('switch', { name: `Enable ${name}`, exact: true });
  }

  siteEdit(name) {
    return this.siteRow(name).getByRole('button', { name: 'Edit this community site' });
  }

  siteRemove(name) {
    return this.siteRow(name).getByRole('button', { name: 'Remove this community site' });
  }

  // ── Toasts ──────────────────────────────────────────────────────────────

  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default ServerSettingsPage;
