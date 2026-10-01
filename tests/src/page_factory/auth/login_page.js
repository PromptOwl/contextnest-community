/**
 * Login Page Object Model
 *
 * Page location: ui/src/components/Login.tsx
 * Route: / (the SPA shows the login screen when unauthenticated)
 *
 * ContextNest Community renders the login form on the root route — there is
 * no dedicated /login URL and a successful login re-renders the app shell in
 * place rather than redirecting.
 */

import { expect } from '@playwright/test';
import logger from '../../helper/logger/logger.js';

class LoginPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // Selectors — test IDs live on ui/src/components/Login.tsx. Each one
    // falls back to a stable attribute of the same element so the suite can
    // run against a deployed bundle that predates the test IDs (they ship
    // with this framework's branch).
    this.emailInput = page
      .getByTestId('login-email-input')
      .or(page.getByPlaceholder('Email', { exact: true }));
    this.passwordInput = page
      .getByTestId('login-password-input')
      .or(page.getByPlaceholder('Password', { exact: true }));
    this.submitButton = page
      .getByTestId('login-submit-button')
      .or(page.getByRole('button', { name: 'Login', exact: true }));
    this.nameInput = page
      .getByTestId('login-name-input')
      .or(page.getByPlaceholder('Name', { exact: true }));
    this.registerToggle = page
      .getByTestId('login-register-toggle')
      .or(page.getByRole('button', { name: 'Register', exact: true }));
    this.promptowlButton = page
      .getByTestId('login-promptowl-button')
      .or(page.getByRole('button', { name: /with PromptOwl$/ }));
    this.errorMessage = page
      .getByTestId('login-error')
      .or(page.locator('p.text-destructive'));

    // Post-login landmark: the app shell's user menu (ui/src/App.tsx)
    this.userMenuTrigger = page.getByTestId('user-menu-trigger');
  }

  /**
   * Navigate to the login screen (the unauthenticated root route)
   */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to login screen`);
    await this.page.goto('/');
    await this.emailInput.waitFor({ state: 'visible' });
    logger.info('Login screen loaded');
  }

  /**
   * Fill credentials and submit the login form
   * @param {string} email - User email
   * @param {string} password - User password
   */
  async login(email, password) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Logging in with email: ${email}`);
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
    logger.info('Login credentials submitted');
  }

  /**
   * Wait for login to complete. The SPA swaps the login form for the app
   * shell in place, so success is the user menu becoming visible.
   * @param {number} timeout - Timeout in milliseconds (default: 30000)
   */
  async waitForLoginSuccess(timeout = 30000) {
    logger.info('Waiting for login success...');
    await this.userMenuTrigger.waitFor({ state: 'visible', timeout });
    logger.info('Login successful - app shell rendered');
  }

  /**
   * Check if email input is visible
   * @returns {Promise<boolean>}
   */
  async isEmailInputVisible() {
    return await this.emailInput.isVisible();
  }

  /**
   * Check if password input is visible
   * @returns {Promise<boolean>}
   */
  async isPasswordInputVisible() {
    return await this.passwordInput.isVisible();
  }

  /**
   * Check if the submit button is visible
   * @returns {Promise<boolean>}
   */
  async isSubmitButtonVisible() {
    return await this.submitButton.isVisible();
  }

  /**
   * Switch the form into register mode (open sign-up servers only)
   */
  async switchToRegister() {
    logger.info('Switching to register mode');
    await this.registerToggle.click();
    await this.nameInput.waitFor({ state: 'visible' });
  }

  /**
   * Read the login error message, if one is displayed
   * @returns {Promise<string|null>}
   */
  async getErrorMessage() {
    try {
      if (await this.errorMessage.isVisible({ timeout: 5000 })) {
        const errorText = await this.errorMessage.textContent();
        logger.warn(`Error message displayed: ${errorText}`);
        return errorText;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Complete login flow (navigate + login + wait for success)
   * @param {string} email - User email
   * @param {string} password - User password
   */
  async performLogin(email, password) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Performing complete login flow`);
    await this.goto();
    await this.login(email, password);
    await this.waitForLoginSuccess();
    logger.info('Login flow completed successfully');
  }
}

export default LoginPage;
