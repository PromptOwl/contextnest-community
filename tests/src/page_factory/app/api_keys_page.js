/**
 * API Keys Page Object Model
 *
 * Page location: ui/src/pages/app/api-keys/page.tsx
 * Route: /api-keys (rail → Workspace → API keys)
 *
 * The account's external-client keys: two info boxes explaining the scopes
 * ("All your nests" / "One nest only"), a create form (name + scope picker +
 * Generate key), search / filter / sort controls, and one row per key with
 * its scope badge, prefix, created and last-used dates, Rotate and Revoke.
 * A freshly generated or rotated key is shown once, in KeyRevealModal
 * (ui/src/components/ConnectModal.tsx); Rotate and Revoke confirm through the
 * governance ReasonDialog.
 *
 * The page carries no data-testids of its own, so everything is addressed by
 * role, accessible name or visible text.
 */

import logger from '../../helper/logger/logger.js';

/** Escape a string for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class ApiKeysPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail entry (ui/src/components/DocumentSidebar.tsx) ────────────────
    this.railItem = page.getByTestId('document-sidebar-dashboard-api-keys');

    // ── Page shell ────────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    this.allNestsBox = page.locator('p.rounded-md.border').filter({ hasText: 'All your nests' });
    this.oneNestBox = page.locator('p.rounded-md.border').filter({ hasText: 'One nest only' });
    this.loader = page.getByText('Loading your keys…');
    this.emptyState = page.getByText('No keys yet. Generate one above to connect an AI client.');

    // ── Create form ───────────────────────────────────────────────────────
    this.nameInput = page.getByRole('textbox', { name: 'Key name' });
    this.scopeSelect = page.getByRole('combobox', { name: 'What this key can reach' });
    this.generate = page.getByRole('button', { name: 'Generate key' });
    this.duplicateError = page.getByText('You already have a key with this name.');

    // ── List ──────────────────────────────────────────────────────────────
    this.rows = page.locator('main ul.divide-y > li');
    this.searchInput = page.getByRole('textbox', { name: 'Search keys' });

    // ── Reveal modal (KeyRevealModal) ─────────────────────────────────────
    this.revealDialog = page.getByRole('dialog', { name: /^API key (generated|rotated)$/ });
    this.revealValue = this.revealDialog.locator('code.font-mono');
    this.revealClose = this.revealDialog.getByRole('button', { name: "I've saved it — close" });

    // ── ReasonDialog (rotate / revoke confirmation) ───────────────────────
    this.reasonConfirm = page.getByTestId('reason-dialog-confirm');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** Open API keys directly and wait for the key list to settle. */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to API keys`);
    await this.page.goto('/api-keys');
    await this.pageTitle.filter({ hasText: 'API keys' }).waitFor({ state: 'visible' });
    await this.loader.waitFor({ state: 'hidden' }).catch(() => {});
  }

  // ── Create ──────────────────────────────────────────────────────────────

  /**
   * Pick a scope in the create form's Radix select.
   * @param {string} optionText - "All your nests" or "Only <nest name>"
   */
  async chooseScope(optionText) {
    await this.scopeSelect.click();
    await this.page.getByRole('option', { name: optionText, exact: true }).click();
  }

  /**
   * Fill the form and generate a key; returns the revealed plaintext.
   * @param {string} name
   * @param {string} [scopeOption] - Scope picker option text
   */
  async generateKey(name, scopeOption) {
    logger.info(`Generating API key "${name}"`);
    await this.nameInput.fill(name);
    if (scopeOption) await this.chooseScope(scopeOption);
    await this.generate.click();
    await this.revealDialog.waitFor({ state: 'visible', timeout: 30_000 });
    return (await this.revealValue.innerText()).trim();
  }

  // ── Rows ────────────────────────────────────────────────────────────────

  /** One key row, located by its exact name. */
  row(name) {
    return this.rows.filter({
      has: this.page.locator('p.font-medium', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
    });
  }

  /** The row's scope badge ("All your nests" / "Nest: <name>"). */
  rowScope(name) {
    return this.row(name).locator('[title^="This key reaches"]');
  }

  /** The row's "<prefix> · created <date> · last used <date>" line. */
  rowMeta(name) {
    return this.row(name).locator('p.text-xs');
  }

  rowPrefix(name) {
    return this.row(name).locator('code.font-mono');
  }

  rowRotate(name) {
    return this.row(name).getByRole('button', { name: 'Rotate', exact: true });
  }

  rowRevoke(name) {
    return this.row(name).getByRole('button', { name: `Revoke ${name}`, exact: true });
  }

  /** The ReasonDialog, located by its title. */
  confirmDialog(title) {
    return this.page.getByRole('dialog', { name: title });
  }

  /** A toast carrying the given text. */
  toast(text) {
    return this.toasts.filter({ hasText: text });
  }
}

export default ApiKeysPage;
