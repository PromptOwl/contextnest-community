/**
 * Community Dashboard Test Suite — CN-DASH-001 … CN-DASH-062
 *
 * Page under test: ui/src/pages/app/nests/page.tsx (route `/`), plus the
 * components it opens: AllNestsBar, ImportFolderModal, RenameNestDialog,
 * DeleteNestDialog and the governance ReasonDialog.
 *
 * Conventions
 * -----------
 * - Preconditions (nests, pins, archive state, sharing) are arranged through
 *   the REST API via `role.dashboardApi` — creating ten nests through the New
 *   Nest dialog is ten dialogs' worth of flake for setup that isn't under test.
 * - Every nest a test creates is named with `commonFunction.generateEntityName()`
 *   (AUTO_ prefix) and registered in the entity registry, so the teardown and
 *   the next run's orphan sweeper remove it.
 * - A few states cannot be arranged from a real account — the cold-load
 *   skeletons, "no nests at all", "not allowed to create", an anonymous-admin
 *   nest, chip overflow, unsynced folders on the server's disk, and every
 *   failure path. Those are driven through `src/lib/route_stubs.js`, which
 *   serves the real response shape to the real UI. Each such test says so.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js):
 *   the cases share one account, so a parallel run would have them filtering
 *   and counting each other's nests.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { registerEntity } from '../../src/lib/entity_registry.js';
import {
  nestRow,
  stubNestList,
  stubArchivedList,
  stubUnsynced,
  stubNoNotifications,
  failRoute,
} from '../../src/lib/route_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

// The login-form cases need an account with local email/password credentials —
// a promptowl-method role signs in through the device flow instead.
const manualRole =
  Object.values(samples).find((r) => (r.method || 'manual') === 'manual') || null;

// ── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Open the dashboard for a role, with clipboard access granted so the Copy
 * buttons can be asserted on their real effect.
 * @returns {Promise<{page: import('@playwright/test').Page, nestsPage: any, api: any}>}
 */
async function openDashboard(role, { clipboard = false } = {}) {
  await role.initialize();
  if (clipboard) {
    await role.context
      .grantPermissions(['clipboard-read', 'clipboard-write'])
      .catch(() => {}); // Non-Chromium / unsupported — the fallback assertion covers it.
  }
  const { page, nestsPage, dashboardApi: api } = role;
  return { page, nestsPage, api };
}

/** Read the clipboard, or null when the browser won't allow it. */
async function readClipboard(page) {
  try {
    return await page.evaluate(() => navigator.clipboard.readText());
  } catch {
    return null;
  }
}

/** Look a nest up by name and register it for cleanup (UI-created nests). */
async function registerNestByName(api, name) {
  const found = (await api.listNests()).find((n) => n.name === name);
  if (found) registerEntity('nests', { id: found.id, name: found.name });
  return found ?? null;
}

/** A stub grid of `count` deterministically named, sortable nest rows. */
function stubGrid(count, overrides = () => ({})) {
  return Array.from({ length: count }, (_, i) =>
    nestRow({
      id: `stub-nest-${String(i + 1).padStart(2, '0')}`,
      name: `Stub Nest ${String(i + 1).padStart(2, '0')}`,
      slug: `stub-nest-${i + 1}`,
      ...overrides(i),
    })
  );
}

/** Nest ids the dashboard keeps out of the grid (unaccepted invites). */
async function gridNests(api) {
  const pending = await api.pendingInviteNestIds();
  return (await api.listNests()).filter((n) => !pending.has(n.id));
}

