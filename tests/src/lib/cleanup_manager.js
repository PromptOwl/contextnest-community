/**
 * Cleanup Manager
 *
 * Deletes automation-created entities (AUTO_ prefix) from the ContextNest
 * Community server. Unlike TheOwl's UI-driven cleanup, deletion here goes
 * through the REST API using the authenticated page's request context — the
 * session cookie stored by setup-auth authorizes the calls, which is faster
 * and far less flaky than driving delete dialogs through the UI.
 *
 * Three entry points (same contract as the TheOwl framework):
 *   - cleanupStaleEntities(page)  — Phase 1 of the orphan sweeper: delete
 *     known IDs carried forward from a previous interrupted run.
 *   - sweepOrphans(page, runId)   — Phase 2: scan the server for any AUTO_
 *     nests the registry doesn't know about and delete them.
 *   - cleanupAllRegistered(page)  — global cleanup/teardown: delete every
 *     entity tracked in the current run's registry.
 *
 * Every report has the shape:
 *   { totalAttempted, successful, failed, details: [{ type, id, name, status, error? }] }
 */

import {
  getPendingEntities,
  getStaleEntities,
  clearStaleEntities,
  markDeleted,
  ENTITY_TYPES,
} from './entity_registry.js';
import { AUTO_PREFIX } from '../helper/utility/utility.js';
import logger from '../helper/logger/logger.js';

/**
 * Deletion order matters: documents live inside nests, so deleting a nest
 * already removes its documents — documents and tags first keeps individual
 * failures isolated, nests last sweeps whatever remains.
 */
export const CLEANUP_ORDER = ['documents', 'nests'];

/**
 * Issue an authenticated API request via the page's request context.
 * The storage-state session cookie (cnst_session) rides along automatically.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'GET'|'POST'|'DELETE'} method
 * @param {string} urlPath - Path relative to baseURL (e.g. '/nests')
 * @returns {Promise<{ok: boolean, status: number, data: any}>}
 */
async function apiRequest(page, method, urlPath) {
  const response = await page.request.fetch(urlPath, { method });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON response (e.g. 204) — fine.
  }
  return { ok: response.ok(), status: response.status(), data };
}

/**
 * Delete a single entity through the REST API.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} type - Entity type: nests|documents
 * @param {Object} entity - { id, name, metadata }
 * @returns {Promise<{status: string, error?: string}>}
 */
async function deleteEntity(page, type, entity) {
  let urlPath;
  switch (type) {
    case 'nests':
      urlPath = `/nests/${entity.id}`;
      break;
    case 'documents': {
      // Documents are nodes scoped to a nest; nestId travels in the metadata.
      const nestId = entity.metadata?.nestId;
      if (!nestId) {
        return { status: 'failed', error: 'Document entity registered without metadata.nestId' };
      }
      urlPath = `/nests/${nestId}/nodes/${entity.id}`;
      break;
    }
    default:
      return { status: 'failed', error: `Unknown entity type: ${type}` };
  }

  const { ok, status } = await apiRequest(page, 'DELETE', urlPath);

  // 404 means it's already gone — that's a successful cleanup.
  if (ok || status === 404) {
    return { status: 'deleted' };
  }
  return { status: 'failed', error: `DELETE ${urlPath} → HTTP ${status}` };
}

/**
 * Delete a list of { type, entity } pairs with retries, building a report.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<{type: string, entity: Object}>} items
 * @param {Object} [options]
 * @param {number} [options.maxRetries=2]
 * @param {Function} [options.onDeleted] - Callback (type, entity) after success
 * @returns {Promise<Object>} Cleanup report
 */
async function deleteAll(page, items, { maxRetries = 2, onDeleted = null } = {}) {
  const report = { totalAttempted: items.length, successful: 0, failed: 0, details: [] };

  for (const { type, entity } of items) {
    let result = { status: 'failed', error: 'not attempted' };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        result = await deleteEntity(page, type, entity);
      } catch (error) {
        result = { status: 'failed', error: error.message };
      }
      if (result.status === 'deleted') break;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    if (result.status === 'deleted') {
      report.successful++;
      if (onDeleted) onDeleted(type, entity);
      logger.info(`[Cleanup] Deleted ${type}/${entity.name} (${entity.id})`);
    } else {
      report.failed++;
      logger.warn(`[Cleanup] Failed ${type}/${entity.name}: ${result.error}`);
    }
    report.details.push({ type, id: entity.id, name: entity.name, status: result.status, ...(result.error ? { error: result.error } : {}) });
  }

  return report;
}

