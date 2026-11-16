/**
 * Import Folder Test Suite — CN-IMP-001 … CN-IMP-012
 *
 * Dialog under test: ui/src/components/ImportFolderModal.tsx ("Import into a
 * new nest"), opened from the Nests page's "Import Folder" button.
 *
 * Conventions
 * -----------
 * - Every import goes through the real dialog: the fixtures are picked with
 *   the file chooser and Import uploads them (POST /nests/import).
 * - "Choose folder" normally opens the system folder picker, which a test
 *   can't drive; `importFolderPage.useFolderInput()` turns that picker off in
 *   the test's browser, so the dialog uses its own folder input instead.
 * - Fixtures are built at run time in the test's output folder
 *   (`src/lib/import_folder_fixtures.js`); nothing is committed. A folder or
 *   zip name becomes the nest name, so each one is an AUTO_ name.
 * - Every nest an import creates is deleted after the test
 *   (`importFolderApi.deleteImportedNests()`), and is in the entity registry
 *   for the teardown and the orphan sweeper.
 * - Results are read back through the REST API: the nest and its documents.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import {
  buildDocsFolder,
  buildSkippedContentFolder,
  buildSingleMarkdown,
  buildMarkdownExport,
  buildZip,
  smallAndOversized,
} from '../../src/lib/import_folder_fixtures.js';

const primaryRole = samples.primary_user ?? null;

/** An import on a shared server can take a while to land. */
const WRITE = { timeout: 90_000 };

