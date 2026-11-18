/**
 * Sidebar Rail Test Suite — CN-RAIL-001 … CN-RAIL-009
 *
 * Components under test: the app's navigation as #582 (Review flow) left it.
 * - The left rail: ui/src/components/DocumentSidebar.tsx (All nests, the nest
 *   list, the "work" rows that are not in the header, Hide sidebar).
 * - The header ribbon: ui/src/components/HeaderRibbon.tsx (My Work, My Drafts).
 * - Workspace settings: ui/src/components/SettingsShell.tsx, opened from the
 *   account menu (Teams, API keys, Connected apps, and the admin pages).
 * - The header's "Show sidebar" button and the account menu in ui/src/App.tsx.
 * All of them are fed by the page registry in ui/src/lib/pages.ts.
 *
 * Conventions
 * -----------
 * - The primary account is a server admin (and so a superadmin in key mode);
 *   the secondary account is a regular user. Cases that need either skip when
 *   the account isn't what they need.
 * - Connected apps and Stream follow server-wide switches read from
 *   `GET /health`. Those are never flipped on the shared server: the cases
 *   that need one serve the real /health with only that field overridden
 *   (`src/lib/sidebar_rail_stubs.js`), in the test's own browser.
 * - Read-only: nothing is created or saved. Hiding the rail is a
 *   browser-local preference; each case runs in a fresh context.
 * - Desktop width unless a case says otherwise: the ribbon shows from the md
 *   breakpoint up, and below it My Work and My Drafts move into the drawer.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { RIBBON_ITEMS, SETTINGS_PAGES, ADMIN_SETTINGS_IDS } from '../../src/page_factory/app/sidebar_rail_page.js';
import { stubHealth } from '../../src/lib/sidebar_rail_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** Initialise a role and skip unless it is (or isn't) a server admin. */
async function asRole(role, { admin }) {
  await role.initialize();
  const isAdmin = await role.teammatesApi.isServerAdmin();
  test.skip(isAdmin !== admin, `${role.roleInfo?.email ?? 'this account'} is ${isAdmin ? '' : 'not '}a server admin on this server.`);
  return role;
}

/** The URL regex a page path should match. */
const urlFor = (path) => new RegExp(`${path === '/' ? '/$' : path.replace(/\//g, '\\/') + '$'}`);

