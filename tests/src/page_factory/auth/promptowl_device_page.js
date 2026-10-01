/**
 * PromptOwl Device Authorization Page Object
 *
 * Drives the popup that "Login with PromptOwl" opens on the PromptOwl app
 * (dev.promptowl.ai): signs in with a PromptOwl account when the popup lands
 * on /login, then approves the device on /device.
 *
 * Selectors come from TheOwl's own UI:
 *   - /login: same role/testid selectors TheOwl's framework uses
 *     (tests/src/page_factory/auth/login_page.js there)
 *   - /device: app/(auth)/device/DeviceAuthorizationClient.tsx
 *     (device-auth-approve-button, device-auth-verification-code, …)
 *
 * dev.promptowl.ai sits behind Vercel deployment protection for a fresh
 * browser — playwright.config.js sends the x-vercel-protection-bypass header
 * (VERCEL_BYPASS_SECRET) on every request so the popup gets through.
 */

import logger from '../../helper/logger/logger.js';

class PromptOwlDevicePage {
  /**
   * @param {import('@playwright/test').Page} popup - The PromptOwl popup page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(popup, roleAlias = null) {
    this.page = popup;
    this.roleAlias = roleAlias;

    // PromptOwl /login
    this.emailInput = popup.getByRole('textbox', { name: 'Email' });
    this.passwordInput = popup.getByTestId('login-password-input');
    this.signInButton = popup.getByRole('button', { name: 'Sign in with Email' });

    // PromptOwl /device
    this.approveButton = popup.getByTestId('device-auth-approve-button');
    this.verificationCode = popup.getByTestId('device-auth-verification-code');
  }

  /**
   * Complete the device flow: sign in when the popup redirected to /login,
   * then click Authorize on the device page.
   *
   * @param {Object} role - Role with the PromptOwl account's { email, password, alias }
   * @param {string} deviceUrl - The /device?code=… URL the community app opened
   */
  async authorize(role, deviceUrl) {
    await this.page.waitForLoadState('domcontentloaded');

    // Unauthenticated popups land on the PromptOwl login page first.
    const needsLogin = await this.emailInput
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    if (needsLogin) {
      logger.info(`[${role.alias}] Signing in to PromptOwl as ${role.email}`);
      await this.emailInput.fill(role.email);
      await this.passwordInput.fill(role.password);
      await this.signInButton.click();
    }

    // Sign-in may not redirect back to /device — reopen the device URL then.
    const approveVisible = await this.approveButton
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!approveVisible) {
      logger.info(`[${role.alias}] Reopening device URL after PromptOwl sign-in`);
      await this.page.goto(deviceUrl);
      await this.approveButton.waitFor({ state: 'visible', timeout: 20000 });
    }

    logger.info(`[${role.alias}] Authorizing device`);
    await this.approveButton.click();
  }
}

export default PromptOwlDevicePage;