test.describe('Import Folder', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Nests this test's imports created — deleted afterwards, whatever happened.
  let importApi = null;
  test.afterEach(async () => {
    if (importApi) await importApi.deleteImportedNests().catch(() => {});
    importApi = null;
  });

  /** Initialise the owner, skip unless they may create nests, open the Nests page. */
  async function openNests(role) {
    await role.initialize();
    test.skip(!(await role.dashboardApi.canCreateNests()), 'This account may not create (or import) nests here.');
    importApi = role.importFolderApi;
    const imp = role.importFolderPage;
    await imp.useFolderInput();
    await imp.goto();
    return imp;
  }

  const fixturesDir = () => test.info().outputPath('import-fixtures');

  test('CN-IMP-001: Verify that the Import button stays disabled until a source is selected, and that Cancel closes the dialog without creating a nest', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-cancel');
    const folder = buildDocsFolder(fixturesDir(), name);
    const sent = [];
    imp.page.on('request', (r) => {
      if (r.url().includes('/nests/import')) sent.push(r.url());
    });

    await imp.open();
    await expect(imp.importButton).toBeDisabled();
    await imp.chooseFolder(folder);
    await expect(imp.importButton).toBeEnabled();

    await imp.cancelButton.click();
    await expect(imp.dialog).toBeHidden();
    expect(sent, 'Cancel sends no import request').toHaveLength(0);
    expect(await importApi.nestsNamed(name), 'Cancel creates no nest').toHaveLength(0);

    // Reopening starts empty.
    await imp.open();
    await expect(imp.summary).toHaveCount(0);
    await expect(imp.importButton).toBeDisabled();
  });

  test('CN-IMP-002: Verify that importing a folder creates a new nest marked as Imported', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-folder');
    const folder = buildDocsFolder(fixturesDir(), name);

    await imp.open();
    await imp.chooseFolder(folder);
    expect(await imp.summaryText()).toBe(`${name} — 3 documents · 6 files scanned`);
    await expect(imp.nameInput).toHaveValue(name);

    await imp.submit();
    await expect(imp.dialog).toBeHidden();
    const nest = await importApi.importedNest(name);
    expect(nest, 'the import created a nest with the folder name').toBeTruthy();
    expect(!!nest.is_imported).toBe(true);

    const { nestsPage } = primary_user;
    await expect(nestsPage.cardBadge(name, 'Imported')).toBeVisible(WRITE);
    await expect(nestsPage.importedByLine(name)).toContainText('you');
  });

  test('CN-IMP-003: Verify that the imported nest keeps the folder structure, document titles and tags', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-structure');
    const folder = buildDocsFolder(fixturesDir(), name);

    await imp.open();
    await imp.chooseFolder(folder);
    await imp.submit();
    await expect(imp.dialog).toBeHidden();

    const nest = await importApi.importedNest(name);
    const docs = await importApi.documents(nest.id);
    expect(docs.map((d) => d.id)).toEqual(['guides/setup', 'guides/welcome', 'notes']);
    const byId = Object.fromEntries(docs.map((d) => [d.id, d]));
    // Title: frontmatter title, else the first heading, else the file name.
    expect(byId.notes.title).toBe('Team Notes');
    expect(byId['guides/welcome'].title).toBe('Welcome Guide');
    expect(byId['guides/setup'].title).toBe('setup');
    expect(byId.notes.tags).toEqual(expect.arrayContaining(['#alpha', '#beta']));
  });

  test('CN-IMP-004: Verify that non-text files, hidden folders, node_modules and _suggestions are skipped during import', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-skip');
    const folder = buildSkippedContentFolder(fixturesDir(), name);

    await imp.open();
    await imp.chooseFolder(folder);
    expect(await imp.summaryText()).toBe(`${name} — 1 document · 1 file scanned`);

    await imp.submit();
    await expect(imp.dialog).toBeHidden();
    const nest = await importApi.importedNest(name);
    const docs = await importApi.documents(nest.id);
    expect(docs.map((d) => d.id)).toEqual(['doc']);
  });

  test('CN-IMP-005: Verify that a custom nest name entered in the dialog is used for the new nest', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const folderName = commonFunction.generateEntityName('imp-folder-name');
    const custom = commonFunction.generateEntityName('imp-custom');
    const folder = buildDocsFolder(fixturesDir(), folderName);

    await imp.open();
    await imp.chooseFolder(folder);
    await imp.nameInput.fill(custom);
    await imp.submit();
    await expect(imp.dialog).toBeHidden();

    expect(await importApi.importedNest(custom), 'the nest has the typed name').toBeTruthy();
    expect(await importApi.importedNest(folderName), 'no nest with the folder name').toBeNull();
  });

  test('CN-IMP-006: Verify that a single markdown file can be imported into a new nest', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-single');
    const file = buildSingleMarkdown(fixturesDir());

    await imp.open();
    await imp.chooseFiles(file);
    expect(await imp.summaryText()).toBe('Imported — 1 document · 1 file scanned');
    await expect(imp.nameInput).toHaveValue('Imported');

    await imp.nameInput.fill(name);
    await imp.submit();
    await expect(imp.dialog).toBeHidden();
    const nest = await importApi.importedNest(name);
    const docs = await importApi.documents(nest.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Single Doc');
  });

  test('CN-IMP-007: Verify that a whole-nest markdown export is split into separate documents on import', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-export');
    const file = buildMarkdownExport(fixturesDir());

    await imp.open();
    await imp.chooseFiles(file);
    expect(await imp.summaryText()).toBe('Imported — 2 documents · 2 files scanned');

    await imp.nameInput.fill(name);
    await imp.submit();
    await expect(imp.dialog).toBeHidden();
    const nest = await importApi.importedNest(name);
    const docs = await importApi.documents(nest.id);
    expect(docs.map((d) => [d.id, d.title])).toEqual([
      ['first-doc', 'First Doc'],
      ['second-doc', 'Second Doc'],
    ]);
  });

  test('CN-IMP-008: Verify that a .zip file can be imported, keeping its folders and documents', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-zip');
    const zip = await buildZip(fixturesDir(), name, {
      'notes.md': '# Zip Notes\n\nFrom the zip.\n',
      'guides/a.md': '# Zip A\n',
    });

    await imp.open();
    await imp.chooseFiles(zip);
    expect(await imp.summaryText()).toBe(`${name} — 2 documents · 2 files scanned`);
    await expect(imp.nameInput).toHaveValue(name);

    await imp.submit();
    await expect(imp.dialog).toBeHidden();
    const nest = await importApi.importedNest(name);
    const docs = await importApi.documents(nest.id);
    expect(docs.map((d) => [d.id, d.title])).toEqual([
      ['guides/a', 'Zip A'],
      ['notes', 'Zip Notes'],
    ]);
  });

  test('CN-IMP-009: Verify that a .zip entry with a ../ path is imported as a document inside the new nest', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-zip-path');
    const zip = await buildZip(fixturesDir(), name, {
      'notes.md': '# Zip Notes\n',
      '../evil.md': '# Outside Path\n',
    });

    await imp.open();
    await imp.chooseFiles(zip);
    await imp.submit();
    await expect(imp.dialog).toBeHidden();
    await expect(imp.error).toHaveCount(0);

    const nest = await importApi.importedNest(name);
    const docs = await importApi.documents(nest.id);
    expect(docs.map((d) => d.id)).toEqual(['evil', 'notes']);
    expect(docs.find((d) => d.id === 'evil').title).toBe('Outside Path');
  });

  test('CN-IMP-010: Verify that a file larger than 8 MB is left out and reported to the user', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-oversized');

    await imp.open();
    await imp.chooseFiles(smallAndOversized());
    await imp.nameInput.fill(name);
    await imp.submit();

    // The import happens; the dialog stays open and names the file left out.
    await expect(imp.dialog).toBeVisible();
    await expect(imp.error).toHaveText('Imported, but 1 file could not be read or was too large: huge.md');
    const nest = await importApi.importedNest(name);
    expect(nest, 'the nest was created with the rest').toBeTruthy();
    const docs = await importApi.documents(nest.id);
    expect(docs.map((d) => d.id)).toEqual(['small']);
  });

  test('CN-IMP-011: Verify that an import with a duplicate nest name is rejected with a clear message', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-duplicate');
    const folder = buildDocsFolder(fixturesDir(), name);

    await imp.open();
    await imp.chooseFolder(folder);
    await imp.submit();
    await expect(imp.dialog).toBeHidden();
    expect(await importApi.importedNest(name)).toBeTruthy();

    // Same folder, same name again.
    await imp.open();
    await imp.chooseFolder(folder);
    await imp.submit();
    await expect(imp.dialog).toBeVisible();
    await expect(imp.error).toHaveText('A nest with this name already exists. Pick a different name.');
    expect(await importApi.nestsNamed(name), 'still only one nest with that name').toHaveLength(1);
  });

  test('CN-IMP-012: Verify that switching between Folder and File / .zip clears the previously selected files', async ({
    primary_user,
    commonFunction,
  }) => {
    const imp = await openNests(primary_user);
    const name = commonFunction.generateEntityName('imp-switch');
    const folder = buildDocsFolder(fixturesDir(), name);

    await imp.open();
    await imp.chooseFolder(folder);
    await expect(imp.summary).toBeVisible();
    await expect(imp.importButton).toBeEnabled();

    await imp.fileSource.check();
    await expect(imp.summary).toHaveCount(0);
    await expect(imp.importButton).toBeDisabled();
    // The typed (here: filled-in) nest name is kept.
    await expect(imp.nameInput).toHaveValue(name);
  });
});
