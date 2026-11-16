/**
 * Nest Archive Test Suite — CN-ARCH-001 … CN-ARCH-010
 *
 * Page under test: the nest page (ui/src/components/NestView.tsx) — archiving
 * from inside a nest, what an archived nest still offers, its published links,
 * and the editor's archive request with its Review Queue decision. Archiving,
 * the Archived switch and restoring from the dashboard are covered by the
 * Dashboard suite (CN-DASH-045 … CN-DASH-050).
 *
 * Conventions
 * -----------
 * - primary_user owns every nest; secondary_user is the editor who asks for
 *   an archive (shared with write access) or the collaborator who loses it.
 * - Preconditions (nests, a document, a published link, shares, requests)
 *   are arranged through the REST API (`nestArchiveApi`); the step under test
 *   goes through the UI. Outcomes are read back through the API too.
 * - Every nest is an AUTO_ name, deleted after the test
 *   (`nestArchiveApi.deleteCreatedNests()`), and is in the entity registry for
 *   the teardown and the orphan sweeper. The notifications a nest raised are
 *   marked read first, so neither account's inbox keeps them.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

/** The document every archived-nest case reads. */
const DOC_TITLE = 'Archive Doc';
const DOC_BODY = 'Archived body text.';

test.describe('Nest archive', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner and create a nest (optionally with one document).
   * Skips unless the owner may create nests.
   */
  async function ownerNest(role, commonFunction, suffix, { withDocument = false } = {}) {
    await role.initialize();
    const api = role.nestArchiveApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Archive suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    cleanups.push(() => api.settleNotificationsFor(nest.id));
    const document = withDocument
      ? await api.createDocument(nest.id, { title: DOC_TITLE, content: `# ${DOC_TITLE}\n\n${DOC_BODY}\n` })
      : null;
    return { api, nest, document, page: role.nestArchivePage, nestsPage: role.nestsPage };
  }

  /**
   * Share the nest with secondary_user as an editor, so they can ask for an
   * archive. Skips when the server has no editor seats: a nest admin archives
   * instead of asking, which is a different flow.
   */
  async function shareWithEditor(owner, secondary) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const granted = await owner.api.shareForAuthoring(owner.nest.id, secondaryRole.email);
    test.skip(granted !== 'write', 'No editor seats on this server — secondary_user would be a nest admin.');
    await secondary.initialize();
    const editorApi = secondary.nestArchiveApi;
    await editorApi.settleInvitesFor(owner.nest.id);
    cleanups.push(() => editorApi.settleNotificationsFor(owner.nest.id));
    return { editorApi, editorPage: secondary.nestArchivePage, editorNests: secondary.nestsPage };
  }

  /** Open a published link in a fresh, signed-out browser context. */
  async function openAsVisitor(browser) {
    const context = await browser.newContext();
    cleanups.push(() => context.close());
    return context.newPage();
  }

  test('CN-ARCH-001: Verify that "Archive instead" on the nest page archives the nest without typing the nest name', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'arch-instead');

    await page.goto(nest.id);
    await page.chooseMenu('Delete');
    await expect(page.deleteDialog).toBeVisible();
    // The name is not typed: Delete stays locked, Archive instead does not.
    await expect(page.deleteConfirmInput).toHaveValue('');
    await expect(page.deleteSubmit).toBeDisabled();
    await expect(page.archiveInstead).toBeEnabled();

    await page.archiveInstead.click();
    await expect(page.deleteDialog).toBeHidden(WRITE);
    await expect(page.toasts.filter({ hasText: `"${nest.name}" archived` })).toBeVisible(WRITE);
    // Back on the dashboard, with the nest archived — not deleted.
    await expect.poll(() => new URL(page.page.url()).pathname, WRITE).toBe('/');
    await expect.poll(() => api.isArchived(nest.id), WRITE).toBe(true);
    expect(await api.isLive(nest.id), 'the nest left the live list').toBe(false);
  });

  test('CN-ARCH-002: Verify that an archived nest opens with Connect, Add with AI, Share, New Folder, Import and New Document hidden', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page, nestsPage } = await ownerNest(primary_user, commonFunction, 'arch-readonly', {
      withDocument: true,
    });
    await api.archiveNest(nest.id);

    // Opened the way a user reaches it: Nests → Archived → the nest's row.
    await nestsPage.goto();
    await nestsPage.toggleArchived(true);
    const row = nestsPage.archivedRow(nest.name);
    await expect(row).toBeVisible(WRITE);
    await row.getByText(nest.name, { exact: true }).click();
    await expect(page.page).toHaveURL(new RegExp(`/nest/${nest.id}`));
    await expect(page.backToNests).toBeVisible();
    await expect(page.text(DOC_TITLE).first()).toBeVisible();

    for (const action of [
      page.connectButton,
      page.addWithAiButton,
      page.shareButton,
      page.newFolderButton,
      page.importButton,
      page.newDocumentButton,
    ]) {
      await expect(action).toHaveCount(0);
    }
    // The governance tabs are withheld too, and the nest menu keeps no write
    // action (at most the read-only Activity log).
    await expect(page.tab('Overview')).toBeVisible();
    for (const tab of ['Review Queue', 'External Edits', 'Collaborators']) {
      await expect(page.tab(tab)).toHaveCount(0);
    }
    const menu = await page.menuItems();
    for (const entry of ['Delete', 'Nest settings', 'Structure rules', 'Activity trace']) {
      expect(menu, `the archived nest's menu offers no "${entry}"`).not.toContain(entry);
    }
  });

  test('CN-ARCH-003: Verify that a document in an archived nest opens read-only', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, document, page } = await ownerNest(primary_user, commonFunction, 'arch-doc', {
      withDocument: true,
    });
    await api.archiveNest(nest.id);
    const typed = 'QA-TYPED-INTO-ARCHIVED';

    await page.gotoDocument(nest.id, document.id);
    const body = page.text(DOC_BODY);
    await expect(body).toBeVisible(WRITE);
    await expect(page.editableContent).toHaveCount(0);

    // Clicking into the text and typing changes nothing.
    await body.click();
    await page.page.keyboard.type(typed);
    await expect(page.editableContent).toHaveCount(0);
    await expect(page.main.getByText(typed)).toHaveCount(0);
    const stored = await api.getNode(nest.id, document.id);
    expect(JSON.stringify(stored.data?.node ?? {}), 'the stored document is unchanged').not.toContain(typed);
  });

  test('CN-ARCH-004: Verify that a collaborator no longer sees an archived nest on their dashboard', async ({
    primary_user,
    secondary_user,
    commonFunction,
  }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'arch-collab');
    await owner.api.addCollaborator(owner.nest.id, secondaryRole.email, 'read');
    await secondary_user.initialize();
    const collabApi = secondary_user.nestArchiveApi;
    await collabApi.settleInvitesFor(owner.nest.id);
    cleanups.push(() => collabApi.settleNotificationsFor(owner.nest.id));
    const nests = secondary_user.nestsPage;

    // Before: the shared nest is on the collaborator's dashboard.
    await expect(async () => {
      await nests.goto();
      await nests.filterByName(owner.nest.name);
      await expect(nests.nestCard(owner.nest.name)).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 60_000, intervals: [1_000, 3_000, 5_000] });

    await owner.api.archiveNest(owner.nest.id);

    // After: gone from it.
    await expect(async () => {
      await nests.goto();
      await nests.filterByName(owner.nest.name);
      await expect(nests.noMatchesState).toBeVisible({ timeout: 10_000 });
      await expect(nests.nestCard(owner.nest.name)).toHaveCount(0);
    }).toPass({ timeout: 60_000, intervals: [1_000, 3_000, 5_000] });
  });

  test("CN-ARCH-005: Verify that a nest's published link stops working once the nest is archived", async ({
    primary_user,
    commonFunction,
    browser,
  }) => {
    const { api, nest, document } = await ownerNest(primary_user, commonFunction, 'arch-link', {
      withDocument: true,
    });
    const link = await api.publishDocument(nest.id, document.id);
    const visitor = await openAsVisitor(browser);

    const before = await visitor.goto(link);
    expect(before.status()).toBe(200);
    await expect(visitor.getByText(DOC_BODY)).toBeVisible();

    await api.archiveNest(nest.id);

    const after = await visitor.goto(link);
    expect(after.status()).toBe(404);
    await expect(visitor.getByText('This link is no longer available')).toBeVisible();
    await expect(visitor.getByText(DOC_BODY)).toHaveCount(0);
  });

  test('CN-ARCH-006: Verify that restoring the nest brings the published link back at the same URL', async ({
    primary_user,
    commonFunction,
    browser,
  }) => {
    const { api, nest, document, page, nestsPage } = await ownerNest(primary_user, commonFunction, 'arch-restore', {
      withDocument: true,
    });
    const link = await api.publishDocument(nest.id, document.id);
    await api.archiveNest(nest.id);
    const visitor = await openAsVisitor(browser);
    expect((await visitor.goto(link)).status(), 'archived: the link is off').toBe(404);

    // Restore through the dashboard's Archived list.
    await nestsPage.goto();
    await nestsPage.toggleArchived(true);
    await expect(nestsPage.archivedRow(nest.name)).toBeVisible(WRITE);
    await nestsPage.restoreNest(nest.name);
    await expect(nestsPage.toasts.filter({ hasText: `"${nest.name}" restored` })).toBeVisible(WRITE);

    // The same URL answers again.
    const after = await visitor.goto(link);
    expect(after.status()).toBe(200);
    await expect(visitor.getByText(DOC_BODY)).toBeVisible();

    // And the nest is writable again.
    await page.goto(nest.id);
    await expect(page.newDocumentButton.first()).toBeVisible(WRITE);
    await expect(page.connectButton).toBeVisible();
    await expect(page.shareButton).toBeVisible();
  });

  test('CN-ARCH-007: Verify that requesting an archive shows a success message and the "Archive requested" badge', async ({
    primary_user,
    secondary_user,
    commonFunction,
  }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'arch-request');
    const { editorPage } = await shareWithEditor(owner, secondary_user);
    const reason = `QA archive ask ${Date.now()}`;

    await editorPage.goto(owner.nest.id);
    await expect.poll(() => editorPage.menuItems(), WRITE).toContain('Delete');
    await editorPage.chooseMenu('Delete');
    await expect(editorPage.requestDialog).toBeVisible();
    // Both asks stay locked until there is a reason.
    await expect(editorPage.reasonSecondary).toHaveText('Request archive');
    await expect(editorPage.reasonSecondary).toBeDisabled();
    await editorPage.reasonInput.fill(reason);
    await expect(editorPage.reasonSecondary).toBeEnabled();
    await editorPage.reasonSecondary.click();
    await expect(editorPage.requestDialog).toBeHidden(WRITE);

    await expect(editorPage.toasts.filter({ hasText: 'Archive requested' })).toBeVisible(WRITE);
    const badgeShown = await editorPage.flagBadge
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!badgeShown) {
      test.info().annotations.push({
        type: 'known issue',
        description:
          'After "Request archive" the requester\'s "Archive requested" badge (and the menu without Delete) can stay missing until the nest page is reloaded.',
      });
      await editorPage.page.reload();
      await editorPage.backToNests.waitFor({ state: 'visible' });
    }
    await expect(editorPage.flagBadge).toHaveText(/Archive requested/, WRITE);
    // While it is pending, the editor can't raise another one.
    await expect.poll(() => editorPage.menuItems(), { timeout: 30_000 }).not.toContain('Delete');

    // The server holds it as an archive request with that reason.
    const pending = await owner.api.deletionRequests(owner.nest.id);
    expect(pending.some((r) => r.targetType === 'nest_archive' && r.reason === reason)).toBe(true);
    // Nothing is archived yet.
    expect(await owner.api.isLive(owner.nest.id)).toBe(true);
  });

  test('CN-ARCH-008: Verify that the requester can withdraw the archive request by clicking the badge', async ({
    primary_user,
    secondary_user,
    commonFunction,
  }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'arch-withdraw');
    const { editorApi, editorPage } = await shareWithEditor(owner, secondary_user);
    await editorApi.requestNestDeletion(owner.nest.id, 'nest_archive', 'QA withdraw me');

    await editorPage.goto(owner.nest.id);
    await expect(editorPage.flagBadge).toHaveText(/Archive requested/, WRITE);
    await expect(editorPage.flagBadge).toHaveAttribute('title', 'Click to withdraw your archive request');

    await editorPage.flagBadge.click();
    await expect(editorPage.flagBadge).toHaveCount(0, WRITE);
    await expect.poll(async () => (await owner.api.deletionRequests(owner.nest.id)).length, WRITE).toBe(0);

    // The owner no longer sees it either.
    await owner.page.goto(owner.nest.id);
    await expect(owner.page.newDocumentButton.first()).toBeVisible(WRITE);
    await expect(owner.page.flagBadge).toHaveCount(0);
    expect(await owner.api.isLive(owner.nest.id)).toBe(true);
  });

  test('CN-ARCH-009: Verify that rejecting an archive request from the Review Queue removes it and keeps the nest live', async ({
    primary_user,
    secondary_user,
    commonFunction,
  }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'arch-reject');
    const { editorApi } = await shareWithEditor(owner, secondary_user);
    const reason = `QA reject me ${Date.now()}`;
    await editorApi.requestNestDeletion(owner.nest.id, 'nest_archive', reason);

    await owner.page.goto(owner.nest.id);
    await owner.page.openReviewQueue();
    const row = owner.page.requestRow(reason);
    await expect(row).toBeVisible(WRITE);
    await expect(row).toContainText('Archive nest');
    await expect(row).toContainText(secondaryRole.email);

    await owner.page.rejectRequest(reason, 'Not yet — still in use');
    await expect(row).toHaveCount(0, WRITE);

    // The nest stays live, and the request is on record as declined.
    expect(await owner.api.isLive(owner.nest.id)).toBe(true);
    expect(await owner.api.isArchived(owner.nest.id)).toBe(false);
    const declined = await owner.api.deletionRequests(owner.nest.id, 'declined');
    expect(declined.some((r) => r.reason === reason)).toBe(true);
  });

  test('CN-ARCH-010: Verify that approving an archive request from the Review Queue archives the nest', async ({
    primary_user,
    secondary_user,
    commonFunction,
  }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'arch-approve');
    const { editorApi } = await shareWithEditor(owner, secondary_user);
    const reason = `QA approve me ${Date.now()}`;
    await editorApi.requestNestDeletion(owner.nest.id, 'nest_archive', reason);

    await owner.page.goto(owner.nest.id);
    await owner.page.openReviewQueue();
    await expect(owner.page.requestRow(reason)).toBeVisible(WRITE);
    await owner.page.requestRow(reason).getByRole('button', { name: 'Approve', exact: true }).click();

    // Approving is confirmed as an archive, not a deletion.
    const confirm = owner.page.approveDialog(owner.nest.name);
    await expect(confirm).toBeVisible();
    await expect(owner.page.reasonConfirm).toHaveText('Archive nest');
    await owner.page.reasonConfirm.click();
    await expect(confirm).toBeHidden(WRITE);

    await expect.poll(() => owner.api.isArchived(owner.nest.id), WRITE).toBe(true);
    expect(await owner.api.isLive(owner.nest.id), 'the nest left the live list').toBe(false);
  });
});
