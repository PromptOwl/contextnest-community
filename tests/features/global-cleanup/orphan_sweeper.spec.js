/**
 * Orphan Sweeper — Pre-Run Cleanup (Two-Phase)
 *
 * Runs after auth setup but before test specs. Ensures a clean baseline
 * regardless of how the previous run ended (graceful, Ctrl+C, or kill -9).
 *
 * Phase 1: Delete stale entities from the registry — known IDs carried
 *          forward from a previous interrupted run by initializeRun().
 * Phase 2: API-based sweep — scans the server for any AUTO_ nests the
 *          registry doesn't know about and deletes them.
 *
 * Usage:
 *   npx playwright test --project=test-suite   (runs automatically before tests)
 *   npx playwright test --project=orphan-sweep (run standalone)
 */

import { test } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { getRunId } from '../../src/lib/entity_registry.js';
import { cleanupStaleEntities, sweepOrphans } from '../../src/lib/cleanup_manager.js';

const availableRoles = Object.values(samples);
const primaryRole = availableRoles[0] || null;

test.describe('Orphan Sweeper', () => {
  // Extended timeout: large backlogs of orphan entities can take a while to sweep
  test.setTimeout(5 * 60 * 1000); // 5 minutes

  test('TC-030: should clean stale entities and sweep AUTO_ orphans from previous runs', async ({ primary_user }) => {
    test.skip(!primaryRole, 'No test roles configured.');

    await primary_user.initialize();
    const { page } = primary_user;

    const currentRunId = getRunId();
    console.log(`[OrphanSweeper] Current runId: ${currentRunId || 'none'}`);

    // ── Phase 1: Stale registry entities (known IDs from interrupted runs) ──
    console.log('\n[OrphanSweeper] ── Phase 1: Stale Entity Cleanup ──');
    const staleReport = await cleanupStaleEntities(page);

    if (staleReport.totalAttempted > 0) {
      console.log(`  Stale attempted: ${staleReport.totalAttempted}`);
      console.log(`  Stale successful: ${staleReport.successful}`);
      console.log(`  Stale failed:     ${staleReport.failed}`);

      for (const detail of staleReport.details) {
        const status = detail.status === 'deleted' ? 'OK' : 'FAIL';
        const error = detail.error ? ` — ${detail.error}` : '';
        console.log(`    [${status}] ${detail.type}/${detail.name}${error}`);
      }
    } else {
      console.log('  No stale entities found');
    }

    // ── Phase 2: API-based orphan sweep (AUTO_ nests) ──
    console.log('\n[OrphanSweeper] ── Phase 2: API Orphan Sweep ──');
    const sweepReport = await sweepOrphans(page, currentRunId);

    // Log combined summary
    const totalAttempted = staleReport.totalAttempted + sweepReport.totalAttempted;
    const totalSuccessful = staleReport.successful + sweepReport.successful;
    const totalFailed = staleReport.failed + sweepReport.failed;

    console.log('\n[OrphanSweeper] ========== SWEEP REPORT ==========');
    console.log(`  Total attempted: ${totalAttempted}`);
    console.log(`  Successful:      ${totalSuccessful}`);
    console.log(`  Failed:          ${totalFailed}`);

    if (sweepReport.details.length > 0) {
      console.log('\n  API Sweep Details:');
      for (const detail of sweepReport.details) {
        const status = detail.status === 'deleted' ? 'OK' : 'FAIL';
        const error = detail.error ? ` — ${detail.error}` : '';
        console.log(`    [${status}] ${detail.type}/${detail.name}${error}`);
      }
    }
    console.log('[OrphanSweeper] ====================================\n');

    // This test always passes — failed orphan deletion is non-fatal.
    // The global cleanup at the end of the run will catch any new entities.
  });
});
