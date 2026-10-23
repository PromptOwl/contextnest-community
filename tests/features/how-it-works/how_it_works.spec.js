/**
 * How It Works Test Suite — CN-HELP-001 … CN-HELP-009
 *
 * Page under test: ui/src/pages/app/guide/page.tsx (route `/guide`,
 * rail → Help → How it works).
 *
 * Conventions
 * -----------
 * - The page is open to every signed-in user. The primary account runs every
 *   case; CN-HELP-004 also opens it as the secondary account, which must not
 *   be a server admin for that half to mean anything.
 * - Read-only: the page is static text, so nothing is stubbed and nothing is
 *   written. Checks are about where the page lives and what it links to,
 *   not its wording — section headings are the only text pinned.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { GUIDE_SECTIONS, GUIDE_DESCRIPTION } from '../../src/page_factory/app/how_it_works_page.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

test.describe('How it works', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test('CN-HELP-001: "How it works" appears in the Help group of the sidebar and opens the page at /guide', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, nestsPage, howItWorksPage: hw } = primary_user;
    await nestsPage.goto();
    await expect(hw.helpGroup).toBeVisible();
    await expect(hw.helpGroup).toHaveText(/Help/i);
    await expect(hw.railItemInHelp).toBeVisible();
    await expect(hw.railItemInHelp).toHaveText(/How it works/);
    await hw.railItemInHelp.click();
    await expect(page).toHaveURL(/\/guide$/);
    await hw.waitLoaded();
  });

  test('CN-HELP-002: the "How it works" sidebar item is highlighted as the current page while it is open', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, nestsPage, howItWorksPage: hw } = primary_user;
    await nestsPage.goto();
    await expect(hw.railItem).not.toHaveAttribute('aria-current', 'page');
    await hw.railItem.click();
    await hw.waitLoaded();
    await expect(hw.railItem).toHaveAttribute('aria-current', 'page');
    // It's the only current row.
    await expect(page.locator('[data-testid^="document-sidebar-dashboard-"][aria-current="page"]')).toHaveCount(1);
  });

  test('CN-HELP-003: the page opens directly from its URL and shows the breadcrumb "Home > How it works"', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, howItWorksPage: hw } = primary_user;
    await hw.goto();
    await expect(page).toHaveURL(/\/guide$/);
    await expect(hw.breadcrumb).toBeVisible();
    expect(await hw.crumbs()).toEqual(['Home', 'How it works']);
    // A reload lands on the same page.
    await page.reload();
    await hw.waitLoaded();
    expect(await hw.crumbs()).toEqual(['Home', 'How it works']);
  });

  test('CN-HELP-004: a non-admin user can open How it works and sees the same sections as an admin', async ({ primary_user, secondary_user }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured.');
    await primary_user.initialize();
    await primary_user.howItWorksPage.goto();
    const adminSections = await primary_user.howItWorksPage.sections.allInnerTexts();

    await secondary_user.initialize();
    test.skip(await secondary_user.teammatesApi.isServerAdmin(), 'secondary_user is a server admin on this server.');
    const { nestsPage, howItWorksPage: hw, page } = secondary_user;
    await nestsPage.goto();
    await expect(page.getByTestId('document-sidebar-group-admin'), 'a non-admin has no Admin group').toHaveCount(0);
    await expect(hw.railItemInHelp).toBeVisible();
    await hw.railItemInHelp.click();
    await hw.waitLoaded();
    await expect(page).toHaveURL(/\/guide$/);
    await expect(hw.sections).toHaveText(adminSections);
  });

  test('CN-HELP-005: the page title "How it works" and its description are displayed', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, howItWorksPage: hw } = primary_user;
    await hw.goto();
    await expect(page.getByRole('heading', { level: 1, name: 'How it works' })).toBeVisible();
    await expect(hw.pageTitle).toContainText(GUIDE_DESCRIPTION);
  });

  test('CN-HELP-006: the page shows all its sections in the correct order', async ({ primary_user }) => {
    await primary_user.initialize();
    const { howItWorksPage: hw } = primary_user;
    await hw.goto();
    await expect(hw.sections).toHaveText(GUIDE_SECTIONS);
    for (const title of GUIDE_SECTIONS) {
      await expect(hw.section(title), `"${title}" has content`).not.toHaveText(title);
    }
  });

  test('CN-HELP-007: the "Manage keys" button in the Workspace section opens the API keys page', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, howItWorksPage: hw } = primary_user;
    await hw.goto();
    const workspace = hw.section('Workspace');
    await expect(workspace.getByRole('button', { name: 'Manage keys', exact: true })).toBeVisible();
    await hw.manageKeys.click();
    await expect(page).toHaveURL(/\/api-keys$/);
    await expect(hw.pageTitle).toContainText('API keys');
  });

  test('CN-HELP-008: the header Docs button, which the page points to for agent setup, opens the Docs page', async ({ primary_user }) => {
    await primary_user.initialize();
    const { howItWorksPage: hw } = primary_user;
    await hw.goto();
    await expect(hw.pageTitle).toContainText('Docs page in the header');
    await expect(hw.docsButton).toBeVisible();
    await hw.docsButton.click();
    await expect(hw.pageTitle).toContainText('Docs');
    expect(await hw.crumbs()).toEqual(['Home', 'Docs']);
    await expect(hw.page.locator('main')).toContainText('MCP');
  });

  test('CN-HELP-009: the shortcuts the page names work from it: Ctrl / ⌘ K focuses the search and ? opens the Keyboard shortcuts dialog', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page, howItWorksPage: hw } = primary_user;
    await hw.goto();
    const documents = hw.section('Documents');
    await expect(documents).toContainText('searches every nest and document');
    await expect(documents).toContainText('lists all shortcuts');

    // Ctrl / ⌘ K → the header search takes focus.
    await hw.sections.first().click();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(hw.search).toBeFocused();
    await page.keyboard.press('Escape');

    // ? → the Keyboard shortcuts dialog.
    await hw.sections.first().click();
    await page.keyboard.type('?');
    await expect(hw.shortcutsDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(hw.shortcutsDialog).toBeHidden();
    await expect(page).toHaveURL(/\/guide$/);
  });
});
