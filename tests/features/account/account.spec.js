/**
 * Account Test Suite — CN-ACCT-001 … CN-ACCT-010
 *
 * Page under test: ui/src/pages/app/account/page.tsx and
 * ui/src/components/ChangePasswordDialog.tsx (route `/account`, header user
 * menu → Account).
 *
 * Conventions
 * -----------
 * - The page edits the signed-in user's own account, and on the shared dev
 *   server that is a test account the other suites sign in as. No case saves:
 *   every one installs `guardAccountWrites` (src/lib/account_stubs.js), which
 *   refuses and records any name or password write, and ends by checking none
 *   was sent.
 * - The password rules (empty, too short, same as current, mismatch) are
 *   checked in the browser before anything is sent, so the dummy values typed
 *   here never reach the server.
 * - CN-ACCT-003 also opens the page as the secondary account, which must not
 *   be a server admin for that half to mean anything. CN-ACCT-010 uses a fresh
 *   browser context with no session.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { ACCOUNT_ROWS } from '../../src/page_factory/app/account_page.js';
import { guardAccountWrites } from '../../src/lib/account_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** Dummy values for the client-side password checks; never sent. */
const DUMMY_CURRENT = 'qa-dummy-current-1';

/** Who the server says is signed in: `{ email, name }`. */
async function whoAmI(role) {
  const admin = await role.dashboardApi.adminStatus();
  return admin?.me ?? {};
}

/** Initialise a role, guard its account writes, and open the Account page. */
async function openAccount(role) {
  await role.initialize();
  const guard = await guardAccountWrites(role.page);
  await role.accountPage.goto();
  return guard;
}

