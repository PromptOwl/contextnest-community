/**
 * Email Login Test Suite
 *
 * Flow: Login Using Email Account
 * 1. User opens the application (unauthenticated root shows the login screen)
 * 2. User enters valid email credentials
 * 3. System authenticates the user
 * 4. The app shell renders in place (nests dashboard + user menu)
 *
 * Uses role-based credentials from tests/src/lib/roles.js
 * Page objects provided via base_test fixtures
 * Authentication states are pre-stored by environment_setup.js
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

// The login-form tests need an account with manual (email/password)
// credentials — a promptowl-method role signs in through the device flow,
// so its password is not valid on the community login form.
const manualRole =
  Object.values(samples).find((r) => (r.method || 'manual') === 'manual') || null;

test.describe('Email Login Flow', () => {
  /**
   * Tests that require fresh login (no stored state)
   * These tests verify the actual login functionality
   * Uses standalone page fixtures (loginPage, appShellPage)
   */
  test.describe('Login Flow Tests', () => {
    test.beforeEach(async ({ page }) => {
      // Clear any existing sessions before each test
      await page.context().clearCookies();

      // Navigate to establish context for storage clearing
      try {
        await page.goto('/');
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
      } catch (error) {
        console.warn('BeforeEach cleanup warning:', error.message);
      }
    });

    test('TC-001: should complete full email login flow and render the app shell', async ({ loginPage, appShellPage, nestsPage }) => {
      // Skip test if no roles are configured
      test.skip(!manualRole, 'No manual-login role configured. Set TEST_ACCOUNT*_ (method: manual) in environment.');

      // Step 1: User opens the application — login screen renders
      await loginPage.goto();

      // Verify login screen is fully loaded
      await expect(loginPage.emailInput).toBeVisible();
      await expect(loginPage.passwordInput).toBeVisible();
      await expect(loginPage.submitButton).toBeVisible();

      // Step 2: User enters valid email credentials
      await loginPage.login(manualRole.email, manualRole.password);

      // Step 3 & 4: System authenticates and the app shell renders in place
      await loginPage.waitForLoginSuccess();

      // Verify authenticated content is visible
      expect(await appShellPage.isLoggedIn()).toBe(true);
      await expect(nestsPage.pageTitle).toBeVisible({ timeout: 15000 });
    });

    test('TC-002: should display all login form elements', async ({ loginPage }) => {
      // Navigate to the login screen
      await loginPage.goto();

      // Verify all required form elements are visible
      await expect(loginPage.emailInput).toBeVisible();
      await expect(loginPage.passwordInput).toBeVisible();
      await expect(loginPage.submitButton).toBeVisible();
    });

    test('TC-003: should show error message for invalid credentials', async ({ loginPage }) => {
      // Navigate to the login screen
      await loginPage.goto();

      // Attempt login with invalid credentials
      await loginPage.login('invalid@test.com', 'wrongpassword');

      // Verify error handling — either an error message renders, or we stay
      // on the login screen (the server rate-limits repeated login attempts,
      // so the exact message can vary between 401 and 429 responses).
      const errorMessage = await loginPage.getErrorMessage();
      if (errorMessage) {
        expect(errorMessage.toLowerCase()).toMatch(/(error|invalid|incorrect|too many|try again)/);
      }

      // Never authenticated: the login form is still there, no app shell
      await expect(loginPage.emailInput).toBeVisible();
      await expect(loginPage.userMenuTrigger).not.toBeVisible();
    });

    test('TC-004: should keep the session across a page reload', async ({ loginPage, appShellPage, page }) => {
      test.skip(!manualRole, 'No manual-login role configured. Set TEST_ACCOUNT*_ (method: manual) in environment.');

      // Log in fresh
      await loginPage.performLogin(manualRole.email, manualRole.password);

      // Reload — the cnst_session cookie must keep the user signed in
      await page.reload();
      await expect(appShellPage.userMenuTrigger).toBeVisible({ timeout: 15000 });
    });
  });

  /**
   * Tests using the pre-authenticated session stored by setup-auth
   * (no login form interaction — validates the stored-state fast path)
   */
  test.describe('Stored Session Tests', () => {
    test('TC-005: should reach the nests dashboard with a stored session', async ({ primary_user }) => {
      // Works for any auth method — the session was stored by setup-auth.
      test.skip(!samples.primary_user, 'primary_user is not configured.');

      await primary_user.initialize();
      const { appShellPage, nestsPage } = primary_user;

      await appShellPage.goto();
      expect(await appShellPage.isLoggedIn()).toBe(true);
      await expect(nestsPage.pageTitle).toBeVisible({ timeout: 15000 });
    });
  });
});
