/**
 * Environment Setup for Playwright Tests
 *
 * This setup runs once before all tests to:
 * 1. Create cookies_storage directory
 * 2. Authenticate users for each role
 * 3. Save authentication state for reuse in tests
 *
 * This approach significantly speeds up test execution by reusing
 * authenticated sessions instead of logging in for each test.
 */

import { test as setup } from '@playwright/test';
import fs from 'fs';
import { samples as roles } from '../../lib/roles.js';
import logger from '../logger/logger.js';
import { initializeRun, getRunId } from '../../lib/entity_registry.js';

// Define path for cookies storage
const cookiesDir = 'tests/src/cookies_storage';

// ContextNest session cookie (src/auth/sessions.ts — SESSION_COOKIE)
const SESSION_COOKIE = 'cnst_session';

/**
 * Ensure the cookies_storage directory exists
 */
function initializeDirectory() {
  fs.mkdirSync(cookiesDir, { recursive: true });
  logger.info(`Cookies storage directory initialized: ${cookiesDir}`);
}

/**
 * Validate if a session is still valid.
 * Checks if the storage state file exists and the session cookie is not expired.
 *
 * @param {Object} role - Role configuration object
 * @returns {Promise<boolean>} True if session is valid
 */
async function validateSession(role) {
  const fixturePath = role.path;

  try {
    await fs.promises.access(fixturePath, fs.constants.F_OK);
  } catch (error) {
    logger.warn(`Session file not found for ${role.alias}, will perform login.`);
    return false;
  }

  // Check if the session cookie is still valid
  try {
    const data = JSON.parse(await fs.promises.readFile(fixturePath, 'utf8'));
    const sessionCookie = (data.cookies || []).find((c) => c.name === SESSION_COOKIE);

    if (!sessionCookie) {
      logger.warn(`No ${SESSION_COOKIE} cookie found for ${role.alias}, will perform login.`);
      return false;
    }

    // expires is in seconds since epoch (-1 means session cookie)
    const nowSeconds = Date.now() / 1000;
    if (sessionCookie.expires && sessionCookie.expires > 0 && sessionCookie.expires < nowSeconds) {
      logger.warn(
        `Session cookie expired for ${role.alias} (expired ${new Date(sessionCookie.expires * 1000).toISOString()}), will perform login.`
      );
      return false;
    }

    logger.info(`Session file found for ${role.alias} with valid cookie.`);
    return true;
  } catch (error) {
    logger.warn(`Failed to parse session file for ${role.alias}: ${error.message}, will perform login.`);
    return false;
  }
}

/**
 * Perform login for a specific role.
 * The community server renders the login form on the root route and swaps in
 * the app shell in place on success (no redirect).
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {Object} role - Role configuration object
 */
async function performLogin(page, role) {
  try {
    const baseURL = process.env.BASE_URL;

    if (!baseURL) {
      throw new Error('BASE_URL environment variable is not defined');
    }

    logger.info(`Performing login for ${role.alias}`);

    // Navigate to the root — unauthenticated visitors get the login screen
    await page.goto('/');
    logger.info('Navigated to login screen');

    // Fill in credentials (test IDs on ui/src/components/Login.tsx)
    await page.getByTestId('login-email-input').fill(role.email);
    logger.info(`Filled email: ${role.email}`);

    await page.getByTestId('login-password-input').fill(role.password);
    logger.info('Filled password');

    await page.getByTestId('login-submit-button').click();
    logger.info('Clicked login button');

    // Wait for successful login — the app shell's user menu appears
    await page.getByTestId('user-menu-trigger').waitFor({ state: 'visible', timeout: 30000 });
    logger.info(`Login successful for ${role.alias}`);

    // Save authentication state
    await page.context().storageState({ path: role.path });
    logger.info(`Authentication state saved to ${role.path}`);
  } catch (error) {
    logger.error(`Login failed for ${role.alias}: ${error.message}`);
    throw error;
  }
}

/**
 * Setup authentication for a specific role
 *
 * @param {Object} role - Role configuration object
 * @returns {Function} Setup function
 */
function setupAuth(role) {
  return async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Check if we need to login
    if (!(await validateSession(role))) {
      await performLogin(page, role);
    } else {
      logger.info(`Using existing session for ${role.alias}`);
    }

    await context.close();
  };
}

/**
 * Authentication test suite
 * Runs as a separate project before UI tests
 */
setup.describe('Authentication Setup', function () {
  setup.beforeAll(async function ({ playwright: _p }, testInfo) {
    // Initialize the cookies directory
    initializeDirectory();

    // Initialize entity registry for this test run
    initializeRun();
    logger.info(`Entity registry initialized. runId: ${getRunId()}`);

    // Log environment settings
    const infoSettings = {
      BASE_URL: process.env.BASE_URL,
      ENV: process.env.ENV,
      Roles: Object.keys(roles).join(', ') || 'No roles configured',
    };

    if (!testInfo.workerIndex) {
      console.table(infoSettings);
    }

    // Validate required environment variables
    if (!process.env.BASE_URL) {
      throw new Error('BASE_URL environment variable is required');
    }

    if (Object.keys(roles).length === 0) {
      throw new Error(
        'No roles configured. Please set TEST_ACCOUNT1_USER and TEST_ACCOUNT1_PW in your tests/.env file'
      );
    }
  });

  // Iterate over roles and dynamically add authentication steps
  Object.values(roles).forEach((role) => {
    setup(`Authenticate as ${role.alias}`, setupAuth(role));
  });
});
