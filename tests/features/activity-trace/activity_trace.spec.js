/**
 * Activity Trace Test Suite — CN-TRACE-001 … CN-TRACE-008
 *
 * Page under test: ui/src/components/ActivityTracePage.tsx, server-wide mode
 * (route `/trace`, rail → Admin → Activity trace).
 *
 * Conventions
 * -----------
 * - The page is for server admins: the primary account runs every case but the
 *   non-admin half of CN-TRACE-001, which needs a second account that is not one.
 * - The page only reads (`GET /admin/trace`). Cases run against the real
 *   server-wide trace where they can. That trace grows with every request on a
 *   shared server — the suite's own included — so rows and counts are checked
 *   against the response the page itself received, never a number read
 *   separately.
 * - A few states can't be arranged from the real trace: an empty or failing
 *   read, a read slow enough to watch Refresh while it loads, an exact last
 *   page, and one row of every shape. Those are served by
 *   `src/lib/activity_trace_stubs.js`, and each such test says so.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { TRACE_COLUMNS } from '../../src/page_factory/app/activity_trace_page.js';
import { traceRow, stubTrace, holdTrace } from '../../src/lib/activity_trace_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

const PAGE_SIZE = 25;

/** "{from}–{to} of {total}" for a read at `offset` with `total` rows. */
const counterFor = (offset, total) => `${total === 0 ? 0 : offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`;

/** Initialise the primary account; skips when it isn't a server admin. */
async function asAdmin(role) {
  await role.initialize();
  test.skip(!(await role.teammatesApi.isServerAdmin()), 'primary_user is not a server admin on this server.');
  return role;
}

/** The rows the page shows must be exactly the events it received. */
async function expectRowsMatch(tr, events) {
  await expect(tr.rows).toHaveCount(events.length);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    await expect(tr.kindBadge(i), `row ${i} kind`).toHaveText(e.kind);
    await expect(tr.cell(i, 'Call'), `row ${i} call`).toHaveText(e.kind === 'mcp' ? String(e.tool ?? '') : `${e.method} ${e.path}`);
  }
}

