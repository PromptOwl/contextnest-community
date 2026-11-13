/**
 * Collaborators Test Suite — CN-COLLAB-001 … CN-COLLAB-031
 *
 * Page under test: the nest page's Collaborators tab
 * (ui/src/components/nest/CollaboratorsTab.tsx) — what each role sees and can
 * do, adding, changing and removing people, sharing with a team, the
 * visibility control and API-only access keys.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest; secondary_user is the collaborator whose
 *   role each case sets (Viewer, Editor or Admin). A case that needs a third
 *   person adds a `qa-…@example.com` test account found in the server
 *   directory, never a real person, and skips when there is none.
 * - Editor and Admin are paid seats. When the server has no free seat for the
 *   role a case needs (402), that case skips instead of failing.
 * - Preconditions (nests, shares, teams, visibility, stewardship) are arranged
 *   through the REST API (`collaboratorsApi`); the step under test goes
 *   through the UI. Outcomes are read back through the API too. API-only keys
 *   are exercised the way an outside tool uses them: a bearer request with no
 *   session.
 * - Every nest is an AUTO_ name, deleted after the test
 *   (`collaboratorsApi.deleteCreatedNests()`), and is in the entity registry
 *   for the teardown and the orphan sweeper. Teams are AUTO_ names deleted the
 *   same way. The notifications a nest raised are marked read first.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

const DOC_TITLE = 'Collaborators Doc';
const DOC_BODY = 'Readable body text.';
const ROLE_LABEL = { read: 'Viewer', write: 'Editor', admin: 'Admin' };

test.describe('Collaborators', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner and create a nest, optionally governed and with one
   * published document. Skips unless the owner may create nests.
   */
  async function ownerNest(role, commonFunction, suffix, { governed = false, withDoc = false } = {}) {
    await role.initialize();
    const api = role.collaboratorsApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Collaborators suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    cleanups.push(() => api.deleteCreatedTeams());
    cleanups.push(() => api.settleNotificationsFor(nest.id));
    const doc = withDoc
      ? await api.createDoc(nest.id, { title: DOC_TITLE, content: `# ${DOC_TITLE}\n\n${DOC_BODY}\n` })
      : null;
    if (governed) await api.governNest(nest.id);
    return { api, nest, doc, page: role.collaboratorsPage };
  }

  /** Open secondary_user's session, settling any invite the nest raised. */
  async function openSecondary(owner, secondary) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await secondary.initialize();
    const api = secondary.collaboratorsApi;
    await api.settleInvitesFor(owner.nest.id).catch(() => {});
    cleanups.push(() => api.settleNotificationsFor(owner.nest.id));
    return { api, page: secondary.collaboratorsPage, newDocument: secondary.newDocumentPage, email: secondaryRole.email };
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

  /** A third person (a QA test account). Skips when the directory has none. */
  async function thirdPerson(owner) {
    const email = await owner.api.testPerson([primaryRole.email, secondaryRole?.email ?? '']);
    test.skip(!email, 'No other qa-…@example.com test account on this server.');
    return email;
  }

  /**
   * Submit the add form and wait for the person's row — or skip when the
   * server has no free seat for the role. A role that moves the person to a
   * paid seat asks first ("This raises what someone is billed"); the case
   * confirms it, as the admin would.
   */
  async function addThroughUi(page, email, roleLabel) {
    await page.addPerson(email, roleLabel);
    const settle = () =>
      Promise.race([
        page.row(email).waitFor({ state: 'visible', ...WRITE }).then(() => 'added'),
        page.errorAlert.first().waitFor({ state: 'visible', ...WRITE }).then(() => 'error'),
        page.billingDialog.waitFor({ state: 'visible', ...WRITE }).then(() => 'billing'),
      ]);
    let outcome = await settle();
    if (outcome === 'billing') {
      await page.billingConfirm.click();
      outcome = await settle();
    }
    if (outcome === 'error') {
      const message = await page.errorAlert.first().innerText();
      test.skip(/seat|plan|licen|upgrade|subscri/i.test(message), `No free ${roleLabel} seat: ${message}`);
      throw new Error(`Adding ${email} as ${roleLabel} failed: ${message}`);
    }
  }

  // ── Who sees what ──────────────────────────────────────────────────────────

  test('CN-COLLAB-001: Verify that the owner sees the Collaborators tab with visibility, API-only access and People with access', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-owner');

    await owner.page.goto(owner.nest.id);
    await expect(owner.page.collaboratorsTab).toHaveAttribute('aria-selected', 'true');
    await expect(owner.page.visibilitySelect).toBeVisible();
    await expect(owner.page.headlessPanel).toBeVisible();
    await expect(owner.page.peopleWithAccess).toBeVisible();
    await expect(owner.page.personInput).toBeVisible();
  });

  test("CN-COLLAB-002: Verify that a Viewer doesn't see the Collaborators tab, and a direct link opens another tab", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-viewer-tab');
    const viewer = await share(owner, secondary_user, 'read');

    await viewer.page.gotoLink(owner.nest.id);
    // The link only falls back once the caller's access has loaded, so the
    // tab can't be missing here just because it hasn't appeared yet.
    await expect(viewer.page.page).not.toHaveURL(/tab=collaborators/, WRITE);
    // The nest's home tab: Overview before po-1213, Documents after.
    await expect(viewer.page.page.getByRole('tab', { name: /^(Overview|Documents)$/, selected: true })).toHaveCount(1);
    await expect(viewer.page.collaboratorsTab).toHaveCount(0);
  });

  test("CN-COLLAB-003: Verify that a Viewer can read documents but can't create, edit or delete them", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-viewer-read', { withDoc: true });
    const viewer = await share(owner, secondary_user, 'read');

    await viewer.page.gotoDocument(owner.nest.id, owner.doc.id);
    await expect(viewer.page.main.getByText(DOC_BODY).first()).toBeVisible(WRITE);
    // No way to edit, and the document's menu has no Delete.
    await expect(viewer.page.documentMenu).toBeVisible();
    const menu = await viewer.page.documentMenuItems();
    expect(menu).toContain('Copy link');
    expect(menu).not.toContain('Delete');
    await expect(viewer.page.editButton).toHaveCount(0);
    await expect(viewer.page.editableBody).toHaveCount(0);

    await viewer.page.gotoNest(owner.nest.id);
    await expect(viewer.page.requestEditAccess).toBeVisible(WRITE);
    await expect(viewer.page.newDocumentButton).toHaveCount(0);

    // The server refuses the same writes.
    expect((await viewer.api.request('PATCH', `/nests/${owner.nest.id}/nodes/${owner.doc.id}`, { content: '# Changed\n' })).ok).toBe(false);
    expect((await viewer.api.request('DELETE', `/nests/${owner.nest.id}/nodes/${owner.doc.id}`)).ok).toBe(false);
  });

  test('CN-COLLAB-004: Verify that an Editor sees the tab but can only add people, with no role change or remove', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-editor-tab');
    const editor = await share(owner, secondary_user, 'write');

    await editor.page.goto(owner.nest.id);
    await expect(editor.page.collaboratorsTab).toBeVisible();
    await expect(editor.page.personInput).toBeVisible();
    await expect(editor.page.row(editor.email)).toContainText('Editor');
    await expect(editor.page.rowRole(editor.email)).toHaveCount(0);
    await expect(editor.page.rowRemove(editor.email)).toHaveCount(0);
  });

  test('CN-COLLAB-005: Verify that an Editor can only grant Viewer or Editor, not Admin', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-editor-grant');
    const editor = await share(owner, secondary_user, 'write');

    await editor.page.goto(owner.nest.id);
    expect(await editor.page.grantableRoles()).toEqual(['Viewer', 'Editor']);
  });

  test('CN-COLLAB-006: Verify that an Editor can add a person as Viewer, and they appear in People with access', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-editor-add');
    const third = await thirdPerson(owner);
    const editor = await share(owner, secondary_user, 'write');

    await editor.page.goto(owner.nest.id);
    await addThroughUi(editor.page, third, 'Viewer');

    await expect(editor.page.row(third)).toContainText('Viewer');
    await expect.poll(async () => (await owner.api.collaborator(owner.nest.id, third))?.permission, WRITE).toBe('read');
  });

  test("CN-COLLAB-007: Verify that an Editor doesn't see the visibility control or API-only access", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-editor-limits');
    const editor = await share(owner, secondary_user, 'write');

    await editor.page.goto(owner.nest.id);
    await expect(editor.page.row(editor.email)).toBeVisible();
    await expect(editor.page.visibilitySelect).toHaveCount(0);
    await expect(editor.page.headlessPanel).toHaveCount(0);
  });

  test('CN-COLLAB-008: Verify that an Editor can create and edit documents', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-editor-write', { withDoc: true });
    const editor = await share(owner, secondary_user, 'write');
    const title = 'Editor Created Doc';

    await editor.newDocument.gotoNest(owner.nest.id);
    await editor.newDocument.openNewDocument();
    await editor.newDocument.fillDocument(title, 'Written by the editor.');
    await editor.newDocument.publishButton.click();
    await expect
      .poll(async () => (await owner.api.listNodes(owner.nest.id)).some((n) => n.title === title), WRITE)
      .toBe(true);

    // They can edit an existing document and save the change from the page.
    const edit = 'Edited by the editor.';
    await editor.page.gotoDocument(owner.nest.id, owner.doc.id);
    await editor.page.editButton.click();
    await expect(editor.page.editableBody.first()).toBeVisible(WRITE);
    await editor.page.editableBody.first().click();
    await editor.page.page.keyboard.press('Control+End');
    await editor.page.page.keyboard.type(` ${edit}`);
    await editor.page.saveButton.click();
    await expect
      .poll(async () => String((await owner.api.getNode(owner.nest.id, owner.doc.id)).data?.node?.content ?? ''), WRITE)
      .toContain(edit);
  });

  test('CN-COLLAB-009: Verify that an Admin sees the full Collaborators tab with visibility, API-only access, role menus and Remove', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-admin-tab');
    const third = await thirdPerson(owner);
    const admin = await share(owner, secondary_user, 'admin');
    await owner.api.grant(owner.nest.id, third, 'read');

    await admin.page.goto(owner.nest.id);
    await expect(admin.page.visibilitySelect).toBeVisible();
    await expect(admin.page.headlessPanel).toBeVisible();
    await expect(admin.page.rowRole(third)).toBeEnabled();
    await expect(admin.page.rowRemove(third)).toBeVisible();
  });

  test('CN-COLLAB-010: Verify that an Admin can add a person as Admin, and change and remove other people', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-admin-manage');
    const third = await thirdPerson(owner);
    const admin = await share(owner, secondary_user, 'admin');

    await admin.page.goto(owner.nest.id);
    await addThroughUi(admin.page, third, 'Admin');
    await expect.poll(async () => (await owner.api.collaborator(owner.nest.id, third))?.permission, WRITE).toBe('admin');

    await admin.page.changeRole(third, 'Editor');
    await expect.poll(async () => (await owner.api.collaborator(owner.nest.id, third))?.permission, WRITE).toBe('write');

    await admin.page.rowRemove(third).click();
    await admin.page.removeConfirm.click();
    await expect(admin.page.row(third)).toHaveCount(0, WRITE);
    expect(await owner.api.collaborator(owner.nest.id, third)).toBeNull();
  });

  test("CN-COLLAB-011: Verify that an Admin can't change their own role or remove themselves", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-admin-self');
    const admin = await share(owner, secondary_user, 'admin');

    await admin.page.goto(owner.nest.id);
    await expect(admin.page.rowRole(admin.email)).toBeDisabled();
    await expect(admin.page.rowRemove(admin.email)).toHaveCount(0);
  });

  test("CN-COLLAB-012: Verify that an Admin can change the nest's visibility", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-admin-visibility');
    const admin = await share(owner, secondary_user, 'admin');

    await admin.page.goto(owner.nest.id);
    await admin.page.chooseVisibility('Public');
    await admin.page.visibilityDialog.getByRole('button', { name: 'Make public' }).click();

    await expect.poll(() => owner.api.visibility(owner.nest.id), WRITE).toBe('public');
  });

  test("CN-COLLAB-013: Verify that an Admin can't delete the nest", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-admin-delete');
    const admin = await share(owner, secondary_user, 'admin');

    // The nest menu's Delete only asks an owner for removal.
    await admin.page.gotoNest(owner.nest.id);
    await admin.page.moreActions.click();
    await admin.page.page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await expect(admin.page.requestRemovalDialog).toBeVisible();
    await expect(admin.page.deleteNestDialog).toHaveCount(0);
    await admin.page.page.keyboard.press('Escape');

    // The server refuses the delete itself.
    expect((await admin.api.request('DELETE', `/nests/${owner.nest.id}`)).ok).toBe(false);
    expect(await owner.api.openStatus(owner.nest.id)).toBe(200);
  });

  // ── Adding people ──────────────────────────────────────────────────────────

  test('CN-COLLAB-014: Verify that the owner can add a person as Viewer, Editor or Admin, and they appear in People with access', async ({ primary_user, secondary_user, commonFunction }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'collab-owner-add');
    const email = secondaryRole.email;
    await openSecondary(owner, secondary_user);

    for (const [permission, label] of Object.entries(ROLE_LABEL)) {
      await owner.page.goto(owner.nest.id);
      await addThroughUi(owner.page, email, label);
      await expect(owner.page.rowRole(email)).toHaveText(label);
      await expect.poll(async () => (await owner.api.collaborator(owner.nest.id, email))?.permission, WRITE).toBe(permission);
      await owner.api.removePerson(owner.nest.id, email);
    }
  });

  test('CN-COLLAB-015: Verify that an invalid email shows "Enter a valid email address."', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-bad-email');

    await owner.page.goto(owner.nest.id);
    await owner.page.addPerson('not-an-email');

    await expect(owner.page.errorAlert).toContainText('Enter a valid email address.');
    await expect(owner.page.rows).toHaveCount(0);
  });

  test('CN-COLLAB-016: Verify that adding someone who already has access, or the owner, is refused', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-refused');
    const viewer = await share(owner, secondary_user, 'read');

    await owner.page.goto(owner.nest.id);
    await owner.page.addPerson(viewer.email);
    await expect(owner.page.errorAlert).toContainText('already has access to this nest', WRITE);

    await owner.page.addPerson(primaryRole.email);
    await expect(owner.page.errorAlert).toContainText('The nest owner already has full access', WRITE);
    await expect(owner.page.rows).toHaveCount(1);
  });

  test('CN-COLLAB-017: Verify that "Also make them a reviewer" makes the new person a nest reviewer', async ({ primary_user, secondary_user, commonFunction }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'collab-invite-reviewer', { governed: true });
    const email = secondaryRole.email;
    await openSecondary(owner, secondary_user);

    await owner.page.goto(owner.nest.id);
    await owner.page.inviteReviewer.click();
    await addThroughUi(owner.page, email, 'Viewer');

    await expect.poll(() => owner.api.isNestReviewer(owner.nest.id, email), WRITE).toBe(true);
    await expect(owner.page.rowReviewer(email)).toBeChecked(WRITE);
  });

  // ── Managing people ────────────────────────────────────────────────────────

  test("CN-COLLAB-018: Verify that changing a person's role saves and changes what they can do", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-change-role');
    const person = await share(owner, secondary_user, 'read');

    await owner.page.goto(owner.nest.id);
    await owner.page.changeRole(person.email, 'Editor');
    const saved = await expect
      .poll(async () => (await owner.api.collaborator(owner.nest.id, person.email))?.permission, WRITE)
      .toBe('write')
      .then(() => true)
      .catch(() => false);
    if (!saved) {
      const message = await owner.page.errorAlert.first().innerText().catch(() => '');
      test.skip(/seat|plan|licen|upgrade|subscri/i.test(message), `No free Editor seat: ${message}`);
      throw new Error(`The role change didn't save: ${message}`);
    }

    // As an Editor they can now create documents.
    await person.page.gotoNest(owner.nest.id);
    await expect(person.page.newDocumentButton).toBeVisible(WRITE);
  });

  test('CN-COLLAB-019: Verify that the Remove access dialog names the person and the nest, and Cancel keeps them', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-remove-cancel');
    const person = await share(owner, secondary_user, 'read');

    await owner.page.goto(owner.nest.id);
    await owner.page.rowRemove(person.email).click();
    await expect(owner.page.removeDialog).toContainText(person.email);
    await expect(owner.page.removeDialog).toContainText(owner.nest.name);
    await owner.page.removeDialog.getByRole('button', { name: 'Cancel' }).click();

    await expect(owner.page.removeDialog).toHaveCount(0);
    await expect(owner.page.row(person.email)).toBeVisible();
    expect(await owner.api.collaborator(owner.nest.id, person.email)).not.toBeNull();
  });

  test('CN-COLLAB-020: Verify that Remove access removes the person, and they can no longer open the nest', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-remove');
    const person = await share(owner, secondary_user, 'read');

    await owner.page.goto(owner.nest.id);
    await owner.page.rowRemove(person.email).click();
    await owner.page.removeConfirm.click();

    await expect(owner.page.toasts.filter({ hasText: `${person.email} removed from this nest` })).toBeVisible(WRITE);
    await expect(owner.page.row(person.email)).toHaveCount(0);
    expect(await person.api.openStatus(owner.nest.id)).not.toBe(200);
    await person.page.gotoNest(owner.nest.id);
    await expect(person.page.noAccess).toBeVisible(WRITE);
  });

  test('CN-COLLAB-021: Verify that the Reviewer switch turns nest-wide review on and off for a person', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-reviewer-switch', { governed: true });
    const person = await share(owner, secondary_user, 'read');

    await owner.page.goto(owner.nest.id);
    await owner.page.rowReviewer(person.email).click();
    await expect(owner.page.toasts.filter({ hasText: 'can now approve documents in this nest' })).toBeVisible(WRITE);
    await expect.poll(() => owner.api.isNestReviewer(owner.nest.id, person.email), WRITE).toBe(true);
    // The switch follows the steward list, which reloads after the toast;
    // clicking before it shows "on" would ask to add the reviewer again.
    await expect(owner.page.rowReviewer(person.email)).toBeChecked(WRITE);

    await owner.page.rowReviewer(person.email).click();
    await expect(owner.page.toasts.filter({ hasText: 'is no longer a reviewer' })).toBeVisible(WRITE);
    await expect.poll(() => owner.api.isNestReviewer(owner.nest.id, person.email), WRITE).toBe(false);
    await expect(owner.page.rowReviewer(person.email)).not.toBeChecked(WRITE);
  });

  // ── Teams ──────────────────────────────────────────────────────────────────

  test('CN-COLLAB-022: Verify that sharing a team adds it under "Teams with access" with its member count', async ({ primary_user, secondary_user, commonFunction }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'collab-team-share');
    const team = await owner.api.createTeamWith(commonFunction.generateEntityName('collab-team'), secondaryRole.email);
    const member = await openSecondary(owner, secondary_user);

    await owner.page.goto(owner.nest.id);
    await owner.page.shareTeam(team.name);

    await expect(owner.page.toasts.filter({ hasText: 'Team shared' })).toBeVisible(WRITE);
    const shared = (await owner.api.nestTeams(owner.nest.id)).find((t) => t.teamId === team.id);
    expect(shared, 'the team is shared with the nest').toBeTruthy();
    const count = shared.members.length;
    await expect(owner.page.teamRow(team.name)).toContainText(`${count} member${count === 1 ? '' : 's'}`);
    expect(await member.api.openStatus(owner.nest.id)).toBe(200);
  });

  test('CN-COLLAB-023: Verify that unsharing a team removes it, and its members lose that access', async ({ primary_user, secondary_user, commonFunction }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'collab-team-unshare');
    const team = await owner.api.createTeamWith(commonFunction.generateEntityName('collab-team'), secondaryRole.email);
    await owner.api.shareWithTeam(owner.nest.id, team.id);
    const member = await openSecondary(owner, secondary_user);
    expect(await member.api.openStatus(owner.nest.id)).toBe(200);

    await owner.page.goto(owner.nest.id);
    // Unshare asks through the browser's own confirm dialog.
    owner.page.page.once('dialog', (dialog) => dialog.accept());
    await owner.page.teamRow(team.name).getByTitle('Unshare team').click();

    await expect(owner.page.teamRow(team.name)).toHaveCount(0, WRITE);
    expect((await owner.api.nestTeams(owner.nest.id)).some((t) => t.teamId === team.id)).toBe(false);
    expect(await member.api.openStatus(owner.nest.id)).not.toBe(200);
  });

  // ── Visibility ─────────────────────────────────────────────────────────────

  test('CN-COLLAB-024: Verify that choosing Public from Private, Organization and Public asks for confirmation, and Cancel keeps the nest Private', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-public-cancel');

    await owner.page.goto(owner.nest.id);
    expect(await owner.page.visibilityOptions()).toEqual(['Private', 'Organization', 'Public']);
    await owner.page.chooseVisibility('Public');
    await expect(owner.page.visibilityDialog).toContainText('Make this nest public?');
    await owner.page.visibilityDialog.getByRole('button', { name: 'Cancel' }).click();

    await expect(owner.page.visibilityDialog).toHaveCount(0);
    await expect(owner.page.visibilitySelect).toHaveText('Private');
    expect(await owner.api.visibility(owner.nest.id)).toBe('private');
  });

  test('CN-COLLAB-025: Verify that confirming Public lets a non-member read the nest', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-public');
    const outsider = await openSecondary(owner, secondary_user);
    expect(await outsider.api.openStatus(owner.nest.id)).not.toBe(200);

    await owner.page.goto(owner.nest.id);
    await owner.page.chooseVisibility('Public');
    await owner.page.visibilityDialog.getByRole('button', { name: 'Make public' }).click();
    await expect.poll(() => owner.api.visibility(owner.nest.id), WRITE).toBe('public');

    expect(await outsider.api.openStatus(owner.nest.id)).toBe(200);
    await outsider.page.gotoNest(owner.nest.id);
    await expect(outsider.page.backToNests).toBeVisible(WRITE);
    await expect(outsider.page.noAccess).toHaveCount(0);
  });

  test('CN-COLLAB-026: Verify that switching back to Private removes access for non-members', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-private');
    await owner.api.setVisibility(owner.nest.id, 'public');
    const outsider = await openSecondary(owner, secondary_user);
    expect(await outsider.api.openStatus(owner.nest.id)).toBe(200);

    await owner.page.goto(owner.nest.id);
    await owner.page.chooseVisibility('Private');
    await expect.poll(() => owner.api.visibility(owner.nest.id), WRITE).toBe('private');

    expect(await outsider.api.openStatus(owner.nest.id)).not.toBe(200);
    await outsider.page.gotoNest(owner.nest.id);
    await expect(outsider.page.noAccess).toBeVisible(WRITE);
  });

  // ── API-only access ────────────────────────────────────────────────────────

  test("CN-COLLAB-027: Verify that API-only access can't be turned on while the nest is Public or Organization, and the reason is shown", async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-headless-public');

    for (const visibility of ['public', 'org']) {
      await owner.api.setVisibility(owner.nest.id, visibility);
      await owner.page.goto(owner.nest.id);
      await expect(owner.page.headlessSwitch).toBeDisabled();
      await expect(owner.page.headlessReason).toContainText(visibility === 'org' ? 'open to your organization' : 'This nest is public');
      await expect(owner.page.headlessReason).toContainText('Make it private first');
    }
  });

  test('CN-COLLAB-028: Verify that Create key needs a name, and the key is shown only once', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-key-create');
    const label = 'QA Key Once';

    await owner.page.goto(owner.nest.id);
    await owner.page.enableApiOnly();
    await expect(owner.page.createKeyButton).toBeDisabled();
    const key = await owner.page.createKey(label);
    await expect(owner.page.headlessPanel).toContainText("copy it now. It won't be shown again.");

    await owner.page.goto(owner.nest.id);
    await expect(owner.page.headlessPanel).toContainText(label);
    expect(await owner.page.page.content()).not.toContain(key);
  });

  test("CN-COLLAB-029: Verify that a created key can read approved documents but can't edit", async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-key-read', { withDoc: true });

    await owner.page.goto(owner.nest.id);
    await owner.page.enableApiOnly();
    const key = await owner.page.createKey('QA Key Read');

    const docPath = `/nests/${owner.nest.id}/nodes/${owner.doc.id}`;
    expect(await owner.api.statusWithKey(key, 'GET', `/nests/${owner.nest.id}/nodes`)).toBe(200);
    expect(await owner.api.statusWithKey(key, 'GET', docPath)).toBe(200);
    expect(await owner.api.statusWithKey(key, 'PATCH', docPath, { content: '# Changed\n' })).toBeGreaterThanOrEqual(400);
  });

  test('CN-COLLAB-030: Verify that revoking a key stops it working', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-key-revoke', { withDoc: true });
    const label = 'QA Key Revoke';
    const path = `/nests/${owner.nest.id}/nodes`;

    await owner.page.goto(owner.nest.id);
    await owner.page.enableApiOnly();
    const key = await owner.page.createKey(label);
    expect(await owner.api.statusWithKey(key, 'GET', path)).toBe(200);

    await owner.page.revokeKey(label);
    await expect(owner.page.toasts.filter({ hasText: 'revoked' })).toBeVisible(WRITE);
    await expect.poll(() => owner.api.statusWithKey(key, 'GET', path), WRITE).not.toBe(200);
  });

  test('CN-COLLAB-031: Verify that turning API-only access off pauses its keys', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'collab-key-pause', { withDoc: true });
    const path = `/nests/${owner.nest.id}/nodes`;

    await owner.page.goto(owner.nest.id);
    await owner.page.enableApiOnly();
    const key = await owner.page.createKey('QA Key Pause');
    expect(await owner.api.statusWithKey(key, 'GET', path)).toBe(200);

    await owner.page.headlessSwitch.click();
    await expect(owner.page.keyLabelInput).toHaveCount(0, WRITE);
    await expect.poll(() => owner.api.statusWithKey(key, 'GET', path), WRITE).not.toBe(200);
  });
});
