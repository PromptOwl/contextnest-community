/**
 * Common Utility Functions for Playwright Tests
 *
 * Provides reusable helper functions for test automation including
 * locator generation, assertions, retries, and test data management.
 */

import { expect } from '@playwright/test';
import logger from '../logger/logger.js';

/**
 * Prefix used for every entity created by automation. The orphan sweeper and
 * global cleanup identify test data by this prefix — always create test
 * entities through generateEntityName() so they can be swept.
 */
export const AUTO_PREFIX = 'AUTO_';

/**
 * Utility class with common test helper functions
 */
class CommonFunction {
  /**
   * @param {import('@playwright/test').Page} [page] - Optional page binding
   * @param {string} [roleAlias] - Optional role alias for logging
   */
  constructor(page = null, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
  }

  /**
   * Generate a unique automation entity name with timestamp.
   * Always used for nests/documents/tags created by tests so cleanup can
   * find them by the AUTO_ prefix.
   * @param {string} suffix - Descriptive suffix (default: 'entity')
   * @returns {string} Unique entity name, e.g. "AUTO_m1abc-x4k9-nest"
   */
  generateEntityName(suffix = 'entity') {
    const timestamp = Date.now().toString(36);
    const randomString = Math.random().toString(36).substring(2, 8);
    return `${AUTO_PREFIX}${timestamp}-${randomString}-${suffix}`;
  }

  /**
   * Generate a unique test identifier
   * @param {string} prefix - Prefix for the identifier
   * @returns {string} Unique test ID
   */
  generateTestId(prefix = 'test') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Get locator with dynamic parameter substitution.
   * Replaces {0}, {1}, {2}... placeholders with provided parameters.
   *
   * @param {import('@playwright/test').Page} page - Playwright page object
   * @param {string} locator - Locator string with placeholders like {0}, {1}
   * @param {...string} params - Parameters to substitute into the locator
   * @returns {Promise<import('@playwright/test').Locator>} Formatted locator
   *
   * @example
   * await getLocator(page, 'button:has-text("{0}")', 'Submit');
   */
  async getLocator(page, locator, ...params) {
    const formattedLocator = locator.replace(/{(\d+)}/g, (match, index) => params[index]);
    return page.locator(formattedLocator);
  }

  /**
   * Assert that element contains expected text
   * @param {import('@playwright/test').Page} page - Playwright page object
   * @param {string} locator - Element locator
   * @param {string} expectedText - Expected text content
   * @param {...string} params - Parameters for locator substitution
   */
  async assertText(page, locator, expectedText, ...params) {
    const element = await this.getLocator(page, locator, ...params);
    await expect(element).toHaveText(expectedText);
    logger.info(`Assert text passed: "${expectedText}"`);
  }

  /**
   * Assert that element has/doesn't have an attribute
   * @param {import('@playwright/test').Page} page - Playwright page object
   * @param {string} locator - Element locator
   * @param {string} attribute - Attribute name
   * @param {boolean} shouldHave - Whether element should have the attribute
   * @param {...string} params - Parameters for locator substitution
   */
  async assertAttribute(page, locator, attribute, shouldHave = true, ...params) {
    const element = await this.getLocator(page, locator, ...params);

    if (shouldHave) {
      await expect(element).toHaveAttribute(attribute);
    } else {
      await expect(element).not.toHaveAttribute(attribute);
    }
    logger.info(`Assert attribute ${attribute} ${shouldHave ? 'exists' : 'does not exist'}`);
  }

  /**
   * Assert that element is visible
   * @param {import('@playwright/test').Page} page - Playwright page object
   * @param {string} locator - Element locator
   * @param {...string} params - Parameters for locator substitution
   */
  async assertVisible(page, locator, ...params) {
    const element = await this.getLocator(page, locator, ...params);
    await expect(element).toBeVisible();
    logger.info(`Assert visible passed for: ${locator}`);
  }

  /**
   * Wait for element to be visible with retry logic
   * @param {import('@playwright/test').Locator} locator - Element locator
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<boolean>} True if visible, false otherwise
   */
  async waitForVisible(locator, timeout = 10000) {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return true;
    } catch (error) {
      logger.warn(`Element not visible after ${timeout}ms`);
      return false;
    }
  }

  /**
   * Retry a function with exponential backoff
   * @param {Function} fn - Function to retry
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} initialDelay - Initial delay in milliseconds
   * @returns {Promise<any>} Result of the function
   */
  async retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const delay = initialDelay * Math.pow(2, attempt);
          logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    logger.error(`All ${maxRetries + 1} attempts failed: ${lastError.message}`);
    throw lastError;
  }
}

export default CommonFunction;
