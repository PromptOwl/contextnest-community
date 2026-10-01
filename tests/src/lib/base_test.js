/**
 * Base Test Fixtures
 *
 * Extends Playwright's base test with custom fixtures for:
 * - Page object instances (global fixtures)
 * - Role-based authenticated sessions
 * - Logger integration
 * - Common utilities
 *
 * Usage:
 * import { test, expect } from '../../src/lib/base_test.js';
 *
 * test('my test', async ({ primary_user }) => {
 *   await primary_user.initialize();
 *   const nestsPage = primary_user.nestsPage;
 *   // Test continues...
 * });
 */

import { test as baseTest, expect } from '@playwright/test';
import { samples as roles } from './roles.js';
import CommonFunction from '../helper/utility/utility.js';
import logger from '../helper/logger/logger.js';

// Import page objects
import LoginPage from '../page_factory/auth/login_page.js';
import AppShellPage from '../page_factory/app/app_shell_page.js';
import NestsPage from '../page_factory/app/nests_page.js';

/**
 * Global fixtures available to all tests
 * These don't require authentication
 */
const globalFixtures = {
  /**
   * Common utility functions
   * Available in all tests as { commonFunction }
   */
  commonFunction: async ({}, use) => {
    const commonFunction = new CommonFunction();
    await use(commonFunction);
  },

  /**
   * Logger instance
   * Available in all tests as { testLogger }
   */
  testLogger: async ({}, use) => {
    await use(logger);
  },
};

/**
 * Standalone page object fixtures
 * These use the default Playwright page (no authentication)
 * Useful for testing login flows, public pages, etc.
 *
 * Usage:
 * test('my test', async ({ loginPage, nestsPage }) => {
 *   await loginPage.goto();
 * });
 */
const pageFixtures = {
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  appShellPage: async ({ page }, use) => {
    await use(new AppShellPage(page));
  },

  nestsPage: async ({ page }, use) => {
    await use(new NestsPage(page));
  },
};

/**
 * Create role-based fixtures
 * Each role gets its own fixture with lazy initialization
 *
 * Role fixtures provide:
 * - Authenticated browser context (loaded from cookies_storage)
 * - Page object instances (loginPage, nestsPage, etc.)
 * - Common utilities
 * - Error logging
 */
// Always register the standard aliases so spec files referencing them load
// even when no credentials are configured (their tests skip via
// `test.skip(!primaryRole, …)` before touching the fixture). Configured
// roles from the environment are merged on top.
const DEFAULT_ALIASES = ['primary_user', 'secondary_user'];
const roleAliases = [...new Set([...DEFAULT_ALIASES, ...Object.keys(roles)])];

const roleFixtures = roleAliases.reduce((acc, roleName) => {
  acc[roleName] = async ({ browser }, use) => {
    const role = roles[roleName];

    // Unconfigured alias: provide a stub that fails loudly if a test ever
    // initializes it instead of skipping.
    if (!role) {
      await use({
        async initialize() {
          throw new Error(
            `Role ${roleName} is not configured. Set the TEST_ACCOUNT*_ variables in tests/.env/ (see tests/env.template).`
          );
        },
      });
      return;
    }

    // Create a role instance with lazy initialization
    const roleInstance = {
      _initialized: false,
      _context: null,
      _page: null,

      /**
       * Initialize context and page with stored authentication
       * Only called when first accessing the role in a test
       */
      async initialize() {
        if (!this._initialized) {
          logger.info(`Initializing role: ${role.alias}`);

          // Load authentication state from cookies_storage
          this._context = await browser.newContext({ storageState: role.path });
          this._page = await this._context.newPage();

          // Add error listener for debugging
          this._page.on('pageerror', (error) => {
            logger.error(`Page error [${role.alias}]: ${error.message}`);
          });

          // Add console listener for debugging
          this._page.on('console', (msg) => {
            if (msg.type() === 'error') {
              logger.error(`Console error [${role.alias}]: ${msg.text()}`);
            }
          });

          this._initialized = true;
          logger.info(`Role initialized: ${role.alias}`);
        }
        return this;
      },

      /**
       * Get the page object
       * Throws if not initialized
       */
      get page() {
        if (!this._initialized) {
          throw new Error(`Role ${roleName} not initialized. Call await ${roleName}.initialize() first.`);
        }
        return this._page;
      },

      /**
       * Get the browser context
       * Throws if not initialized
       */
      get context() {
        if (!this._initialized) {
          throw new Error(`Role ${roleName} not initialized. Call await ${roleName}.initialize() first.`);
        }
        return this._context;
      },

      /**
       * Page object getters
       * Returns page object instances with the current page and role
       */

      // Auth page objects
      get loginPage() {
        return new LoginPage(this.page, role.alias);
      },

      // App shell (header, sidebar, user menu)
      get appShellPage() {
        return new AppShellPage(this.page, role.alias);
      },

      // Nests dashboard
      get nestsPage() {
        return new NestsPage(this.page, role.alias);
      },

      /**
       * Utility instances
       */
      get commonFunction() {
        return new CommonFunction(this.page, role.alias);
      },

      /**
       * Role information
       */
      get roleInfo() {
        return {
          alias: role.alias,
          email: role.email,
        };
      },

      /**
       * Cleanup method
       * Closes context and resets initialization flag
       */
      async close() {
        if (this._context) {
          await this._context.close();
          logger.info(`Role context closed: ${role.alias}`);
        }
        this._initialized = false;
      },
    };

    // Pass the role instance to the test
    await use(roleInstance);

    // Cleanup after the test
    await roleInstance.close();
  };
  return acc;
}, {});

/**
 * Extended test with all fixtures
 * Combines global, page, and role-based fixtures
 */
const test = baseTest.extend({
  ...globalFixtures,
  ...pageFixtures,
  ...roleFixtures,
});

/**
 * Export test and expect
 *
 * Usage in test files:
 * import { test, expect } from '../../src/lib/base_test.js';
 *
 * test('test with primary user', async ({ primary_user, commonFunction }) => {
 *   await primary_user.initialize();
 *   // Use primary_user.page, primary_user.nestsPage, etc.
 * });
 */
export { test, expect };