test.describe('Community Dashboard', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // ══════════════════════════════════════════════════════════════════════════
  // Access, shell and server banner
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Access and shell', () => {
    test('CN-DASH-001: an unauthenticated user cannot access the Dashboard in KEY mode', async ({
      page,
      loginPage,
      nestsPage,
      appShellPage,
    }) => {
      // KEY mode only — an open-mode server has no login screen to land on.
      const health = await page.request.get('/health').then((r) => r.json());
      test.skip(health?.auth_mode === 'open', 'Server runs in OPEN mode — no auth to enforce.');

      await page.context().clearCookies();
      await loginPage.goto();

      // The login form stands in for the dashboard: no page heading, no shell.
      await expect(loginPage.emailInput).toBeVisible();
      await expect(loginPage.passwordInput).toBeVisible();
      await expect(appShellPage.userMenuTrigger).not.toBeVisible();
      await expect(nestsPage.pageTitle).not.toBeVisible();
      await expect(nestsPage.newNestButton).not.toBeVisible();
    });

    test('CN-DASH-002: the Dashboard renders correctly after a successful sign-in', async ({
      loginPage,
      nestsPage,
      appShellPage,
    }) => {
      test.skip(!manualRole, 'No manual-login role configured.');

      await loginPage.performLogin(manualRole.email, manualRole.password);

      // The shell, the page heading and the server banner all land together.
      expect(await appShellPage.isLoggedIn()).toBe(true);
      await expect(nestsPage.pageTitle).toBeVisible({ timeout: 15000 });
      await expect(nestsPage.pageTitle).toContainText('Nests');
      await expect(nestsPage.pageTitle).toContainText('Shared knowledge vaults for your team');
      await expect(nestsPage.serverUrlCode).toBeVisible();
      await expect(nestsPage.gridLoader).not.toBeVisible();
    });

    test('CN-DASH-004: the banner displays the server URL and the Copy button copies it', async ({
      primary_user,
    }) => {
      const { page, nestsPage } = await openDashboard(primary_user, { clipboard: true });
      await nestsPage.goto();

      const origin = new URL(page.url()).origin;
      await expect(nestsPage.serverUrlCode).toHaveText(origin);

      await nestsPage.copyServerUrl.click();

      const copied = await readClipboard(page);
      if (copied !== null) {
        expect(copied).toBe(origin);
      } else {
        // Clipboard unreadable in this browser — the button's Copy→Check swap
        // is the user-visible confirmation (it carries no success toast).
        await expect(nestsPage.copyServerUrl.locator('svg.lucide-check')).toBeVisible();
      }
    });

    test('CN-DASH-005: the banner Nest and Document counts are accurate', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      // A nest with a known document count of 0 guarantees at least one row.
      await api.createNest(commonFunction.generateEntityName('counts'), 'Count check');

      await nestsPage.goto();
      await expect(nestsPage.countSkeletons).toHaveCount(0);

      // The banner counts every nest the grid knows about — pending invites
      // live in their own card and are excluded from both numbers.
      const nests = await gridNests(api);
      const expectedDocs = nests.reduce((sum, n) => sum + Number(n.document_count ?? 0), 0);

      await expect(nestsPage.bannerNestCount).toHaveText(String(nests.length));
      await expect(nestsPage.bannerDocumentCount).toHaveText(String(expectedDocs));
    });

    test('CN-DASH-006: the whole-brain bar appears only when the user has at least one nest', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, nestsPage, api } = await openDashboard(primary_user);
      await api.createNest(commonFunction.generateEntityName('brain'));

      await nestsPage.goto();
      await expect(nestsPage.wholeBrainBar).toBeVisible();
      await expect(nestsPage.connectAllButton).toBeVisible();

      // With no nests at all the strip has nothing to frame, so it goes away.
      await stubNestList(page, []);
      await stubNoNotifications(page);
      await nestsPage.reload();
      await expect(nestsPage.wholeBrainBar).not.toBeVisible();
      await expect(nestsPage.connectAllButton).not.toBeVisible();
    });

    test('CN-DASH-008: "Manage API keys" navigates to the API keys page', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, nestsPage, api } = await openDashboard(primary_user);
      const health = await api.health();
      // The key section only renders for a signed-in caller on a keyed server —
      // an open-mode deployment needs no credential at all.
      test.skip(health?.auth_mode === 'open', 'Server runs in OPEN mode — no API key section.');

      await api.createNest(commonFunction.generateEntityName('keys'));
      await nestsPage.goto();
      await nestsPage.connectAllButton.click();
      await expect(nestsPage.manageKeysButton).toBeVisible();

      await nestsPage.manageKeysButton.click();

      // The dialog steps aside and the app lands on the API keys page.
      await expect(nestsPage.connectDialog).not.toBeVisible();
      await expect(page).toHaveURL(/\/api-keys$/);
      await expect(page.getByTestId('page-title')).toContainText('API keys');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Creating and importing nests
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Create and import', () => {
    test.beforeEach(async ({ primary_user }) => {
      const { api } = await openDashboard(primary_user);
      const canCreate = await api.canCreateNests();
      test.skip(
        !canCreate,
        'This account cannot create nests (NEST_CREATION=admins and not an admin).'
      );
    });

    test('CN-DASH-009: a nest cannot be created with an empty name', async ({ primary_user }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const before = (await api.listNests()).length;

      await nestsPage.goto();
      await nestsPage.openCreateDialog();

      // Nothing typed: the button is dead and the form says nothing yet — the
      // inline hint only appears once there is a name to object to.
      await expect(nestsPage.createSubmit).toBeDisabled();
      await expect(nestsPage.createError).toHaveCount(0);

      // Whitespace does not survive trimming, so it is named as the problem.
      await nestsPage.createNameInput.fill('   ');
      await expect(nestsPage.createError).toHaveText('Name is required');
      await expect(nestsPage.createSubmit).toBeDisabled();

      await nestsPage.createCancel.click();
      expect((await api.listNests()).length).toBe(before);
    });

    test('CN-DASH-010: a nest name over 100 characters is rejected with an inline message', async ({
      primary_user,
    }) => {
      const { nestsPage } = await openDashboard(primary_user);
      await nestsPage.goto();
      await nestsPage.openCreateDialog();

      const tooLong = `AUTO_${'x'.repeat(100)}`; // 105 characters
      await nestsPage.createNameInput.fill(tooLong);

      await expect(nestsPage.createError).toHaveText(
        `Nest names are capped at 100 characters — this one is ${tooLong.length}.`
      );
      await expect(nestsPage.createSubmit).toBeDisabled();

      // Back under the cap and the form clears itself.
      await nestsPage.createNameInput.fill('AUTO_within-the-cap');
      await expect(nestsPage.createError).toHaveCount(0);
      await expect(nestsPage.createSubmit).toBeEnabled();
      await nestsPage.createCancel.click();
    });

    test('CN-DASH-011: a nest name containing an HTML tag is rejected', async ({ primary_user }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const before = (await api.listNests()).length;

      await nestsPage.goto();
      await nestsPage.openCreateDialog();
      await nestsPage.createNameInput.fill('AUTO_<img src=x onerror=alert(1)>');

      // Refused, not stripped — names are stored as plain text.
      await expect(nestsPage.createError).toHaveText(
        'Nest names are plain text — remove the HTML tags.'
      );
      await expect(nestsPage.createSubmit).toBeDisabled();

      await nestsPage.createCancel.click();
      expect((await api.listNests()).length).toBe(before);
    });

    test('CN-DASH-012: a nest name without letters or digits is rejected', async ({
      primary_user,
    }) => {
      const { nestsPage } = await openDashboard(primary_user);
      await nestsPage.goto();
      await nestsPage.openCreateDialog();

      // The URL slug is built from a-z0-9, so "###" would derive an empty one.
      await nestsPage.createNameInput.fill('###');
      await expect(nestsPage.createError).toHaveText(
        'The URL slug is built from a-z and 0-9, so the name needs at least one of those'
      );
      await expect(nestsPage.createSubmit).toBeDisabled();
      await nestsPage.createCancel.click();
    });

    test('CN-DASH-013: cancelling the create dialog creates nothing and clears errors', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, nestsPage, api } = await openDashboard(primary_user);
      const name = commonFunction.generateEntityName('cancelled');
      const before = (await api.listNests()).length;

      await nestsPage.goto();

      // Raise a real submit error first, so there is something to clear.
      await failRoute(page, '/nests', { method: 'POST', status: 500, error: 'Nope' });
      await nestsPage.createNest(name);
      await expect(nestsPage.createError).toHaveText('Nope');

      await nestsPage.createCancel.click();
      await expect(nestsPage.createDialog).not.toBeVisible();

      // Reopening starts clean, and nothing reached the server.
      await nestsPage.openCreateDialog();
      await expect(nestsPage.createError).toHaveCount(0);
      await nestsPage.createCancel.click();

      const after = await api.listNests();
      expect(after.length).toBe(before);
      expect(after.some((n) => n.name === name)).toBe(false);
    });

    test('CN-DASH-014: a nest is created successfully with valid data and opens automatically', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, nestsPage, api } = await openDashboard(primary_user);
      const name = commonFunction.generateEntityName('created');

      await nestsPage.goto();
      await nestsPage.createNest(name, 'Created by CN-DASH-014');

      // Straight into the new nest — the next thing anyone does is add a doc.
      await expect(page).toHaveURL(/\/nest\/[^/]+/, { timeout: 15000 });

      const created = await registerNestByName(api, name);
      expect(created, `nest "${name}" should exist on the server`).not.toBeNull();
      expect(created.description).toBe('Created by CN-DASH-014');
      expect(page.url()).toContain(created.id);

      // And it is on the grid when we come back.
      await nestsPage.goto();
      await expect(nestsPage.nestCard(name)).toBeVisible();
    });

    test('CN-DASH-015: the Import Folder button opens the import modal', async ({
      primary_user,
    }) => {
      const { nestsPage } = await openDashboard(primary_user);
      await nestsPage.goto();

      await expect(nestsPage.importFolderButton).toBeVisible();
      await nestsPage.openImportDialog();

      await expect(nestsPage.importDialog).toBeVisible();
      await expect(nestsPage.importDialog).toContainText('Import a folder from your computer');
      await expect(nestsPage.importDialog.getByRole('radio', { name: 'Folder' })).toBeVisible();
      await expect(
        nestsPage.importDialog.getByRole('radio', { name: 'File / .zip' })
      ).toBeVisible();
    });

  });

  // ══════════════════════════════════════════════════════════════════════════
  // Nest cards
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Nest cards', () => {
    test('CN-DASH-017: clicking a nest card opens the nest', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, nestsPage, api } = await openDashboard(primary_user);
      const name = commonFunction.generateEntityName('open-click');
      const nest = await api.createNest(name);

      await nestsPage.goto();
      await nestsPage.openNest(name);

      await expect(page).toHaveURL(new RegExp(`/nest/${nest.id}`), { timeout: 15000 });
    });

    test('CN-DASH-018: a nest card can be opened with the keyboard (Enter/Space)', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, nestsPage, api } = await openDashboard(primary_user);
      const enterNest = await api.createNest(commonFunction.generateEntityName('key-enter'));
      const spaceNest = await api.createNest(commonFunction.generateEntityName('key-space'));

      await nestsPage.goto();
      await nestsPage.openNestWithKeyboard(enterNest.name, 'Enter');
      await expect(page).toHaveURL(new RegExp(`/nest/${enterNest.id}`), { timeout: 15000 });

      await nestsPage.goto();
      await nestsPage.openNestWithKeyboard(spaceNest.name, ' ');
      await expect(page).toHaveURL(new RegExp(`/nest/${spaceNest.id}`), { timeout: 15000 });
    });

    test('CN-DASH-020: an imported nest displays its Imported badge and provenance', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const canCreate = await api.canCreateNests();
      test.skip(!canCreate, 'Importing a nest needs the same permission as creating one.');

      const name = commonFunction.generateEntityName('imported');
      await api.importNest(name, [
        { path: 'guides/welcome.md', content: '# Welcome\n\nImported document.\n' },
      ]);

      await nestsPage.goto();
      await expect(nestsPage.cardBadge(name, 'Imported')).toBeVisible();
      // The importer is the owner, so provenance reads "Imported by you".
      await expect(nestsPage.importedByLine(name)).toContainText('Imported by');
      await expect(nestsPage.importedByLine(name)).toContainText('you');
    });

    test('CN-DASH-033: an owned nest can be renamed from the card and updates instantly', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const name = commonFunction.generateEntityName('rename-before');
      const renamed = commonFunction.generateEntityName('rename-after');
      const nest = await api.createNest(name, 'Rename me');

      await nestsPage.goto();
      await nestsPage.renameNest(name, renamed);

      // The card renames in place — no reload needed.
      await expect(nestsPage.nestCard(renamed)).toBeVisible();
      await expect(nestsPage.nestCard(name)).toHaveCount(0);

      // And the server agrees.
      const updated = (await api.listNests()).find((n) => n.id === nest.id);
      expect(updated.name).toBe(renamed);
    });

    test('CN-DASH-034: pinning a nest moves it to the front and persists after reload', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      // A shared token narrows the grid to this test's own two nests. Scoping
      // the assertion this way rather than unpinning everything the account has
      // keeps the suite off the user's real bookmarks on a shared server.
      const token = `pin${Date.now().toString(36)}`;
      const older = await api.createNest(`${commonFunction.generateEntityName(token)}-older`);
      await new Promise((r) => setTimeout(r, 1100));
      const newer = await api.createNest(`${commonFunction.generateEntityName(token)}-newer`);

      await nestsPage.goto();
      await nestsPage.filterByName(token);
      // Newest activity first, so `older` sits behind `newer` to begin with.
      expect(await nestsPage.visibleNestNames()).toEqual([newer.name, older.name]);

      await nestsPage.pinNest(older.name);

      await expect(nestsPage.unpinIcon(older.name)).toBeVisible();
      await expect(nestsPage.unpinIcon(older.name)).toHaveAttribute('aria-pressed', 'true');
      expect(await nestsPage.visibleNestNames()).toEqual([older.name, newer.name]);

      // A pin is server-side state, so it survives a reload.
      await nestsPage.reload();
      await nestsPage.filterByName(token);
      expect(await nestsPage.visibleNestNames()).toEqual([older.name, newer.name]);
      await expect(nestsPage.unpinIcon(older.name)).toBeVisible();
      expect((await api.listNests()).find((n) => n.id === older.id).pinned).toBeTruthy();
      expect((await api.listNests()).find((n) => n.id === newer.id).pinned).toBeFalsy();
    });

    test('CN-DASH-035: unpinning a nest returns it to its normal position', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      // A shared token so the grid can be narrowed to just these three — the
      // account holds more than one page of nests by now, and a pinned nest is
      // only "at the front" of what the grid is actually showing.
      const token = `unpin${Date.now().toString(36)}`;
      // Spaced out so "recent activity" has a deterministic order to return to.
      const first = await api.createNest(`${commonFunction.generateEntityName(token)}-a`);
      await new Promise((r) => setTimeout(r, 1100));
      const second = await api.createNest(`${commonFunction.generateEntityName(token)}-b`);
      await new Promise((r) => setTimeout(r, 1100));
      const third = await api.createNest(`${commonFunction.generateEntityName(token)}-c`);
      const byActivity = [third.name, second.name, first.name];

      await nestsPage.goto();
      await nestsPage.filterByName(token);
      await expect(nestsPage.nestCardHeadings).toHaveCount(3);

      await nestsPage.pinNest(first.name);
      await expect(nestsPage.unpinIcon(first.name)).toBeVisible();
      expect(await nestsPage.visibleNestNames()).toEqual([first.name, third.name, second.name]);

      await nestsPage.unpinNest(first.name);

      // Back to where recent activity puts it, and the bookmark is empty again.
      await expect(nestsPage.pinIcon(first.name)).toBeVisible();
      await expect(nestsPage.pinIcon(first.name)).toHaveAttribute('aria-pressed', 'false');
      expect(await nestsPage.visibleNestNames()).toEqual(byActivity);
    });

  });

  // ══════════════════════════════════════════════════════════════════════════
  // Filtering, scoping, sorting and paging
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Filter, scope and sort', () => {
    test('CN-DASH-023: the filter bar appears only when there are more than 5 nests', async ({
      primary_user,
    }) => {
      // Forced counts: the live account's nest count moves as the suite runs,
      // and the rule under test is a boundary at exactly five.
      const { page, nestsPage } = await openDashboard(primary_user);
      await stubNoNotifications(page);
      const setNests = await stubNestList(page, stubGrid(5));

      await nestsPage.goto();
      await expect(nestsPage.nestCardHeadings).toHaveCount(5);
      await expect(nestsPage.filterInput).not.toBeVisible();
      await expect(nestsPage.scopeSelect).not.toBeVisible();
      await expect(nestsPage.sortSelect).not.toBeVisible();
      // The Archived switch is always there — it is the only way to reach them.
      await expect(nestsPage.archivedSwitch).toBeVisible();

      setNests(stubGrid(6));
      await nestsPage.reload();
      await expect(nestsPage.nestCardHeadings).toHaveCount(6);
      await expect(nestsPage.filterInput).toBeVisible();
      await expect(nestsPage.scopeSelect).toBeVisible();
      await expect(nestsPage.sortSelect).toBeVisible();
      await expect(nestsPage.filterSummary).toHaveText('6 of 6');
    });

    test('CN-DASH-024: the filter matches name and description case-insensitively', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      await api.ensureOwnedNests(6, commonFunction);
      // One nest carries the token in its name, the other only in its text.
      const token = `Zebra${Date.now().toString(36)}`;
      const byName = await api.createNest(
        `${commonFunction.generateEntityName('filter-name')}-${token}`
      );
      const byDescription = await api.createNest(
        commonFunction.generateEntityName('filter-desc'),
        `Mentions ${token} in the description only`
      );

      await nestsPage.goto();
      await nestsPage.filterByName(token.toUpperCase());

      // Both match, nothing else does.
      await expect(nestsPage.nestCard(byName.name)).toBeVisible();
      await expect(nestsPage.nestCard(byDescription.name)).toBeVisible();
      await expect(nestsPage.nestCardHeadings).toHaveCount(2);

      // Lower case finds the same two — the match ignores case on both fields.
      await nestsPage.filterByName(token.toLowerCase());
      await expect(nestsPage.nestCardHeadings).toHaveCount(2);
      await expect(nestsPage.clearFilters).toBeVisible();
    });

    test('CN-DASH-025: a filter with no matches shows an empty state with a Clear filters option', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      await api.ensureOwnedNests(6, commonFunction);

      await nestsPage.goto();
      await nestsPage.filterByName('no-nest-will-ever-be-called-this');

      await expect(nestsPage.noMatchesState).toBeVisible();
      await expect(nestsPage.nestCardHeadings).toHaveCount(0);
      await expect(nestsPage.filterSummary).toHaveText(/^0 of \d+$/);

      // The empty state's own way back out.
      await nestsPage.clearFiltersCta.click();
      await expect(nestsPage.filterInput).toHaveValue('');
      await expect(nestsPage.noMatchesState).toHaveCount(0);
      expect(await nestsPage.nestCardCount()).toBeGreaterThan(0);
    });

    test('CN-DASH-026: the scope select defaults to "My nests" and Owned/Shared scopes filter correctly', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      await api.ensureOwnedNests(6, commonFunction);
      const owned = await api.createNest(commonFunction.generateEntityName('scope-owned'));

      await nestsPage.goto();

      // "My nests" — owned or shared with me — is the first screen.
      expect(await nestsPage.currentScope()).toBe('mine');
      await expect(nestsPage.nestCard(owned.name)).toBeVisible();

      await nestsPage.selectScope('owned');
      await expect(nestsPage.nestCard(owned.name)).toBeVisible();

      // "Shared with me" is about grants, so a nest of my own is not in it.
      await nestsPage.selectScope('shared');
      await expect(nestsPage.nestCard(owned.name)).toHaveCount(0);
    });

    test('CN-DASH-027: the Organization and Public scopes filter by visibility', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      await api.ensureOwnedNests(6, commonFunction);
      const orgNest = await api.createNest(commonFunction.generateEntityName('scope-org'));
      const publicNest = await api.createNest(commonFunction.generateEntityName('scope-public'));
      const privateNest = await api.createNest(commonFunction.generateEntityName('scope-private'));
      await api.setVisibility(orgNest.id, 'org');
      await api.setVisibility(publicNest.id, 'public');

      await nestsPage.goto();

      await nestsPage.selectScope('org');
      await expect(nestsPage.nestCard(orgNest.name)).toBeVisible();
      await expect(nestsPage.cardBadge(orgNest.name, 'Organization')).toBeVisible();
      await expect(nestsPage.nestCard(publicNest.name)).toHaveCount(0);
      await expect(nestsPage.nestCard(privateNest.name)).toHaveCount(0);

      await nestsPage.selectScope('public');
      await expect(nestsPage.nestCard(publicNest.name)).toBeVisible();
      await expect(nestsPage.cardBadge(publicNest.name, 'Public')).toBeVisible();
      await expect(nestsPage.nestCard(orgNest.name)).toHaveCount(0);
      await expect(nestsPage.nestCard(privateNest.name)).toHaveCount(0);
    });

    test('CN-DASH-028: narrow scopes persist after reload while broad scopes reset to default', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      await api.ensureOwnedNests(6, commonFunction);

      await nestsPage.goto();

      // A narrow scope is this browser's remembered preference.
      await nestsPage.selectScope('owned');
      await nestsPage.reload();
      expect(await nestsPage.currentScope()).toBe('owned');

      // A broad one never becomes the first screen — it falls back to default.
      await nestsPage.selectScope('public');
      await nestsPage.reload();
      expect(await nestsPage.currentScope()).toBe('mine');

      await nestsPage.selectScope('org');
      await nestsPage.reload();
      expect(await nestsPage.currentScope()).toBe('mine');

      await nestsPage.selectScope('all');
      await nestsPage.reload();
      expect(await nestsPage.currentScope()).toBe('mine');
    });

    test('CN-DASH-029: sorting works by Recent activity and by Name (A–Z)', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      await api.ensureOwnedNests(6, commonFunction);
      // A shared token narrows the grid to these three, so neither sort can
      // push one of them past the 24-card page boundary.
      const token = `sort${Date.now().toString(36)}`;
      // Spaced so the activity order is unambiguous at second granularity.
      const first = await api.createNest(`${commonFunction.generateEntityName(token)}-a`);
      await new Promise((r) => setTimeout(r, 1100));
      const second = await api.createNest(`${commonFunction.generateEntityName(token)}-b`);
      await new Promise((r) => setTimeout(r, 1100));
      const third = await api.createNest(`${commonFunction.generateEntityName(token)}-c`);
      const ours = [first.name, second.name, third.name];
      const byActivity = [third.name, second.name, first.name];
      const byName = [...ours].sort((a, b) => a.localeCompare(b));

      await nestsPage.goto();
      await nestsPage.filterByName(token);
      await expect(nestsPage.nestCardHeadings).toHaveCount(3);

      // Default: most recent first.
      expect(await nestsPage.currentSort()).toBe('activity');
      expect(await nestsPage.visibleNestNames()).toEqual(byActivity);

      await nestsPage.selectSort('name');
      expect(await nestsPage.visibleNestNames()).toEqual(byName);

      await nestsPage.selectSort('activity');
      expect(await nestsPage.visibleNestNames()).toEqual(byActivity);
    });

    test('CN-DASH-030: Clear filters resets query, scope and sort together', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      await api.ensureOwnedNests(6, commonFunction);

      await nestsPage.goto();

      // Nothing is narrowing the list yet, so there is nothing to clear.
      await expect(nestsPage.clearFilters).toHaveCount(0);

      await nestsPage.filterByName('AUTO_');
      await nestsPage.selectScope('owned');
      await nestsPage.selectSort('name');
      await expect(nestsPage.clearFilters).toBeVisible();

      await nestsPage.clearFilters.click();

      await expect(nestsPage.filterInput).toHaveValue('');
      expect(await nestsPage.currentScope()).toBe('mine');
      expect(await nestsPage.currentSort()).toBe('activity');
      await expect(nestsPage.clearFilters).toHaveCount(0);
    });

    test('CN-DASH-031: the grid pages at 24 cards with a "Show more" button', async ({
      primary_user,
    }) => {
      // Forced counts: 30 real nests per run is a lot of residue for a rule
      // that is entirely client-side.
      const { page, nestsPage } = await openDashboard(primary_user);
      await stubNoNotifications(page);
      await stubNestList(page, stubGrid(30));

      await nestsPage.goto();

      // One page of 24, with the remainder named on the button.
      await expect(nestsPage.nestCardHeadings).toHaveCount(24);
      await expect(nestsPage.showMore).toBeVisible();
      await expect(nestsPage.showMore).toContainText('Show more (6 left)');
      await expect(nestsPage.filterSummary).toHaveText('30 of 30');

      await nestsPage.showMore.click();

      await expect(nestsPage.nestCardHeadings).toHaveCount(30);
      await expect(nestsPage.showMore).toHaveCount(0);
    });

    test('CN-DASH-032: changing the filter or scope resets pagination', async ({ primary_user }) => {
      // Forced counts, as above — the reset is only observable past 24 cards.
      const { page, nestsPage } = await openDashboard(primary_user);
      await stubNoNotifications(page);
      await stubNestList(page, stubGrid(30));

      await nestsPage.goto();
      await nestsPage.showMore.click();
      await expect(nestsPage.nestCardHeadings).toHaveCount(30);

      // A new query starts at page one again, even though all 30 still match.
      await nestsPage.filterByName('Stub Nest');
      await expect(nestsPage.filterSummary).toHaveText('30 of 30');
      await expect(nestsPage.nestCardHeadings).toHaveCount(24);
      await expect(nestsPage.showMore).toBeVisible();

      await nestsPage.showMore.click();
      await expect(nestsPage.nestCardHeadings).toHaveCount(30);

      // So does a new scope.
      await nestsPage.selectScope('owned');
      await expect(nestsPage.nestCardHeadings).toHaveCount(24);
      await expect(nestsPage.showMore).toBeVisible();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Shared nests and invites (needs a second account)
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Shared nests and invites', () => {
    test.skip(
      !secondaryRole,
      'secondary_user is not configured — sharing needs a second account. See tests/env.template.'
    );

    /**
     * The secondary account creates a nest and shares it with the primary at
     * `permission`. Returns the nest plus a disposer the test calls at the end
     * (the teardown runs as the primary, who cannot delete someone else's nest).
     */
    async function shareWithPrimary(secondary, commonFunction, permission, suffix) {
      await secondary.initialize();
      const api = secondary.dashboardApi;
      const nest = await api.createNest(
        commonFunction.generateEntityName(suffix),
        `Shared ${permission} with the primary account`
      );
      await api.addCollaborator(nest.id, primaryRole.email, permission);
      return { nest, dispose: () => api.deleteNest(nest.id).catch(() => {}) };
    }

    test('CN-DASH-036: a shared nest displays "Shared by" and the correct role badge', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { nest, dispose } = await shareWithPrimary(
        secondary_user,
        commonFunction,
        'read',
        'shared-viewer'
      );
      try {
        const { nestsPage, api } = await openDashboard(primary_user);
        // Settle the invite so the nest leaves Pending invites for the grid.
        await api.settleInvitesFor(nest.id);

        await nestsPage.goto();
        await expect(nestsPage.nestCard(nest.name)).toBeVisible();
        await expect(nestsPage.sharedByLine(nest.name)).toContainText(secondaryRole.email);
        await expect(nestsPage.cardBadge(nest.name, 'Viewer')).toBeVisible();
      } finally {
        await dispose();
      }
    });

    test('CN-DASH-037: the rename icon is hidden for non-admin collaborators', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      // An editor is the strongest non-admin grant — rename is owner/admin only.
      const { nest, dispose } = await shareWithPrimary(
        secondary_user,
        commonFunction,
        'write',
        'shared-editor-rename'
      );
      try {
        const { nestsPage, api } = await openDashboard(primary_user);
        await api.settleInvitesFor(nest.id);

        await nestsPage.goto();
        await expect(nestsPage.nestCard(nest.name)).toBeVisible();
        await expect(nestsPage.cardBadge(nest.name, 'Editor')).toBeVisible();
        await expect(nestsPage.renameIcon(nest.name)).toHaveCount(0);
      } finally {
        await dispose();
      }
    });

    test('CN-DASH-038: a Viewer can pin a shared nest', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { nest, dispose } = await shareWithPrimary(
        secondary_user,
        commonFunction,
        'read',
        'shared-viewer-pin'
      );
      try {
        const { nestsPage, api } = await openDashboard(primary_user);
        await api.settleInvitesFor(nest.id);

        await nestsPage.goto();
        await expect(nestsPage.pinIcon(nest.name)).toHaveAttribute('aria-pressed', 'false');
        // A pin is this person's own bookmark, so read-only access is enough.
        await nestsPage.pinNest(nest.name);

        await expect(nestsPage.unpinIcon(nest.name)).toBeVisible();
        await expect(nestsPage.unpinIcon(nest.name)).toHaveAttribute('aria-pressed', 'true');
        // Accepted by the server, not just reflected optimistically.
        expect((await api.listNests()).find((n) => n.id === nest.id).pinned).toBeTruthy();
        // Still a viewer — pinning granted nothing else.
        await expect(nestsPage.renameIcon(nest.name)).toHaveCount(0);
        await expect(nestsPage.deleteIcon(nest.name)).toHaveCount(0);
      } finally {
        await dispose();
      }
    });

    test('CN-DASH-039: a Viewer does not see a delete icon on a shared nest', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { nest, dispose } = await shareWithPrimary(
        secondary_user,
        commonFunction,
        'read',
        'shared-viewer-delete'
      );
      try {
        const { nestsPage, api } = await openDashboard(primary_user);
        await api.settleInvitesFor(nest.id);

        await nestsPage.goto();
        await expect(nestsPage.nestCard(nest.name)).toBeVisible();
        // Neither the real delete nor the request-removal stand-in: a viewer
        // has no removal action to take.
        await expect(nestsPage.deleteIcon(nest.name)).toHaveCount(0);
        await expect(nestsPage.requestRemovalIcon(nest.name)).toHaveCount(0);
        // The bookmark is the one action everybody gets.
        await expect(nestsPage.pinToggle(nest.name)).toBeVisible();
      } finally {
        await dispose();
      }
    });

    test("CN-DASH-040: an Editor's trash icon opens the request-removal flow instead of delete", async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { nest, dispose } = await shareWithPrimary(
        secondary_user,
        commonFunction,
        'write',
        'shared-editor-remove'
      );
      try {
        const { nestsPage, api } = await openDashboard(primary_user);
        await api.settleInvitesFor(nest.id);

        await nestsPage.goto();
        await expect(nestsPage.deleteIcon(nest.name)).toHaveCount(0);
        await expect(nestsPage.requestRemovalIcon(nest.name)).toBeVisible();

        await nestsPage.requestRemovalIcon(nest.name).click();

        // The ask, not the act: a reason, and both outcomes to ask for.
        await expect(nestsPage.reasonDialog).toBeVisible();
        await expect(nestsPage.reasonDialog).toContainText(`Request removal of "${nest.name}"`);
        await expect(nestsPage.reasonInput).toBeVisible();
        await expect(nestsPage.reasonConfirm).toContainText('Request deletion');
        await expect(nestsPage.reasonSecondary).toContainText('Request archive');

        // Nothing is removed by opening it.
        expect((await api.listNests()).some((n) => n.id === nest.id)).toBe(true);
      } finally {
        await dispose();
      }
    });

    test('CN-DASH-041: a pending invite appears in its own card and is excluded from the grid', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { nest, dispose } = await shareWithPrimary(
        secondary_user,
        commonFunction,
        'read',
        'invite-pending'
      );
      try {
        const { nestsPage, api } = await openDashboard(primary_user);
        // Deliberately NOT settled — an unread invite is the precondition.
        expect(await api.pendingInvitesFor(nest.id)).not.toHaveLength(0);

        await nestsPage.goto();
        await expect(nestsPage.pendingInvitesCard).toContainText('Pending invites');
        await expect(nestsPage.inviteRow(nest.name)).toBeVisible();
        await expect(nestsPage.inviteAccept(nest.name)).toBeVisible();
        await expect(nestsPage.inviteDecline(nest.name)).toBeVisible();

        // It is in the invite card instead of the grid, and out of the counts.
        await expect(nestsPage.nestCard(nest.name)).toHaveCount(0);
        const counted = await gridNests(api);
        await expect(nestsPage.bannerNestCount).toHaveText(String(counted.length));
      } finally {
        await dispose();
      }
    });

  });

  // ══════════════════════════════════════════════════════════════════════════
  // Archiving, restoring and deleting
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Archive, restore and delete', () => {
    test('CN-DASH-044: deleting a nest requires typing the exact nest name', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const nest = await api.createNest(commonFunction.generateEntityName('delete-confirm'));

      await nestsPage.goto();
      await nestsPage.openDeleteDialog(nest.name);

      // The damage list, then a name typed back before the button lives.
      await expect(nestsPage.deleteDialog).toContainText('This will remove:');
      await expect(nestsPage.deleteDialog).toContainText('All documents and content');
      await expect(nestsPage.deleteSubmit).toBeDisabled();

      await nestsPage.deleteConfirmInput.fill(`${nest.name}-not-quite`);
      await expect(nestsPage.deleteSubmit).toBeDisabled();

      await nestsPage.deleteConfirmInput.fill(nest.name.toUpperCase());
      await expect(nestsPage.deleteSubmit).toBeDisabled();

      await nestsPage.deleteConfirmInput.fill(nest.name);
      await expect(nestsPage.deleteSubmit).toBeEnabled();

      // Cancelled, so nothing is gone.
      await nestsPage.deleteCancel.click();
      await expect(nestsPage.deleteDialog).not.toBeVisible();
      expect((await api.listNests()).some((n) => n.id === nest.id)).toBe(true);
    });

    test('CN-DASH-045: "Archive instead" archives the nest from the delete dialog', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const nest = await api.createNest(commonFunction.generateEntityName('archive-instead'));

      await nestsPage.goto();
      await nestsPage.openDeleteDialog(nest.name);
      // The reversible option sits in front of someone reaching for Delete.
      await expect(nestsPage.archiveInstead).toBeVisible();
      await expect(nestsPage.deleteDialog).toContainText('Just want it out of the way?');

      await nestsPage.archiveInstead.click();

      await expect(
        nestsPage.toasts.filter({ hasText: `"${nest.name}" archived — find it under Archived` })
      ).toBeVisible();
      await expect(nestsPage.nestCard(nest.name)).toHaveCount(0);

      // Put away, not gone.
      await nestsPage.toggleArchived(true);
      await expect(nestsPage.archivedRow(nest.name)).toBeVisible();
      expect((await api.listNests({ archived: true })).some((n) => n.id === nest.id)).toBe(true);
    });

    test('CN-DASH-046: the Archived switch replaces the grid with the archived list', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const live = await api.createNest(commonFunction.generateEntityName('archive-switch-live'));
      const archived = await api.createNest(
        commonFunction.generateEntityName('archive-switch-away')
      );
      await api.archiveNest(archived.id);

      await nestsPage.goto();
      await expect(nestsPage.nestCard(live.name)).toBeVisible();

      await nestsPage.toggleArchived(true);

      // The archived list stands in for the whole grid, with its own copy.
      await expect(nestsPage.archivedSection).toBeVisible();
      await expect(nestsPage.archivedSection).toContainText('These nests are read-only');
      await expect(nestsPage.archivedRow(archived.name)).toBeVisible();
      await expect(nestsPage.nestCardHeadings).toHaveCount(0);
      // The live grid's filter bar goes with it.
      await expect(nestsPage.filterInput).not.toBeVisible();

      await nestsPage.toggleArchived(false);
      await expect(nestsPage.archivedSection).toHaveCount(0);
      await expect(nestsPage.nestCard(live.name)).toBeVisible();
    });

    test('CN-DASH-047: the archived list gets its own filter and sort past 5 entries', async ({
      primary_user,
    }) => {
      // Forced counts: archiving six real nests per run to test a boundary at
      // five is a lot of lifecycle churn for a client-side rule.
      const { page, nestsPage } = await openDashboard(primary_user);
      const five = stubGrid(5).map((n) => ({ ...n, archived_at: '2026-01-02 09:00:00' }));
      await stubArchivedList(page, five);

      await nestsPage.goto();
      await nestsPage.toggleArchived(true);
      await expect(nestsPage.archivedFilterInput).not.toBeVisible();
      await expect(nestsPage.archivedSortSelect).not.toBeVisible();

      // Re-stubbing wins: Playwright matches the most recently added handler first.
      const six = stubGrid(6).map((n, i) => ({
        ...n,
        archived_at: `2026-01-0${i + 1} 09:00:00`,
      }));
      await stubArchivedList(page, six);
      await nestsPage.reload();
      await nestsPage.toggleArchived(true);

      await expect(nestsPage.archivedFilterInput).toBeVisible();
      await expect(nestsPage.archivedSortSelect).toBeVisible();

      // Its filter matches on name only, and is its own state.
      await nestsPage.archivedFilterInput.fill('Stub Nest 03');
      await expect(nestsPage.archivedRow('Stub Nest 03')).toBeVisible();
      expect(await nestsPage.archivedNames()).toEqual(['Stub Nest 03']);
      await expect(nestsPage.archivedClearFilter).toBeVisible();

      await nestsPage.archivedClearFilter.click();
      await expect(nestsPage.archivedFilterInput).toHaveValue('');

      // And its own sort: date archived (newest first) or name.
      await nestsPage.archivedSortSelect.selectOption('name');
      expect(await nestsPage.archivedNames()).toEqual(six.map((n) => n.name));
      await nestsPage.archivedSortSelect.selectOption('archived');
      expect(await nestsPage.archivedNames()).toEqual([...six].reverse().map((n) => n.name));
    });

    test('CN-DASH-048: Restore/Delete appear only on archived rows the user owns', async ({
      primary_user,
    }) => {
      // Forced rows: `GET /nests?archived=1` only ever returns nests the caller
      // owns, so a non-owned archived row cannot be produced for real.
      const { page, nestsPage } = await openDashboard(primary_user);
      await stubArchivedList(page, [
        nestRow({
          id: 'stub-arch-mine',
          name: 'Stub Archived Mine',
          is_owner: true,
          archived_at: '2026-01-02 09:00:00',
        }),
        nestRow({
          id: 'stub-arch-theirs',
          name: 'Stub Archived Theirs',
          is_owner: false,
          permission: 'read',
          owner_email: 'someone@else.com',
          archived_at: '2026-01-01 09:00:00',
        }),
      ]);

      await nestsPage.goto();
      await nestsPage.toggleArchived(true);

      // Mine offers both lifecycle actions.
      await expect(nestsPage.archivedRestore('Stub Archived Mine')).toBeVisible();
      await expect(
        nestsPage.archivedRow('Stub Archived Mine').getByRole('button')
      ).toHaveCount(2);

      // Someone else's offers none — archive, restore and delete are theirs.
      await expect(nestsPage.archivedRow('Stub Archived Theirs')).toBeVisible();
      await expect(nestsPage.archivedRestore('Stub Archived Theirs')).toHaveCount(0);
      await expect(
        nestsPage.archivedRow('Stub Archived Theirs').getByRole('button')
      ).toHaveCount(0);
    });

    test('CN-DASH-049: restoring an archived nest returns it to the live grid', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const nest = await api.createNest(commonFunction.generateEntityName('restore'));
      await api.archiveNest(nest.id);

      await nestsPage.goto();
      await expect(nestsPage.nestCard(nest.name)).toHaveCount(0);
      await nestsPage.toggleArchived(true);
      await nestsPage.archivedRestore(nest.name).click();

      // One deliberate click — restoring re-opens the nest to collaborators.
      await expect(nestsPage.restoreDialog).toBeVisible();
      await expect(nestsPage.restoreDialog).toContainText('It goes back exactly as it was');
      await nestsPage.restoreConfirm.click();

      await expect(nestsPage.toasts.filter({ hasText: `"${nest.name}" restored` })).toBeVisible();
      await expect(nestsPage.archivedRow(nest.name)).toHaveCount(0);

      await nestsPage.toggleArchived(false);
      await expect(nestsPage.nestCard(nest.name)).toBeVisible();
      expect((await api.listNests()).some((n) => n.id === nest.id)).toBe(true);
    });

    test('CN-DASH-050: the archived section shows an empty state when nothing is archived', async ({
      primary_user,
    }) => {
      // Forced emptiness: the account archives nests elsewhere in this suite.
      const { page, nestsPage } = await openDashboard(primary_user);
      await stubArchivedList(page, []);

      await nestsPage.goto();
      await nestsPage.toggleArchived(true);

      await expect(nestsPage.archivedEmptyState).toBeVisible();
      await expect(nestsPage.archivedSection).toContainText(
        'Archiving a nest puts it here instead of deleting it'
      );
      expect(await nestsPage.archivedNames()).toEqual([]);
    });

    test('CN-DASH-051: deleting an imported nest states the original folder is unaffected', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const canCreate = await api.canCreateNests();
      test.skip(!canCreate, 'Importing a nest needs the same permission as creating one.');

      const name = commonFunction.generateEntityName('imported-delete');
      await api.importNest(name);

      await nestsPage.goto();
      await nestsPage.openDeleteDialog(name);

      // The workspace copy goes; the folder the user imported from does not.
      await expect(nestsPage.deleteDialog).toContainText('All documents and content (the workspace copy)');
      await expect(nestsPage.importedFolderNotice).toBeVisible();
      await expect(nestsPage.deleteDialog).not.toContainText('The nest folder on disk');

      await nestsPage.deleteCancel.click();
    });

    test('CN-DASH-052: an owned nest is deleted successfully and removed from the grid', async ({
      primary_user,
      commonFunction,
    }) => {
      const { nestsPage, api } = await openDashboard(primary_user);
      const nest = await api.createNest(commonFunction.generateEntityName('delete-for-real'));

      await nestsPage.goto();
      await expect(nestsPage.nestCard(nest.name)).toBeVisible();

      await nestsPage.deleteNest(nest.name);

      await expect(nestsPage.nestCard(nest.name)).toHaveCount(0);
      expect((await api.listNests()).some((n) => n.id === nest.id)).toBe(false);
      // Deleted, not archived.
      expect((await api.listNests({ archived: true })).some((n) => n.id === nest.id)).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Empty states
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Empty states', () => {
    test('CN-DASH-053: a creator-capable user with no nests sees the "Create First Nest" empty state', async ({
      primary_user,
    }) => {
      // Forced emptiness: the test account owns nests by design.
      const { page, nestsPage, api } = await openDashboard(primary_user);
      test.skip(
        !(await api.canCreateNests()),
        'This account cannot create nests, so it sees the ask-admin state instead.'
      );
      await stubNestList(page, []);
      await stubUnsynced(page, []);
      await stubNoNotifications(page);

      await nestsPage.goto();

      await expect(nestsPage.noNestsState).toBeVisible();
      await expect(nestsPage.createFirstNestButton).toBeVisible();
      await expect(
        nestsPage.page.getByText('Create your first nest to start sharing knowledge with your team')
      ).toBeVisible();
      await expect(nestsPage.nestCardHeadings).toHaveCount(0);

      // The empty state's CTA is the same create dialog as the header's.
      await nestsPage.createFirstNestButton.click();
      await expect(nestsPage.createDialog).toBeVisible();
    });

    test('CN-DASH-055: the discovered-nests empty state offers "Browse all nests"', async ({
      primary_user,
    }) => {
      // Forced list: a discovered nest belongs to another account on a shared
      // server, which a single-account test run has no way to arrange.
      const { page, nestsPage } = await openDashboard(primary_user);
      await stubUnsynced(page, []);
      await stubNoNotifications(page);
      await stubNestList(page, [
        nestRow({
          id: 'stub-discovered-1',
          name: 'Stub Discovered One',
          discovered: true,
          is_owner: false,
          permission: 'read',
          visibility: 'org',
          owner_email: 'someone@else.com',
        }),
        nestRow({
          id: 'stub-discovered-2',
          name: 'Stub Discovered Two',
          discovered: true,
          is_owner: false,
          permission: 'read',
          visibility: 'public',
          owner_email: 'someone@else.com',
        }),
      ]);

      await nestsPage.goto();

      // Said plainly, not as "hidden by the current filter".
      await expect(nestsPage.discoveredState).toBeVisible();
      await expect(
        nestsPage.page.getByText(/2 nests others have opened up on this server/)
      ).toBeVisible();
      await expect(nestsPage.browseDiscovered).toBeVisible();
      await expect(nestsPage.nestCardHeadings).toHaveCount(0);

      await nestsPage.browseDiscovered.click();

      // Discovery is one select away — "All nests" brings them into view.
      await expect(nestsPage.nestCard('Stub Discovered One')).toBeVisible();
      await expect(nestsPage.nestCard('Stub Discovered Two')).toBeVisible();
    });
  });
});
