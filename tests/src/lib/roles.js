/**
 * Role-Based User Configuration
 *
 * Manages test user accounts with role-based access.
 * Loads credentials from environment variables and provides
 * storage state paths for authenticated sessions.
 *
 * ContextNest stewardship roles (Viewer / Editor / Reviewer) map naturally
 * onto these accounts — e.g. TEST_ACCOUNT1 as an owner/reviewer and
 * TEST_ACCOUNT2 as an editor or viewer for multi-user governance tests.
 */

import path from 'path';

/**
 * Define roles from environment variables.
 * Each role contains credentials and a storage state path.
 * Add or remove roles by setting the corresponding environment variables.
 */
const roleDefinitions = [
  {
    alias: process.env.TEST_ACCOUNT1_ALIAS,
    email: process.env.TEST_ACCOUNT1_USER,
    password: process.env.TEST_ACCOUNT1_PW,
  },
  {
    alias: process.env.TEST_ACCOUNT2_ALIAS,
    email: process.env.TEST_ACCOUNT2_USER,
    password: process.env.TEST_ACCOUNT2_PW,
  },
].filter((role) => role.alias && role.email && role.password); // Filter out undefined roles

/**
 * List of available role aliases
 * Used to determine which roles are configured
 */
const availableSamples = roleDefinitions.map((role) => role.alias).filter(Boolean);

/**
 * Build samples configuration for authenticated sessions.
 * Maps role aliases to their credentials and storage state paths.
 *
 * @example
 * import { samples } from '../lib/roles.js';
 * const primaryUser = samples.primary_user;
 * console.log(primaryUser.email); // 'test@example.com'
 * console.log(primaryUser.path);  // './tests/src/cookies_storage/primary_user.json'
 */
const samples = roleDefinitions.reduce((acc, role) => {
  const { alias } = role;
  if (alias && availableSamples.includes(alias)) {
    const filePath = path.join('./tests/src/cookies_storage', `${alias}.json`);
    acc[alias] = {
      alias,
      email: role.email,
      password: role.password,
      path: filePath,
      ...role,
    };
  }
  return acc;
}, {});

/**
 * Export samples for use in tests
 *
 * Usage:
 * import { samples } from '../lib/roles.js';
 *
 * // Access specific role
 * const primaryUser = samples.primary_user;
 * await loginPage.login(primaryUser.email, primaryUser.password);
 */
export { samples };