/**
 * Phase 1 of the orphan sweeper: delete stale entities carried forward from
 * a previous interrupted run (known IDs stored in the registry).
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Object>} Cleanup report
 */
export async function cleanupStaleEntities(page) {
  const stale = getStaleEntities();
  if (stale.length === 0) {
    return { totalAttempted: 0, successful: 0, failed: 0, details: [] };
  }

  // Respect dependency order across mixed stale entries
  const ordered = CLEANUP_ORDER.flatMap((type) =>
    stale.filter((e) => e.entityType === type).map((e) => ({ type, entity: e }))
  );

  const report = await deleteAll(page, ordered);

  // Only forget the stale list once everything was actually removed.
  if (report.failed === 0) {
    clearStaleEntities();
  }
  return report;
}

/**
 * How old an AUTO_ nest must be before the sweep treats it as an orphan.
 * Override with ORPHAN_MIN_AGE_MINUTES.
 */
const ORPHAN_MIN_AGE_MS = (Number(process.env.ORPHAN_MIN_AGE_MINUTES) || 120) * 60_000;

/**
 * When an AUTO_ nest was created: from the timestamp generateEntityName()
 * puts in its name (`AUTO_<base36 ms>-…`), else from the server's created_at.
 * Null when neither can be read — such a nest is swept as before.
 */
function autoCreatedAt(nest) {
  const m = /^AUTO_([0-9a-z]+)-/.exec(nest.name);
  if (m) {
    const t = parseInt(m[1], 36);
    if (Number.isFinite(t) && t > 1.5e12 && t < 4e12) return t;
  }
  const raw = typeof nest.created_at === 'string' ? nest.created_at : '';
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Phase 2 of the orphan sweeper: scan the server for AUTO_ nests the registry
 * doesn't know about (created by crashed runs before registration could
 * happen) and delete them.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string|null} currentRunId - For logging only
 * @returns {Promise<Object>} Cleanup report
 */
export async function sweepOrphans(page, currentRunId = null) {
  const report = { totalAttempted: 0, successful: 0, failed: 0, details: [] };

  const { ok, status, data } = await apiRequest(page, 'GET', '/nests');
  if (!ok) {
    logger.warn(`[OrphanSweep] GET /nests failed with HTTP ${status} — skipping sweep`);
    return report;
  }

  const nests = Array.isArray(data) ? data : data?.nests || [];
  // Only sweep nests this account owns — shared/discovered AUTO_ nests belong
  // to another test account's run and its own sweep will take them.
  const candidates = nests.filter(
    (n) => typeof n.name === 'string' && n.name.startsWith(AUTO_PREFIX) && !n.discovered
  );
  // Several runs (CI on every PR, local runs) share the same accounts on a
  // deployed server. A young AUTO_ nest may belong to a run still in
  // progress, and deleting it pulls the data out from under that run's tests
  // — so only nests old enough to be leftovers count as orphans.
  const now = Date.now();
  const orphans = candidates.filter((n) => {
    const created = autoCreatedAt(n);
    return created === null || now - created >= ORPHAN_MIN_AGE_MS;
  });
  const kept = candidates.length - orphans.length;
  if (kept > 0) {
    logger.info(`[OrphanSweep] Leaving ${kept} AUTO_ nest(s) younger than ${ORPHAN_MIN_AGE_MS / 60_000} min — they may belong to a run in progress`);
  }

  if (orphans.length === 0) {
    logger.info(`[OrphanSweep] No orphan AUTO_ nests found (runId: ${currentRunId || 'none'})`);
    return report;
  }

  logger.info(`[OrphanSweep] Found ${orphans.length} orphan AUTO_ nests to delete`);
  const items = orphans.map((n) => ({ type: 'nests', entity: { id: n.id, name: n.name } }));
  return deleteAll(page, items);
}

/**
 * Delete every entity tracked in the current run's registry, in dependency
 * order. Used by the global cleanup teardown and the interrupt-safe
 * globalTeardown hook.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} [options]
 * @param {number} [options.maxRetries=2]
 * @returns {Promise<Object>} Cleanup report
 */
export async function cleanupAllRegistered(page, { maxRetries = 2 } = {}) {
  const pending = getPendingEntities();

  const items = CLEANUP_ORDER.flatMap((type) =>
    (pending[type] || []).map((entity) => ({ type, entity }))
  );

  return deleteAll(page, items, {
    maxRetries,
    onDeleted: (type, entity) => markDeleted(type, entity.id),
  });
}

export { ENTITY_TYPES };
