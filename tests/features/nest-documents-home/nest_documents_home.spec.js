/**
 * Nest Documents home — CN-NH-001 … CN-NH-006 (po-1213, AC-NH-01..09)
 *
 * Documents is the nest's one home: Overview merged into it, every row and
 * feed item names its last editor (the human, then the agent), and Fields,
 * Reader mode and the list/grid switch live in the header's ⋯ menu.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest; each test creates its own AUTO_ nest via
 *   `nestOverviewApi` and deletes it after the test.
 * - An agent edit is a PATCH that names `client.agent` (spec §9.4): the human
 *   is the caller, the agent rides alongside.
 * - CI runs e2e against the deployed server (nest-dev), not this branch's
 *   build. Until that server ships po-1213 (its node list carries
 *   `last_edit`), the suite skips rather than fails; CN_EXPECT_NEST_HOME=1
 *   turns that skip into a failure.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import NestHomePage from '../../src/page_factory/app/nest_home_page.js';

const primaryRole = samples.primary_user ?? null;
const WRITE = { timeout: 60_000 };
const AGENT = 'e2e-nest-home-agent';

test.describe('Nest documents home', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()().catch(() => {});
  });

  /**
   * A nest with two documents in "guides", one last edited by an agent.
   * Skips when the server under test does not ship po-1213 yet.
   */
  async function arrange(role, commonFunction, suffix) {
    await role.initialize();
    const api = role.nestOverviewApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Nest home suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    const handDoc = await api.createTypedDocument(nest.id, { title: 'Hand Doc', folder: 'guides' });
    const agentDoc = await api.createTypedDocument(nest.id, { title: 'Agent Doc', folder: 'guides' });
    await api.updateDocument(nest.id, agentDoc.id, {
      content: '# Agent Doc\n\nEdited by an agent.\n',
      client: { agent: AGENT },
    });

    const list = await role.page.request.get(`/nests/${nest.id}/nodes`);
    const rows = (await list.json()).nodes ?? [];
    const deployed = rows.some((r) => r.last_edit);
    if (process.env.CN_EXPECT_NEST_HOME === '1') {
      expect(deployed, 'the server under test does not ship po-1213 (no last_edit on list rows)').toBe(true);
    }
    test.skip(!deployed, 'The server under test does not ship the Documents home yet (po-1213).');
    return { nest, handDoc, agentDoc, page: new NestHomePage(role.page) };
  }

  test('CN-NH-001: Verify that a nest opens on Documents, has no Overview tab, and ?tab=overview opens Documents', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await arrange(primary_user, commonFunction, 'nesthome-landing');
    await page.gotoNest(nest.id);
    await expect(page.selectedTab).toHaveText('Documents', WRITE);
    await expect(page.tab('Overview')).toHaveCount(0);

    await page.gotoNest(nest.id, 'overview');
    await expect(page.selectedTab).toHaveText('Documents', WRITE);
  });

  test('CN-NH-002: Verify that the summary line and the Recently edited feed sit above the list', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, agentDoc, page } = await arrange(primary_user, commonFunction, 'nesthome-feed');
    await page.gotoNest(nest.id);
    await expect(page.facts).toContainText('2 documents', WRITE);
    await expect(page.facts).toContainText('1 folder');
    await expect(page.feedItem(agentDoc.id)).toContainText('Agent Doc', WRITE);
    await expect(page.feedItem(agentDoc.id)).toContainText('Guides');
  });

  test('CN-NH-003: Verify that an agent edit reads "<human> via <agent>" on the feed and on the row', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, agentDoc, handDoc, page } = await arrange(primary_user, commonFunction, 'nesthome-editor');
    await page.gotoNest(nest.id);
    await expect(page.feedItem(agentDoc.id)).toContainText(`via ${AGENT}`, WRITE);
    // The feed's time has the full date on hover.
    await expect(page.feedItem(agentDoc.id).locator('time')).toHaveAttribute('title', /\d/);

    await page.page.getByRole('button', { name: /Guides/ }).first().click();
    await expect(page.rowLastEdit(agentDoc.id)).toContainText(`via ${AGENT}`, WRITE);
    // The human comes first: something precedes " via ".
    await expect(page.rowLastEdit(agentDoc.id)).toHaveText(new RegExp(`\\S+.* via ${AGENT}`));
    await expect(page.rowLastEdit(handDoc.id)).toBeVisible();
  });

  test('CN-NH-004: Verify that the ⋯ menu holds the list/grid switch and Fields, and both work', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await arrange(primary_user, commonFunction, 'nesthome-menu');
    await page.gotoNest(nest.id);
    await expect(page.tab('Fields')).toHaveCount(0);

    await page.openMenu();
    const grid = page.menuItem('nest-view-grid');
    const list = page.menuItem('nest-view-list');
    // The switch toggles; whichever way this browser last left it, flip it twice.
    const startedInGrid = await list.isVisible();
    await (startedInGrid ? list : grid).click();
    await page.openMenu();
    await expect(page.menuItem(startedInGrid ? 'nest-view-grid' : 'nest-view-list')).toBeVisible();
    await page.page.keyboard.press('Escape');

    await page.openMenu();
    await page.menuItem('nest-open-fields').click();
    await expect(page.fieldsDialog).toBeVisible(WRITE);
  });

  test('CN-NH-005: Verify that an old ?tab=fields link opens the Fields dialog over Documents', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await arrange(primary_user, commonFunction, 'nesthome-fields-link');
    await page.page.goto(`/nest/${nest.id}?tab=fields`);
    await expect(page.fieldsDialog).toBeVisible(WRITE);
    await expect(page.selectedTab).toHaveText('Documents');
  });

  test('CN-NH-006: Verify that at phone width the page does not scroll sideways and the feed names the editor', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, agentDoc, page } = await arrange(primary_user, commonFunction, 'nesthome-phone');
    await page.page.setViewportSize({ width: 390, height: 844 });
    await page.gotoNest(nest.id);
    await expect(page.feedItem(agentDoc.id)).toContainText(`via ${AGENT}`, WRITE);
    const overflow = await page.page.evaluate(
      () => document.scrollingElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
