/**
 * Reader Mode Test Suite — CN-READER-001 … CN-READER-006
 *
 * Page under test: Public Docs Reader Mode — the "Reader mode: On / Off"
 * button on the nest's Settings tab (in the nest header as "Reader: On / Off"
 * until #582) and its "Public Docs Reader Mode" dialog
 * (ui/src/components/NestView.tsx), and what readers get with it on: the
 * in-app docs reader for a signed-in person who can only read the nest
 * (ui/src/components/ReaderView.tsx) and the docs site at /d/<key>/ for a
 * signed-out visitor to a Public nest (src/site/routes.ts, src/site/render.ts).
 *
 * Conventions
 * -----------
 * - primary_user owns every nest; secondary_user is the reader, collaborator
 *   or outsider each case needs. Editor and Admin are paid seats: when the
 *   server has no free seat for the role a case needs (402), the case skips.
 * - Each nest gets two published pages, "Welcome" (the home page by
 *   convention) and "Second Page". Visibility and Reader mode are arranged
 *   through the REST API (`readerModeApi`) except where the case is about
 *   turning Reader mode on; outcomes are read back through the API too.
 * - A signed-out visitor is a fresh browser context with no session, closed
 *   after the test. The server keeps its list of docs sites for a few seconds,
 *   so a case that expects the docs site retries with a fresh visitor.
 * - Every nest is an AUTO_ name, deleted after the test
 *   (`readerModeApi.deleteCreatedNests()`), and is in the entity registry for
 *   the teardown and the orphan sweeper. The notifications a nest raised are
 *   marked read first.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import ReaderModePage from '../../src/page_factory/app/reader_mode_page.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

const HOME_TITLE = 'Welcome';
const HOME_BODY = 'Start here with the reader home page.';
const NEXT_TITLE = 'Second Page';
const NEXT_BODY = 'More reading on the second page.';
const ROLE_LABEL = { read: 'Viewer', write: 'Editor', admin: 'Admin' };

test.describe('Reader mode', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner and create a nest with a home page and a second page,
   * optionally Public and with Reader mode on. Skips unless the owner may
   * create nests.
   */
  async function ownerNest(role, commonFunction, suffix, { visibility = 'private', reader = false } = {}) {
    await role.initialize();
    const api = role.readerModeApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Reader mode suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    cleanups.push(() => api.settleNotificationsFor(nest.id));
    const home = await api.createDoc(nest.id, { title: HOME_TITLE, content: `# ${HOME_TITLE}\n\n${HOME_BODY}\n` });
    const next = await api.createDoc(nest.id, { title: NEXT_TITLE, content: `# ${NEXT_TITLE}\n\n${NEXT_BODY}\n` });
    if (visibility !== 'private') await api.setVisibility(nest.id, visibility);
    if (reader) await api.setReaderMode(nest.id, true);
    return { api, nest, home, next, page: role.readerModePage };
  }

  /** Open secondary_user's session, settling any invite the nest raised. */
  async function openSecondary(owner, secondary) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await secondary.initialize();
    const api = secondary.readerModeApi;
    await api.settleInvitesFor(owner.nest.id).catch(() => {});
    cleanups.push(() => api.settleNotificationsFor(owner.nest.id));
    return { api, page: secondary.readerModePage };
  }

  /**
   * Share the nest with secondary_user at `permission`. Skips when the server
   * has no free seat for that role.
   */
  async function share(owner, secondary, permission) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const res = await owner.api.grant(owner.nest.id, secondaryRole.email, permission);
    test.skip(res.status === 402, `No free ${ROLE_LABEL[permission]} seat on this server.`);
    expect(res.ok, `share as ${permission}: HTTP ${res.status} ${res.data?.error ?? ''}`).toBe(true);
    return openSecondary(owner, secondary);
  }

  /** Change secondary_user's role. Skips when the server has no free seat for it. */
  async function changeRole(owner, permission) {
    const res = await owner.api.setPermission(owner.nest.id, secondaryRole.email, permission);
    test.skip(res.status === 402, `No free ${ROLE_LABEL[permission]} seat on this server.`);
    expect(res.ok, `change to ${permission}: HTTP ${res.status} ${res.data?.error ?? ''}`).toBe(true);
  }

  /** A signed-out visitor: a fresh browser context with no session. */
  async function signedOut(browser) {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    cleanups.push(() => context.close());
    return new ReaderModePage(await context.newPage(), 'visitor');
  }

  // ── Turning it on ──────────────────────────────────────────────────────────

  test('CN-READER-001: Verify that the owner can turn Reader mode on in the “Public Docs Reader Mode” dialog, the Settings tab button changes to “Reader mode: On”, and it stays after a reload', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'reader-on');

    // #582 moved the button from the nest header to the Settings tab.
    await owner.page.gotoAsManager(owner.nest.id);
    await expect(owner.page.readerButton).toContainText('Reader mode: Off');
    await owner.page.setReaderMode(true);
    await expect(owner.page.readerButton).toContainText('Reader mode: On');
    await expect.poll(async () => (await owner.api.readerMode(owner.nest.id)).enabled, WRITE).toBe(true);

    await owner.page.gotoAsManager(owner.nest.id);
    await expect(owner.page.readerButton).toContainText('Reader mode: On');
  });

  // ── What readers get ───────────────────────────────────────────────────────

  test('CN-READER-002: Verify that with Reader mode on, a signed-out visitor opening a Public nest gets the docs site (/d/…) with the page list, the home document and Next/Previous, not the nest tabs', async ({ primary_user, commonFunction, browser }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'reader-site', { visibility: 'public', reader: true });

    // The server's list of docs sites refreshes within seconds; a fresh visitor
    // each try, so a cached answer from an earlier try can't stand in.
    let visitor;
    await expect(async () => {
      visitor = await signedOut(browser);
      await visitor.gotoNest(owner.nest.id);
      expect(new URL(visitor.page.url()).pathname).toMatch(/^\/d\/[^/]+\/$/);
    }).toPass({ timeout: 60_000, intervals: [3_000] });

    await expect(visitor.siteNav).toContainText(HOME_TITLE);
    await expect(visitor.siteNav).toContainText(NEXT_TITLE);
    await expect(visitor.page.locator('#content')).toContainText(HOME_BODY);
    await expect(visitor.sitePager).toContainText(NEXT_TITLE);
    await expect(visitor.overviewTab).toHaveCount(0);
    await expect(visitor.documentsTab).toHaveCount(0);
  });

  test('CN-READER-003: Verify that with Reader mode on, a signed-in person who can only read the nest sees the docs reader with no tabs or editing', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'reader-viewer', { reader: true });
    const viewer = await share(owner, secondary_user, 'read');

    await viewer.page.gotoNest(owner.nest.id);
    await expect(viewer.page.readerSearch).toBeVisible(WRITE);
    await expect(viewer.page.page.getByText(HOME_BODY).first()).toBeVisible();
    await expect(viewer.page.readerPager).toContainText(NEXT_TITLE);
    await expect(viewer.page.overviewTab).toHaveCount(0);
    await expect(viewer.page.documentsTab).toHaveCount(0);
    await expect(viewer.page.newDocumentButton).toHaveCount(0);
    await expect(viewer.page.page.locator('[contenteditable="true"]')).toHaveCount(0);
  });

  test('CN-READER-004: Verify that with Reader mode on, the owner and Editors still get the full nest view', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'reader-authors', { reader: true });

    await owner.page.gotoNest(owner.nest.id);
    await expect(owner.page.overviewTab).toBeVisible(WRITE);
    await expect(owner.page.documentsTab).toBeVisible();
    await expect(owner.page.newDocumentButton).toBeVisible();
    await expect(owner.page.readerSearch).toHaveCount(0);

    const editor = await share(owner, secondary_user, 'write');
    await editor.page.gotoNest(owner.nest.id);
    await expect(editor.page.overviewTab).toBeVisible(WRITE);
    await expect(editor.page.documentsTab).toBeVisible();
    await expect(editor.page.newDocumentButton).toBeVisible();
    await expect(editor.page.readerSearch).toHaveCount(0);
  });

  // ── Who it is for ──────────────────────────────────────────────────────────

  test('CN-READER-005: Verify that Reader mode doesn’t open a Private nest: non-members and signed-out visitors still can’t see it', async ({ primary_user, secondary_user, commonFunction, browser }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'reader-private', { reader: true });
    expect(await owner.api.visibility(owner.nest.id)).toBe('private');
    expect((await owner.api.readerMode(owner.nest.id)).enabled).toBe(true);

    const outsider = await openSecondary(owner, secondary_user);
    expect(await outsider.api.openStatus(owner.nest.id)).not.toBe(200);
    await outsider.page.gotoNest(owner.nest.id);
    await expect(outsider.page.noAccess).toBeVisible(WRITE);
    await expect(outsider.page.page.getByText(HOME_BODY)).toHaveCount(0);

    const visitor = await signedOut(browser);
    await visitor.gotoNest(owner.nest.id);
    await expect(visitor.loginEmail).toBeVisible(WRITE);
    expect(new URL(visitor.page.url()).pathname).not.toMatch(/^\/d\//);
    await expect(visitor.page.getByText(HOME_BODY)).toHaveCount(0);
  });

  test('CN-READER-006: Verify that Viewers and Editors don’t see the “Reader” button, and only the owner, nest Admins and server admins can change Reader mode', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'reader-roles');
    await owner.page.gotoAsManager(owner.nest.id);

    // Viewer (the Reader button is on the Settings tab since #582)
    const member = await share(owner, secondary_user, 'read');
    await member.page.gotoSettings(owner.nest.id);
    await expect(member.page.backToNests).toBeVisible(WRITE);
    await expect(member.page.readerButton).toHaveCount(0);
    expect((await member.api.tryReaderMode(owner.nest.id, true)).status).toBe(403);

    // Editor
    await changeRole(owner, 'write');
    await member.page.gotoNest(owner.nest.id);
    await expect(member.page.newDocumentButton).toBeVisible(WRITE);
    await member.page.gotoSettings(owner.nest.id);
    await expect(member.page.readerButton).toHaveCount(0);
    expect((await member.api.tryReaderMode(owner.nest.id, true)).status).toBe(403);
    expect((await owner.api.readerMode(owner.nest.id)).enabled).toBe(false);

    // Nest Admin
    await changeRole(owner, 'admin');
    await member.page.gotoAsManager(owner.nest.id);
    expect((await member.api.tryReaderMode(owner.nest.id, true)).ok).toBe(true);
    await expect.poll(async () => (await owner.api.readerMode(owner.nest.id)).enabled, WRITE).toBe(true);
  });
});
