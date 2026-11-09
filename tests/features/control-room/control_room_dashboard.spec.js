/**
 * Control Room → Overview, Decision ledger, Agents (po-1186 CR2) — CN-CR-008 … CN-CR-014
 *
 * Page under test: ui/src/pages/app/control-room/ (route `/control-room`).
 * Each case names the acceptance criterion it checks (AC-CR-03, 03b, 04, 07c, 11, 13).
 *
 * Conventions
 * -----------
 * - The primary account must be a server admin or own/administer a nest.
 * - CN-CR-008 (AC-CR-03) reads the REAL server: the tiles must equal the
 *   Surfaces read models for the same range. It skips while the server has no
 *   listener activity in the last 14 days (seed one, or run it on staging).
 * - The other cases answer the page's reads in this browser
 *   (tests/src/lib/control_room_dashboard_stubs.js), so they don't depend on
 *   what the server holds: a paused channel, a private-nest row, day zero.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import ControlRoomPage from '../../src/page_factory/app/control_room_page.js';
import { stubSurfacesOn } from '../../src/lib/control_room_stubs.js';
import { stubDashboard } from '../../src/lib/control_room_dashboard_stubs.js';

const primaryRole = samples.primary_user ?? null;

/**
 * CI runs e2e against the deployed server (nest-dev), not this branch's build.
 * Until that server ships the Control room (its /health carries
 * `surfaces_enabled`), the suite skips rather than fails, as in
 * control_room_setup.spec.js. CN_EXPECT_CONTROL_ROOM=1 turns the skip into a failure.
 */
let deployed = false;

test.beforeAll(async ({ request }) => {
  try {
    const h = await (await request.get('/health')).json();
    deployed = typeof h?.surfaces_enabled === 'boolean';
  } catch {
    deployed = false;
  }
});

test.beforeEach(() => {
  if (process.env.CN_EXPECT_CONTROL_ROOM === '1') {
    expect(deployed, 'the server under test does not ship the Control room (/health has no surfaces_enabled)').toBe(true);
  }
  test.skip(!deployed, 'The server under test does not ship the Control room yet (po-1186 CR2).');
});

/** The page's own range: the last 14 UTC days, today included. */
function range14() {
  const now = Date.now();
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
  return { from: new Date(today - 13 * 86400000).toISOString(), to: new Date(now + 1).toISOString() };
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth);
}

async function smallChartLabels(page) {
  return page.evaluate(() => [...document.querySelectorAll('svg text')].filter((t) => parseFloat(getComputedStyle(t).fontSize) < 14).length);
}

