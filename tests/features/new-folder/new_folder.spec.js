/**
 * New Folder Test Suite — CN-FOLDER-001 … CN-FOLDER-012
 *
 * Page under test: the "New folder" dialog on the nest page
 * (ui/src/components/NestView.tsx) and where the folder it creates shows up —
 * the Overview's Contents tree (ui/src/components/nest/OverviewTab.tsx) and
 * the Documents tab. The dialog's inline checks come from
 * ui/src/lib/folder-path.ts. What the dialog created is read back through the
 * REST API.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest; secondary_user is the read-only
 *   collaborator in CN-FOLDER-011. Each test creates its own AUTO_ nest with
 *   one document, "Alpha One", in folder "alpha" (`newFolderApi`), and deletes
 *   the nest after the test (`newFolderApi.deleteCreatedNests()`). The nest is
 *   in the entity registry for the teardown and the orphan sweeper.
 * - Every test starts on the nest's Overview tab.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { nestHomeShipped } from '../../src/lib/nest_home_probe.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

/** The toast New folder shows once the folder exists. */
const createdToast = (label) => `Folder "${label}" created`;

/** The document every nest is seeded with, and its folder. */
const SEED_TITLE = 'Alpha One';
const SEED_FOLDER = 'alpha';

/** Inline errors from ui/src/lib/folder-path.ts. */
const NO_ASCII_ERROR = 'Folder paths are built from a-z and 0-9, so the name needs at least one of those.';
const DOT_ERROR = '"." and ".." don\'t name a folder — use a name.';
const DEPTH_ERROR = 'Folders may nest at most 8 levels deep — this path is 9. Remove 1 level.';

