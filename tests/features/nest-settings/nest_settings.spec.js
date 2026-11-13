/**
 * Nest Settings Test Suite — CN-NSET-001 … CN-NSET-023
 *
 * Page under test: the Nest settings dialog (ui/src/components/NestSettingsModal.tsx)
 * opened from the nest's ⋯ menu — Stewardship & Approval Workflow,
 * Auto-publish owner & admin edits, Review prime documents only and Prime
 * tags, Always-include tags, Creators review their own documents, Review SLA,
 * Record what people and agents read, Require confirmation for agent writes
 * (with "Keys that skip the gate"), and the Systems panel — and where each
 * setting shows up: the document page (status, Publish / Submit for review,
 * "Always include", "Prime document", "Can approve:", Activity), the Stewards
 * and Review Queue tabs, and the "Agent writes awaiting confirmation" banner.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest (and is a server superadmin on dev, which
 *   CN-NSET-018…020 need). secondary_user is a nest Admin, an Editor, a Viewer,
 *   a reviewer steward, or the agent whose API key writes (CN-NSET-018…020).
 *   Cases that need a paid seat for it skip when none is free.
 * - Preconditions (nests, documents, submissions, stewards, shares, archive,
 *   an API key) are arranged through the REST API (`nestSettingsApi`); the step
 *   under test goes through the UI. Outcomes are read back in the UI and the API.
 * - Every nest is an AUTO_ name, deleted after the test
 *   (`nestSettingsApi.deleteCreatedNests()`), and is in the entity registry for
 *   the teardown and the orphan sweeper. API keys and Systems are revoked by
 *   the case that made them. The notifications a nest raised are marked read.
 * - CN-NSET-015 is a known bug (a creator who is their document's reviewer
 *   gets no Edit or Submit on it) and is skipped until it is fixed.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

// The rows of the Nest settings dialog, by their labels.
const STEWARDSHIP = 'Stewardship & Approval Workflow';
const AUTO_PUBLISH = 'Auto-publish owner';
const PRIME_ONLY = 'Review prime documents only';
const CREATOR_REVIEW = 'Creators review their own documents';
const READ_LOG = 'Record what people and agents read';
const AGENT_WRITES = 'Require confirmation for agent writes';

test.describe('Nest Settings', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner and create a nest, with stewardship on when asked
   * (owner/admin edits still need review). Skips unless the owner may create
   * nests.
   */
  async function ownerNest(role, commonFunction, suffix, { governed = false } = {}) {
    await role.initialize();
    const api = role.nestSettingsApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Nest Settings suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    cleanups.push(() => api.settleNotificationsFor(nest.id));
    if (governed) await api.setStewardship(nest.id, true);
    return { api, nest, page: role.nestSettingsPage, role };
  }

  /** Share the nest with secondary_user at `permission`, or skip when no seat is free. */
  async function share(owner, secondary, permission) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const res = await owner.api.grant(owner.nest.id, secondaryRole.email, permission);
    test.skip(res.status === 402, `No free ${permission} seat on this server.`);
    expect(res.ok, `share as ${permission}: HTTP ${res.status} ${res.data?.error ?? ''}`).toBe(true);
    await secondary.initialize();
    const api = secondary.nestSettingsApi;
    await api.settleInvitesFor(owner.nest.id).catch(() => {});
    cleanups.push(() => api.settleNotificationsFor(owner.nest.id));
    return { api, page: secondary.nestSettingsPage, role: secondary };
  }

  /** A saved setting, polled until it lands. */
  const saved = (owner, key) => async () => (await owner.api.settings(owner.nest.id))?.[key] ?? null;

  /** An API key for secondary_user (the agent), revoked after the test. */
  async function agentKey(agent, commonFunction) {
    const key = await agent.api.createApiKey(commonFunction.generateEntityName('nset-agent'));
    cleanups.push(() => agent.api.revokeApiKey(key.id));
    return key;
  }

  /** Switch agent-write confirmation on through the dialog (superadmin only). */
  async function holdAgentWrites(owner) {
    test.skip(!(await owner.api.isServerAdmin()), 'Only a server superadmin can switch on agent-write confirmation.');
    await owner.page.change(owner.nest.id, { [AGENT_WRITES]: true });
    await expect.poll(saved(owner, 'require_push_confirmation'), WRITE).toBe(true);
  }

  /** Revoke every System that works in this nest, after the test. */
  function revokeSystemsAfter(owner) {
    cleanups.push(async () => {
      for (const s of await owner.api.nestSystems(owner.nest.id)) await owner.api.revokeSystem(s.id);
    });
  }

  // ── Who can open it ────────────────────────────────────────────────────────

  test('CN-NSET-001: Verify that the owner can open Nest settings from the ⋯ menu and sees the default settings, and that extra sections appear only when stewardship is on', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-open');
    const { page, api, nest } = owner;

    expect(await page.nestMenuItems(nest.id)).toContain('Nest settings');
    await page.open(nest.id);
    await expect(page.dialog).toContainText(`Settings: ${nest.name}`);
    await expect(page.switchFor(STEWARDSHIP)).toHaveAttribute('aria-checked', 'false');
    await expect(page.switchFor(AUTO_PUBLISH)).toHaveAttribute('aria-checked', 'false');
    await expect(page.alwaysIncludeInput).toHaveValue('always-include');
    await expect(page.switchFor(READ_LOG)).toHaveAttribute('aria-checked', 'true');
    await expect(page.switchFor(AGENT_WRITES)).toHaveAttribute('aria-checked', 'false');

    // Prime, Creators review and Review SLA only once stewardship is on.
    for (const section of [page.primeSection, page.creatorSection, page.slaSection]) await expect(section).toHaveCount(0);
    await page.switchFor(STEWARDSHIP).click();
    for (const section of [page.primeSection, page.creatorSection, page.slaSection]) await expect(section).toBeVisible();
    await page.cancelButton.click();
    await expect(page.dialog).toBeHidden();
    expect((await api.settings(nest.id)).stewardship_enabled).toBe(false);
  });

  test("CN-NSET-002: Verify that Editors and Viewers can't open Nest settings, and an archived nest doesn't offer it", async ({ primary_user, secondary_user, commonFunction }) => {
    for (const permission of ['write', 'read']) {
      const owner = await ownerNest(primary_user, commonFunction, `nset-${permission}`);
      const member = await share(owner, secondary_user, permission);
      expect(await member.page.nestMenuItems(owner.nest.id)).not.toContain('Nest settings');
    }

    const archived = await ownerNest(primary_user, commonFunction, 'nset-archived');
    await archived.api.archiveNest(archived.nest.id);
    cleanups.push(() => archived.api.restoreNest(archived.nest.id));
    expect(await archived.page.nestMenuItems(archived.nest.id)).not.toContain('Nest settings');
  });

  test("CN-NSET-003: Verify that a nest Admin can open Nest settings, can turn read recording on but not off, and can't change agent-write confirmation", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-admin');
    await owner.api.setSettings(owner.nest.id, { access_log_enabled: false });
    const admin = await share(owner, secondary_user, 'admin');
    test.skip(await admin.api.isServerAdmin(), "secondary_user is a server admin here, so it isn't limited like a nest Admin.");
    const ap = admin.page;

    expect(await ap.nestMenuItems(owner.nest.id)).toContain('Nest settings');
    await ap.open(owner.nest.id);
    await expect(ap.switchFor(READ_LOG)).toHaveAttribute('aria-checked', 'false');
    await ap.switchFor(READ_LOG).click();
    await ap.save();
    await expect.poll(saved(owner, 'access_log_enabled'), WRITE).toBe(true);

    // On again, it's locked for the Admin; agent writes are superadmin-only.
    await ap.open(owner.nest.id);
    await expect(ap.switchFor(READ_LOG)).toHaveAttribute('aria-checked', 'true');
    await expect(ap.switchFor(READ_LOG)).toBeDisabled();
    await expect(ap.switchFor(AGENT_WRITES)).toBeDisabled();
    await expect(ap.superadminNote).toBeVisible();
    await ap.cancelButton.click();
  });

  test("CN-NSET-004: Verify that a nest Admin can't turn stewardship off", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-admin-off', { governed: true });
    const admin = await share(owner, secondary_user, 'admin');
    const ap = admin.page;

    await ap.open(owner.nest.id);
    await ap.switchFor(STEWARDSHIP).click();
    await expect(ap.disableWarning).toBeVisible();
    await ap.disableAck.click();
    await ap.saveButton.click();
    await expect(ap.dialogError()).toContainText('Only the nest owner or the server license-admin can disable stewardship', WRITE);
    await expect(ap.dialog).toBeVisible();
    expect((await owner.api.settings(owner.nest.id)).stewardship_enabled).toBe(true);
  });

  // ── Saving ─────────────────────────────────────────────────────────────────

  test('CN-NSET-005: Verify that saved settings stay after a reload, tags are cleaned up, and Cancel discards changes', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-save');
    const { page, api, nest } = owner;

    await page.open(nest.id);
    await page.setSwitch(STEWARDSHIP, true);
    await page.setSwitch(AUTO_PUBLISH, true);
    await page.alwaysIncludeInput.fill('always-include, #FAQ , faq');
    await page.primeTagsInput.fill('#QA-Prime , qa-prime, Docs');
    await page.save();
    await expect.poll(saved(owner, 'stewardship_enabled'), WRITE).toBe(true);
    const after = await api.settings(nest.id);
    expect(after.allow_self_approve).toBe(true);
    expect(after.always_include_tags).toEqual(['always-include', 'faq']);
    expect(after.prime_tags).toEqual(['qa-prime', 'docs']);

    // Kept after a reload.
    await page.open(nest.id);
    await expect(page.switchFor(STEWARDSHIP)).toHaveAttribute('aria-checked', 'true');
    await expect(page.switchFor(AUTO_PUBLISH)).toHaveAttribute('aria-checked', 'true');
    await expect(page.alwaysIncludeInput).toHaveValue('always-include, faq');
    await expect(page.primeTagsInput).toHaveValue('qa-prime, docs');

    // Cancel keeps nothing.
    await page.switchFor(AUTO_PUBLISH).click();
    await page.alwaysIncludeInput.fill('something-else');
    await page.cancelButton.click();
    await expect(page.dialog).toBeHidden();
    const kept = await api.settings(nest.id);
    expect(kept.allow_self_approve).toBe(true);
    expect(kept.always_include_tags).toEqual(['always-include', 'faq']);
  });

  // ── Stewardship & Approval Workflow ────────────────────────────────────────

  test('CN-NSET-006: Verify that with stewardship on, new documents start as Drafts and need approval, and with stewardship off they publish straight away', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-workflow');
    const { page, api, nest } = owner;

    // Off: saved straight to Published.
    const free = await api.createDoc(nest.id, { title: `${nest.name} Off` });
    expect(await api.statusOf(nest.id, free.id)).toBe('published');
    await page.gotoDocument(nest.id, free.id);
    await expect(page.autoPublishedBadge).toBeVisible();

    // On: a Draft that goes through approval.
    await page.change(nest.id, { [STEWARDSHIP]: true });
    await expect.poll(saved(owner, 'stewardship_enabled'), WRITE).toBe(true);
    const draft = await api.createDoc(nest.id, { title: `${nest.name} On` });
    await page.gotoDocument(nest.id, draft.id);
    await expect(page.draftBadge).toBeVisible();
    await expect(page.autoPublishedBadge).toHaveCount(0);
    await page.submitButton.click();
    await expect(page.submitDialog).toContainText(`Publish “${draft.title}” (requires approval)`);
    await page.submitForApproval.click();
    await expect.poll(async () => api.statusOf(nest.id, draft.id), WRITE).toBe('pending_review');
  });

  test('CN-NSET-007: Verify that turning stewardship on keeps published documents published', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-keep');
    const { page, api, nest } = owner;
    const doc = await api.createDoc(nest.id, { title: `${nest.name} Published` });
    expect(await api.statusOf(nest.id, doc.id)).toBe('published');

    await page.change(nest.id, { [STEWARDSHIP]: true });
    await expect.poll(saved(owner, 'stewardship_enabled'), WRITE).toBe(true);
    expect(await api.statusOf(nest.id, doc.id)).toBe('published');
    await page.gotoDocument(nest.id, doc.id);
    await expect(page.publishedBadge).toBeVisible();
    await expect(page.draftBadge).toHaveCount(0);
  });

  test('CN-NSET-008: Verify that turning stewardship off needs a confirmation tick, and removes stewards and pending reviews but keeps collaborators and review history', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-off', { governed: true });
    const { page, api, nest } = owner;
    const reviewer = await share(owner, secondary_user, 'read');
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'nest' });
    const waiting = await api.createPendingDoc(nest.id, { title: `${nest.name} Waiting` });
    const approved = await api.createPendingDoc(nest.id, { title: `${nest.name} Approved` });
    await reviewer.api.approve(nest.id, approved.id);
    const rejected = await api.createPendingDoc(nest.id, { title: `${nest.name} Rejected` });
    await reviewer.api.expectOk('POST', `/nests/${nest.id}/nodes/${rejected.id}/reject`, { note: 'Not yet' });

    await page.open(nest.id);
    await page.switchFor(STEWARDSHIP).click();
    await expect(page.disableWarning).toBeVisible();
    await expect(page.saveButton).toBeDisabled();
    await page.disableAck.click();
    await expect(page.saveButton).toBeEnabled();
    await page.save();
    await expect.poll(saved(owner, 'stewardship_enabled'), WRITE).toBe(false);

    // Stewards and pending reviews are gone.
    expect(await api.stewardRows(nest.id)).toEqual([]);
    expect(await api.statusOf(nest.id, waiting.id)).toBe('draft');
    const sp = primary_user.stewardsPage;
    expect(await sp.tabNames(nest.id)).not.toContain('Stewards');
    await page.page.goto(`/nest/${nest.id}?tab=review`);
    await expect(page.main.getByText('Stewardship is off', { exact: true })).toBeVisible(WRITE);
    await expect(page.main.getByText(waiting.title)).toHaveCount(0);

    // Collaborators and review history are kept.
    expect(await api.collaborator(nest.id, secondaryRole.email)).not.toBeNull();
    await page.gotoDocument(nest.id, approved.id);
    expect(await page.activityText()).toContain('Approved');
    await page.gotoDocument(nest.id, rejected.id);
    expect(await page.activityText()).toContain('Rejected (Not yet)');
  });

  // ── Auto-publish owner & admin edits, prime documents ──────────────────────

  test("CN-NSET-009: Verify that with auto-publish on, the owner's and Admin's edits publish straight away, Editors still need review, and turning it off unpublishes nothing", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-autopub');
    const { page, api, nest } = owner;
    // Published before stewardship is switched on.
    const doc = await api.createDoc(nest.id, { title: `${nest.name} Doc` });
    await api.setStewardship(nest.id, true);
    await page.change(nest.id, { [AUTO_PUBLISH]: true });
    await expect.poll(saved(owner, 'allow_self_approve'), WRITE).toBe(true);
    const version = async () => (await api.node(nest.id, doc.id)).version;

    // The owner's edit publishes straight away.
    await page.gotoDocument(nest.id, doc.id);
    await page.typeInDocument('Owner edit');
    await expect(page.submitButton).toHaveCount(0);
    await page.publishButton.click();
    await expect.poll(version, WRITE).toBe(2);
    expect(await api.statusOf(nest.id, doc.id)).toBe('published');

    // So does a nest Admin's.
    const admin = await share(owner, secondary_user, 'admin');
    await admin.page.gotoDocument(nest.id, doc.id);
    await admin.page.typeInDocument('Admin edit');
    await expect(admin.page.submitButton).toHaveCount(0);
    await admin.page.publishButton.click();
    await expect.poll(version, WRITE).toBe(3);
    expect(await api.statusOf(nest.id, doc.id)).toBe('published');

    // An Editor still goes through review.
    await api.removePerson(nest.id, secondaryRole.email);
    const editor = await share(owner, secondary_user, 'write');
    await editor.page.gotoDocument(nest.id, doc.id);
    await editor.page.typeInDocument('Editor edit');
    await expect(editor.page.submitButton).toBeVisible();
    await expect(editor.page.publishButton).toHaveCount(0);

    // Turning it off unpublishes nothing.
    await page.change(nest.id, { [AUTO_PUBLISH]: false });
    await expect.poll(saved(owner, 'allow_self_approve'), WRITE).toBe(false);
    expect(await api.statusOf(nest.id, doc.id)).toBe('published');
  });

  test('CN-NSET-010: Verify that prime documents still need approval even with auto-publish on', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-primewins', { governed: true });
    const { page, api, nest } = owner;
    await page.change(nest.id, { [AUTO_PUBLISH]: true });
    await expect.poll(saved(owner, 'allow_self_approve'), WRITE).toBe(true);

    // Prime by tag.
    const tagged = await api.createDoc(nest.id, { title: `${nest.name} Prime`, tags: ['prime-document'] });
    expect(await api.statusOf(nest.id, tagged.id)).toBe('draft');
    await page.gotoDocument(nest.id, tagged.id);
    await expect(page.submitButton).toBeVisible();
    await expect(page.publishButton).toHaveCount(0);

    // Prime by the document's own switch.
    const plain = await api.createDoc(nest.id, { title: `${nest.name} Plain` });
    expect(await api.statusOf(nest.id, plain.id)).toBe('published');
    await page.gotoDocument(nest.id, plain.id);
    await page.primeSwitch.click();
    await expect(page.submitButton).toBeVisible(WRITE);
    await expect(page.publishButton).toHaveCount(0);
  });

  test('CN-NSET-011: Verify that with prime-only review on, only prime documents need approval, and the auto-publish switch is disabled', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-primeonly', { governed: true });
    const { page, api, nest } = owner;

    await page.open(nest.id);
    await page.setSwitch(PRIME_ONLY, true);
    await expect(page.switchFor(AUTO_PUBLISH)).toBeDisabled();
    await expect(page.noEffectNote).toBeVisible();
    await page.save();
    await expect.poll(saved(owner, 'prime_only_review'), WRITE).toBe(true);

    const plain = await api.createDoc(nest.id, { title: `${nest.name} Plain` });
    const prime = await api.createDoc(nest.id, { title: `${nest.name} Prime`, tags: ['prime-document'] });
    await page.gotoDocument(nest.id, plain.id);
    await expect(page.publishedBadge).toBeVisible();
    await page.gotoDocument(nest.id, prime.id);
    await expect(page.draftBadge).toBeVisible();
    await expect(page.submitButton).toBeVisible();
  });

  test('CN-NSET-012: Verify that a custom prime tag works, and a removed prime tag no longer counts', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-primetag', { governed: true });
    const { page, api, nest } = owner;

    await page.open(nest.id);
    await page.setSwitch(PRIME_ONLY, true);
    await page.primeTagsInput.fill('qa-prime');
    await page.save();
    await expect.poll(saved(owner, 'prime_tags'), WRITE).toEqual(['qa-prime']);

    const custom = await api.createDoc(nest.id, { title: `${nest.name} Custom`, tags: ['qa-prime'] });
    const removed = await api.createDoc(nest.id, { title: `${nest.name} Removed`, tags: ['prime-document'] });
    await page.gotoDocument(nest.id, custom.id);
    await expect(page.draftBadge).toBeVisible();
    await expect(page.submitButton).toBeVisible();
    await page.gotoDocument(nest.id, removed.id);
    await expect(page.publishedBadge).toBeVisible();
  });

  // ── Always-include tags ────────────────────────────────────────────────────

  test('CN-NSET-013: Verify that documents with an Always-include tag are always included and treated as prime', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-always', { governed: true });
    const { page, api, nest } = owner;

    // The default tag.
    const tagged = await api.createDoc(nest.id, { title: `${nest.name} Tagged`, tags: ['always-include'] });
    const plain = await api.createDoc(nest.id, { title: `${nest.name} Plain` });
    await page.gotoDocument(nest.id, tagged.id);
    await expect(page.alwaysIncludeSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(page.alwaysIncludedPrimeNote).toBeVisible();
    await page.gotoDocument(nest.id, plain.id);
    await expect(page.alwaysIncludeSwitch).toHaveAttribute('aria-checked', 'false');

    // A custom tag replaces it.
    await page.open(nest.id);
    await page.alwaysIncludeInput.fill('faq');
    await page.save();
    await expect.poll(saved(owner, 'always_include_tags'), WRITE).toEqual(['faq']);
    const faq = await api.createDoc(nest.id, { title: `${nest.name} FAQ`, tags: ['faq'] });
    await page.gotoDocument(nest.id, faq.id);
    await expect(page.alwaysIncludeSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(page.alwaysIncludedPrimeNote).toBeVisible();
    await page.gotoDocument(nest.id, tagged.id);
    await expect(page.alwaysIncludeSwitch).toHaveAttribute('aria-checked', 'false');
  });

  // ── Creators review their own documents ────────────────────────────────────

  test("CN-NSET-014: Verify that with creator review on, an Editor's new document publishes straight away and the Editor approves later changes to it", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-creator', { governed: true });
    const { page, api, nest } = owner;
    await page.change(nest.id, { [CREATOR_REVIEW]: true });
    await expect.poll(saved(owner, 'creator_is_reviewer'), WRITE).toBe(true);
    const editor = await share(owner, secondary_user, 'write');
    const editorName = (await editor.api.adminStatus())?.me?.name || secondaryRole.email;

    const doc = await editor.api.createDoc(nest.id, { title: `${nest.name} Editor Doc` });
    expect(await api.statusOf(nest.id, doc.id)).toBe('published');
    await editor.page.gotoDocument(nest.id, doc.id);
    await expect(editor.page.publishedBadge).toBeVisible();

    // The owner's change goes to the Editor.
    await page.gotoDocument(nest.id, doc.id);
    await page.typeInDocument('Owner change');
    await page.submitForReview();
    await expect.poll(async () => api.statusOf(nest.id, doc.id), WRITE).toBe('pending_review');
    await page.gotoDocument(nest.id, doc.id);
    await expect(page.approvers).toContainText(editorName, WRITE);
    await editor.page.gotoDocument(nest.id, doc.id);
    await expect(editor.page.approveButton).toBeVisible(WRITE);
  });

  test('CN-NSET-015: Verify that with creator review on, the creator can still edit and submit their own document (known bug: automate it, but skip it until the bug is fixed)', async ({ primary_user, secondary_user, commonFunction }) => {
    // Skipped: known bug. The creator is made their document's only (reviewer)
    // steward, and the editor treats a reviewer-only steward as read-only, so
    // the creator gets no Edit or Submit on their own document — although the
    // server accepts both. Remove this line once it is fixed.
    test.skip(true, 'Known bug: with creator review on, the creator gets no Edit or Submit on their own document');
    const owner = await ownerNest(primary_user, commonFunction, 'nset-creator-own', { governed: true });
    const { api, nest } = owner;
    await owner.page.change(nest.id, { [CREATOR_REVIEW]: true });
    const editor = await share(owner, secondary_user, 'write');
    const editorName = (await editor.api.adminStatus())?.me?.name || secondaryRole.email;
    const doc = await editor.api.createDoc(nest.id, { title: `${nest.name} Own` });

    await editor.page.gotoDocument(nest.id, doc.id);
    await editor.page.typeInDocument('Creator change');
    await editor.page.submitForReview();
    await expect.poll(async () => api.statusOf(nest.id, doc.id), WRITE).toBe('pending_review');
    await editor.page.gotoDocument(nest.id, doc.id);
    await expect(editor.page.approvers).toBeVisible();
    await expect(editor.page.approvers).not.toContainText(editorName);
  });

  // ── Review SLA ─────────────────────────────────────────────────────────────

  test('CN-NSET-016: Verify that Review SLA accepts whole hours, empty or 0 turns it off, and invalid values show an error', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-sla', { governed: true });
    const { page, api, nest } = owner;

    await page.open(nest.id);
    for (const value of ['1.5', '-3', '9000']) {
      await page.slaInput.fill(value);
      await page.saveButton.click();
      await expect(page.slaError).toHaveText('Review SLA must be a whole number of hours (1–8760), or empty for off.');
      await expect(page.dialog).toBeVisible();
      expect((await api.settings(nest.id)).review_sla_hours).toBeNull();
    }

    await page.slaInput.fill('24');
    await page.save();
    await expect.poll(saved(owner, 'review_sla_hours'), WRITE).toBe(24);
    await page.open(nest.id);
    await expect(page.slaInput).toHaveValue('24');

    // 0 turns it off.
    await page.slaInput.fill('0');
    await page.save();
    await expect.poll(saved(owner, 'review_sla_hours'), WRITE).toBeNull();

    // So does an empty box.
    await api.setSettings(nest.id, { review_sla_hours: 12 });
    await page.open(nest.id);
    await expect(page.slaInput).toHaveValue('12');
    await page.slaInput.fill('');
    await page.save();
    await expect.poll(saved(owner, 'review_sla_hours'), WRITE).toBeNull();
  });

  // ── Record what people and agents read ─────────────────────────────────────

  test("CN-NSET-017: Verify that the owner can turn read recording off and on, and reads appear in the Activity panel only when it's on", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-reads');
    const { page, api, nest } = owner;
    const reader = await share(owner, secondary_user, 'read');
    const email = secondaryRole.email.toLowerCase();

    // On (the default): a read is recorded.
    const onDoc = await api.createDoc(nest.id, { title: `${nest.name} Read On` });
    await reader.page.gotoDocument(nest.id, onDoc.id);
    await expect.poll(async () => api.readers(nest.id, onDoc.id), WRITE).toContain(email);
    await page.gotoDocument(nest.id, onDoc.id);
    expect((await page.activityText()).toLowerCase()).toContain(`read v1 ${email}`);

    // Off: kept after a reload, and nothing is recorded.
    await page.change(nest.id, { [READ_LOG]: false });
    await expect.poll(saved(owner, 'access_log_enabled'), WRITE).toBe(false);
    await page.open(nest.id);
    await expect(page.switchFor(READ_LOG)).toHaveAttribute('aria-checked', 'false');
    await page.cancelButton.click();
    const offDoc = await api.createDoc(nest.id, { title: `${nest.name} Read Off` });
    await reader.page.gotoDocument(nest.id, offDoc.id);
    await reader.page.page.waitForTimeout(5_000);
    expect(await api.readers(nest.id, offDoc.id)).toEqual([]);
    await page.gotoDocument(nest.id, offDoc.id);
    expect((await page.activityText()).toLowerCase()).not.toContain('read v1');

    // On again.
    await page.change(nest.id, { [READ_LOG]: true });
    await expect.poll(saved(owner, 'access_log_enabled'), WRITE).toBe(true);
  });

  // ── Require confirmation for agent writes ──────────────────────────────────

  test("CN-NSET-018: Verify that with agent-write confirmation on, writes made with an API key wait for approval, while the owner's own writes don't", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-agent-hold');
    const { page, api, nest } = owner;
    await holdAgentWrites(owner);
    const agent = await share(owner, secondary_user, 'write');
    const key = await agentKey(agent, commonFunction);
    const title = `${nest.name} Agent`;

    const held = await api.agentWrite(key.apiKey, nest.id, title);
    expect(held.status, JSON.stringify(held.data)).toBe(202);
    expect(held.data?.status).toBe('pending_confirmation');
    expect(await api.nodeByTitle(nest.id, title)).toBeNull();

    // The owner's own write is not held.
    const own = await api.createDoc(nest.id, { title: `${nest.name} Own` });
    expect(await api.statusOf(nest.id, own.id)).toBe('published');

    // Confirmed from the banner, it lands.
    await page.openHeldWrite(nest.id);
    await expect(page.pushBanner).toContainText(key.label);
    await page.confirmWrite.click();
    await expect.poll(async () => (await api.nodeByTitle(nest.id, title))?.id ?? null, WRITE).not.toBeNull();
  });

  test('CN-NSET-019: Verify that rejecting a held agent write discards it', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-agent-reject');
    const { page, api, nest } = owner;
    await holdAgentWrites(owner);
    const agent = await share(owner, secondary_user, 'write');
    const key = await agentKey(agent, commonFunction);
    const title = `${nest.name} Agent`;
    expect((await api.agentWrite(key.apiKey, nest.id, title)).status).toBe(202);

    await page.openHeldWrite(nest.id);
    await page.rejectWrite.click();
    await expect.poll(async () => (await api.pendingPushes(nest.id, 'rejected')).length, WRITE).toBe(1);
    expect(await api.nodeByTitle(nest.id, title)).toBeNull();
    expect(await api.pendingPushes(nest.id, 'pending')).toEqual([]);
    await page.gotoNest(nest.id);
    await expect(page.pushBanner).toHaveCount(0);
  });

  test('CN-NSET-020: Verify that “Always allow” lets a key skip confirmation, and Revoke takes that back', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-agent-allow');
    const { page, api, nest } = owner;
    await holdAgentWrites(owner);
    const agent = await share(owner, secondary_user, 'write');
    const key = await agentKey(agent, commonFunction);
    expect((await api.agentWrite(key.apiKey, nest.id, `${nest.name} First`)).status).toBe(202);

    // Always allow, then confirm: the key's next write goes straight through.
    await page.openHeldWrite(nest.id);
    await page.alwaysAllow.check();
    await expect(page.alwaysAllow).toBeChecked();
    await page.confirmWrite.click();
    await expect.poll(async () => (await api.nodeByTitle(nest.id, `${nest.name} First`))?.id ?? null, WRITE).not.toBeNull();
    await expect.poll(async () => (await api.pushAllowlist(nest.id)).length, WRITE).toBe(1);
    expect((await api.agentWrite(key.apiKey, nest.id, `${nest.name} Second`)).status).toBe(201);

    // Listed under "Keys that skip the gate"; Revoke puts it back under the gate.
    await page.open(nest.id);
    await expect(page.keysList).toContainText(`key: ${key.label}`, WRITE);
    await page.keysList.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.keysList).toContainText('None.', WRITE);
    await page.cancelButton.click();
    expect((await api.agentWrite(key.apiKey, nest.id, `${nest.name} Third`)).status).toBe(202);
  });

  // ── Systems ────────────────────────────────────────────────────────────────

  test("CN-NSET-021: Verify that a new System's key is shown only once, and revoking the System stops the key working", async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-sys');
    const { page, api, nest } = owner;
    revokeSystemsAfter(owner);
    const name = `${nest.name} Sys`;

    await page.open(nest.id);
    const key = await page.createSystem(name, 'Read');
    await expect(page.freshKeyNotice).toBeVisible();
    expect((await api.withKey(key, 'GET', `/nests/${nest.id}/nodes`)).status).toBe(200);
    await page.freshKeyDone.click();
    await expect(page.freshKey).toHaveCount(0);
    await expect(page.systemRow(name)).toBeVisible();

    await page.revokeButton(name).click();
    await expect(page.revokeSystemDialog).toContainText(`Revoke “${name}”?`);
    await page.revokeSystemDialog.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.toasts.filter({ hasText: 'its key has stopped working' }).first()).toBeVisible(WRITE);
    expect((await api.withKey(key, 'GET', `/nests/${nest.id}/nodes`)).status).toBe(401);
  });

  test('CN-NSET-022: Verify that a Read System can only read, and a Write System can write', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-sys-rw');
    const { page, api, nest } = owner;
    revokeSystemsAfter(owner);

    await page.open(nest.id);
    const readKey = await page.createSystem(`${nest.name} Reader`, 'Read');
    await page.freshKeyDone.click();
    const writeKey = await page.createSystem(`${nest.name} Writer`, 'Write');
    await page.freshKeyDone.click();

    expect((await api.withKey(readKey, 'GET', `/nests/${nest.id}/nodes`)).status).toBe(200);
    const refused = await api.withKey(readKey, 'POST', `/nests/${nest.id}/nodes`, { title: 'By Reader', content: 'x' });
    expect(refused.status).toBe(403);
    expect(refused.data?.error).toBe('This API key is read-only and cannot perform write or governance actions.');
    expect((await api.withKey(writeKey, 'POST', `/nests/${nest.id}/nodes`, { title: 'By Writer', content: 'x' })).status).toBe(201);
  });

  test('CN-NSET-023: Verify that a System needs a name of up to 60 characters, Rotate gives a new key and stops the old one, and Systems can be added to and removed from nests', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'nset-sys-rotate');
    const { page, api, nest } = owner;
    const other = await api.createNest(commonFunction.generateEntityName('nset-sys-other'), 'Nest Settings suite (safe to delete)');
    revokeSystemsAfter(owner);
    const name = `${nest.name} Sys`;

    // A name is needed, and at most 60 characters.
    await page.open(nest.id);
    await expect(page.systemCreate).toBeDisabled();
    await page.systemName.fill('X'.repeat(61));
    await page.systemCreate.click();
    await expect(page.toasts.filter({ hasText: 'name must be a string of at most 60 characters.' }).first()).toBeVisible(WRITE);
    await expect(page.freshKey).toHaveCount(0);

    // Rotate shows a new key once and stops the old one.
    const first = await page.createSystem(name, 'Write');
    await page.freshKeyDone.click();
    await page.rotateButton(name).click();
    await expect(page.freshKey).toBeVisible(WRITE);
    const second = (await page.freshKey.innerText()).trim();
    expect(second).not.toBe(first);
    await expect(page.freshKeyNotice).toBeVisible();
    await page.freshKeyDone.click();
    expect((await api.withKey(first, 'GET', `/nests/${nest.id}/nodes`)).status).toBe(401);
    expect((await api.withKey(second, 'GET', `/nests/${nest.id}/nodes`)).status).toBe(200);

    // Added to another nest, then removed from it.
    const inOther = async () => (await api.withKey(second, 'GET', `/nests/${other.id}/nodes`)).status;
    await page.addNestSelect(name).click();
    await page.page.getByRole('option', { name: other.name, exact: true }).click();
    await expect.poll(inOther, WRITE).toBe(200);
    await page.removeNestButton(name, other.name).click();
    await expect.poll(inOther, WRITE).not.toBe(200);
  });
});
