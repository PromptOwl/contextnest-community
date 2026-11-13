/**
 * Nest Import Test Suite — CN-NIMP-001 … CN-NIMP-014
 *
 * Page under test: the nest page's Import button and its "Import into this
 * nest" dialog (ui/src/components/NestView.tsx) — Files, Upload PDF and
 * Whole vault, each through the browser's file chooser. Every chosen file
 * becomes its own document in the nest (Markdown frontmatter supplies the
 * title and tags: ui/src/lib/import-frontmatter.ts). What the import created
 * is read back through the REST API. The dashboard's Import Folder, which
 * makes a new nest, is the Import Folder suite.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest; secondary_user is the read-only
 *   collaborator in CN-NIMP-011 and the editor in CN-NIMP-014. Each test
 *   creates its own empty AUTO_ nest
 *   (`nestImportApi`), arranges anything else through the API, and deletes
 *   the nest after the test (`nestImportApi.deleteCreatedNests()`). The nest
 *   is in the entity registry for the teardown and the orphan sweeper.
 * - Files are built at run time (src/lib/nest_import_fixtures.js): single
 *   files in memory, the vault folder in the test's output folder.
 * - Stewardship is off, so an import publishes — except in CN-NIMP-012,
 *   which turns it on.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { nestHomeShipped } from '../../src/lib/nest_home_probe.js';
import {
  markdownFile,
  htmlFile,
  textFile,
  pngFile,
  pdfFile,
  docxFile,
  buildVault,
} from '../../src/lib/nest_import_fixtures.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

/** The toast an import shows once its documents exist. */
const addedToast = (n) => `Added ${n} ${n === 1 ? 'item' : 'items'}`;

const UNSUPPORTED_TOAST = 'Drop .md, .html, .pdf, .pptx, .docx or .xlsx files to add them to this vault.';

const MEETING_NOTES = '# Meeting notes\n\nAgenda for Monday.\n';