test.describe('Activity trace', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test('CN-TRACE-001: the page is admin-only and shows the server-wide trace table', async ({
    primary_user,
    secondary_user,
  }) => {
    // ── A non-admin: no rail row, the URL shows Nests, the API refuses ──
    if (secondaryRole) {
      await secondary_user.initialize();
      if (!(await secondary_user.teammatesApi.isServerAdmin())) {
        const { page, nestsPage, activityTracePage: tr } = secondary_user;
        await nestsPage.goto();
        await expect(page.getByTestId('document-sidebar-dashboard-teams')).toBeVisible();
        await expect(tr.railItem).toHaveCount(0);
        await page.goto('/trace');
        await expect(tr.pageTitle).toContainText('Nests');
        await expect(tr.userFilter).toHaveCount(0);
        const res = await secondary_user.dashboardApi.request('GET', '/admin/trace');
        expect(res.status, 'GET /admin/trace as a non-admin').toBe(403);
      }
    }

    // ── The admin: rail row → the server-wide trace ──
    await asAdmin(primary_user);
    const { nestsPage, activityTracePage: tr } = primary_user;
    await nestsPage.goto();
    await expect(tr.railItem).toBeVisible();
    const { query, body } = await tr.gotoAndRead(() => tr.railItem.click());
    await expect(tr.railItem).toHaveAttribute('aria-current', 'page');
    await expect(tr.pageTitle).toContainText('Activity trace');
    // Server-wide: no kind or user filter, the first page of 25, and a Nest column.
    expect(query).toEqual({ kind: null, user: null, limit: '25', offset: '0' });
    await expect(tr.headers).toHaveText(TRACE_COLUMNS);
    expect(body.total, 'a shared server has activity').toBeGreaterThan(0);
    await expectRowsMatch(tr, body.events);
    await expect(tr.counter).toHaveText(counterFor(0, body.total));
    await expect(tr.page.getByText('Rolling retention window (server setting), newest first.')).toBeVisible();
    // Newest first, in the order the server recorded them (by row id). A row is
    // written when its request finishes, so a slow request that started earlier
    // can sit above a faster later one by its start time.
    const ids = body.events.map((e) => e.id);
    expect(ids, 'rows are newest first').toEqual([...ids].sort((a, b) => b - a));
  });

  test('CN-TRACE-002: the table columns and kind badges render correctly', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { page, activityTracePage: tr } = primary_user;

    // ── The real trace: each badge colour matches its kind ──
    const { body } = await tr.gotoAndRead();
    await expect(tr.headers).toHaveText(TRACE_COLUMNS);
    for (let i = 0; i < body.events.length; i++) {
      await expect(tr.kindBadge(i)).toHaveClass(body.events[i].kind === 'mcp' ? /bg-violet-50/ : /bg-blue-50/);
    }

    // ── One row of every shape (stubbed: the real trace may lack some) ──
    const rows = [
      traceRow(0, { method: 'POST', path: '/nests/n-1/nodes', nest_id: 'n-1', caller: 'ann@example.com', status: 201, duration_ms: 48 }),
      traceRow(1, { kind: 'mcp', method: null, path: null, tool: 'context_search', nest_id: 'n-2', caller: 'agent@example.com', status: 200, duration_ms: 230, client: { agent: 'claude-code', session_id: 's-9f2' } }),
      traceRow(2, { method: 'DELETE', path: '/nests/n-3', nest_id: 'n-3', caller: 'bob@example.com', status: 403, duration_ms: 5 }),
      traceRow(3, { method: 'GET', path: '/health', nest_id: null, caller: null, status: null, duration_ms: null }),
    ];
    await stubTrace(page, rows);
    await page.reload();
    await tr.waitIdle();
    await expect(tr.rows).toHaveCount(4);

    // api row: blue badge, "METHOD path", nest, caller, green 2xx, ms.
    await expect(tr.kindBadge(0)).toHaveText('api');
    await expect(tr.kindBadge(0)).toHaveClass(/bg-blue-50/);
    await expect(tr.cell(0, 'Call')).toHaveText('POST /nests/n-1/nodes');
    await expect(tr.cell(0, 'Nest')).toHaveText('n-1');
    await expect(tr.cell(0, 'Caller')).toHaveText('ann@example.com');
    await expect(tr.cell(0, 'Status').locator('span')).toHaveText('201');
    await expect(tr.cell(0, 'Status').locator('span')).toHaveClass(/text-green-700/);
    await expect(tr.cell(0, 'ms')).toHaveText('48');
    await expect(tr.cell(0, 'Time')).not.toBeEmpty();

    // mcp row: violet badge, the tool name, and the client the call carried.
    await expect(tr.kindBadge(1)).toHaveText('mcp');
    await expect(tr.kindBadge(1)).toHaveClass(/bg-violet-50/);
    await expect(tr.cell(1, 'Call')).toHaveText('context_search');
    await expect(tr.cell(1, 'Caller')).toContainText('agent@example.com');
    await expect(tr.cell(1, 'Caller')).toContainText('claude-code · s-9f2');

    // A refused call shows its status in red.
    await expect(tr.cell(2, 'Status').locator('span')).toHaveText('403');
    await expect(tr.cell(2, 'Status').locator('span')).toHaveClass(/text-red-600/);

    // Missing nest, caller, status and duration read as "—".
    for (const col of ['Nest', 'Caller', 'Status', 'ms']) {
      await expect(tr.cell(3, col), `${col} with no value`).toHaveText('—');
    }
  });

  test('CN-TRACE-003: filtering by kind (All/API/MCP) works', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { activityTracePage: tr } = primary_user;
    const all = await tr.gotoAndRead();
    await expect(tr.kindSelect).toHaveText('All');

    const mcp = await tr.chooseKind('MCP');
    expect(mcp.query.kind).toBe('mcp');
    await expect(tr.kindSelect).toHaveText('MCP');
    expect(mcp.body.events.every((e) => e.kind === 'mcp'), 'only MCP rows').toBe(true);
    if (mcp.body.events.length) await expectRowsMatch(tr, mcp.body.events);
    else await expect(tr.emptyState).toBeVisible();
    await expect(tr.counter).toHaveText(counterFor(0, mcp.body.total));

    const apiRead = await tr.chooseKind('API');
    expect(apiRead.query.kind).toBe('api');
    expect(apiRead.body.events.length, 'a shared server has API rows').toBeGreaterThan(0);
    expect(apiRead.body.events.every((e) => e.kind === 'api'), 'only API rows').toBe(true);
    await expectRowsMatch(tr, apiRead.body.events);
    for (let i = 0; i < apiRead.body.events.length; i++) await expect(tr.kindBadge(i)).toHaveText('api');

    // API + MCP make up All (the trace only grows between reads).
    expect(apiRead.body.total + mcp.body.total).toBeGreaterThanOrEqual(all.body.total);

    const back = await tr.chooseKind('All');
    expect(back.query.kind, 'All sends no kind filter').toBeNull();
    await expectRowsMatch(tr, back.body.events);
  });

  test('CN-TRACE-004: filtering by user works (debounced; Enter applies immediately)', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { page, activityTracePage: tr } = primary_user;
    await tr.gotoAndRead();
    const needle = primaryRole.email.split('@')[0];

    // Typing sends nothing per keystroke…
    const userReads = [];
    page.on('request', (r) => {
      try {
        const u = new URL(r.url());
        if (u.pathname === '/admin/trace') userReads.push({ user: u.searchParams.get('user'), at: Date.now() });
      } catch {
        /* not a URL we care about */
      }
    });
    await tr.userFilter.pressSequentially(needle, { delay: 60 });

    // …then one read with the whole value once typing stops. (Timing it against
    // the last key is unreliable on a loaded browser, so the proof is that no
    // read ever carried a half-typed value.)
    await expect.poll(() => userReads.filter((r) => r.user).length, { timeout: 5000 }).toBe(1);
    await page.waitForTimeout(500);
    expect(userReads.filter((r) => r.user).map((r) => r.user), 'no read while still typing').toEqual([needle]);
    await tr.waitIdle();
    const rowsShown = await tr.rows.count();
    expect(rowsShown, 'the admin has activity of their own').toBeGreaterThan(0);
    for (let i = 0; i < rowsShown; i++) {
      await expect(tr.cell(i, 'Caller')).toContainText(needle, { ignoreCase: true });
    }

    // Enter applies at once, without waiting out the debounce.
    await tr.userFilter.fill('');
    await expect.poll(() => userReads.at(-1)?.user ?? null, { timeout: 5000 }).toBeNull();
    await tr.waitIdle();
    const before = userReads.length;
    await tr.userFilter.fill(primaryRole.email);
    const pressed = Date.now();
    await tr.userFilter.press('Enter');
    await expect.poll(() => userReads.slice(before).find((r) => r.user === primaryRole.email)?.at ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
    const sentAfter = userReads.slice(before).find((r) => r.user === primaryRole.email).at - pressed;
    expect(sentAfter, 'Enter sends the filter before the 300 ms debounce would').toBeLessThan(280);
    await tr.waitIdle();
    const exact = await tr.rows.count();
    for (let i = 0; i < exact; i++) await expect(tr.cell(i, 'Caller')).toContainText(primaryRole.email, { ignoreCase: true });

    // A user with no activity: the empty state.
    await tr.userFilter.fill('nobody-qa-no-such-user@example.invalid');
    await tr.userFilter.press('Enter');
    await expect(tr.emptyState).toBeVisible();
    await expect(tr.counter).toHaveText('0–0 of 0');
  });

  test('CN-TRACE-005: changing filters resets to page 1', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { activityTracePage: tr } = primary_user;
    const first = await tr.gotoAndRead();
    test.skip(first.body.total <= PAGE_SIZE, 'the trace has a single page, so there is no later page to reset from');

    // To page 2, then change the kind: back to offset 0.
    const p2 = await tr.nextRead(() => tr.nextButton.click());
    expect(p2.query.offset).toBe('25');
    await expect(tr.counter).toHaveText(counterFor(25, p2.body.total));
    await tr.waitIdle();
    const byKind = await tr.chooseKind('API');
    expect(byKind.query).toMatchObject({ kind: 'api', offset: '0' });
    await expect(tr.counter).toHaveText(counterFor(0, byKind.body.total));
    await expect(tr.prevButton).toBeDisabled();

    // To page 2 again, then filter by user: back to offset 0.
    if (byKind.body.total > PAGE_SIZE) {
      const p2b = await tr.nextRead(() => tr.nextButton.click());
      expect(p2b.query.offset).toBe('25');
      await tr.waitIdle();
    }
    await tr.userFilter.fill(primaryRole.email.split('@')[0]);
    const byUser = await tr.nextRead(
      () => tr.userFilter.press('Enter'),
      (q) => q.user === primaryRole.email.split('@')[0] && q.offset === '0'
    );
    expect(byUser.query.offset).toBe('0');
    expect(byUser.query.user).toBe(primaryRole.email.split('@')[0]);
    await tr.waitIdle();
    await expect(tr.counter).toHaveText(counterFor(0, byUser.body.total));
    await expect(tr.prevButton).toBeDisabled();
  });

  test('CN-TRACE-006: pagination shows 25 rows with a "{from}–{to} of {total}" counter', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { page, activityTracePage: tr } = primary_user;

    // ── The real trace: 25 a page, the counter and Previous / Next ──
    const p1 = await tr.gotoAndRead();
    test.skip(p1.body.total <= PAGE_SIZE, 'the trace has a single page');
    await expect(tr.rows).toHaveCount(PAGE_SIZE);
    await expect(tr.counter).toHaveText(`1–25 of ${p1.body.total}`);
    await expect(tr.prevButton).toBeDisabled();
    await expect(tr.nextButton).toBeEnabled();

    const p2 = await tr.nextRead(() => tr.nextButton.click());
    expect(p2.query).toMatchObject({ limit: '25', offset: '25' });
    await tr.waitIdle();
    await expectRowsMatch(tr, p2.body.events);
    await expect(tr.counter).toHaveText(counterFor(25, p2.body.total));
    await expect(tr.prevButton).toBeEnabled();

    const back = await tr.nextRead(() => tr.prevButton.click());
    expect(back.query.offset).toBe('0');
    await tr.waitIdle();
    await expect(tr.counter).toHaveText(counterFor(0, back.body.total));
    await expect(tr.prevButton).toBeDisabled();

    // ── An exact last page (stubbed: the real total keeps growing) ──
    await stubTrace(page, Array.from({ length: 30 }, (_, i) => traceRow(i)));
    await page.reload();
    await tr.waitIdle();
    await expect(tr.rows).toHaveCount(25);
    await expect(tr.counter).toHaveText('1–25 of 30');
    await tr.nextButton.click();
    await tr.waitIdle();
    await expect(tr.rows).toHaveCount(5);
    await expect(tr.counter).toHaveText('26–30 of 30');
    await expect(tr.nextButton).toBeDisabled();
    await expect(tr.prevButton).toBeEnabled();
  });

  test('CN-TRACE-007: Refresh reloads the table and is disabled while loading', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { page, activityTracePage: tr } = primary_user;

    // Held reads (so the loading state can be seen), then the real response.
    const hold = await holdTrace(page);
    await page.goto('/trace');
    await expect(tr.refreshButton).toBeDisabled();
    await expect(tr.refreshSpinner).toBeVisible();
    const firstRead = tr.nextRead();
    hold.release();
    const first = await firstRead;
    await tr.waitIdle();
    await expect(tr.refreshButton).toBeEnabled();
    await expect(tr.refreshSpinner).toHaveCount(0);
    await expectRowsMatch(tr, first.body.events);

    // Refresh: disabled with a spinner while its read is held, then the new rows.
    hold.rearm();
    const kindBefore = await tr.kindSelect.innerText();
    await tr.refreshButton.click();
    await expect(tr.refreshButton).toBeDisabled();
    await expect(tr.refreshSpinner).toBeVisible();
    const refreshed = tr.nextRead();
    hold.release();
    const again = await refreshed;
    await tr.waitIdle();
    expect(again.query, 'Refresh re-reads the same page with the same filters').toEqual(first.query);
    await expect(tr.refreshButton).toBeEnabled();
    await expectRowsMatch(tr, again.body.events);
    await expect(tr.counter).toHaveText(counterFor(0, again.body.total));
    // The server-wide trace only grows, and Refresh shows it.
    expect(again.body.total).toBeGreaterThanOrEqual(first.body.total);
    await expect(tr.kindSelect).toHaveText(kindBefore);
  });

  test('CN-TRACE-008: the empty and error states display correctly', async ({ primary_user }) => {
    // Forced states: a shared server's trace is never empty and doesn't fail on demand.
    await asAdmin(primary_user);
    const { page, activityTracePage: tr } = primary_user;

    // ── Empty ──
    await stubTrace(page, []);
    await page.goto('/trace');
    await tr.waitIdle();
    await expect(tr.emptyState).toBeVisible();
    await expect(tr.rows).toHaveCount(0);
    await expect(tr.counter).toHaveText('0–0 of 0');
    await expect(tr.prevButton).toBeDisabled();
    await expect(tr.nextButton).toBeDisabled();
    await expect(tr.error).toHaveCount(0);

    // ── Error ──
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubTrace(page, { status: 500, body: { error: 'Trace store unavailable' } });
    await page.reload();
    await tr.waitIdle();
    await expect(tr.error).toBeVisible();
    await expect(tr.error).toHaveText('Trace store unavailable');
    await expect(tr.refreshButton).toBeEnabled();

    // Recovers on Refresh once the trace answers again.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const recovered = await tr.nextRead(() => tr.refreshButton.click());
    await tr.waitIdle();
    await expect(tr.error).toHaveCount(0);
    await expectRowsMatch(tr, recovered.body.events);
  });
});
