/**
 * Nest Overview Test Suite — CN-OVR-001 … CN-OVR-021
 *
 * Page under test: the nest's Overview tab (ui/src/components/nest/OverviewTab.tsx,
 * rules in ui/src/lib/nest-overview.ts) — the description, the facts line, the
 * Contents tree with its folder row actions, the Recently edited card and the
 * empty-nest options. Where an Overview action leads (the Documents tab, the
 * editor, a dialog) is only checked as far as it opening.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest; secondary_user is the read-only collaborator
 *   in CN-OVR-020. Each test creates its own AUTO_ nest (`nestOverviewApi`) and
 *   deletes it after the test (`nestOverviewApi.deleteCreatedNests()`). The nest
 *   is in the entity registry for the teardown and the orphan sweeper.
 * - Most tests use the standard layout: "Root Doc A" and "Root Doc B" at the
 *   top level, "Guide 1" … "Guide 3" in guides, "Advanced Guide" in
 *   guides/advanced, and an empty notes folder (6 documents, 3 folders).
 * - The tree shows folders by their display name ("Guides", not "guides").
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

/** The description every nest gets unless a test says otherwise. */
const DESCRIPTION = 'Nest Overview suite (safe to delete)';

/** The standard layout: 6 documents in 3 folders. */
const STANDARD = {
  folders: ['notes'],
  docs: [
    { title: 'Root Doc A' },
    { title: 'Root Doc B' },
    { title: 'Guide 1', folder: 'guides' },
    { title: 'Guide 2', folder: 'guides' },
    { title: 'Guide 3', folder: 'guides' },
    { title: 'Advanced Guide', folder: 'guides/advanced' },
  ],
};