test.describe('Nest import', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner, create an empty nest and open it. Skips unless the
   * owner may create nests.
   */
  async function ownerNest(role, commonFunction, suffix) {
    await role.initialize();
    const api = role.nestImportApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Nest Import suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    const page = role.nestImportPage;
    await page.gotoNest(nest.id);
    await expect(page.importButton).toBeVisible();
    return { api, nest, page };
  }

  /** The document the page has open (`?doc=`), or null on the nest itself. */
  const openDocument = (page) => new URL(page.page.url()).searchParams.get('doc');

  test('CN-NIMP-001: Verify that Import opens the "Import into this nest" dialog with Files, Upload PDF and Whole vault', async ({
    primary_user,
    commonFunction,
  }) => {
    const { page } = await ownerNest(primary_user, commonFunction, 'nimp-dialog');

    await page.openImport();

    await expect(page.dialog).toContainText('Pick what to bring in.');
    await expect(page.filesOption).toContainText('.md, .html, .pdf, .pptx, .docx or .xlsx — one or many');
    await expect(page.uploadPdfOption).toContainText('Becomes a PDF document with its text extracted');
    await expect(page.wholeVaultOption).toContainText('A folder, keeping its structure');
  });

  test('CN-NIMP-002: Verify that Import → Files with one .md file adds the document and opens it', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-one');

    await page.importFiles([markdownFile('meeting-notes.md', MEETING_NOTES)]);

    await expect(page.toast(addedToast(1))).toBeVisible(WRITE);
    await expect.poll(() => openDocument(page), WRITE).toBe('nodes/meeting-notes');
    await expect(page.titleInput).toHaveValue('meeting-notes', WRITE);
    await expect(page.main.getByText('Agenda for Monday.')).toBeVisible(WRITE);

    const doc = await api.findDocument(nest.id, 'nodes/meeting-notes');
    expect(doc?.type).toBe('document');
    expect(doc?.status).toBe('published');
  });

  test('CN-NIMP-003: Verify that Import → Files with several files adds them all', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-several');

    await page.importFiles([
      markdownFile('alpha.md', '# Alpha\n\nAlpha body.\n'),
      htmlFile('beta.html', '<!doctype html><html><body><h1>Beta</h1></body></html>'),
      textFile('gamma.txt', 'Gamma plain text.'),
    ]);

    await expect(page.toast(addedToast(3))).toBeVisible(WRITE);
    // Several documents leave you on the nest.
    expect(openDocument(page)).toBeNull();

    const docs = await api.listDocuments(nest.id);
    const typeOf = (id) => docs.find((d) => d.id === id)?.type;
    expect(docs.map((d) => d.id).sort()).toEqual(['nodes/alpha', 'nodes/beta', 'nodes/gamma']);
    expect(typeOf('nodes/alpha')).toBe('document');
    expect(typeOf('nodes/beta')).toBe('artifact');
    expect(typeOf('nodes/gamma')).toBe('document');
  });

  test('CN-NIMP-004: Verify that importing a file named like an existing document is refused and the existing one is unchanged', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-duplicate');
    await api.createDocument(nest.id, { title: 'meeting-notes', content: MEETING_NOTES });

    await page.importFiles([markdownFile('meeting-notes.md', '# Meeting notes\n\nREPLACED CONTENT.\n')]);

    await expect(
      page.toast(
        'meeting-notes.md: A document already exists at nodes/meeting-notes. Update it, or create this one under a different folder or title.'
      )
    ).toBeVisible(WRITE);
    expect(await api.documentIds(nest.id)).toEqual(['nodes/meeting-notes']);
    const doc = await api.findDocument(nest.id, 'nodes/meeting-notes');
    expect(doc?.content).toContain('Agenda for Monday.');
    expect(doc?.content).not.toContain('REPLACED CONTENT');
  });

  test('CN-NIMP-005: Verify that Import → Whole vault keeps the folder structure and skips hidden folders', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-vault');
    // Needs the Overview's Contents tree, which po-1213 retired; port to Documents.
    test.skip(await nestHomeShipped(api, commonFunction), 'Overview is merged into Documents on this server (po-1213).');
    const vault = buildVault(test.info().outputDir);

    await page.importVault(vault);

    await expect(page.toast(addedToast(2))).toBeVisible(WRITE);
    expect(await api.documentIds(nest.id)).toEqual(['nodes/guides/setup', 'nodes/team-notes/kickoff']);
    await expect(page.folderRow('Guides')).toBeVisible(WRITE);
    await expect(page.folderRow('Team Notes')).toBeVisible(WRITE);
  });

  test('CN-NIMP-006: Verify that Import → Upload PDF adds a PDF document with its text extracted', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-pdf');

    await page.uploadPdf([pdfFile('hello-report.pdf', 'Hello PDF text')]);

    await expect(page.toast(addedToast(1))).toBeVisible(WRITE);
    await expect.poll(() => openDocument(page), WRITE).toBe('nodes/hello-report');
    await expect(page.main.getByText('Hello PDF text')).toBeVisible(WRITE);

    const doc = await api.findDocument(nest.id, 'nodes/hello-report');
    expect(doc?.type).toBe('pdf');
    expect(doc?.content).toContain('Hello PDF text');
  });

  test('CN-NIMP-007: Verify that importing only unsupported files is refused with a message', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-unsupported');

    await page.importFiles([pngFile('photo.png')]);

    await expect(page.toast(UNSUPPORTED_TOAST)).toBeVisible(WRITE);
    expect(openDocument(page)).toBeNull();
    expect(await api.documentIds(nest.id)).toEqual([]);
  });

  test('CN-NIMP-008: Verify that unsupported files in a mixed selection are skipped and the rest are imported', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-mixed');

    await page.importFiles([markdownFile('notes-two.md', '# Notes two\n\nSecond notes.\n'), pngFile('photo.png')]);

    await expect(page.toast(`${addedToast(1)} (skipped 1 unsupported)`)).toBeVisible(WRITE);
    await expect.poll(() => openDocument(page), WRITE).toBe('nodes/notes-two');
    expect(await api.documentIds(nest.id)).toEqual(['nodes/notes-two']);
  });

  test("CN-NIMP-009: Verify that a .md file with a YAML header imports with that header's title and tags", async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-frontmatter');

    await page.importFiles([
      markdownFile('fm-doc.md', '---\ntitle: Quarterly Plan\ntags: [finance, planning]\n---\n\n# Plan\n\nPlan body text.\n'),
    ]);

    await expect(page.toast(addedToast(1))).toBeVisible(WRITE);
    await expect.poll(() => openDocument(page), WRITE).toBe('nodes/quarterly-plan');
    await expect(page.titleInput).toHaveValue('Quarterly Plan', WRITE);

    const doc = await api.findDocument(nest.id, 'nodes/quarterly-plan');
    expect(doc?.title).toBe('Quarterly Plan');
    expect([...(doc?.tags ?? [])].sort()).toEqual(['#finance', '#planning']);
    expect(doc?.content).toContain('Plan body text.');
    expect(doc?.content).not.toContain('title: Quarterly Plan');
  });

  test('CN-NIMP-010: Verify that importing a Word file adds a document with its text and a link to the original', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-word');

    await page.importFiles([await docxFile('team-report.docx', 'Docx body sentence.')]);

    await expect(page.toast(addedToast(1))).toBeVisible(WRITE);
    await expect.poll(() => openDocument(page), WRITE).toBe('nodes/team-report');
    await expect(page.main.getByText('Imported from team-report.docx', { exact: false })).toBeVisible(WRITE);
    await expect(page.main.getByRole('link', { name: 'Download the original' })).toBeVisible();
    await expect(page.main.getByText('Docx body sentence.')).toBeVisible();

    const doc = await api.findDocument(nest.id, 'nodes/team-report');
    expect(doc?.type).toBe('document');
  });

  test("CN-NIMP-011: Verify that a read-only collaborator doesn't see Import", async ({
    primary_user,
    secondary_user,
    commonFunction,
  }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'nimp-reader');
    await owner.api.createDocument(owner.nest.id, { title: 'Reader Doc', content: '# Reader Doc\n\nShared.\n' });

    await owner.api.addCollaborator(owner.nest.id, secondaryRole.email, 'read');
    await secondary_user.initialize();
    const readerApi = secondary_user.nestImportApi;
    await readerApi.settleInvitesFor(owner.nest.id);
    cleanups.push(() => readerApi.settleNotificationsFor(owner.nest.id));

    const reader = secondary_user.nestImportPage;
    await reader.gotoNest(owner.nest.id);
    await expect(reader.main.getByText('Reader Doc').first()).toBeVisible(WRITE);
    await expect(reader.importButton).toHaveCount(0);
  });

  test('CN-NIMP-012: Verify that importing into a nest with stewardship on saves the document as a draft', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-governed');
    // Stewardship on, and the owner may not approve their own work.
    await api.requireReview(nest.id);
    await page.gotoNest(nest.id);

    await page.importFiles([markdownFile('gov-note.md', '# Gov note\n\nGoverned body.\n')]);

    await expect(page.toast(addedToast(1))).toBeVisible(WRITE);
    await expect.poll(() => openDocument(page), WRITE).toBe('nodes/gov-note');
    await expect(page.main.getByRole('button', { name: 'Submit for review', exact: true })).toBeVisible(WRITE);

    const doc = await api.findDocument(nest.id, 'nodes/gov-note');
    expect(doc?.status).toBe('draft');
  });

  test('CN-NIMP-013: Verify that a multi-file import adds the valid files and shows an error only for the file that already exists', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page } = await ownerNest(primary_user, commonFunction, 'nimp-partial');
    await api.createDocument(nest.id, { title: 'meeting-notes', content: MEETING_NOTES });

    await page.importFiles([
      markdownFile('alpha.md', '# Alpha\n\nAlpha body.\n'),
      markdownFile('meeting-notes.md', '# Meeting notes\n\nREPLACED CONTENT.\n'),
      markdownFile('beta.md', '# Beta\n\nBeta body.\n'),
    ]);

    await expect(
      page.toast(
        'meeting-notes.md: A document already exists at nodes/meeting-notes. Update it, or create this one under a different folder or title.'
      )
    ).toBeVisible(WRITE);
    await expect(page.toast(addedToast(2))).toBeVisible(WRITE);
    expect(openDocument(page)).toBeNull();

    expect(await api.documentIds(nest.id)).toEqual(['nodes/alpha', 'nodes/beta', 'nodes/meeting-notes']);
    const existing = await api.findDocument(nest.id, 'nodes/meeting-notes');
    expect(existing?.content).toContain('Agenda for Monday.');
    expect(existing?.content).not.toContain('REPLACED CONTENT');
  });

  test('CN-NIMP-014: Verify that a collaborator with edit access can import files into the nest', async ({
    primary_user,
    secondary_user,
    commonFunction,
  }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'nimp-editor');

    const granted = await owner.api.shareForAuthoring(owner.nest.id, secondaryRole.email);
    test.skip(granted !== 'write', 'No editor seats on this server — secondary_user would be a nest admin.');
    await secondary_user.initialize();
    const editorApi = secondary_user.nestImportApi;
    await editorApi.settleInvitesFor(owner.nest.id);
    cleanups.push(() => editorApi.settleNotificationsFor(owner.nest.id));

    const editor = secondary_user.nestImportPage;
    await editor.gotoNest(owner.nest.id);
    await expect(editor.importButton).toBeVisible(WRITE);
    await editor.importFiles([markdownFile('editor-note.md', '# Editor note\n\nBy the editor.\n')]);

    await expect(editor.toast(addedToast(1))).toBeVisible(WRITE);
    await expect.poll(() => openDocument(editor), WRITE).toBe('nodes/editor-note');

    const doc = await owner.api.findDocument(owner.nest.id, 'nodes/editor-note');
    expect(doc, 'the owner sees the imported document').not.toBeNull();
    expect(doc?.created_by ?? doc?.author).toBe(secondaryRole.email);
  });
});