test.describe('Account', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test('CN-ACCT-001: the Account item in the user menu opens the Account page at /account', async ({ primary_user }) => {
    await primary_user.initialize();
    const { writes } = await guardAccountWrites(primary_user.page);
    const { page, nestsPage, accountPage: ac } = primary_user;
    await nestsPage.goto();
    // A "me" page: in the user menu, not a rail row.
    await expect(page.getByTestId('document-sidebar-dashboard-account')).toHaveCount(0);
    await ac.userMenu.click();
    await expect(ac.accountMenuItem).toBeVisible();
    await expect(ac.accountMenuItem).toHaveText(/Account/);
    await ac.accountMenuItem.click();
    await expect(page).toHaveURL(/\/account$/);
    await ac.waitLoaded();
    expect(writes).toHaveLength(0);
  });

  test("CN-ACCT-002: the page shows the Profile photo, Name, Email address and Password rows with the signed-in user's details", async ({ primary_user }) => {
    const { writes } = await openAccount(primary_user);
    const ac = primary_user.accountPage;
    const me = await whoAmI(primary_user);
    await expect(ac.pageTitle).toContainText('Your Account');
    await expect(ac.pageTitle).toContainText('Who you are on this server.');
    expect(await ac.rowLabels()).toEqual(ACCOUNT_ROWS);

    const shownName = me.name?.trim() || me.email;
    await expect(ac.row('Profile photo')).toContainText(shownName.charAt(0).toUpperCase());
    if (me.name?.trim()) await expect(ac.row('Name')).toContainText(me.name.trim());
    else await expect(ac.notSet).toBeVisible();
    await expect(ac.row('Email address')).toContainText(me.email);
    await expect(ac.row('Password')).toContainText('••••••••••••');
    await expect(ac.editName).toBeVisible();
    await expect(ac.changePassword).toBeVisible();
    expect(writes).toHaveLength(0);
  });

  test('CN-ACCT-003: an admin sees the Admin badge next to their email, and a non-admin does not', async ({ primary_user, secondary_user }) => {
    const { writes } = await openAccount(primary_user);
    const isAdmin = await primary_user.teammatesApi.isServerAdmin();
    test.skip(!isAdmin, 'primary_user is not a server admin on this server.');
    await expect(primary_user.accountPage.row('Email address').getByText('Admin', { exact: true })).toBeVisible();
    expect(writes).toHaveLength(0);

    if (secondaryRole) {
      const guard = await openAccount(secondary_user);
      if (!(await secondary_user.teammatesApi.isServerAdmin())) {
        const me = await whoAmI(secondary_user);
        await expect(secondary_user.accountPage.row('Email address')).toContainText(me.email);
        await expect(secondary_user.accountPage.adminBadge).toHaveCount(0);
      }
      expect(guard.writes).toHaveLength(0);
    }
  });

  test('CN-ACCT-004: Cancel or Escape closes the name editor without saving', async ({ primary_user }) => {
    const { writes } = await openAccount(primary_user);
    const ac = primary_user.accountPage;
    const before = (await whoAmI(primary_user)).name ?? null;

    // Cancel.
    await ac.editName.click();
    await ac.nameInput.fill(`${before ?? ''} qa-unsaved`);
    await ac.cancelName.click();
    await expect(ac.nameInput).toHaveCount(0);
    await expect(ac.editName).toBeVisible();

    // Escape.
    await ac.editName.click();
    await ac.nameInput.fill(`${before ?? ''} qa-unsaved`);
    await ac.nameInput.press('Escape');
    await expect(ac.nameInput).toHaveCount(0);

    // Nothing was sent and the name is unchanged.
    if (before?.trim()) await expect(ac.row('Name')).toContainText(before.trim());
    expect(writes).toHaveLength(0);
    expect((await whoAmI(primary_user)).name ?? null).toBe(before);
  });

  test('CN-ACCT-005: the Change password dialog rejects an empty new password, one shorter than 8 characters, and one the same as the current password, each with its message', async ({ primary_user }) => {
    const { writes } = await openAccount(primary_user);
    const ac = primary_user.accountPage;
    await ac.openPasswordDialog();

    for (const [next, message] of [
      ['        ', 'New password cannot be empty or only whitespace.'],
      ['short7x', 'New password must be at least 8 characters.'],
      [DUMMY_CURRENT, 'New password must be different from the current password.'],
    ]) {
      await ac.fillPasswords(DUMMY_CURRENT, next, next);
      await ac.submitPassword.click();
      await expect(ac.passwordError, `new password ${JSON.stringify(next)}`).toHaveText(message);
      await expect(ac.dialog).toBeVisible();
    }
    expect(writes, 'the checks run before anything is sent').toHaveLength(0);
  });

  test("CN-ACCT-006: \"Passwords don't match.\" shows and the Change password button stays disabled while the new and confirm passwords differ", async ({ primary_user }) => {
    const { writes } = await openAccount(primary_user);
    const ac = primary_user.accountPage;
    await ac.openPasswordDialog();
    await ac.fillPasswords(DUMMY_CURRENT, 'qa-dummy-new-pass-1', 'qa-dummy-new-pass-2');
    await expect(ac.dialog.getByText("Passwords don't match.", { exact: true })).toBeVisible();
    await expect(ac.submitPassword).toBeDisabled();
    // Matching again lifts both.
    await ac.confirmPassword.fill('qa-dummy-new-pass-1');
    await expect(ac.dialog.getByText("Passwords don't match.", { exact: true })).toHaveCount(0);
    await expect(ac.submitPassword).toBeEnabled();
    expect(writes).toHaveLength(0);
  });

  test('CN-ACCT-007: clicking Edit opens the name field pre-filled with the current name and focused, with Save disabled until the name is changed', async ({ primary_user }) => {
    const { writes } = await openAccount(primary_user);
    const ac = primary_user.accountPage;
    const current = (await whoAmI(primary_user)).name ?? '';
    await ac.editName.click();
    await expect(ac.nameInput).toBeVisible();
    await expect(ac.nameInput).toHaveValue(current);
    await expect(ac.nameInput).toBeFocused();
    await expect(ac.nameInput).toHaveAttribute('maxlength', '80');
    await expect(ac.nameInput).toHaveAttribute('placeholder', 'Your name');
    await expect(ac.editName).toHaveCount(0);
    await expect(ac.saveName).toBeDisabled();
    await ac.nameInput.fill(`${current} qa-unsaved`);
    await expect(ac.saveName).toBeEnabled();
    // Back to the same value: disabled again.
    await ac.nameInput.fill(current);
    await expect(ac.saveName).toBeDisabled();
    await ac.nameInput.press('Escape');
    expect(writes).toHaveLength(0);
  });

  test('CN-ACCT-008: each eye toggle in the Change password dialog shows and hides its password', async ({ primary_user }) => {
    const { writes } = await openAccount(primary_user);
    const ac = primary_user.accountPage;
    await ac.openPasswordDialog();
    for (const field of [ac.currentPassword, ac.newPassword, ac.confirmPassword]) {
      await field.fill('qa-dummy-value-1');
      const toggle = ac.toggleFor(field);
      await expect(field).toHaveAttribute('type', 'password');
      await expect(toggle).toHaveAttribute('aria-label', 'Show password');
      await toggle.click();
      await expect(field).toHaveAttribute('type', 'text');
      await expect(toggle).toHaveAttribute('aria-label', 'Hide password');
      await toggle.click();
      await expect(field).toHaveAttribute('type', 'password');
    }
    expect(writes).toHaveLength(0);
  });

  test('CN-ACCT-009: closing the Change password dialog with Cancel clears its fields, so reopening it shows them empty', async ({ primary_user }) => {
    const { writes } = await openAccount(primary_user);
    const ac = primary_user.accountPage;
    await ac.openPasswordDialog();
    await ac.fillPasswords(DUMMY_CURRENT, 'qa-dummy-new-pass-1', 'qa-dummy-new-pass-1');
    await ac.cancelPassword.click();
    await expect(ac.dialog).toBeHidden();
    await ac.openPasswordDialog();
    await expect(ac.currentPassword).toHaveValue('');
    await expect(ac.newPassword).toHaveValue('');
    await expect(ac.confirmPassword).toHaveValue('');
    await expect(ac.passwordError).toHaveCount(0);
    expect(writes).toHaveLength(0);
  });

  test('CN-ACCT-010: a signed-out visitor opening /account is shown the login screen', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      const page = await ctx.newPage();
      await page.goto('/account');
      await expect(page.getByTestId('login-email-input')).toBeVisible();
      await expect(page.getByTestId('login-password-input')).toBeVisible();
      await expect(page.getByTestId('account-page')).toHaveCount(0);
      await expect(page.getByText('Sign in to see your account.')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});