/** "Guide 1" … "Guide n" in `folder` (none means the top level). */
const numbered = (prefix, n, folder) =>
  Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i + 1}`, ...(folder ? { folder } : {}) }));

test.describe('Nest overview', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner and create a nest with `folders` and `docs` (in that
   * order). Skips unless the owner may create nests. Doesn't open the nest.
   */
  async function ownerNest(role, commonFunction, suffix, { description = DESCRIPTION, folders = [], docs = [] } = {}) {
    await role.initialize();
    const api = role.nestOverviewApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), description);
    cleanups.push(() => api.deleteCreatedNests());
    for (const folder of folders) await api.createFolder(nest.id, folder);
    const created = {};
    for (const doc of docs) created[doc.title] = await api.createTypedDocument(nest.id, doc);
    return { api, nest, docs: created, page: role.nestOverviewPage };
  }

  test('CN-OVR-001: Verify that opening a nest lands on the Overview tab with the nest description shown', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-landing', STANDARD);

    await page.gotoNest(nest.id);
    await expect(page.selectedTab).toHaveText('Overview');
    await expect(page.overview.getByText(DESCRIPTION, { exact: true })).toBeVisible();
    await expect(page.contents).toBeVisible();
  });

  test('CN-OVR-002: Verify that the facts line shows the correct document, folder and “edited this week” counts', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-facts', STANDARD);

    await page.gotoNest(nest.id);
    await expect.poll(() => page.factTexts(), WRITE).toEqual(['6 documents', '3 folders', '6 edited this week']);
  });

  test('CN-OVR-003: Verify that a nest without folders or a description shows only the document and edited counts', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-facts-plain', {
      description: '',
      docs: [{ title: 'Plain One' }, { title: 'Plain Two' }],
    });

    await page.gotoNest(nest.id);
    await expect.poll(() => page.factTexts(), WRITE).toEqual(['2 documents', '2 edited this week']);
    // The header holds only the facts line — no description above it.
    await expect(page.overview.locator('header p')).toHaveCount(1);
  });

  test('CN-OVR-004: Verify that a governed nest shows “AI ready” and “pending review” facts, and “pending review” opens the Review Queue', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-governed');
    await api.requireReview(nest.id);
    const pending = await api.createTypedDocument(nest.id, { title: 'Pending One' });
    await api.submitForReview(nest.id, pending.id);

    await page.gotoNest(nest.id);
    await expect.poll(() => page.factTexts(), WRITE).toEqual(['1 document', '1 edited this week', '0 AI ready', '1 pending review']);
    // "0 AI ready" carries no green dot — a zero mustn't look healthy.
    await expect(page.facts.locator('.bg-emerald-500')).toHaveCount(0);

    await page.factLink('1 pending review').click();
    await expect(page.selectedTab).toHaveText('Review Queue');
  });

  test('CN-OVR-005: Verify that folders in Contents start collapsed and expand and collapse on click', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-expand', STANDARD);

    await page.gotoNest(nest.id);
    const guides = page.folderRow('Guides');
    await expect(guides).toHaveAttribute('aria-expanded', 'false');
    await expect(guides).toHaveAttribute('title', 'Show Guides');
    await expect(page.docRow('Guide 1')).toHaveCount(0);

    await guides.click();
    await expect(guides).toHaveAttribute('aria-expanded', 'true');
    await expect(guides).toHaveAttribute('title', 'Hide Guides');
    await expect(page.docRow('Guide 1')).toBeVisible(WRITE);

    await guides.click();
    await expect(guides).toHaveAttribute('aria-expanded', 'false');
    await expect(page.docRow('Guide 1')).toHaveCount(0);
  });

  test('CN-OVR-006: Verify that a folder’s count includes the documents in its subfolders', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-count', STANDARD);

    await page.gotoNest(nest.id);
    // 3 in guides plus 1 in guides/advanced.
    await expect(page.folderCount('Guides')).toHaveAttribute('aria-label', '4 documents');
    await expect(page.folderCount('Notes')).toHaveAttribute('aria-label', '0 documents');
  });

  test('CN-OVR-007: Verify that a subfolder appears inside its parent folder and expands on its own', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-subfolder', STANDARD);

    await page.gotoNest(nest.id);
    await expect(page.folderRow('Advanced')).toHaveCount(0);

    await page.expandFolder('Guides');
    const advanced = page.folderRow('Advanced');
    await expect(advanced).toBeVisible(WRITE);
    await expect(advanced).toHaveAttribute('aria-expanded', 'false');
    await expect(page.docRow('Advanced Guide')).toHaveCount(0);

    await advanced.click();
    await expect(advanced).toHaveAttribute('aria-expanded', 'true');
    await expect(page.docRow('Advanced Guide')).toBeVisible(WRITE);
    await expect(page.folderRow('Guides')).toHaveAttribute('aria-expanded', 'true');
  });

  test('CN-OVR-008: Verify that a folder with more than 5 documents shows the first 5 and “View all N”, which opens the folder in Documents', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-view-all', {
      docs: [{ title: 'Top Doc' }, ...numbered('Guide', 7, 'guides')],
    });

    await page.gotoNest(nest.id);
    await page.expandFolder('Guides');
    for (let i = 1; i <= 5; i++) await expect(page.docRow(`Guide ${i}`)).toBeVisible(WRITE);
    await expect(page.docRow('Guide 6')).toHaveCount(0);
    await expect(page.docRow('Guide 7')).toHaveCount(0);
    await expect(page.viewAllRow()).toHaveText('View all 7');
    await expect(page.viewAllRow()).toHaveAttribute('title', '2 more — open Guides in Documents');

    await page.viewAllRow().click();
    await expect(page.selectedTab).toHaveText('Documents');
    await expect(page.allDocumentsCrumb.locator('xpath=..')).toContainText('Guides');
    await expect(page.documentRows).toHaveCount(7, WRITE);
    await expect(page.main.getByTestId('document-row-nodes/top-doc')).toHaveCount(0);
  });

  test('CN-OVR-009: Verify that more than 5 top-level documents show the first 5 and “View all N”, which opens all documents in Documents', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-view-all-top', {
      docs: numbered('Top', 7),
    });

    await page.gotoNest(nest.id);
    for (let i = 1; i <= 5; i++) await expect(page.docRow(`Top ${i}`)).toBeVisible(WRITE);
    await expect(page.docRow('Top 6')).toHaveCount(0);
    await expect(page.docRow('Top 7')).toHaveCount(0);
    await expect(page.viewAllRow()).toHaveText('View all 7');

    await page.viewAllRow().click();
    await expect(page.selectedTab).toHaveText('Documents');
    await expect(page.documentRows).toHaveCount(7, WRITE);
    // The whole nest, not a folder: no folder breadcrumb.
    await expect(page.allDocumentsCrumb).toHaveCount(0);
  });

  test('CN-OVR-010: Verify that an empty folder has no expand arrow and opens in Documents when clicked', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-empty-folder', {
      folders: ['notes'],
      docs: [{ title: 'Top Doc' }],
    });

    await page.gotoNest(nest.id);
    const notes = page.folderRow('Notes');
    await expect(notes).toHaveAttribute('title', 'Browse Notes in Documents');
    expect(await notes.getAttribute('aria-expanded')).toBeNull();

    await notes.click();
    await expect(page.selectedTab).toHaveText('Documents');
    await expect(page.allDocumentsCrumb.locator('xpath=..')).toContainText('Notes', WRITE);
    await expect(page.documentRows).toHaveCount(0);
  });

  test('CN-OVR-011: Verify that clicking a document in Contents opens it', async ({ primary_user, commonFunction }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-open-doc', STANDARD);

    await page.gotoNest(nest.id);
    await page.docRow('Root Doc A').click();
    await expect(page.page).toHaveURL(/[?&]doc=nodes%2Froot-doc-a/);
    await expect(page.editorTitle).toHaveValue('Root Doc A', WRITE);
  });

  test('CN-OVR-012: Verify that HTML, Agent and Skill items show their type label, and documents and tasks show none', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-types', {
      docs: [
        { title: 'Html Page', type: 'artifact', folder: 'tools' },
        { title: 'Helper Agent', type: 'agent', folder: 'tools' },
        { title: 'Writer Skill', type: 'skill', folder: 'tools' },
        { title: 'Some Task', type: 'task', folder: 'tools' },
        { title: 'Plain Doc', folder: 'tools' },
      ],
    });

    await page.gotoNest(nest.id);
    await page.expandFolder('Tools');
    await expect(page.typeLabel('Html Page')).toHaveText(/^html$/i, WRITE);
    await expect(page.typeLabel('Helper Agent')).toHaveText(/^agent$/i);
    await expect(page.typeLabel('Writer Skill')).toHaveText(/^skill$/i);
    await expect(page.docRow('Some Task')).toBeVisible();
    await expect(page.typeLabel('Some Task')).toHaveCount(0);
    await expect(page.typeLabel('Plain Doc')).toHaveCount(0);
  });

  test('CN-OVR-013: Verify that “Open <folder> in Documents” opens the Documents tab filtered to that folder', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-open-folder', STANDARD);

    await page.gotoNest(nest.id);
    await page.clickFolderAction('Guides', 'Open Guides in Documents');

    await expect(page.selectedTab).toHaveText('Documents');
    await expect(page.allDocumentsCrumb.locator('xpath=..')).toContainText('Guides');
    // The three documents directly in guides; the top-level ones are left out.
    await expect(page.documentRows).toHaveCount(3, WRITE);
    for (let i = 1; i <= 3; i++) {
      await expect(page.main.getByTestId(`document-row-nodes/guides/guide-${i}`)).toBeVisible();
    }
    await expect(page.main.getByTestId('document-row-nodes/root-doc-a')).toHaveCount(0);
  });

  test('CN-OVR-014: Verify that deleting an empty folder from Contents removes it', async ({ primary_user, commonFunction }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-delete-empty', {
      folders: ['notes'],
      docs: [{ title: 'Keep Doc' }],
    });

    await page.gotoNest(nest.id);
    await page.clickFolderAction('Notes', 'Delete Notes');
    const dialog = page.deleteDialog('Notes');
    await expect(dialog).toContainText('This folder is empty — deleting it just removes it from the tree.');

    await page.dialogConfirm.click();
    await expect(page.toast('Deleted Notes')).toBeVisible(WRITE);
    await expect(page.folderRow('Notes')).toHaveCount(0, WRITE);
    expect(await api.folderPaths(nest.id)).not.toContain('notes');
    expect((await api.listDocuments(nest.id)).map((d) => d.title)).toEqual(['Keep Doc']);
  });

  test('CN-OVR-015: Verify that deleting a non-empty folder warns how many documents will be deleted, and Cancel keeps everything', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-delete-cancel', STANDARD);

    await page.gotoNest(nest.id);
    await page.clickFolderAction('Guides', 'Delete Guides');
    const dialog = page.deleteDialog('Guides');
    await expect(dialog).toContainText('This deletes all 4 documents in this folder and its subfolders');
    await expect(dialog).toContainText('It cannot be undone.');

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.folderRow('Guides')).toBeVisible();
    await expect(page.folderCount('Guides')).toHaveAttribute('aria-label', '4 documents');
    expect(await api.listDocuments(nest.id)).toHaveLength(6);
  });

  test('CN-OVR-016: Verify that Recently edited shows the 3 latest edited documents, newest first, and opens one when clicked', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-recent');
    // Edit times are stored to the second, so space the writes out.
    const first = await api.createTypedDocument(nest.id, { title: 'First', folder: 'old' });
    for (const title of ['Second', 'Third', 'Fourth']) {
      await page.page.waitForTimeout(1_100);
      await api.createTypedDocument(nest.id, { title });
    }
    await page.page.waitForTimeout(1_100);
    await api.updateDocument(nest.id, first.id, { content: '# First\n\nEdited by the Nest Overview suite.\n' });

    await page.gotoNest(nest.id);
    await expect.poll(() => page.recentTitles(), WRITE).toEqual(['First', 'Fourth', 'Third']);
    await expect(page.recentItems().first()).toContainText('Old');

    await page.recentItems().first().click();
    await expect(page.page).toHaveURL(/[?&]doc=nodes%2Fold%2Ffirst/);
  });

  test('CN-OVR-017: Verify that an empty nest shows “Add the first page” with New document, Import files and Add with AI', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-empty-nest');

    await page.gotoNest(nest.id);
    await expect(page.emptyDescription).toHaveText(DESCRIPTION);
    await expect(page.emptyHeading).toBeVisible();
    for (const option of ['New document', 'Import files', 'Add with AI']) {
      await expect(page.emptyAction(option)).toBeVisible();
    }
    await expect(page.dropHint).toBeVisible();
    await expect(page.contents).toHaveCount(0);
    await expect(page.recent).toHaveCount(0);
  });

  test('CN-OVR-018: Verify that each empty-nest option opens its flow: the editor, the Import dialog and the Add with AI dialog', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-empty-options');

    await page.gotoNest(nest.id);
    await page.emptyAction('New document').click();
    await expect(page.editorTitle).toBeVisible(WRITE);

    await page.gotoNest(nest.id);
    await page.emptyAction('Import files').click();
    await expect(page.importDialog).toBeVisible();
    await page.page.keyboard.press('Escape');
    await expect(page.importDialog).toBeHidden();

    await page.emptyAction('Add with AI').click();
    await expect(page.addWithAiDialog).toBeVisible();
    await expect(page.addWithAiDialog).toContainText(nest.name);
  });

  test('CN-OVR-019: Verify that a nest with only an empty folder shows the Contents tree, not the empty-nest options', async ({
    primary_user,
    commonFunction,
  }) => {
    const { nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-folder-only', { folders: ['notes'] });

    await page.gotoNest(nest.id);
    await expect(page.folderRow('Notes')).toBeVisible(WRITE);
    await expect(page.emptyHeading).toHaveCount(0);
    await expect.poll(() => page.factTexts(), WRITE).toEqual(['0 documents', '1 folder']);
  });

  test('CN-OVR-020: Verify that a read-only collaborator sees Contents with only “Open in Documents” and no New document or Delete actions', async ({
    primary_user,
    secondary_user,
    commonFunction,
  }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'ovr-reader', STANDARD);
    await owner.page.gotoNest(owner.nest.id);
    await expect(owner.page.folderAction('Delete Guides')).toHaveCount(1);

    await owner.api.addCollaborator(owner.nest.id, secondaryRole.email, 'read');
    await secondary_user.initialize();
    const readerApi = secondary_user.nestOverviewApi;
    await readerApi.settleInvitesFor(owner.nest.id);
    cleanups.push(() => readerApi.settleNotificationsFor(owner.nest.id));

    const reader = secondary_user.nestOverviewPage;
    await reader.gotoNest(owner.nest.id);
    await expect(reader.folderRow('Guides')).toBeVisible(WRITE);
    await expect.poll(() => reader.factTexts(), WRITE).toEqual(['6 documents', '3 folders', '6 edited this week']);
    for (const folder of ['Guides', 'Notes']) {
      await expect(reader.folderAction(`Open ${folder} in Documents`)).toHaveCount(1);
      await expect(reader.folderAction(`New document in ${folder}`)).toHaveCount(0);
      await expect(reader.folderAction(`Delete ${folder}`)).toHaveCount(0);
    }
  });

  test('CN-OVR-021: Verify that an archived nest’s Overview shows Contents with only “Open in Documents” and no New document or Delete actions', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'ovr-archived', STANDARD);
    await page.gotoNest(nest.id);
    await expect(page.folderAction('New document in Guides')).toHaveCount(1);

    await api.archiveNest(nest.id);

    await page.gotoNest(nest.id);
    await expect(page.folderRow('Guides')).toBeVisible(WRITE);
    await expect.poll(() => page.factTexts(), WRITE).toEqual(['6 documents', '3 folders', '6 edited this week']);
    for (const folder of ['Guides', 'Notes']) {
      await expect(page.folderAction(`Open ${folder} in Documents`)).toHaveCount(1);
      await expect(page.folderAction(`New document in ${folder}`)).toHaveCount(0);
      await expect(page.folderAction(`Delete ${folder}`)).toHaveCount(0);
    }
  });
});