test.describe('Control room: dashboard', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test('CN-CR-008 / AC-CR-03: the tiles equal /surfaces/windows, /surfaces/proposals, /surfaces/commits and the budget for the range', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    const health = await (await page.request.get('/health')).json();
    test.skip(!health.surfaces_enabled, 'Surfaces is off on this server.');
    const { from, to } = range14();
    const q = new URLSearchParams({ from, to, by: 'none', grain: 'day', source: 'surfaces' });
    const roll = await (await page.request.get(`/rollups?${q}`)).json();
    test.skip(!roll.totals || roll.totals.entries === 0, 'No listener activity in the last 14 days on this server.');

    // /surfaces/windows answers at most 200 rows a call, so read it per binding.
    const allBindings = (await (await page.request.get('/surfaces/bindings')).json()).bindings;
    let windows = [];
    for (const b of allBindings) {
      const w = (await (await page.request.get(`/surfaces/windows?${new URLSearchParams({ from, to, binding_id: b.id })}`)).json()).windows;
      expect(w.length, 'per-binding read stays under the 200-row page').toBeLessThan(200);
      windows = windows.concat(w.filter((x) => x.status === 'judged'));
    }
    const bindings = allBindings.filter((b) => b.status !== 'removed' && b.conversation_kind !== 'dm');
    // Every listener nest counts toward the tiles, personal (DM) nests included
    // (their rows are redacted, never left out); spend is the team nests' budgets.
    const listenerNests = [...new Set(allBindings.filter((b) => b.status !== 'removed').map((b) => b.nest_id))];
    let items = [];
    let commits = 0;
    let spent = 0;
    for (const n of listenerNests) {
      const props = (await (await page.request.get(`/surfaces/proposals?nest_id=${n}`)).json()).proposals ?? [];
      items = items.concat(props.flatMap((p) => p.items.map((i) => ({ ...i, created_at: p.created_at }))));
      commits += ((await (await page.request.get(`/surfaces/commits?nest_id=${n}`)).json()).commits ?? []).filter((c) => c.created_at >= from).length;
    }
    for (const n of [...new Set(bindings.map((b) => b.nest_id))]) {
      const b = await page.request.get(`/surfaces/nests/${n}/budget`);
      if (b.ok()) spent += (await b.json()).budget.spent_micros;
    }
    const inRange = items.filter((i) => i.created_at >= from || (i.decided_at && i.decided_at >= from));

    const cr = new ControlRoomPage(page);
    await cr.goto('overview');
    await expect(cr.tileValue('reviewed')).toHaveText(windows.length.toLocaleString('en-US'));
    const noOp = windows.filter((w) => w.verdict === 'no_op').length;
    await expect(cr.tile('reviewed')).toContainText(`${Math.round((noOp / windows.length) * 100)}% ended with no proposal`);
    const saved = inRange.filter((i) => i.state === 'approved').length;
    await expect(cr.tileValue('saved')).toHaveText(String(saved));
    expect(saved).toBe(commits);
    await expect(cr.tile('saved')).toContainText(
      `${inRange.filter((i) => i.state === 'approved' && i.edited).length} edited first · ${inRange.filter((i) => i.state === 'rejected').length} rejected · ${inRange.filter((i) => i.state === 'expired').length} expired`,
    );
    await expect(cr.tileValue('spend')).toContainText(`$${(spent / 1e6).toFixed(spent / 1e6 < 1 && spent ? 3 : 2)}`);
    // AC-CR-10 on the page: the rollups line says it matches the ledger.
    await expect(page.getByTestId('cr-rollups-reconcile')).toContainText('Matches the decision ledger for the same range');
  });

  test('CN-CR-009 / AC-CR-03b: a paused channel raises an alert naming it, the reason in counts, and the three fix options', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    await stubDashboard(page, { paused: true });
    const cr = new ControlRoomPage(page);
    await cr.goto('overview');
    const alert = page.getByTestId('cr-paused-alert');
    await expect(alert).toContainText('#onboarding is paused.');
    await expect(alert).toContainText('Company is readable by 312 people');
    await expect(alert).toContainText('1 person from outside the workspace');
    await expect(alert).not.toContainText('@');
    await expect(alert.getByRole('button', { name: 'Adjust who can read Company' })).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Keep paused' })).toBeVisible();
    // "Bind to another nest" is the server admin's (Setup); shown when Setup is.
    if (await cr.tab('Setup').count()) await expect(alert.getByRole('button', { name: 'Bind to another nest' })).toBeVisible();
    await alert.getByRole('button', { name: 'Keep paused' }).click();
    await expect(alert).toHaveCount(0);
  });

  test('CN-CR-010 / AC-CR-04: the cold-start card shows coverage, time to first approved and the folder bars; with no seed it says so and points to Setup', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    await stubDashboard(page, { coldStart: 'seeded' });
    const cr = new ControlRoomPage(page);
    await cr.goto('overview');
    await expect(page.getByTestId('cs-coverage')).toContainText('4 of 5');
    await expect(page.getByTestId('cs-first')).toContainText('2 h 14 m');
    await expect(page.getByTestId('cr-coldstart')).toContainText('how-we-work/ has nothing approved yet.');

    await stubDashboard(page, { coldStart: 'none' });
    await cr.goto('overview');
    await expect(page.getByTestId('cr-coldstart-none')).toContainText(/starter folders yet/i);
  });

  test('CN-CR-011 / AC-CR-07c: a private-nest row reads "DM · private nest · title hidden" in the ledger and the drawer', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    await stubDashboard(page, {});
    const cr = new ControlRoomPage(page);
    await cr.goto('ledger');
    const row = page.locator('[data-testid="cr-ledger-row"][data-entry="win_private"]:visible');
    await expect(row).toContainText('DM · private nest · title hidden');
    await expect(row).not.toContainText('Dentist');
    await row.click();
    await expect(page.getByTestId('cr-trace-title')).toHaveText('DM · private nest · title hidden');
    await expect(page.getByTestId('cr-trace-body')).toContainText("This row comes from someone's private nest");
  });

  test('CN-CR-012: the drawer\'s Reason row is the agent\'s reason, never the verdict again; a complete chain says so', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    await stubDashboard(page, {});
    const cr = new ControlRoomPage(page);
    await page.goto('/control-room?section=ledger&entry=run_external');
    await expect(page.getByTestId('cr-trace-body')).toBeVisible();
    await expect(page.getByTestId('cr-trace-reason')).toContainText('New decision');
    await expect(page.getByTestId('cr-trace-reason')).toContainText('Moved feature flags to flags/ service');
    await expect(page.getByTestId('cr-trace-reason')).not.toHaveText(/^Proposed$/);
    await expect(page.getByTestId('cr-trace-body')).toContainText('Complete chain.');
    await expect(page.getByTestId('cr-trace-steps')).toContainText('decision');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('cr-trace')).toHaveCount(0);
    void cr;
  });

  test('CN-CR-013 / AC-CR-13: day zero — Overview, Decision ledger and Agents each show their empty state with a way on, and no charts', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    await stubDashboard(page, { empty: true });
    const cr = new ControlRoomPage(page);
    await cr.goto('overview');
    await expect(page.getByTestId('cr-empty-overview')).toContainText('Nothing is listening yet');
    await expect(page.getByTestId('cr-empty-overview').getByRole('button', { name: 'Report its runs here' })).toBeVisible();
    await expect(page.locator('main svg[role="img"]')).toHaveCount(0);
    await cr.tab('Decision ledger').click();
    await expect(page.getByTestId('cr-empty-ledger')).toContainText('No agent actions yet');
    await expect(page.getByTestId('cr-empty-ledger').getByRole('button', { name: 'Connect an agent' })).toBeVisible();
    await cr.tab('Agents').click();
    await expect(page.getByTestId('cr-empty-agents')).toContainText('No agents have reported yet');
    await expect(page.getByTestId('cr-connect')).toContainText('Connect an agent');
  });

  for (const width of [390, 1440]) {
    test(`CN-CR-014 / AC-CR-11: at ${width}px every Control room tab has no horizontal scroll and no chart label under 14px`, async ({ primary_user }) => {
      await primary_user.initialize();
      const { page } = primary_user;
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      await stubSurfacesOn(page);
      await stubDashboard(page, { paused: true, coldStart: 'seeded' });
      const cr = new ControlRoomPage(page);
      for (const tab of ['overview', 'ledger', 'agents']) {
        await cr.goto(tab);
        await page.waitForLoadState('networkidle');
        expect(await noHorizontalScroll(page), `${tab} at ${width}`).toBe(true);
        expect(await smallChartLabels(page), `${tab} at ${width}`).toBe(0);
      }
      await page.goto('/control-room?section=ledger&entry=run_external');
      await expect(page.getByTestId('cr-trace-body')).toBeVisible();
      expect(await noHorizontalScroll(page)).toBe(true);
    });
  }
});
