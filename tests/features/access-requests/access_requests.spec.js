/**
 * Request access when a write is denied — CN-ACCESS-001 … CN-ACCESS-004
 *
 * Pages under test: DocumentEditor ("Request edit access", and the prompt a
 * refused save raises), NestView ("Request edit access" for the nest), My Work
 * (Approve / Deny an access row), and RequestAccessDialog itself.
 * CU-wdqcq041jn.
 *
 * Conventions
 * -----------
 * - Two accounts: the primary owns one seeded nest (AUTO_ name, registered for
 *   teardown); the secondary is shared into it as a viewer ('read') and asks.
 *   Every case skips when no second account is configured (tests/env.template).
 * - Preconditions go over REST (`myWorkApi`); the UI is driven only for the
 *   behaviour under test.
 * - CI runs e2e against the deployed server. Until it serves
 *   /nests/:id/access-requests the suite skips rather than fails;
 *   CN_EXPECT_ACCESS_REQUESTS=1 turns that skip into a failure.
 * - Serial: the cases share the nest and build on each other's requests.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** Writes on nest-dev take seconds; locally well under one. */
const WRITE = { timeout: 30_000 };

/** @type {{ nestId: string, nestName: string, docId: string, docTitle: string } | null} */
let seeded = null;
let featureDeployed = false;

