/**
 * Sidebar Rail — pinned ("starred") nests, CN-RAIL-011 (PO-1441)
 *
 * Component under test: ui/src/components/DocumentSidebar.tsx (the nest list)
 * with ui/src/components/NestPinButton.tsx and ui/src/lib/nest-pin.ts.
 *
 * Pinned nests sit at the top of the rail; the rest keep today's order. A pin
 * toggled from a rail row moves the row at once (optimistic) and moves it back
 * when the server refuses. The nest list and the pin endpoint are served from
 * route stubs (`src/lib/route_stubs.js`), so nothing is written to the server
 * and the account's real pins are untouched. Numbered 011 to stay clear of
 * CN-RAIL-009/010 in the sibling spec.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { nestRow, stubNestList } from '../../src/lib/route_stubs.js';

const primaryRole = samples.primary_user ?? null;

const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
const idOf = (name) => `stub-pin-${name.toLowerCase()}`;

/** The rail's nest names, top to bottom (textContent: the CSS uppercases them). */
const railNames = (sidebar) =>
  sidebar.locator('[data-relation]').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));

test.describe('Sidebar rail — pinned nests', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test('CN-RAIL-011: pinned nests sit at the top of the rail; a rail pin moves at once and a refused one moves back', async ({ primary_user }) => {
    await primary_user.initialize();
    const page = primary_user.page;

    const pinned = new Set([idOf('Delta'), idOf('Bravo')]);
    const rows = () => NAMES.map((name) => nestRow({ id: idOf(name), name, slug: name.toLowerCase(), pinned: pinned.has(idOf(name)) }));
    const setList = await stubNestList(page, rows());

    // The pin endpoint: held open until the test releases it, so the
    // optimistic move is observable; `refuse` answers 500 instead.
    let refuse = false;
    // One gate per request: the test waits for the request to ARRIVE before
    // releasing it, so a slow handler can't leave `release` stale or unset.
    let arrived;
    let held = new Promise((r) => (arrived = r));
    const nextRequest = async () => {
      const release = await held;
      held = new Promise((r) => (arrived = r));
      return release;
    };
    await page.route(
      (url) => /^\/nests\/stub-pin-[a-z]+\/pin$/.test(new URL(url).pathname),
      async (route, request) => {
        const id = new URL(request.url()).pathname.split('/')[2];
        await new Promise((r) => arrived(r));
        if (refuse) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Pin failed (stub)' }) });
        const value = request.method() === 'POST';
        if (value) pinned.add(id);
        else pinned.delete(id);
        setList(rows());
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pinned: value }) });
      }
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const sidebar = page.getByTestId('document-sidebar');
    await expect(sidebar).toBeVisible();

    // Pinned first (by name), then the rest by name.
    await expect.poll(() => railNames(sidebar)).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie', 'Echo']);
    await expect(sidebar.getByRole('button', { name: 'Unpin nest Bravo' })).toBeVisible();

    // Pin Echo from its rail row: it joins the pinned group before the server answers.
    await sidebar.getByRole('button', { name: 'Pin nest Echo' }).click();
    await expect.poll(() => railNames(sidebar)).toEqual(['Bravo', 'Delta', 'Echo', 'Alpha', 'Charlie']);
    (await nextRequest())();
    await expect(sidebar.getByRole('button', { name: 'Unpin nest Echo' })).toBeVisible();
    await expect.poll(() => railNames(sidebar)).toEqual(['Bravo', 'Delta', 'Echo', 'Alpha', 'Charlie']);

    // A refused unpin: Bravo leaves the group at once, then comes back with an error.
    refuse = true;
    await sidebar.getByRole('button', { name: 'Unpin nest Bravo' }).click();
    await expect.poll(() => railNames(sidebar)).toEqual(['Delta', 'Echo', 'Alpha', 'Bravo', 'Charlie']);
    (await nextRequest())();
    await expect.poll(() => railNames(sidebar)).toEqual(['Bravo', 'Delta', 'Echo', 'Alpha', 'Charlie']);
    await expect(page.getByText('Pin failed (stub)')).toBeVisible();

    // The phone drawer is the same rail, in the same order.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('nest-sidebar-expand').click();
    await expect(sidebar).toBeVisible();
    await expect.poll(() => railNames(sidebar)).toEqual(['Bravo', 'Delta', 'Echo', 'Alpha', 'Charlie']);
  });
});