test.describe('Sidebar rail', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test("CN-RAIL-001: a regular user gets All nests in the rail, My Work and My Drafts in the header, and Teams and API keys in Workspace settings", async ({ secondary_user }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await asRole(secondary_user, { admin: false });
    const { page, sidebarRailPage: rail } = secondary_user;
    await stubHealth(page, { mcpOauthEnabled: false });
    await page.setViewportSize(DESKTOP);
    await rail.goto();

    // The rail: All nests, and none of the old group headers.
    await expect(rail.allNests).toBeVisible();
    await expect(rail.allNests).toHaveText(/All nests/);
    await expect(page.locator('[data-testid^="document-sidebar-group-"]')).toHaveCount(0);

    // The header ribbon: My Work and My Drafts, nothing else.
    await expect(rail.ribbon).toBeVisible();
    await expect(rail.ribbon).toHaveAttribute('aria-label', 'Workspace');
    for (const item of RIBBON_ITEMS) {
      await expect(rail.ribbonItem(item.id), `ribbon ${item.id}`).toBeVisible();
      await expect(rail.ribbonItem(item.id)).toHaveAttribute('aria-label', new RegExp(item.label));
    }
    await expect(rail.ribbon.locator('[data-testid^="header-ribbon-"]')).toHaveCount(RIBBON_ITEMS.length);

    // The account menu: Settings and Help.
    await rail.userMenu.click();
    await expect(rail.userMenuSettings).toBeVisible();
    await expect(rail.userMenuHelp).toBeVisible();

    // Workspace settings (from the open menu): the pages everyone has.
    await rail.openSettings();
    expect(await rail.settingsIds()).toEqual(['teams', 'api-keys']);
  });

  test('CN-RAIL-002: the admin pages appear in Workspace settings only for admins', async ({ primary_user, secondary_user }) => {
    await asRole(primary_user, { admin: true });
    const adminRail = primary_user.sidebarRailPage;
    await adminRail.goto();
    await adminRail.openSettings();
    for (const id of ADMIN_SETTINGS_IDS) await expect(adminRail.settingsItem(id), `admin page ${id}`).toBeVisible();

    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await asRole(secondary_user, { admin: false });
    const userRail = secondary_user.sidebarRailPage;
    await userRail.goto();
    await userRail.openSettings();
    await expect(userRail.settingsItem('teams')).toBeVisible();
    for (const id of [...ADMIN_SETTINGS_IDS, 'messages']) await expect(userRail.settingsItem(id), `admin page ${id}`).toHaveCount(0);
  });

  test('CN-RAIL-003: each navigation item opens its page and is the only one marked as the current page', async ({ primary_user }) => {
    await asRole(primary_user, { admin: true });
    const { page, sidebarRailPage: rail } = primary_user;
    await page.setViewportSize(DESKTOP);
    await rail.goto();

    // All nests is Home.
    await rail.ribbonItem('my-work').click();
    await rail.allNests.click();
    await expect(page).toHaveURL(urlFor('/'));
    await expect(rail.allNests).toHaveAttribute('aria-current', 'page');
    await expect(rail.currentItems()).toHaveCount(1);

    // The header ribbon.
    for (const item of RIBBON_ITEMS) {
      await rail.ribbonItem(item.id).click();
      await expect(page, `${item.label} opens ${item.path}`).toHaveURL(urlFor(item.path));
      await expect(rail.ribbonItem(item.id), `${item.label} is the current page`).toHaveAttribute('aria-current', 'page');
      await expect(rail.currentItems()).toHaveCount(1);
    }

    // Workspace settings: every page this admin is shown.
    await rail.openSettings();
    const shown = await rail.settingsIds();
    expect(shown).toEqual(expect.arrayContaining(['teams', 'api-keys', ...ADMIN_SETTINGS_IDS]));
    for (const p of SETTINGS_PAGES.filter((s) => shown.includes(s.id))) {
      await rail.settingsItem(p.id).click();
      await expect(page, `${p.label} opens ${p.path}`).toHaveURL(urlFor(p.path));
      await expect(rail.settingsItem(p.id), `${p.label} is the current page`).toHaveAttribute('aria-current', 'page');
      await expect(rail.currentItems()).toHaveCount(1);
    }

    // Help: How it works.
    await rail.openHelp();
    await expect(page).toHaveURL(urlFor('/guide'));
  });

  test('CN-RAIL-004: on a phone, My Work and My Drafts move from the header into the sidebar drawer', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, sidebarRailPage: rail } = primary_user;
    await page.setViewportSize(DESKTOP);
    await rail.goto();
    await expect(rail.ribbonItem('my-work')).toBeVisible();
    await expect(rail.row('my-work')).toBeHidden();
    await expect(rail.row('my-drafts')).toBeHidden();

    await page.setViewportSize(PHONE);
    await expect(rail.ribbon).toBeHidden();
    await rail.showSidebar.click();
    await expect(rail.row('my-work')).toBeVisible();
    await expect(rail.row('my-drafts')).toBeVisible();
    await rail.row('my-drafts').click();
    await expect(page).toHaveURL(urlFor('/my-drafts'));

    // Back at desktop width the ribbon carries them again.
    await page.setViewportSize(DESKTOP);
    await expect(rail.ribbonItem('my-drafts')).toBeVisible();
    await expect(rail.ribbonItem('my-drafts')).toHaveAttribute('aria-current', 'page');
    await expect(rail.row('my-drafts')).toBeHidden();
  });

  test('CN-RAIL-005: Connected apps appears in Workspace settings only when MCP sign-in is enabled', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, sidebarRailPage: rail } = primary_user;

    await stubHealth(page, { mcpOauthEnabled: true });
    await rail.goto();
    await rail.openSettings();
    await expect(rail.settingsItem('connected-apps')).toBeVisible();
    await expect(rail.settingsItem('connected-apps')).toHaveText(/Connected apps/);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubHealth(page, { mcpOauthEnabled: false });
    await rail.goto();
    await rail.openSettings();
    await expect(rail.settingsItem('teams')).toBeVisible();
    await expect(rail.settingsItem('connected-apps')).toHaveCount(0);
  });

  test('CN-RAIL-006: Stream appears in the rail only when the Document stream switch is on', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, sidebarRailPage: rail } = primary_user;
    await page.setViewportSize(DESKTOP);

    await stubHealth(page, { docStream: true });
    await rail.goto();
    await expect(rail.row('stream')).toBeVisible();
    await expect(rail.row('stream')).toHaveText(/Stream/);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubHealth(page, { docStream: false });
    await rail.goto();
    await expect(rail.ribbonItem('my-work')).toBeVisible();
    await expect(rail.row('stream')).toHaveCount(0);
  });

  test('CN-RAIL-007: the Message log appears in Workspace settings only for superadmins', async ({ primary_user, secondary_user }) => {
    test.info().annotations.push({
      type: 'note',
      description: 'An admin who is not a superadmin exists only in AUTH_MODE=open; on a key-mode server every admin is a superadmin, so this case checks superadmin vs non-admin.',
    });
    await asRole(primary_user, { admin: true });
    const adminRail = primary_user.sidebarRailPage;
    await adminRail.goto();
    await adminRail.openSettings();
    await expect(adminRail.settingsItem('messages')).toBeVisible();
    await expect(adminRail.settingsItem('messages')).toHaveText(/Message log/);

    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await asRole(secondary_user, { admin: false });
    const userRail = secondary_user.sidebarRailPage;
    await userRail.goto();
    await userRail.openSettings();
    await expect(userRail.settingsItem('teams')).toBeVisible();
    await expect(userRail.settingsItem('messages')).toHaveCount(0);
  });

  test('CN-RAIL-008: the Hide sidebar button hides the rail and it can be shown again', async ({ primary_user }) => {
    await primary_user.initialize();
    const rail = primary_user.sidebarRailPage;
    await rail.page.setViewportSize(DESKTOP);
    await rail.goto();
    await expect(rail.sidebar).toBeVisible();
    await expect(rail.hideSidebar).toHaveAttribute('aria-label', 'Hide sidebar');

    await rail.hideSidebar.click();
    await expect(rail.allNests).toBeHidden();
    await expect(rail.showSidebar).toBeVisible();
    await expect(rail.showSidebar).toHaveAttribute('aria-label', 'Show sidebar');

    await rail.showSidebar.click();
    await expect(rail.sidebar).toBeVisible();
    await expect(rail.allNests).toBeVisible();
  });

  test('CN-RAIL-009: exactly one account menu is mounted, in the rail while the rail is on screen and in the header otherwise', async ({ primary_user }) => {
    await primary_user.initialize();
    const rail = primary_user.sidebarRailPage;
    const page = rail.page;
    const inRail = rail.sidebar.getByTestId('user-menu-trigger');
    const inHeader = page.getByRole('banner').getByTestId('user-menu-trigger');

    // Desktop, rail shown: the menu is at the foot of the rail, nowhere else.
    await page.setViewportSize({ width: 1280, height: 800 });
    await rail.goto();
    await expect(rail.sidebar).toBeVisible();
    await expect(inRail).toBeVisible();
    await expect(rail.userMenu).toHaveCount(1);

    // Desktop, rail hidden: the menu moves to the header.
    await rail.hideSidebar.click();
    await expect(inHeader).toBeVisible();
    await expect(rail.userMenu).toHaveCount(1);
    await rail.showSidebar.click();
    await expect(inRail).toBeVisible();
    await expect(rail.userMenu).toHaveCount(1);

    // Phone, drawer closed: the menu is in the header.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(inHeader).toBeVisible();
    await expect(rail.userMenu).toHaveCount(1);

    // Phone, drawer open: the menu is at the foot of the drawer.
    await rail.showSidebar.click();
    await expect(inRail).toBeVisible();
    await expect(rail.userMenu).toHaveCount(1);
  });
});
