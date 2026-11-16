/**
 * Sidebar Rail Test Suite — CN-RAIL-001 … CN-RAIL-008
 *
 * Component under test: ui/src/components/DocumentSidebar.tsx (AppPagesNav),
 * fed by the page registry in ui/src/lib/pages.ts (`appRail(caps)`), plus the
 * header's "Show sidebar" button in ui/src/App.tsx.
 *
 * Conventions
 * -----------
 * - The primary account is a server admin (and so a superadmin in key mode);
 *   the secondary account is a regular user. Cases that need either skip when
 *   the account isn't what they need.
 * - Connected apps and Stream follow server-wide switches read from
 *   `GET /health`. Those are never flipped on the shared server: CN-RAIL-005
 *   and CN-RAIL-006 serve the real /health with only that field overridden
 *   (`src/lib/sidebar_rail_stubs.js`), in the test's own browser.
 * - Read-only: nothing is created or saved. Folding a group and hiding the
 *   rail are browser-local preferences; each case runs in a fresh context.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { RAIL_PAGES } from '../../src/page_factory/app/sidebar_rail_page.js';
import { stubHealth } from '../../src/lib/sidebar_rail_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

const ADMIN_ROWS = ['teammates', 'settings', 'trace'];

/** Initialise a role and skip unless it is (or isn't) a server admin. */
async function asRole(role, { admin }) {
  await role.initialize();
  const isAdmin = await role.teammatesApi.isServerAdmin();
  test.skip(isAdmin !== admin, `${role.roleInfo?.email ?? 'this account'} is ${isAdmin ? '' : 'not '}a server admin on this server.`);
  return role;
}

