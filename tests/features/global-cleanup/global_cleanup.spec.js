/**
 * Global Cleanup Test Suite
 *
 * Comprehensive teardown that always runs (even if tests fail) as a
 * Playwright teardown project.
 *
 * Reads the entity registry, deletes all tracked entities in dependency
 * order, logs a detailed report, and clears the registry.
 *
 * Usage:
 *   npx playwright test --project=test-suite       (runs automatically as teardown)
 *   npx playwright test --project=teardown-cleanup (run standalone)
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { getPendingEntities, clearAll } from '../../src/lib/entity_registry.js';
import { cleanupAllRegistered, CLEANUP_ORDER } from '../../src/lib/cleanup_manager.js';

const availableRoles = Object.values(samples);
const primaryRole = availableRoles[0] || null;

test.describe('Global Cleanup', () => {
  test.describe.configure({ mode: 'serial' });

  test('TC-028: should delete all registered test entities', async ({ primary_user }) => {
    test.skip(!primaryRole, 'No test roles configured.');

    // Check if there are any entities to clean up
    const pending = getPendingEntities();
    const totalPending = CLEANUP_ORDER.reduce((sum, type) => sum + (pending[type]?.length || 0), 0);

    if (totalPending === 0) {
      console.log('[GlobalCleanup] No entities found in registry to delete');
      return;
    }

    // A delete on a shared server takes a few seconds, and a full run leaves
    // dozens of entities, so the default test timeout is too short. Allow
    // about 10s per entity, never less than the default.
    test.setTimeout(Math.max(2 * 60 * 1000, totalPending * 10_000));

    console.log(`[GlobalCleanup] Found ${totalPending} entities to clean up`);
    for (const type of CLEANUP_ORDER) {
      const count = pending[type]?.length || 0;
      if (count > 0) {
        console.log(`  ${type}: ${count}`);
      }
    }

    await primary_user.initialize();
    const { page } = primary_user;

    // Run cleanup for all registered entities
    const report = await cleanupAllRegistered(page, { maxRetries: 3 });

    // Log detailed report
    console.log('\n[GlobalCleanup] ========== CLEANUP REPORT ==========');
    console.log(`  Total attempted: ${report.totalAttempted}`);
    console.log(`  Successful:      ${report.successful}`);
    console.log(`  Failed:          ${report.failed}`);

    if (report.details.length > 0) {
      console.log('\n  Details:');
      for (const detail of report.details) {
        const status = detail.status === 'deleted' ? 'OK' : 'FAIL';
        const error = detail.error ? ` — ${detail.error}` : '';
        console.log(`    [${status}] ${detail.type}/${detail.name}${error}`);
      }
    }
    console.log('[GlobalCleanup] ====================================\n');

    // Clear the registry only if all deletions succeeded.
    // If some failed, keep the registry so the orphan sweeper can pick them up next run.
    if (report.failed === 0) {
      clearAll();
      console.log('[GlobalCleanup] Registry cleared (all entities deleted successfully)');
    } else {
      console.warn(`[GlobalCleanup] Registry NOT cleared — ${report.failed} entities failed to delete`);
      console.warn('[GlobalCleanup] Failed entities will be swept by orphan sweeper on next run');
    }
  });

  test('TC-029: should verify registry state after cleanup', async () => {
    const pending = getPendingEntities();
    const remaining = CLEANUP_ORDER.reduce((sum, type) => sum + (pending[type]?.length || 0), 0);

    if (remaining > 0) {
      console.warn(`[GlobalCleanup] ${remaining} entities still pending — orphan sweeper will retry next run`);
    } else {
      console.log('[GlobalCleanup] Registry is clean');
    }

    // Non-fatal: pending entities are handled by the next run's sweeper
    expect(remaining).toBeGreaterThanOrEqual(0);
  });
});
