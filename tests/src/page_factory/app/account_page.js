/**
 * Account Page Object Model
 *
 * Page location: ui/src/pages/app/account/page.tsx (+ components/ChangePasswordDialog.tsx)
 * Route: /account (header user menu → Account; no rail row — `meta.hidden`)
 *
 * "Your Account": four rows — Profile photo (the name's or email's first
 * letter), Name (Edit → an inline field with Save / Cancel; Enter saves,
 * Escape cancels), Email address (with an Admin badge for admins) and
 * Password (masked; "Change password" opens a dialog with current / new /
 * confirm fields, each with an eye toggle). The dialog checks the new
 * password in the browser before anything is sent.
 */

import logger from '../../helper/logger/logger.js';

/** The page's rows, in order. */
export const ACCOUNT_ROWS = ['Profile photo', 'Name', 'Email address', 'Password'];

class AccountPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Header user menu (ui/src/App.tsx) ─────────────────────────────────
    this.userMenu = page.getByTestId('user-menu-trigger');
    this.accountMenuItem = page.getByTestId('user-menu-account');

    // ── Page ──────────────────────────────────────────────────────────────
    this.root = page.getByTestId('account-page');
    this.pageTitle = page.getByTestId('page-title');
    this.avatar = this.root.locator('span.rounded-full').first();
    this.adminBadge = this.root.getByText('Admin', { exact: true });
    this.notSet = this.root.getByText('Not set — your email is shown instead');

    // ── Name editor ───────────────────────────────────────────────────────
    this.editName = page.getByTestId('account-edit-name');
    this.nameInput = page.getByTestId('account-name-input');
    this.saveName = this.root.getByRole('button', { name: 'Save', exact: true });
    this.cancelName = this.root.getByRole('button', { name: 'Cancel', exact: true });

    // ── Change password dialog ────────────────────────────────────────────
    this.changePassword = page.getByTestId('account-change-password');
    this.dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Change password' }) });
    this.currentPassword = this.dialog.getByPlaceholder('Enter your current password');
    this.newPassword = this.dialog.getByPlaceholder('At least 8 characters');
    this.confirmPassword = this.dialog.getByPlaceholder('Re-enter your new password');
    this.submitPassword = this.dialog.getByRole('button', { name: 'Change password', exact: true });
    this.cancelPassword = this.dialog.getByRole('button', { name: 'Cancel', exact: true });
    this.passwordError = this.dialog.locator('p.text-destructive');
  }

  /** Open the Account page directly and wait for it. */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Opening Account`);
    await this.page.goto('/account');
    await this.waitLoaded();
  }

  async waitLoaded() {
    await this.root.waitFor({ state: 'visible' });
    await this.pageTitle.filter({ hasText: 'Your Account' }).waitFor({ state: 'visible' });
  }

  /** A row by its label ("Name", "Email address", …). */
  row(label) {
    return this.root.locator('div.border-b').filter({ has: this.page.locator('div.text-sm.font-medium', { hasText: new RegExp(`^${label}$`) }) });
  }

  /** Row labels, in order. */
  async rowLabels() {
    return (await this.root.locator('div.border-b div.text-sm.font-medium').allInnerTexts()).map((t) => t.trim());
  }

  /** Open the Change password dialog. */
  async openPasswordDialog() {
    await this.changePassword.click();
    await this.dialog.waitFor({ state: 'visible' });
  }

  /** The eye toggle inside a password field's wrapper. */
  toggleFor(field) {
    return field.locator('xpath=..').getByRole('button', { name: /^(Show|Hide) password$/ });
  }

  /** Fill all three password fields. */
  async fillPasswords(current, next, confirm) {
    await this.currentPassword.fill(current);
    await this.newPassword.fill(next);
    await this.confirmPassword.fill(confirm);
  }
}

export default AccountPage;