test.describe('Sidebar rail', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test("CN-RAIL-001: a regular user's rail shows the Nests row and the Work, Workspace and Help groups", async ({ secondary_user }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await asRole(secondary_user, { admin: false });
    const rail = secondary_user.sidebarRailPage;
    await rail.goto();

    await expect(rail.row('nests')).toBeVisible();
    await expect(rail.row('nests')).toHaveText(/Nests/);
    expect(await rail.groupIds()).toEqual(['work', 'workspace', 'help']);
    await expect(rail.group('work')).toHaveText(/Work/i);
    await expect(rail.group('workspace')).toHaveText(/Workspace/i);
    await expect(rail.group('help')).toHaveText(/Help/i);
    // Each group carries its everyday rows.
    for (const id of ['my-work', 'my-drafts', 'teams', 'api-keys', 'guide']) {
      await expect(rail.row(id), `rail row ${id}`).toBeVisible();
    }
  });

  test('CN-RAIL-002: the Admin group appears in the rail only for admins', async ({ primary_user, secondary_user }) => {
    await asRole(primary_user, { admin: true });
    const adminRail = primary_user.sidebarRailPage;
    await adminRail.goto();
    await expect(adminRail.group('admin')).toBeVisible();
    await expect(adminRail.group('admin')).toHaveText(/Admin/i);
    await adminRail.expandGroup('admin');
    for (const id of ADMIN_ROWS) await expect(adminRail.row(id), `admin row ${id}`).toBeVisible();

    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await asRole(secondary_user, { admin: false });
    const userRail = secondary_user.sidebarRailPage;
    await userRail.goto();
    await expect(userRail.row('teams')).toBeVisible();
    await expect(userRail.group('admin')).toHaveCount(0);
    for (const id of [...ADMIN_ROWS, 'messages']) await expect(userRail.row(id), `admin row ${id}`).toHaveCount(0);
  });

  test('CN-RAIL-003: each rail row opens its page and is highlighted as the current page', async ({ primary_user }) => {
    await asRole(primary_user, { admin: true });
    const { page, sidebarRailPage: rail } = primary_user;
    await rail.goto();
    const shown = await rail.rowIds();
    // Rows the server can switch off (Stream, Connected apps) are covered
    // only when this server shows them; CN-RAIL-005/006 cover the switches.
    const pages = RAIL_PAGES.filter((p) => shown.includes(p.id) || p.group !== null);
    expect(shown).toContain('nests');

    for (const p of pages) {
      if (p.group) await rail.expandGroup(p.group);
      if ((await rail.row(p.id).count()) === 0) continue;
      await rail.openRow(p);
      await expect(page, `${p.label} opens ${p.path}`).toHaveURL(new RegExp(`${p.path === '/' ? '/$' : p.path.replace(/\//g, '\\/') + '$'}`));
      await expect(rail.row(p.id), `${p.label} is the current page`).toHaveAttribute('aria-current', 'page');
      // No other row claims to be current.
      await expect(rail.nav.locator('[aria-current="page"]')).toHaveCount(1);
    }
  });

  test('CN-RAIL-004: rail groups collapse and expand', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, sidebarRailPage: rail } = primary_user;
    await rail.goto();
    await rail.expandGroup('work');
    await expect(rail.group('work')).toHaveAttribute('aria-expanded', 'true');
    await expect(rail.row('my-work')).toBeVisible();

    // Collapse: the group's rows go; the other groups stay as they were.
    await rail.group('work').click();
    await expect(rail.group('work')).toHaveAttribute('aria-expanded', 'false');
    await expect(rail.row('my-work')).toHaveCount(0);
    await expect(rail.row('my-drafts')).toHaveCount(0);
    await expect(rail.row('teams')).toBeVisible();

    // Remembered by the browser across a reload.
    await page.reload();
    await rail.waitLoaded();
    await expect(rail.group('work')).toHaveAttribute('aria-expanded', 'false');
    await expect(rail.row('my-work')).toHaveCount(0);

    // Expand again: the rows come back.
    await rail.group('work').click();
    await expect(rail.group('work')).toHaveAttribute('aria-expanded', 'true');
    await expect(rail.row('my-work')).toBeVisible();
    await expect(rail.row('my-drafts')).toBeVisible();
  });

  test('CN-RAIL-005: Connected apps appears in the Workspace group only when MCP sign-in is enabled', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, sidebarRailPage: rail } = primary_user;

    await stubHealth(page, { mcpOauthEnabled: true });
    await rail.goto();
    await rail.expandGroup('workspace');
    await expect(rail.row('connected-apps')).toBeVisible();
    await expect(rail.row('connected-apps')).toHaveText(/Connected apps/);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubHealth(page, { mcpOauthEnabled: false });
    await rail.goto();
    await rail.expandGroup('workspace');
    await expect(rail.row('teams')).toBeVisible();
    await expect(rail.row('connected-apps')).toHaveCount(0);
  });

  test('CN-RAIL-006: Stream appears in the Work group only when the Document stream switch is on', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, sidebarRailPage: rail } = primary_user;

    await stubHealth(page, { docStream: true });
    await rail.goto();
    await rail.expandGroup('work');
    await expect(rail.row('stream')).toBeVisible();
    await expect(rail.row('stream')).toHaveText(/Stream/);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubHealth(page, { docStream: false });
    await rail.goto();
    await rail.expandGroup('work');
    await expect(rail.row('my-work')).toBeVisible();
    await expect(rail.row('stream')).toHaveCount(0);
  });

  test('CN-RAIL-007: the Message log appears in the Admin group only for superadmins', async ({ primary_user, secondary_user }) => {
    test.info().annotations.push({
      type: 'note',
      description: 'An admin who is not a superadmin exists only in AUTH_MODE=open; on a key-mode server every admin is a superadmin, so this case checks superadmin vs non-admin.',
    });
    await asRole(primary_user, { admin: true });
    const adminRail = primary_user.sidebarRailPage;
    await adminRail.goto();
    await adminRail.expandGroup('admin');
    await expect(adminRail.row('messages')).toBeVisible();
    await expect(adminRail.row('messages')).toHaveText(/Message log/);

    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await asRole(secondary_user, { admin: false });
    const userRail = secondary_user.sidebarRailPage;
    await userRail.goto();
    await expect(userRail.row('teams')).toBeVisible();
    await expect(userRail.row('messages')).toHaveCount(0);
  });

  test('CN-RAIL-008: the Hide sidebar button hides the rail and it can be shown again', async ({ primary_user }) => {
    await primary_user.initialize();
    const rail = primary_user.sidebarRailPage;
    await rail.goto();
    await expect(rail.sidebar).toBeVisible();
    await expect(rail.hideSidebar).toHaveAttribute('aria-label', 'Hide sidebar');

    await rail.hideSidebar.click();
    await expect(rail.nav).toBeHidden();
    await expect(rail.showSidebar).toBeVisible();
    await expect(rail.showSidebar).toHaveAttribute('aria-label', 'Show sidebar');

    await rail.showSidebar.click();
    await expect(rail.nav).toBeVisible();
    await expect(rail.row('nests')).toBeVisible();
  });
});
