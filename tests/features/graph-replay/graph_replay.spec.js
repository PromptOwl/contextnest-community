/**
 * Graph → context pull replay (po-1252) — CN-GRAPH-REPLAY-001 … 003
 *
 * Page under test: the nest Graph view (ui/src/components/OntologyGraphView.tsx,
 * side panel ui/src/components/PullLog.tsx), route `/nest/<id>/graph`.
 *
 * Conventions
 * -----------
 * - primary_user owns one AUTO_ nest per test with a three-document chain:
 *   Returns Policy → [[Warranty Terms]] → [[Escalation Matrix]], plus an
 *   unlinked Brand Voice. The pull under test is a REST /context call with
 *   hops 2 made from the same session, so it is recorded with its traversal.
 * - Reduced motion is emulated, so a click shows the replay's final state at
 *   once and the checks don't race the animation clock.
 * - CI runs e2e against the deployed server (nest-dev), not this branch. Until
 *   that server ships the replay (its /health carries `pull_replay`), the suite
 *   skips rather than fails. CN_EXPECT_PULL_REPLAY=1 turns the skip into a
 *   failure.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;
const WRITE = { timeout: 60_000 };

let deployed = false;

test.beforeAll(async ({ request }) => {
  try {
    const h = await (await request.get('/health')).json();
    deployed = h?.pull_replay === true;
  } catch {
    deployed = false;
  }
});

test.beforeEach(() => {
  if (process.env.CN_EXPECT_PULL_REPLAY === '1') {
    expect(deployed, 'the server under test does not ship the pull replay (/health has no pull_replay)').toBe(true);
  }
  test.skip(!deployed, 'The server under test does not ship the Graph pull replay yet (po-1252).');
});

const CHAIN = [
  ['Returns Policy', 'Returns within 45 days. Damaged items follow [[Warranty Terms]].'],
  ['Warranty Terms', 'Lifetime warranty. Big claims go through [[Escalation Matrix]].'],
  ['Escalation Matrix', 'Tier 2 handles warranty claims over 300 dollars.'],
  ['Brand Voice', 'Plain and warm.'],
];

test.describe('Graph: context pull replay', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test.afterEach(async ({ primary_user }) => {
    await primary_user.nestOverviewApi.deleteCreatedNests().catch(() => {});
  });

  /** A nest with the chain, and one recorded /context pull over it. */
  async function nestWithPull(role, commonFunction, suffix) {
    await role.initialize();
    const api = role.nestOverviewApi;
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Graph replay suite (safe to delete)');
    const ids = {};
    for (const [title, body] of CHAIN) {
      ids[title] = (await api.createTypedDocument(nest.id, { title, content: `# ${title}\n\n${body}\n` })).id;
    }
    const res = await role.page.request.post(`/nests/${nest.id}/context`, {
      data: { selector: '[[Returns Policy]]', hops: 2 },
    });
    expect(res.ok(), 'POST /context').toBe(true);
    return { nest, ids, page: role.page };
  }

  test('CN-GRAPH-REPLAY-001: a pull is listed, and clicking it lights its documents in order with the compiled context', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, ids, page } = await nestWithPull(primary_user, commonFunction, 'replay-chain');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/nest/${nest.id}/graph`);

    const item = page.getByTestId('graph-pull-item').first();
    await expect(item).toBeVisible(WRITE);
    await expect(item).toContainText('Context');
    await expect(item).toContainText('3 docs');
    await expect(item).toContainText('2 hops');

    await item.click();
    const trace = page.getByTestId('graph-pull-trace');
    await expect(trace).toBeVisible();
    const steps = page.getByTestId('graph-pull-step');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('Returns Policy');
    await expect(steps.nth(0)).toContainText('Matched');
    await expect(steps.nth(1)).toContainText('Warranty Terms');
    await expect(steps.nth(1)).toContainText('Hop 1 via Returns Policy');
    await expect(steps.nth(2)).toContainText('Escalation Matrix');
    await expect(steps.nth(2)).toContainText('Hop 2 via Warranty Terms');
    await expect(page.locator('[data-testid="graph-pull-step"][data-lit="true"]')).toHaveCount(3);

    // On the canvas: the three pulled documents lit, Brand Voice not.
    for (const t of ['Returns Policy', 'Warranty Terms', 'Escalation Matrix']) {
      await expect(page.locator(`[data-testid="graph-node"][data-node-id="${ids[t]}"]`)).toHaveAttribute('data-pulled', 'true');
    }
    await expect(page.locator(`[data-testid="graph-node"][data-node-id="${ids['Brand Voice']}"]`)).not.toHaveAttribute('data-pulled', 'true');
    await expect(page.locator('[data-testid="graph-pull-edges"] line')).toHaveCount(2);
    await expect(page.getByTestId('graph-pull-hud')).toContainText('3 / 3');

    // Jumping to a step lights only up to it.
    await steps.nth(0).getByRole('button', { name: 'Show step 1' }).click();
    await expect(page.locator('[data-testid="graph-pull-step"][data-lit="true"]')).toHaveCount(1);
    await page.getByTestId('graph-pull-replay-button').click();
    await expect(page.locator('[data-testid="graph-pull-step"][data-lit="true"]')).toHaveCount(3);
  });

  test('CN-GRAPH-REPLAY-002: the page shows the same pull the API and MCP return', async ({ primary_user, commonFunction }) => {
    const { nest, page } = await nestWithPull(primary_user, commonFunction, 'replay-parity');
    const rest = await (await page.request.get(`/nests/${nest.id}/pulls?limit=5`)).json();
    expect(rest.pulls[0].tool).toBe('context');
    expect(rest.pulls[0].steps.map((s) => s.hop)).toEqual([0, 1, 2]);
    const mcp = await page.request.post(`/nests/${nest.id}/mcp`, {
      headers: { Accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_pull_log', arguments: { limit: 5 } } },
    });
    const text = await mcp.text();
    const body = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data: ')).slice(6));
    expect(body.result.structuredContent.pulls[0].steps).toEqual(rest.pulls[0].steps);
  });

  test('CN-GRAPH-REPLAY-003: at phone width the graph, the log and the compiled context stack with no sideways scroll', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await nestWithPull(primary_user, commonFunction, 'replay-phone');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/nest/${nest.id}/graph`);
    const item = page.getByTestId('graph-pull-item').first();
    await expect(item).toBeVisible(WRITE);
    await item.click();
    await expect(page.getByTestId('graph-pull-hud')).toBeInViewport();
    await expect(page.getByTestId('graph-pull-step')).toHaveCount(3);
    const sideways = await page.evaluate(() => document.scrollingElement.scrollWidth > window.innerWidth);
    expect(sideways).toBe(false);
  });
});
