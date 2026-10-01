/**
 * Playwright globalTeardown — Interrupt-Safe Cleanup
 *
 * This script is invoked by Playwright's globalTeardown hook, which runs
 * even when the user presses Ctrl+C (Playwright calls it in its finally block).
 *
 * It launches a fresh Chromium browser with stored auth state, then:
 *   1. Deletes all entities tracked in the current run's registry
 *   2. Sweeps orphan AUTO_ nests via the REST API
 *   3. Clears the registry if everything succeeds
 *
 * If the process is force-killed (double Ctrl+C / kill -9), this won't run,
 * but the next run's initializeRun() preserves stale entities and the
 * orphan sweeper handles them.
 */

import { chromium } from '@playwright/test';
import fs from 'fs';

import { getPendingEntities, clearAll, getRunId, ENTITY_TYPES } from '../../lib/entity_registry.js';
import { cleanupAllRegistered, sweepOrphans } from '../../lib/cleanup_manager.js';
import { samples as roles } from '../../lib/roles.js';

/**
 * Find a valid auth storage state file from configured roles.
 * @returns {string|null} Path to a valid storage state JSON, or null
 */
function findAuthState() {
  for (const role of Object.values(roles)) {
    if (role.path && fs.existsSync(role.path)) {
      try {
        const data = JSON.parse(fs.readFileSync(role.path, 'utf8'));
        // Verify the file has cookies
        if (data.cookies && data.cookies.length > 0) {
          return role.path;
        }
      } catch {
        // Skip malformed files
      }
    }
  }
  return null;
}

/**
 * Playwright globalTeardown function.
 * @param {import('@playwright/test').FullConfig} config
 */
async function globalTeardown(config) {
  // Check if there's anything to clean up
  const pending = getPendingEntities();
  const totalPending = ENTITY_TYPES.reduce((sum, type) => sum + (pending[type]?.length || 0), 0);

  if (totalPending === 0) {
    console.log('[GlobalTeardown] No pending entities — skipping browser cleanup');
    return;
  }

  console.log(`[GlobalTeardown] ${totalPending} pending entities found — launching browser for cleanup`);

  // Find auth state
  const authStatePath = findAuthState();
  if (!authStatePath) {
    console.warn('[GlobalTeardown] No valid auth state found — cannot run cleanup');
    console.warn('[GlobalTeardown] Entities remain in registry; orphan sweeper will handle on next run');
    return;
  }

  const baseURL = process.env.BASE_URL || 'http://localhost:3838';
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
    });
    const context = await browser.newContext({
      baseURL,
      storageState: authStatePath,
    });
    const page = await context.newPage();

    // Phase 1: Delete all registered entities from current run
    console.log('[GlobalTeardown] Phase 1: Cleaning up registered entities...');
    const registryReport = await cleanupAllRegistered(page, { maxRetries: 2 });

    console.log(
      `[GlobalTeardown] Registry cleanup: ${registryReport.successful}/${registryReport.totalAttempted} succeeded`
    );

    // Phase 2: Sweep orphan AUTO_ nests via the API
    const currentRunId = getRunId();
    console.log('[GlobalTeardown] Phase 2: Sweeping orphan entities...');
    const sweepReport = await sweepOrphans(page, currentRunId);

    console.log(
      `[GlobalTeardown] Orphan sweep: ${sweepReport.successful}/${sweepReport.totalAttempted} succeeded`
    );

    // Only clear registry if Phase 1 (tracked entity cleanup) succeeded.
    // Sweep failures (Phase 2) don't need registry preservation since those are untracked orphans.
    if (registryReport.failed === 0) {
      clearAll();
      console.log('[GlobalTeardown] Registry cleared — all tracked entities cleaned up');
    } else {
      console.warn(`[GlobalTeardown] ${registryReport.failed} registry entities failed — preserved for next run`);
    }
    if (sweepReport.failed > 0) {
      console.warn(`[GlobalTeardown] ${sweepReport.failed} orphan sweep failures — will retry on next run`);
    }

    await context.close();
  } catch (error) {
    console.error(`[GlobalTeardown] Error during cleanup: ${error.message}`);
    console.error('[GlobalTeardown] Entities remain in registry; orphan sweeper will handle on next run');
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export default globalTeardown;
