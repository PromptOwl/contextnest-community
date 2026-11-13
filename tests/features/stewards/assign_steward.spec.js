/**
 * Assign Steward Test Suite — CN-STEW-001 … CN-STEW-013
 *
 * Page under test: assigning stewards on a nest — "Assign Steward" in the
 * nest's ⋯ menu, the Stewards tab (owner row, list, scope and role filters,
 * each row's Edit Role / Remove), the "Assign Context Steward" and "Edit
 * steward" dialogs, the billing confirmation a paid role raises, and the
 * "Remove this steward?" confirmation — and what an assigned steward can then
 * do: approve or reject in their scope, edit as an Editor, see their Review
 * Queue and My Work, and what the author sees after a decision.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest, with stewardship on (owner/admin edits still
 *   need review). secondary_user is the steward, an Admin (CN-STEW-001/004) or
 *   an Editor/Viewer collaborator (CN-STEW-002/007). A steward needs no share
 *   to act in their scope (CN-STEW-006).
 * - CN-STEW-004/005 also use a QA test account (qa-…@example.com) from the
 *   server's directory as a third person, and skip when there is none.
 *   CN-STEW-005 makes it a Reviewer, which moves a free account to a paid seat
 *   ("This raises what someone is billed"); the nest and the steward row are
 *   deleted after the test.
 * - Preconditions (nests, documents, submissions, steward rows, shares,
 *   archive) are arranged through the REST API (`stewardsApi`); the step under
 *   test goes through the UI. Outcomes are read back in the UI and the API.
 * - Every nest is an AUTO_ name, deleted after the test
 *   (`stewardsApi.deleteCreatedNests()`), and is in the entity registry for
 *   the teardown and the orphan sweeper. The notifications a nest raised are
 *   marked read first.
 * - CN-STEW-011 is a known bug (a tag or document Reviewer's My Work also
 *   lists documents outside their scope) and is skipped until it is fixed.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

test.describe('Assign Steward', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner and create a nest, with stewardship on unless asked
   * otherwise. Skips unless the owner may create nests.
   */
  async function ownerNest(role, commonFunction, suffix, { governed = true } = {}) {
    await role.initialize();
    const api = role.stewardsApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Assign Steward suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    cleanups.push(() => api.settleNotificationsFor(nest.id));
    if (governed) await api.setStewardship(nest.id, true);
    return { api, nest, page: role.stewardsPage, role };
  }

  /** Open secondary_user's session (as a steward, no share needed). */
  async function openSecondary(owner, secondary) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await secondary.initialize();
    const api = secondary.stewardsApi;
    await api.settleInvitesFor(owner.nest.id).catch(() => {});
    cleanups.push(() => api.settleNotificationsFor(owner.nest.id));
    return { api, page: secondary.stewardsPage, role: secondary };
  }

  /** Share the nest with secondary_user at `permission`, or skip when no seat is free. */
  async function share(owner, secondary, permission) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const res = await owner.api.grant(owner.nest.id, secondaryRole.email, permission);
    test.skip(res.status === 402, `No free ${permission} seat on this server.`);
    expect(res.ok, `share as ${permission}: HTTP ${res.status} ${res.data?.error ?? ''}`).toBe(true);
    return openSecondary(owner, secondary);
  }

  /** A third person (a QA test account). Skips when the directory has none. */
  async function thirdPerson(owner) {
    const email = await owner.api.testPerson([primaryRole.email, secondaryRole?.email ?? '']);
    test.skip(!email, 'No other qa-…@example.com test account on this server.');
    return email;
  }

  /** A document submitted for review, titled after the nest so its notifications are unique. */
  async function pending(owner, label, tags) {
    return owner.api.createPendingDoc(owner.nest.id, { title: `${owner.nest.name} ${label}`, tags });
  }

  // ── Who can assign ─────────────────────────────────────────────────────────

  test('CN-STEW-001: Verify that the owner and a nest Admin can open Assign Steward from the nest\'s ⋯ menu, that an empty Stewards tab shows "No delegated stewards yet…" with "Assign your first steward", and that the owner is shown as "Nest Owner" with "Implicit Authority"', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-open');
    const { page, nest } = owner;

    expect(await page.nestMenuItems(nest.id)).toContain('Assign Steward');
    await page.openAssignFromMenu(nest.id);
    await expect(page.assignDialog).toBeVisible();
    await page.page.keyboard.press('Escape');

    await page.gotoStewards(nest.id);
    await expect(page.ownerRow).toContainText(primaryRole.email);
    await expect(page.ownerRow).toContainText('Nest Owner');
    await expect(page.ownerRow).toContainText('Implicit Authority');
    await expect(page.emptyRoster).toBeVisible();
    await page.assignFirstButton.click();
    await expect(page.assignDialog).toBeVisible();
    await page.page.keyboard.press('Escape');

    // A nest Admin gets the same entry.
    const admin = await share(owner, secondary_user, 'admin');
    expect(await admin.page.nestMenuItems(nest.id)).toContain('Assign Steward');
    await admin.page.openAssignFromMenu(nest.id);
    await expect(admin.page.assignDialog).toBeVisible();
  });

  test('CN-STEW-002: Verify that Assign Steward and the Stewards tab aren\'t available when stewardship is off, in an archived nest, or to an Editor or Viewer', async ({ primary_user, secondary_user, commonFunction }) => {
    // Stewardship off.
    const off = await ownerNest(primary_user, commonFunction, 'stew-off', { governed: false });
    expect(await off.page.nestMenuItems(off.nest.id)).not.toContain('Assign Steward');
    expect(await off.page.tabNames(off.nest.id)).not.toContain('Stewards');

    // An Editor and a Viewer.
    for (const permission of ['write', 'read']) {
      const owner = await ownerNest(primary_user, commonFunction, `stew-${permission}`);
      const member = await share(owner, secondary_user, permission);
      expect(await member.page.nestMenuItems(owner.nest.id)).not.toContain('Assign Steward');
      expect(await member.page.tabNames(owner.nest.id)).not.toContain('Stewards');
    }

    // Archived, even for the owner.
    const archived = await ownerNest(primary_user, commonFunction, 'stew-archived');
    await archived.api.archiveNest(archived.nest.id);
    cleanups.push(() => archived.api.restoreNest(archived.nest.id));
    expect(await archived.page.nestMenuItems(archived.nest.id)).not.toContain('Assign Steward');
    expect(await archived.page.tabNames(archived.nest.id)).not.toContain('Stewards');
  });

  // ── The dialog and its checks ──────────────────────────────────────────────

  test('CN-STEW-003: Verify that the dialog starts with Scope "Tag" and Role "Reviewer" (or "Entire Nest" with Tag disabled when the nest has no tags), and that a steward can\'t be assigned without a valid email or without choosing a tag or document for those scopes', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-form');
    const { page, api, nest } = owner;
    await api.createDoc(nest.id, { title: 'Tagged Doc', tags: ['qa'] });

    await page.openAssignFromMenu(nest.id);
    await expect(page.scopeSelect()).toHaveText('Tag');
    await expect(page.roleSelect()).toContainText('Reviewer');
    const assign = page.assignDialog.getByRole('button', { name: 'Assign Steward', exact: true });
    await expect(assign).toBeDisabled();

    await page.emailInput.fill('not-an-email');
    await assign.click();
    await expect(page.dialogError()).toHaveText('Enter a valid email address.');

    await page.emailInput.fill(secondaryRole?.email ?? 'qa-someone@example.com');
    await assign.click();
    await expect(page.dialogError()).toHaveText('Please specify the tag target');
    await page.chooseScope('Document');
    await assign.click();
    await expect(page.dialogError()).toHaveText('Please specify the document target');
    await expect(page.assignDialog).toBeVisible();
    expect(await api.stewardRows(nest.id)).toEqual([]);
    await page.page.keyboard.press('Escape');

    // A nest with no tags starts on Entire Nest, and Tag can't be picked.
    const bare = await ownerNest(primary_user, commonFunction, 'stew-notags');
    await bare.page.openAssignFromMenu(bare.nest.id);
    await expect(bare.page.scopeSelect()).toHaveText('Entire Nest', WRITE);
    await bare.page.scopeSelect().click();
    await expect(bare.page.page.getByRole('option', { name: 'Tag', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await bare.page.page.keyboard.press('Escape');
  });

  test('CN-STEW-004: Verify that the owner can\'t be assigned as a steward, an Admin can\'t assign themselves, and the same person can\'t be assigned to the same scope twice', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-refuse');
    const { page, api, nest } = owner;
    const third = await thirdPerson(owner);

    // The owner.
    await page.openAssignFromMenu(nest.id);
    await page.fillAssign({ email: primaryRole.email, scope: 'Entire Nest', role: 'Viewer' });
    await expect(page.ownerNote).toBeVisible();
    await page.submitAssign();
    await expect(page.dialogError()).toContainText('The nest owner already holds full stewardship and approval authority', WRITE);
    await page.page.keyboard.press('Escape');

    // The same person and scope twice (Viewer is a free role, so no billing step).
    await page.assign(nest.id, { email: third, scope: 'Entire Nest', role: 'Viewer' });
    await expect(page.assignDialog).toBeHidden(WRITE);
    await page.assign(nest.id, { email: third, scope: 'Entire Nest', role: 'Viewer' });
    await expect(page.dialogError()).toContainText(`"${third}" is already a steward of this nest with the "viewer" role`, WRITE);
    await expect(page.dialogError()).toContainText('Remove the existing assignment first');
    await page.page.keyboard.press('Escape');
    expect((await api.stewardRows(nest.id)).filter((s) => s.userEmail === third)).toHaveLength(1);

    // An Admin adding themselves.
    const admin = await share(owner, secondary_user, 'admin');
    await admin.page.assign(nest.id, { email: secondaryRole.email, scope: 'Entire Nest', role: 'Viewer' });
    await expect(admin.page.dialogError()).toHaveText("You already manage this nest, so you can't add yourself as a steward.", WRITE);
    expect(await api.stewardOf(nest.id, secondaryRole.email)).toBeNull();
  });

  // ── Assigning, and the list ────────────────────────────────────────────────

  test('CN-STEW-005: Verify that a steward can be assigned to the entire nest, a tag or a document and appears in the Stewards list with the right scope and role, that the scope and role filters show only matching rows, and that making a free account a Reviewer shows "This raises what someone is billed", where Cancel assigns nothing and "Confirm and save" assigns them', async ({ primary_user, secondary_user, commonFunction }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'stew-assign');
    const { page, api, nest } = owner;
    // A QA account still on the free seat (one holding a paid role elsewhere
    // on the server would be assigned without the billing step).
    const third = await api.freeTestPerson(nest.id, [primaryRole.email, secondaryRole.email]);
    test.skip(!third, 'No qa-…@example.com test account on the free seat on this server.');
    await api.createDoc(nest.id, { title: 'Tagged Doc', tags: ['qa'] });
    await api.createDoc(nest.id, { title: 'Doc One' });

    // A free account as Reviewer asks first; Cancel assigns nothing.
    await page.assign(nest.id, { email: third, scope: 'Entire Nest', role: 'Reviewer' });
    await expect(page.billingDialog).toBeVisible(WRITE);
    await expect(page.billingDialog).toContainText(`${third}: Viewer (free) → User`);
    await page.billingCancel.click();
    await expect(page.billingDialog).toBeHidden();
    expect(await api.stewardOf(nest.id, third)).toBeNull();
    if (await page.assignDialog.isVisible()) await page.page.keyboard.press('Escape');

    // "Confirm and save" assigns them.
    await page.assign(nest.id, { email: third, scope: 'Entire Nest', role: 'Reviewer' });
    await page.billingConfirm.click();
    const confirmed = await expect
      .poll(async () => (await api.stewardOf(nest.id, third))?.role ?? null, { timeout: 30_000 })
      .toBe('reviewer')
      .then(() => true, () => false);
    test.skip(!confirmed && (await page.dialogError().isVisible()), 'No free paid seat on this server.');
    expect(confirmed).toBe(true);

    // Tag and Document scope.
    await page.assign(nest.id, { email: secondaryRole.email, scope: 'Tag', target: '#qa', role: 'Reviewer' });
    if (await page.billingDialog.isVisible({ timeout: 3_000 }).catch(() => false)) await page.billingConfirm.click();
    await expect(page.assignDialog).toBeHidden(WRITE);
    await page.assign(nest.id, { email: secondaryRole.email, scope: 'Document', target: 'Doc One', role: 'Editor' });
    await expect(page.assignDialog).toBeHidden(WRITE);
    const rows = (await api.stewardRows(nest.id)).map((s) => `${s.userEmail}|${s.scope}|${s.tagName ?? s.nodePattern ?? ''}|${s.role}`).sort();
    expect(rows).toEqual(
      [
        `${third}|nest||reviewer`,
        `${secondaryRole.email}|tag|qa|reviewer`,
        `${secondaryRole.email}|document|nodes/doc-one|editor`,
      ].sort()
    );

    // The list and its filters.
    await page.gotoStewards(nest.id);
    await expect(page.rosterRows).toHaveCount(3);
    await page.scopeFilter('Tag').click();
    await expect(page.rosterRows).toHaveCount(1);
    await expect(page.rosterRows.first()).toContainText(secondaryRole.email);
    await page.scopeFilter('Document').click();
    await expect(page.rosterRows).toHaveCount(1);
    await expect(page.rosterRows.first()).toContainText('editor');
    await page.scopeFilter('Nest').click();
    await expect(page.rosterRows).toHaveCount(1);
    await expect(page.rosterRows.first()).toContainText(third);
    await page.scopeFilter('All').click();
    await page.filterByRole('Reviewer');
    await expect(page.rosterRows).toHaveCount(2);
    await page.filterByRole('Editor');
    await expect(page.rosterRows).toHaveCount(1);
    await page.filterByRole('Viewer');
    await expect(page.rosterRows).toHaveCount(0);
    await page.filterByRole('All');
    await expect(page.rosterRows).toHaveCount(3);
  });

  // ── What a steward can do ──────────────────────────────────────────────────

  test('CN-STEW-006: Verify that a tag steward can approve only documents with that tag, and a document steward only that document, even without being shared on the nest', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-scope');
    const { api, nest } = owner;
    const tagged = await pending(owner, 'Tagged', ['qa']);
    const one = await pending(owner, 'One');
    const plain = await pending(owner, 'Plain');
    const steward = await openSecondary(owner, secondary_user);
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'tag', tag: 'qa' });

    // A tag Reviewer, not shared on the nest.
    await steward.page.gotoDocument(nest.id, tagged.id);
    await expect(steward.page.approveButton).toBeVisible(WRITE);
    for (const doc of [one, plain]) {
      await steward.page.gotoDocument(nest.id, doc.id);
      await expect(steward.page.rejectButton.or(steward.page.cantApproveOwn)).toHaveCount(0);
      await expect(steward.page.approveButton).toHaveCount(0);
    }

    // The same person as a document Reviewer.
    const row = await api.stewardOf(nest.id, secondaryRole.email);
    await api.updateSteward(nest.id, row.id, { scope: 'document', nodeId: one.id });
    await steward.page.gotoDocument(nest.id, one.id);
    await expect(steward.page.approveButton).toBeVisible(WRITE);
    await steward.page.gotoDocument(nest.id, tagged.id);
    await expect(steward.page.approveButton).toHaveCount(0);
  });

  test('CN-STEW-007: Verify that a Viewer steward can only read, an Editor steward can edit and save a draft but not approve, a Reviewer steward can approve and reject, and no steward can approve their own submitted document', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-roles', { governed: false });
    const { api, nest } = owner;
    // Published before stewardship is switched on, then one waiting for review.
    const published = await api.createDoc(nest.id, { title: `${nest.name} Published` });
    await api.setStewardship(nest.id, true);
    const waiting = await pending(owner, 'Waiting');
    const steward = await openSecondary(owner, secondary_user);
    const sp = steward.page;
    const setRole = async (role) => {
      const old = await api.stewardOf(nest.id, secondaryRole.email);
      if (old) await api.removeSteward(nest.id, old.id);
      await api.addSteward(nest.id, { email: secondaryRole.email, role, scope: 'nest' });
    };

    // Viewer: reads only.
    await setRole('viewer');
    await sp.gotoDocument(nest.id, published.id);
    await expect(sp.page.getByRole('heading', { name: published.title }).first()).toBeVisible();
    await expect(sp.editButton).toHaveCount(0);
    await expect(sp.saveDraftButton).toHaveCount(0);
    await sp.gotoDocument(nest.id, waiting.id);
    await expect(sp.approveButton).toHaveCount(0);

    // Editor: edits and saves a draft, can't approve.
    await setRole('editor');
    await sp.gotoDocument(nest.id, waiting.id);
    await expect(sp.approveButton).toHaveCount(0);
    await sp.gotoDocument(nest.id, published.id);
    await sp.typeInDocument('Editor steward change');
    await expect(sp.page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await sp.saveDraftButton.click();
    await expect.poll(async () => api.statusOf(nest.id, published.id), WRITE).toBe('draft');

    // Reviewer: approves and rejects.
    await setRole('reviewer');
    await sp.gotoDocument(nest.id, waiting.id);
    await expect(sp.approveButton).toBeVisible(WRITE);
    await expect(sp.rejectButton).toBeVisible();

    // Never their own submission.
    await share(owner, secondary_user, 'write');
    const own = await steward.api.createDoc(nest.id, { title: `${nest.name} Own` });
    await steward.api.submitForReview(nest.id, own.id);
    await sp.gotoDocument(nest.id, own.id);
    await expect(sp.cantApproveOwn).toBeVisible(WRITE);
    await expect(sp.approveButton).toHaveCount(0);
    expect(await steward.api.canApprove(nest.id, own.id)).toBe(false);
  });

  // ── Edit Role and Remove ───────────────────────────────────────────────────

  test('CN-STEW-008: Verify that Edit Role shows the email fixed and the current role and scope filled in, that Save with no change just closes, and that a changed role or scope saves with "Steward updated" and takes effect', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-edit');
    const { page, api, nest } = owner;
    const tagged = await pending(owner, 'Tagged', ['qa']);
    const one = await pending(owner, 'One');
    const steward = await openSecondary(owner, secondary_user);
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'tag', tag: 'qa' });

    await page.gotoStewards(nest.id);
    await page.rowAction(secondaryRole.email, 'Edit Role');
    await expect(page.editDialog).toBeVisible();
    await expect(page.editDialog).toContainText(secondaryRole.email);
    await expect(page.editDialog.getByTestId('steward-email-input')).toHaveCount(0);
    await expect(page.scopeSelect(page.editDialog)).toHaveText('Tag');
    await expect(page.roleSelect(page.editDialog)).toContainText('Reviewer');

    // Save with nothing changed just closes.
    await page.editDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.editDialog).toBeHidden();

    // Move them to one document.
    await page.rowAction(secondaryRole.email, 'Edit Role');
    await page.chooseScope('Document', page.editDialog);
    await page.chooseTarget('Document', one.title);
    await page.editDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.toasts.filter({ hasText: 'Steward updated' }).first()).toBeVisible(WRITE);
    await expect
      .poll(async () => (await api.stewardOf(nest.id, secondaryRole.email))?.nodePattern ?? null, WRITE)
      .toBe(one.id);

    // It takes effect.
    await steward.page.gotoDocument(nest.id, one.id);
    await expect(steward.page.approveButton).toBeVisible(WRITE);
    await steward.page.gotoDocument(nest.id, tagged.id);
    await expect(steward.page.approveButton).toHaveCount(0);
  });

  test('CN-STEW-009: Verify that removing a steward asks "Remove this steward?", that Cancel keeps them, and that after removal they can no longer approve', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-remove');
    const { page, api, nest } = owner;
    const tagged = await pending(owner, 'Tagged', ['qa']);
    // Shared as a Viewer, so they can still open the document once they are
    // no longer a steward (a steward-only person loses all access).
    const steward = await share(owner, secondary_user, 'read');
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'tag', tag: 'qa' });

    await page.gotoStewards(nest.id);
    await page.rowAction(secondaryRole.email, 'Remove');
    await expect(page.removeDialog).toContainText('They lose approval rights immediately. The user account and any documents stay intact.');
    await page.removeCancel.click();
    await expect(page.removeDialog).toBeHidden();
    expect(await api.stewardOf(nest.id, secondaryRole.email)).not.toBeNull();

    await page.rowAction(secondaryRole.email, 'Remove');
    await page.removeConfirm.click();
    await expect(page.stewardRow(secondaryRole.email)).toHaveCount(0, WRITE);
    expect(await api.stewardOf(nest.id, secondaryRole.email)).toBeNull();

    await steward.page.gotoDocument(nest.id, tagged.id);
    await expect(steward.page.approveButton).toHaveCount(0);
    expect(await steward.api.canApprove(nest.id, tagged.id)).toBe(false);
  });

  // ── The Reviewer's side ────────────────────────────────────────────────────

  test("CN-STEW-010: Verify that a tag or document Reviewer's Review Queue shows only the pending documents in their scope, with the count on the tab", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-queue');
    const { api, nest } = owner;
    const tagged = await pending(owner, 'Tagged', ['qa']);
    const one = await pending(owner, 'One');
    const plain = await pending(owner, 'Plain');
    await openSecondary(owner, secondary_user);
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'tag', tag: 'qa' });
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'document', nodeId: one.id });

    const queue = secondary_user.reviewQueuePage;
    await queue.goto(nest.id);
    await expect(queue.row(tagged.title)).toHaveCount(1, WRITE);
    await expect(queue.row(one.title)).toHaveCount(1);
    await expect(queue.row(plain.title)).toHaveCount(0);
    await expect(queue.reviewTab).toContainText('2');
  });

  test("CN-STEW-011: Verify that a tag or document Reviewer's My Work lists only the pending documents in their scope, with Approve and Reject (known bug: currently also lists out-of-scope documents)", async ({ primary_user, secondary_user, commonFunction }) => {
    // Skipped: known bug. My Work decides "can review" for the whole nest, not
    // per document, so it also lists documents outside the Reviewer's scope
    // (and Approve on them fails). Remove this line once it is fixed.
    test.skip(true, "Known bug: a tag/document Reviewer's My Work also lists out-of-scope documents");
    const owner = await ownerNest(primary_user, commonFunction, 'stew-mywork');
    const { api, nest } = owner;
    const tagged = await pending(owner, 'Tagged', ['qa']);
    const plain = await pending(owner, 'Plain');
    const steward = await openSecondary(owner, secondary_user);
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'tag', tag: 'qa' });
    await steward.api.waitForWork((w) => (w.items ?? []).some((i) => i.nest_id === nest.id), { what: 'the new reviews' });

    const myWork = secondary_user.myWorkPage;
    await myWork.goto();
    await expect(myWork.workRow(tagged.title)).toHaveCount(1, WRITE);
    await expect(myWork.rowApprove(tagged.title)).toBeVisible();
    await expect(myWork.rowReject(tagged.title)).toBeVisible();
    await expect(myWork.workRow(plain.title)).toHaveCount(0);
  });

  test('CN-STEW-012: Verify that a Reviewer approving a document in their scope ("Approve Document", note optional) publishes it, removes it from their queue, and the author sees Published and "‹Doc› was approved by ‹reviewer›"', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-approve');
    const { page, api, nest } = owner;
    const doc = await pending(owner, 'Approve Me', ['qa']);
    const steward = await openSecondary(owner, secondary_user);
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'tag', tag: 'qa' });

    await steward.page.gotoDocument(nest.id, doc.id);
    await steward.page.approveButton.click();
    await expect(steward.page.approveDialog).toContainText('Note (optional)');
    await steward.page.approveDialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(async () => api.statusOf(nest.id, doc.id), WRITE).toBe('published');

    const queue = secondary_user.reviewQueuePage;
    await queue.goto(nest.id);
    await queue.waitForQueueLoaded();
    await expect(queue.row(doc.title)).toHaveCount(0);

    await page.gotoDocument(nest.id, doc.id);
    await expect(page.publishedBadge).toBeVisible();
    const inbox = primary_user.myWorkPage;
    await inbox.goto();
    await expect(inbox.notificationRow(`"${doc.title}" was approved by ${secondaryRole.email}`)).toHaveCount(1, WRITE);
  });

  test('CN-STEW-013: Verify that a Reviewer can\'t reject without feedback ("Please provide feedback explaining why this document is being rejected."), and that rejecting with a reason marks the document Rejected, removes it from the queue, notifies the author with "‹Doc› was rejected by ‹reviewer›", shows "Rejected (‹reason›)" in the document\'s Activity panel, and lets the author edit it again', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'stew-reject');
    const { page, api, nest } = owner;
    const doc = await pending(owner, 'Reject Me', ['qa']);
    const steward = await openSecondary(owner, secondary_user);
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'tag', tag: 'qa' });
    const reason = 'Please add the missing section';
    const sp = steward.page;

    await sp.gotoDocument(nest.id, doc.id);
    await sp.rejectButton.click();
    const reject = sp.rejectDialog.getByRole('button', { name: 'Reject', exact: true });
    await reject.click();
    await expect(sp.rejectDialog).toContainText('Please provide feedback explaining why this document is being rejected.');
    expect(await api.statusOf(nest.id, doc.id)).toBe('pending_review');

    await sp.rejectDialog.locator('textarea').fill(reason);
    await reject.click();
    await expect.poll(async () => api.statusOf(nest.id, doc.id), WRITE).toBe('rejected');

    const queue = secondary_user.reviewQueuePage;
    await queue.goto(nest.id);
    await queue.waitForQueueLoaded();
    await expect(queue.row(doc.title)).toHaveCount(0);

    // The author.
    await page.gotoDocument(nest.id, doc.id);
    await expect(page.rejectedBadge).toBeVisible();
    expect(await page.activityText()).toContain(`Rejected (${reason})`);
    await page.typeInDocument('Author fix');
    await page.saveDraftButton.click();
    await expect.poll(async () => api.statusOf(nest.id, doc.id), WRITE).toBe('draft');
    const inbox = primary_user.myWorkPage;
    await inbox.goto();
    await expect(inbox.notificationRow(`"${doc.title}" was rejected by ${secondaryRole.email}`)).toHaveCount(1, WRITE);
  });
});