test.describe('New folder', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner, create a nest with "Alpha One" in folder "alpha",
   * and open it on the Overview. Skips unless the owner may create nests.
   */
  async function ownerNest(role, commonFunction, suffix) {
    await role.initialize();
    const api = role.newFolderApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    // Every case reads the Overview's Contents tree, which po-1213 retired; port to Documents.
    test.skip(await nestHomeShipped(api, commonFunction), 'Overview is merged into Documents on this server (po-1213).');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'New Folder suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    await api.createDocument(nest.id, {
      title: SEED_TITLE,
      content: `# ${SEED_TITLE}\n\nSeeded.\n`,
      folder: SEED_FOLDER,
    });
    const page = role.newFolderPage;
    await page.gotoNest(nest.id);
    await expect(page.folderRow('Alpha')).toBeVisible(WRITE);
    return { api, nest, page };
  }

  test('CN-FOLDER-001: Verify that New Folder creates a folder and shows it in the Contents tree', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'folder-create');

    await page.openDialog();
    await page.typeName('Team Notes');
    await page.createButton.click();

    await expect(page.dialog).toBeHidden(WRITE);
    await expect(page.toast(createdToast('Team Notes'))).toBeVisible(WRITE);
    await expect(page.folderRow('Team Notes')).toBeVisible(WRITE);
    await expect(page.folderCount('Team Notes')).toHaveAttribute('aria-label', '0 documents');
    expect(await api.folderPaths(nest.id)).toContain('team-notes');
  });

  test('CN-FOLDER-002: Verify that a path with a slash creates nested folders', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'folder-nested');

    await page.createFolder('gtm/deals');
    await expect(page.toast(createdToast('Gtm / Deals'))).toBeVisible(WRITE);
    expect(await api.folderPaths(nest.id)).toEqual(expect.arrayContaining(['gtm', 'gtm/deals']));

    // An empty folder's row opens it in the Documents tab, where its subfolder is listed.
    await expect(page.folderRow('Gtm')).toBeVisible(WRITE);
    await page.folderRow('Gtm').click();
    await expect(page.selectedTab).toHaveText('Documents');
    await expect(page.main.getByText('Deals', { exact: true })).toBeVisible(WRITE);
  });

  test('CN-FOLDER-003: Verify that a subfolder can be created inside an existing folder', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'folder-sub');

    await page.createFolder('alpha/sub');
    await expect(page.toast(createdToast('Alpha / Sub'))).toBeVisible(WRITE);
    expect(await api.folderPaths(nest.id)).toContain('alpha/sub');

    await page.expandFolder('Alpha');
    await expect(page.folderRow('Alpha')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.contents.getByText(SEED_TITLE, { exact: true })).toBeVisible(WRITE);
    await expect(page.folderRow('Sub')).toBeVisible(WRITE);
  });

  test('CN-FOLDER-004: Verify that a new empty folder is still there after a page reload', async ({
    primary_user,
    commonFunction,
  }) => {
    const { page } = await ownerNest(primary_user, commonFunction, 'folder-reload');

    await page.createFolder('Team Notes');
    await expect(page.folderRow('Team Notes')).toBeVisible(WRITE);

    await page.page.reload();
    await page.contents.waitFor({ state: 'visible' });
    await expect(page.folderRow('Team Notes')).toBeVisible(WRITE);
    await expect(page.folderCount('Team Notes')).toHaveAttribute('aria-label', '0 documents');
  });

  test('CN-FOLDER-005: Verify that the dialog previews the rewritten name before creating', async ({
    primary_user,
    commonFunction,
  }) => {
    const { page } = await ownerNest(primary_user, commonFunction, 'folder-preview');

    await page.openDialog();

    await page.typeName('Q3 Plans!');
    await expect(page.namePreview).toHaveText('Will be created as Q3 Plans');
    await expect(page.createButton).toBeEnabled();

    await page.typeName('Café Notes');
    await expect(page.namePreview).toHaveText('Will be created as Cafe Notes');

    // A name stored as typed needs no preview.
    await page.typeName('Team Notes');
    await expect(page.namePreview).toHaveCount(0);
    await expect(page.nameError).toHaveCount(0);
    await expect(page.createButton).toBeEnabled();
  });

  test('CN-FOLDER-006: Verify that a name without any a–z or 0–9 character is blocked', async ({
    primary_user,
    commonFunction,
  }) => {
    const { page } = await ownerNest(primary_user, commonFunction, 'folder-noascii');

    await page.openDialog();
    await page.typeName('!!!');

    await expect(page.nameError).toHaveText(NO_ASCII_ERROR);
    await expect(page.createButton).toBeDisabled();
  });

  test('CN-FOLDER-007: Verify that "." and ".." are blocked as folder names', async ({
    primary_user,
    commonFunction,
  }) => {
    const { page } = await ownerNest(primary_user, commonFunction, 'folder-dots');

    await page.openDialog();

    await page.typeName('..');
    await expect(page.nameError).toHaveText(DOT_ERROR);
    await expect(page.createButton).toBeDisabled();

    await page.typeName('a/../b');
    await expect(page.nameError).toHaveText(DOT_ERROR);
    await expect(page.createButton).toBeDisabled();
  });

  test('CN-FOLDER-008: Verify that a path deeper than 8 levels is blocked', async ({
    primary_user,
    commonFunction,
  }) => {
    const { page } = await ownerNest(primary_user, commonFunction, 'folder-depth');

    await page.openDialog();

    await page.typeName('a/b/c/d/e/f/g/h');
    await expect(page.nameError).toHaveCount(0);
    await expect(page.createButton).toBeEnabled();

    await page.typeName('a/b/c/d/e/f/g/h/i');
    await expect(page.nameError).toHaveText(DEPTH_ERROR);
    await expect(page.createButton).toBeDisabled();
  });

  test("CN-FOLDER-009: Verify that creating a folder with an existing folder's name adds no duplicate and keeps its documents", async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'folder-existing');

    await page.createFolder('Alpha');

    await expect(page.folderRow('Alpha')).toHaveCount(1);
    await expect(page.folderCount('Alpha')).toHaveAttribute('aria-label', '1 document');
    expect((await api.folderPaths(nest.id)).filter((p) => p === SEED_FOLDER)).toHaveLength(1);
    expect(await api.documentTitlesIn(nest.id, SEED_FOLDER)).toEqual([SEED_TITLE]);

    await page.expandFolder('Alpha');
    await expect(page.contents.getByText(SEED_TITLE, { exact: true })).toBeVisible(WRITE);
  });

  test('CN-FOLDER-010: Verify that Cancel and Escape close the dialog without creating a folder', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'folder-cancel');

    await page.openDialog();
    await page.typeName('cancelled one');
    await page.cancelButton.click();
    await expect(page.dialog).toBeHidden();

    await page.openDialog();
    await page.typeName('escaped one');
    await page.page.keyboard.press('Escape');
    await expect(page.dialog).toBeHidden();

    await expect(page.folderRow('Cancelled One')).toHaveCount(0);
    await expect(page.folderRow('Escaped One')).toHaveCount(0);
    expect(await api.folderPaths(nest.id)).toEqual([SEED_FOLDER]);
  });

  test("CN-FOLDER-011: Verify that a read-only collaborator doesn't see New Folder", async ({
    primary_user,
    secondary_user,
    commonFunction,
  }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'folder-reader');
    await expect(owner.page.newFolderButton).toBeVisible();

    await owner.api.addCollaborator(owner.nest.id, secondaryRole.email, 'read');
    await secondary_user.initialize();
    const readerApi = secondary_user.newFolderApi;
    await readerApi.settleInvitesFor(owner.nest.id);
    cleanups.push(() => readerApi.settleNotificationsFor(owner.nest.id));

    const reader = secondary_user.newFolderPage;
    await reader.gotoNest(owner.nest.id);
    await expect(reader.folderRow('Alpha')).toBeVisible(WRITE);
    await expect(reader.newFolderButton).toHaveCount(0);
  });

  test("CN-FOLDER-012: Verify that an archived nest doesn't show New Folder", async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'folder-archived');
    await expect(page.newFolderButton).toBeVisible();

    await api.archiveNest(nest.id);

    await page.gotoNest(nest.id);
    await expect(page.folderRow('Alpha')).toBeVisible(WRITE);
    await expect(page.newFolderButton).toHaveCount(0);
  });
});