/** A note no other row on the page will carry. */
function uniqueText(label) {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Open a document page as the given role. */
async function openDoc(role, nestId, docId) {
  await role.page.goto(`/nest/${nestId}?doc=${encodeURIComponent(docId)}`);
  await role.page.waitForSelector('[data-testid="document-editor-topbar"]');
}

/** The secondary's collaborator row in the seeded nest. */
async function viewerRow(api, nestId) {
  return (await api.listCollaborators(nestId)).find(
    (c) => (c.email ?? '').toLowerCase() === secondaryRole.email.toLowerCase()
  );
}

test.describe('Request access on a denied write', () => {
  test.skip(!primaryRole || !secondaryRole, 'primary_user and secondary_user are both needed. See tests/env.template.');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ primary_user, commonFunction }) => {
    await primary_user.initialize();
    const api = primary_user.myWorkApi;
    const nest = await api.createNest(commonFunction.generateEntityName('access-requests'));
    const docTitle = commonFunction.generateEntityName('pricing');
    const doc = await api.createDocument(nest.id, { title: docTitle, content: `# ${docTitle}\n\nQ3 numbers.\n` });
    await api.addCollaborator(nest.id, secondaryRole.email, 'read');
    seeded = { nestId: nest.id, nestName: nest.name, docId: doc.id, docTitle };
    const probe = await api.request('GET', `/nests/${nest.id}/access-requests`);
    featureDeployed = probe.ok && Array.isArray(probe.data?.requests);
  });

  test.beforeEach(() => {
    if (process.env.CN_EXPECT_ACCESS_REQUESTS === '1') {
      expect(featureDeployed, '/nests/:id/access-requests is not served').toBe(true);
    }
    test.skip(!featureDeployed, 'The server under test does not serve access requests yet (pre-CU-wdqcq041jn).');
  });

  test('CN-ACCESS-001 a viewer asks for edit access from the document, and then sees it pending @smoke', async ({
    secondary_user,
  }) => {
    await secondary_user.initialize();
    const page = secondary_user.page;
    await openDoc(secondary_user, seeded.nestId, seeded.docId);
    await expect(page.getByTestId('document-editor-start-edit')).toHaveCount(0);

    await page.getByTestId('document-editor-request-access').click();
    const note = uniqueText('fixing the Q3 numbers');
    await page.getByTestId('reason-dialog-input').fill(note);
    await page.getByTestId('reason-dialog-confirm').click();
    await expect(page.getByText('Access requested')).toBeVisible(WRITE);

    await page.getByTestId('document-editor-request-access').click();
    await expect(page.getByTestId('request-access-pending')).toBeVisible(WRITE);
  });

  test('CN-ACCESS-002 the owner approves it in My Work, and the viewer can edit', async ({
    primary_user,
    secondary_user,
  }) => {
    await primary_user.initialize();
    const page = primary_user.page;
    await page.goto('/my-work');
    const row = page.locator('div', { hasText: seeded.docTitle }).filter({
      has: page.getByTestId('my-work-access-approve'),
    });
    await expect(row.last()).toBeVisible(WRITE);
    await row.last().getByTestId('my-work-access-approve').click();
    // Editors are a paid seat class: on a plan without them the server refuses
    // the grant (402) and the request stays pending — correct, but nothing
    // further here can be shown on such a server.
    const outcome = page.getByText(/can now edit|aren't included in this server's plan/);
    await expect(outcome).toBeVisible(WRITE);
    test.skip(
      /plan/.test(await outcome.innerText()),
      'This server plan has no editor seats, so approving write access is refused (402).'
    );

    // The viewer's document now opens for editing, and the save goes through.
    await secondary_user.initialize();
    const viewer = secondary_user.page;
    await openDoc(secondary_user, seeded.nestId, seeded.docId);
    const editor = viewer.locator('.ProseMirror');
    await expect(editor).toBeVisible(WRITE);
    await expect(viewer.getByTestId('document-editor-request-access')).toHaveCount(0);
    await editor.click();
    await viewer.keyboard.press('End');
    await viewer.keyboard.type(' Edited by the viewer.');
    await viewer.getByTestId('document-editor-save').click();
    await expect(viewer.getByText(/published|saved as a draft/)).toBeVisible(WRITE);
  });

  test('CN-ACCESS-003 a denied nest request shows who said no and why, with the option to ask again', async ({
    primary_user,
    secondary_user,
  }) => {
    await secondary_user.initialize();
    const viewer = secondary_user.page;
    await viewer.goto(`/nest/${seeded.nestId}`);
    await viewer.getByTestId('nest-request-access').click();
    await viewer.getByTestId('reason-dialog-confirm').click();
    await expect(viewer.getByText('Access requested')).toBeVisible(WRITE);

    await primary_user.initialize();
    const owner = primary_user.page;
    await owner.goto('/my-work');
    // The nest-level access row for this nest: the account's inbox may hold
    // others, including this nest's document request when the plan refused it.
    const deny = owner
      .locator('div', { hasText: seeded.nestName })
      .filter({ has: owner.getByTestId('my-work-access-deny'), hasNotText: seeded.docTitle })
      .last()
      .getByTestId('my-work-access-deny');
    await expect(deny).toBeVisible(WRITE);
    await deny.click();
    const why = uniqueText('nest is locked this week');
    await owner.getByTestId('reason-dialog-input').fill(why);
    await owner.getByTestId('reason-dialog-confirm').click();
    await expect(deny).toHaveCount(0, WRITE);

    await viewer.reload();
    await viewer.getByTestId('nest-request-access').click();
    await expect(viewer.getByTestId('reason-dialog-prior-decline')).toContainText(why, WRITE);
    await expect(viewer.getByTestId('reason-dialog-confirm')).toBeEnabled();
  });

  test('CN-ACCESS-004 a save refused mid-edit offers the request and keeps the edit', async ({
    primary_user,
    secondary_user,
  }) => {
    await primary_user.initialize();
    const api = primary_user.myWorkApi;
    // Fresh document the viewer has no share on, and nest write for the viewer
    // so the editor opens.
    const title = `${seeded.docTitle} draft`;
    const doc = await api.createDocument(seeded.nestId, { title });
    const row = await viewerRow(api, seeded.nestId);
    // Write if the plan has editor seats, else admin — either opens the editor.
    const asWriter = await api.request('PATCH', `/nests/${seeded.nestId}/collaborators/${row.id}`, {
      permission: 'write',
    });
    if (!asWriter.ok) {
      await api.expectOk('PATCH', `/nests/${seeded.nestId}/collaborators/${row.id}`, { permission: 'admin' });
    }

    await secondary_user.initialize();
    const page = secondary_user.page;
    await openDoc(secondary_user, seeded.nestId, doc.id);
    // A writer's document opens straight into editing.
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible(WRITE);
    await editor.click();
    const typed = uniqueText('unsaved line');
    await page.keyboard.press('End');
    await page.keyboard.type(` ${typed}`);

    // Taken back to viewer while they type.
    await api.expectOk('PATCH', `/nests/${seeded.nestId}/collaborators/${row.id}`, { permission: 'read' });
    await page.getByTestId('document-editor-save').click();

    await expect(page.getByTestId('reason-dialog-confirm')).toBeVisible(WRITE);
    await expect(page.getByRole('dialog')).toContainText('Request edit access?');
    await page.keyboard.press('Escape');
    await expect(editor).toContainText(typed);
  });
});
