/**
 * Fields Test Suite — CN-FIELD-001 … CN-FIELD-018
 *
 * Page under test: the nest page's Fields tab
 * (ui/src/components/nest/FieldsTab.tsx and TaskNumberingCard.tsx) — custom
 * field definitions (create, validate, edit, reorder, remove, presets), and
 * the task rules (ticket numbering, surfaces, tag groups and stages, priority
 * levels) — and where that setup shows up: a task's Fields panel, its ticket
 * number and tags, and the Board.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest. secondary_user is a Viewer (CN-FIELD-007)
 *   or a Viewer made nest-wide Reviewer (CN-FIELD-018); Viewer is a free seat.
 * - Every nest gets one plain document first: the Board only offers "Add
 *   task" once a nest has something on it.
 * - Preconditions (fields, task rules, tasks and their values, shares,
 *   stewards, archive) are arranged through the REST API (`fieldsApi`); the
 *   step under test goes through the UI. Outcomes are read back through the
 *   UI and the API.
 * - A new nest numbers tasks by default, with a prefix taken from its name
 *   (AUTO_ nests get "AUTO"). Cases that check numbers set their own prefix.
 * - Every nest is an AUTO_ name, deleted after the test
 *   (`fieldsApi.deleteCreatedNests()`), and is in the entity registry for the
 *   teardown and the orphan sweeper. The notifications a nest raised are
 *   marked read first.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

const DOC_TITLE = 'Fields Doc';

test.describe('Fields', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner and create a nest with one plain document. Skips
   * unless the owner may create nests.
   */
  async function ownerNest(role, commonFunction, suffix) {
    await role.initialize();
    const api = role.fieldsApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Fields suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    cleanups.push(() => api.settleNotificationsFor(nest.id));
    const doc = await api.createDoc(nest.id, { title: DOC_TITLE });
    return { api, nest, doc, page: role.fieldsPage };
  }

  /** Share the nest with secondary_user as a Viewer and open their session. */
  async function shareAsViewer(owner, secondary) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const res = await owner.api.grant(owner.nest.id, secondaryRole.email, 'read');
    expect(res.ok, `share as viewer: HTTP ${res.status} ${res.data?.error ?? ''}`).toBe(true);
    await secondary.initialize();
    const api = secondary.fieldsApi;
    await api.settleInvitesFor(owner.nest.id).catch(() => {});
    cleanups.push(() => api.settleNotificationsFor(owner.nest.id));
    return { api, page: secondary.fieldsPage };
  }

  /** A toast containing `text` appears. */
  async function expectToast(page, text) {
    await expect(page.toasts.filter({ hasText: text }).first()).toBeVisible(WRITE);
  }

  /** Wait until a task with this title exists, and return it. */
  async function taskNamed(api, nestId, title) {
    await expect.poll(async () => (await api.nodeByTitle(nestId, title))?.id ?? null, WRITE).not.toBeNull();
    return api.nodeByTitle(nestId, title);
  }

  /** The three fields most cases use: a tasks-only Text, an all-types Select, a Checkbox. */
  async function seedFields(api, nestId) {
    await api.createField(nestId, { label: 'Customer', key: 'customer', type: 'text', applies_to: ['task'] });
    await api.createField(nestId, {
      label: 'Severity',
      key: 'severity',
      type: 'select',
      options: ['low', 'medium', 'high'],
      applies_to: ['*'],
    });
    await api.createField(nestId, { label: 'Blocked', key: 'blocked_flag', type: 'checkbox', applies_to: ['task'] });
  }

  // ── Custom fields ──────────────────────────────────────────────────────────

  test('CN-FIELD-001: Verify that a Select field with options, "Applies to every node type", Required and a default value is created, kept after a reload, and new tasks get the default value', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-select');
    const { page, api, nest } = owner;

    await page.goto(nest.id);
    await page.addField({
      label: 'Severity',
      options: ['low', 'medium', 'high'],
      allTypes: true,
      required: true,
      defaultValue: 'medium',
    });

    const expectRow = async () => {
      const row = page.row('Severity');
      await expect(row).toContainText('severity');
      await expect(row).toContainText('Required');
      await expect(row).toContainText('All node types');
      for (const option of ['low', 'medium', 'high']) await expect(row).toContainText(option);
    };
    await expectRow();
    const def = await api.fieldDef(nest.id, 'severity');
    expect(def).toMatchObject({ type: 'select', required: true, default_value: 'medium', applies_to: ['*'] });
    expect(def.options).toEqual(['low', 'medium', 'high']);

    // Still there after a reload.
    await page.goto(nest.id);
    await expectRow();

    // A new task gets the default.
    await page.createTask(nest.id, 'Default Task');
    const task = await taskNamed(api, nest.id, 'Default Task');
    await expect.poll(async () => (await api.node(nest.id, task.id)).fields?.severity ?? null, WRITE).toBe('medium');
    await page.gotoDocument(nest.id, task.id);
    await expect(page.panelDropdown('Severity')).toContainText('medium');
  });

  test('CN-FIELD-002: Verify that an invalid key keeps Add field disabled, a key that already exists is refused, and a Select field with a repeated option is refused', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-validate');
    const { page, api, nest } = owner;
    await api.createField(nest.id, { label: 'Customer', key: 'customer', type: 'text' });

    await page.goto(nest.id);

    // The key fills in from the name; an invalid one keeps Add field disabled.
    await page.openNewField();
    await page.fillNewField({ label: 'Bad Key', type: 'Text' });
    await expect(page.keyInput).toHaveValue('bad_key');
    await expect(page.addFieldSubmit).toBeEnabled();
    await page.keyInput.fill('My-Key');
    await expect(page.addFieldSubmit).toBeDisabled();
    await page.page.keyboard.press('Escape');
    await expect(page.fieldDialog).toBeHidden();

    // A key that already exists is refused and the dialog stays open.
    await page.openNewField();
    await page.fillNewField({ label: 'Customer', type: 'Text' });
    await page.addFieldSubmit.click();
    await expect(page.dialogError).toContainText('already exists', WRITE);
    await expect(page.fieldDialog).toBeVisible();
    expect((await api.fieldDefs(nest.id)).map((f) => f.key)).toEqual(['customer']);
    await page.page.keyboard.press('Escape');
    await expect(page.fieldDialog).toBeHidden();

    // A Select field with the same option twice is refused.
    await page.openNewField();
    await page.fillNewField({ label: 'Level', options: ['low', 'low', 'high'] });
    await page.addFieldSubmit.click();
    await expect(page.dialogError).toContainText('listed twice', WRITE);
    await expect(page.fieldDialog).toBeVisible();
    expect(await api.fieldDef(nest.id, 'level')).toBeNull();
  });

  test("CN-FIELD-003: Verify that Text, Select and Checkbox values set on a task are kept after a reload and each change adds a new version, and that a tasks-only field doesn't show on documents", async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-values');
    const { page, api, nest, doc } = owner;
    await seedFields(api, nest.id);
    const task = await api.createTaskNode(nest.id, { title: 'Values Task' });
    const startVersion = (await api.node(nest.id, task.id)).version;
    const fieldsOf = async () => (await api.node(nest.id, task.id)).fields ?? {};

    await page.gotoDocument(nest.id, task.id);
    await page.setPanelValue('Customer', 'Acme');
    await expect.poll(async () => (await fieldsOf()).customer ?? null, WRITE).toBe('Acme');
    await page.choosePanelOption('Severity', 'high');
    await expect.poll(async () => (await fieldsOf()).severity ?? null, WRITE).toBe('high');
    await page.panelSwitch('Blocked').click();
    await expect.poll(async () => (await fieldsOf()).blocked_flag ?? null, WRITE).toBe(true);

    // Kept after a reload.
    await page.gotoDocument(nest.id, task.id);
    await expect(page.panelInput('Customer')).toHaveValue('Acme');
    await expect(page.panelDropdown('Severity')).toContainText('high');
    await expect(page.panelSwitch('Blocked')).toHaveAttribute('aria-checked', 'true');

    // Each change is its own version, and Version history lists all three.
    await expect.poll(async () => (await api.node(nest.id, task.id)).version, WRITE).toBe(startVersion + 3);
    const history = await page.openVersionHistory();
    for (let v = startVersion + 1; v <= startVersion + 3; v++) {
      await expect(history).toContainText(new RegExp(`Version ${v}(?!\\d)`));
    }
    await page.page.keyboard.press('Escape');

    // A document shows the all-types field only.
    await page.gotoDocument(nest.id, doc.id);
    await expect(page.panelLabel('Severity')).toBeVisible();
    await expect(page.panelInput('Customer')).toHaveCount(0);
    await expect(page.panelSwitch('Blocked')).toHaveCount(0);
  });

  // ── Task numbering ─────────────────────────────────────────────────────────

  test('CN-FIELD-004: Verify that a lowercase prefix is saved in capitals, Start at 100 gives the next tasks QA-100 and QA-101, and turning numbering off means new tasks get no number', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-numbering');
    const { page, api, nest } = owner;

    await page.goto(nest.id);
    await page.prefixInput.fill('qa');
    await expect(page.prefixInput).toHaveValue('QA');
    await page.startAtInput.fill('100');
    await page.saveNumbering();
    await expectToast(page, 'Task numbering saved');
    await expect.poll(async () => (await api.taskRules(nest.id))?.ticket_start_at, WRITE).toBe(100);
    expect((await api.taskRules(nest.id)).ticket_prefix).toBe('QA');

    await page.createTask(nest.id, 'Numbered One');
    const one = await taskNamed(api, nest.id, 'Numbered One');
    await page.createTask(nest.id, 'Numbered Two');
    const two = await taskNamed(api, nest.id, 'Numbered Two');
    expect(await api.ticketOf(nest.id, one.id)).toBe('QA-100');
    expect(await api.ticketOf(nest.id, two.id)).toBe('QA-101');

    await page.gotoDocument(nest.id, one.id);
    await expect(page.ticketChips.first()).toHaveText('QA-100');
    await page.gotoBoard(nest.id);
    await expect(page.card('Numbered One')).toContainText('QA-100');
    await expect(page.card('Numbered Two')).toContainText('QA-101');

    // Numbering off: the next task gets no number, the others keep theirs.
    await page.goto(nest.id);
    await page.numberingSwitch.click();
    await expect(page.numberingSwitch).toHaveAttribute('aria-checked', 'false');
    await page.saveNumbering();
    await expect.poll(async () => (await api.taskRules(nest.id))?.ticket_numbering, WRITE).toBe(false);

    await page.createTask(nest.id, 'Unnumbered');
    const three = await taskNamed(api, nest.id, 'Unnumbered');
    expect(await api.ticketOf(nest.id, three.id)).toBeNull();
    await page.gotoDocument(nest.id, three.id);
    await expect(page.ticketChips).toHaveCount(0);
    expect(await api.ticketOf(nest.id, one.id)).toBe('QA-100');
  });

  // ── Surfaces, tag groups and stages ────────────────────────────────────────

  test('CN-FIELD-005: Verify that surfaces with tags and a preselected surface are kept after a reload, the New task dialog offers them with the preselected one chosen, new tasks get the surface\'s first tag, and removing the preselected surface resets it to "No surface"', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-surfaces');
    const { page, api, nest } = owner;

    await page.goto(nest.id);
    await page.addSurface('Web', 'web, frontend');
    await page.addSurface('API', 'api');
    await page.preselectSurface.selectOption({ label: 'Web' });
    await page.saveNumbering();
    await expectToast(page, 'Task numbering saved');
    await expect.poll(async () => (await api.taskRules(nest.id))?.default_surface ?? null, WRITE).toBe('Web');
    expect((await api.taskRules(nest.id)).surfaces).toEqual([
      { name: 'Web', tags: ['web', 'frontend'] },
      { name: 'API', tags: ['api'] },
    ]);

    // Kept after a reload.
    await page.goto(nest.id);
    expect(await page.surfaceNames.evaluateAll((e) => e.map((i) => i.value))).toEqual(['Web', 'API']);
    expect(await page.surfaceTags.evaluateAll((e) => e.map((i) => i.value))).toEqual(['web, frontend', 'api']);
    await expect(page.preselectSurface).toHaveValue('Web');

    // The New task dialog offers them, with Web chosen.
    await page.gotoBoard(nest.id);
    await page.openNewTask();
    expect(await page.selectOptions(page.surfaceSelect)).toEqual(['No surface', 'Web', 'API']);
    await expect(page.surfaceSelect).toHaveValue('web');
    await page.taskTitleInput.fill('Web Task');
    await page.createTaskButton.click();
    await expect(page.createTaskDialog).toBeHidden(WRITE);
    await page.createTask(nest.id, 'Api Task', { surface: 'API' });

    // A task gets its surface's first tag.
    const web = await taskNamed(api, nest.id, 'Web Task');
    const apiTask = await taskNamed(api, nest.id, 'Api Task');
    const webTags = (await api.node(nest.id, web.id)).tags;
    expect(webTags).toContain('#web');
    expect(webTags).not.toContain('#frontend');
    expect((await api.node(nest.id, apiTask.id)).tags).toContain('#api');

    // Removing the preselected surface resets the preselect.
    await page.goto(nest.id);
    await page.removeSurfaceButtons.first().click();
    await expect(page.preselectSurface).toHaveValue('');
    await expect(page.preselectSurface.locator('option:checked')).toHaveText('No surface');
    await page.saveNumbering();
    await expect.poll(async () => (await api.taskRules(nest.id))?.surfaces?.map((s) => s.name), WRITE).toEqual(['API']);
    expect((await api.taskRules(nest.id)).default_surface).toBeNull();
    await page.goto(nest.id);
    await expect(page.preselectSurface.locator('option:checked')).toHaveText('No surface');
  });

  test('CN-FIELD-006: Verify that new tasks start in the default stage, adding another stage tag replaces the old one, and the Board shows the stage columns in the saved order', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-stages');
    const { page, api, nest } = owner;
    const STAGES = ['backlog', 'in-progress', 'in-review', 'done'];

    await page.goto(nest.id);
    await page.engineeringPreset.click();
    await expect(page.tagGroupsInput).toHaveValue('stage');
    await expect(page.startStageInput).toHaveValue('stage:backlog');
    await page.stageOrderInput.fill(STAGES.join(', '));
    await page.saveNumbering();
    await expectToast(page, 'Task numbering saved');
    await expect.poll(async () => (await api.taskRules(nest.id))?.stage_order, WRITE).toEqual(STAGES);
    const rules = await api.taskRules(nest.id);
    expect(rules.exclusive_namespaces).toEqual(['stage']);
    expect(rules.default_stage_tag).toBe('stage:backlog');

    // A new task starts in backlog.
    await page.createTask(nest.id, 'Stage Task');
    const task = await taskNamed(api, nest.id, 'Stage Task');
    expect((await api.node(nest.id, task.id)).tags).toContain('#stage:backlog');

    // Adding another stage replaces it.
    await page.gotoDocument(nest.id, task.id);
    await page.startEditing();
    await page.addTag('stage:in-review');
    await expect
      .poll(async () => (await api.node(nest.id, task.id)).tags.filter((t) => t.startsWith('#stage:')), WRITE)
      .toEqual(['#stage:in-review']);

    // Columns → Tag shows the stages in the saved order.
    await page.gotoBoard(nest.id);
    await expect(page.card('Stage Task')).toBeVisible();
    await expect(async () => {
      await page.columnsSelect.selectOption('tag');
      await expect(page.columnsSelect).toHaveValue('tag', { timeout: 3_000 });
      expect((await page.columnTitles()).filter((t) => STAGES.includes(t))).toEqual(STAGES);
    }).toPass(WRITE);
  });

  // ── Access ─────────────────────────────────────────────────────────────────

  test("CN-FIELD-007: Verify that a viewer sees the fields but has no Add field button, row menus or Save button, the task numbering controls are disabled, and they can't change values on a task", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-viewer');
    const { api, nest } = owner;
    await seedFields(api, nest.id);
    const task = await api.createTaskNode(nest.id, {
      title: 'Viewer Task',
      fields: { customer: 'Acme', severity: 'high', blocked_flag: true },
    });
    // A surface and custom priority levels, so their rows are on the card too.
    await api.setTaskRules(nest.id, {
      surfaces: [{ name: 'Web', tags: ['web'] }],
      default_surface: 'Web',
      exclusive_namespaces: ['stage'],
      default_stage_tag: 'stage:backlog',
      stage_order: ['backlog', 'done'],
      priorities: [{ label: 'High' }, { label: 'Low' }],
    });
    const viewer = await shareAsViewer(owner, secondary_user);
    const vp = viewer.page;

    await vp.goto(nest.id);
    expect(await vp.fieldLabels()).toEqual(['Customer', 'Severity', 'Blocked']);
    await expect(vp.addFieldButton).toHaveCount(0);
    await expect(vp.rowMenus).toHaveCount(0);
    await expect(vp.numberingSave).toHaveCount(0);

    // Every Task numbering control is shown but disabled, and its buttons are gone.
    await expect(vp.surfaceNames.first()).toHaveValue('Web');
    await expect(vp.priorityInputs).toHaveCount(2);
    for (const control of [
      vp.numberingSwitch,
      vp.prefixInput,
      vp.startAtInput,
      vp.surfaceNames.first(),
      vp.surfaceTags.first(),
      vp.preselectSurface,
      vp.tagGroupsInput,
      vp.startStageInput,
      vp.stageOrderInput,
      vp.priorityInputs.first(),
      vp.priorityInputs.last(),
    ]) {
      await expect(control).toBeDisabled();
    }
    for (const button of [
      vp.engineeringPreset,
      vp.addSurfaceButton,
      vp.removeSurfaceButtons,
      vp.customizeLevels,
      vp.addLevel,
      vp.removeLevelButtons,
      vp.numberExisting,
    ]) {
      await expect(button).toHaveCount(0);
    }

    await viewer.page.gotoDocument(nest.id, task.id);
    await expect(viewer.page.panelInput('Customer')).toHaveValue('Acme');
    await expect(viewer.page.panelInput('Customer')).toBeDisabled();
    await expect(viewer.page.panelDropdown('Severity')).toContainText('high');
    await expect(viewer.page.panelDropdown('Severity')).toBeDisabled();
    await expect(viewer.page.panelSwitch('Blocked')).toBeDisabled();
  });

  // ── Editing and removing fields ────────────────────────────────────────────

  test('CN-FIELD-008: Verify that editing a field keeps its key and type locked, and removing an option a task is using shows a warning while the task keeps its value', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-edit');
    const { page, api, nest } = owner;
    await api.createField(nest.id, { label: 'Severity', key: 'severity', type: 'select', options: ['low', 'medium', 'high'] });
    const task = await api.createTaskNode(nest.id, { title: 'Edit Task', fields: { severity: 'high' } });

    await page.goto(nest.id);
    await (await page.rowMenuItem('Severity', 'Edit')).click();
    await expect(page.keyInput).toBeDisabled();
    await expect(page.typeSelect).toBeDisabled();
    await page.labelInput.fill('Impact');
    await page.saveFieldSubmit.click();
    await expectToast(page, '“Impact” saved');
    await expect(page.row('Impact')).toContainText('severity');
    await expect.poll(async () => (await api.fieldDef(nest.id, 'severity'))?.label, WRITE).toBe('Impact');

    // Removing "high" while the task uses it warns, and the task keeps it.
    await (await page.rowMenuItem('Impact', 'Edit')).click();
    await page.optionsInput.fill('low\nmedium');
    await page.saveFieldSubmit.click();
    await expectToast(page, 'no longer fits');
    await expect.poll(async () => (await api.fieldDef(nest.id, 'severity'))?.options, WRITE).toEqual(['low', 'medium']);
    expect((await api.node(nest.id, task.id)).fields?.severity).toBe('high');
    await page.gotoDocument(nest.id, task.id);
    await expect(page.panelDropdown('Impact')).toContainText('high');
  });

  test('CN-FIELD-009: Verify that removing a field and then adding the same key again brings back the values tasks already had', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-readd');
    const { page, api, nest } = owner;
    await api.createField(nest.id, { label: 'Customer', key: 'customer', type: 'text' });
    const task = await api.createTaskNode(nest.id, { title: 'Readd Task', fields: { customer: 'Acme' } });

    await page.goto(nest.id);
    await (await page.rowMenuItem('Customer', 'Remove')).click();
    await expect(page.removeDialog).toBeVisible();
    await page.removeConfirm.click();
    await expect(page.row('Customer')).toHaveCount(0, WRITE);
    await expect.poll(async () => api.fieldDef(nest.id, 'customer'), WRITE).toBeNull();

    await page.gotoDocument(nest.id, task.id);
    await expect(page.panelInput('Customer')).toHaveCount(0);

    // Defining the same key again brings the value back.
    await page.goto(nest.id);
    await page.addField({ label: 'Customer', type: 'Text' });
    await page.gotoDocument(nest.id, task.id);
    await expect(page.panelInput('Customer')).toHaveValue('Acme', WRITE);
  });

  test('CN-FIELD-010: Verify that Number existing tasks is disabled until you save, then numbers older tasks after you confirm, and the next new task gets the next number', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-backfill');
    const { page, api, nest } = owner;
    await api.setTaskRules(nest.id, { ticket_numbering: false });
    const older = await api.createTaskNode(nest.id, { title: 'Older Task' });
    expect(await api.ticketOf(nest.id, older.id)).toBeNull();

    await page.goto(nest.id);
    await expect(page.numberingSwitch).toHaveAttribute('aria-checked', 'false');
    await page.numberingSwitch.click();
    await page.prefixInput.fill('QA');
    await expect(page.numberExisting).toBeDisabled();
    await expect(page.saveFirstHint).toBeVisible();
    await page.saveNumbering();
    await expect.poll(async () => (await api.taskRules(nest.id))?.ticket_prefix, WRITE).toBe('QA');
    await expect(page.numberExisting).toBeEnabled(WRITE);

    // The browser asks to confirm; the case accepts.
    page.page.once('dialog', (dialog) => dialog.accept());
    await page.numberExisting.click();
    await expectToast(page, '1 numbered');
    await expect.poll(async () => api.ticketOf(nest.id, older.id), WRITE).toBe('QA-1');

    await page.createTask(nest.id, 'Newer Task');
    const newer = await taskNamed(api, nest.id, 'Newer Task');
    expect(await api.ticketOf(nest.id, newer.id)).toBe('QA-2');
  });

  test("CN-FIELD-011: Verify that a task's ticket number can't be removed or changed", async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-ticket');
    const { page, api, nest } = owner;
    await api.setTaskRules(nest.id, { ticket_numbering: true, ticket_prefix: 'QA' });
    const task = await api.createTaskNode(nest.id, { title: 'Ticket Task' });
    expect(await api.ticketOf(nest.id, task.id)).toBe('QA-1');

    await page.gotoDocument(nest.id, task.id);
    await page.startEditing();
    // The ticket tag has no Remove button.
    await expect(page.page.getByText('ticket:qa-1', { exact: true }).first()).toBeVisible();
    await expect(page.removeTagButton('ticket:qa-1')).toHaveCount(0);

    // Adding another ticket tag doesn't change the number. (Known issue: the
    // page says "added. Saved." although nothing changed — not asserted here.)
    await page.addTag('ticket:qa-999');
    await expect(page.toasts.first()).toBeVisible(WRITE);
    await page.gotoDocument(nest.id, task.id);
    await expect(page.ticketChips.first()).toHaveText('QA-1');
    const tags = (await api.node(nest.id, task.id)).tags;
    expect(tags).toContain('#ticket:qa-1');
    expect(tags.some((t) => t.includes('qa-999'))).toBe(false);
  });

  test('CN-FIELD-012: Verify that a surface with no tags, a duplicate surface name, an invalid stage name, an invalid tag group, an invalid start stage, and an empty prefix with numbering on are each refused with a message, and nothing is saved', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-rules-invalid');
    const { page, api, nest } = owner;
    const before = JSON.stringify(await api.taskRules(nest.id));

    const cases = [
      { name: 'a surface with no tags', apply: () => page.addSurface('Mobile'), message: /needs at least one valid tag/ },
      {
        name: 'a duplicate surface name',
        apply: async () => {
          await page.addSurface('Web', 'web');
          await page.addSurface('web', 'mobile');
        },
        message: /two surfaces are named/,
      },
      { name: 'an invalid stage name', apply: () => page.stageOrderInput.fill('backlog, in progress!, done'), message: /not a valid stage name/ },
      { name: 'an invalid tag group', apply: () => page.tagGroupsInput.fill('my stage'), message: /not a valid tag namespace/ },
      { name: 'an invalid start stage', apply: () => page.startStageInput.fill('stage:Back Log!'), message: /is not a valid tag/ },
    ];
    for (const c of cases) {
      await test.step(c.name, async () => {
        await page.goto(nest.id);
        await c.apply();
        await page.saveNumbering();
        await expect(page.numberingError).toContainText(c.message, WRITE);
        expect(JSON.stringify(await api.taskRules(nest.id))).toBe(before);
      });
    }

    // An empty prefix with numbering on: the card says to pick one, and
    // nothing is saved. (Known issue: Save stays clickable — not asserted.)
    await test.step('an empty prefix with numbering on', async () => {
      await page.goto(nest.id);
      await expect(page.numberingSwitch).toHaveAttribute('aria-checked', 'true');
      await page.prefixInput.fill('');
      await expect(page.prefixWarning).toBeVisible();
      await page.saveNumbering();
      await expect(page.numberingError).toBeVisible(WRITE);
      expect(JSON.stringify(await api.taskRules(nest.id))).toBe(before);
    });
  });

  test('CN-FIELD-013: Verify that Add field offers New field, Estimate · points, Estimate · hours and Time in status, and that adding an Estimate preset disables both Estimate presets while adding Time in status disables it', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-presets');
    const { page, api, nest } = owner;
    const disabled = (item) => expect(item).toHaveAttribute('aria-disabled', 'true');
    const enabled = (item) => expect(item).not.toHaveAttribute('aria-disabled', 'true');

    await page.goto(nest.id);
    await expect(page.emptyFields).toBeVisible();
    await page.addFieldButton.click();
    for (const item of [page.newFieldItem, page.estimatePointsItem, page.estimateHoursItem, page.timeInStatusItem]) {
      await expect(item).toBeVisible();
      await enabled(item);
    }

    await page.estimatePointsItem.click();
    await expectToast(page, 'Estimate added');
    await expect(page.row('Estimate')).toContainText('points', WRITE);

    await page.addFieldButton.click();
    await disabled(page.estimatePointsItem);
    await disabled(page.estimateHoursItem);
    await enabled(page.timeInStatusItem);
    await page.timeInStatusItem.click();
    await expectToast(page, 'Time in status added');
    await expect(page.row('Time in status')).toBeVisible(WRITE);

    await page.addFieldButton.click();
    await disabled(page.timeInStatusItem);
    await enabled(page.newFieldItem);
    await page.page.keyboard.press('Escape');
    expect((await api.fieldDef(nest.id, 'estimate'))).toMatchObject({ type: 'number', unit: 'points' });
    expect((await api.fieldDefs(nest.id)).some((f) => f.type === 'time_in_status')).toBe(true);

    // Removing Estimate frees both presets; Estimate · hours then disables both again.
    await page.removeField('Estimate');
    await expect(page.row('Estimate')).toHaveCount(0, WRITE);
    await page.addFieldButton.click();
    await enabled(page.estimatePointsItem);
    await enabled(page.estimateHoursItem);
    await page.estimateHoursItem.click();
    await expect(page.row('Estimate')).toContainText('hours', WRITE);

    await page.addFieldButton.click();
    await disabled(page.estimatePointsItem);
    await disabled(page.estimateHoursItem);
    await disabled(page.timeInStatusItem);
    await enabled(page.newFieldItem);
    await page.page.keyboard.press('Escape');
    await expect.poll(async () => (await api.fieldDef(nest.id, 'estimate'))?.unit ?? null, WRITE).toBe('hours');
  });

  test("CN-FIELD-014: Verify that Move up and Move down change the field order, the order stays after a reload, and the first row's Move up is disabled", async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-order');
    const { page, api, nest } = owner;
    for (const label of ['Alpha', 'Bravo', 'Charlie']) {
      await api.createField(nest.id, { label, key: label.toLowerCase(), type: 'text' });
    }

    await page.goto(nest.id);
    expect(await page.fieldLabels()).toEqual(['Alpha', 'Bravo', 'Charlie']);

    await (await page.rowMenuItem('Alpha', 'Move down')).click();
    await expect.poll(() => page.fieldLabels(), WRITE).toEqual(['Bravo', 'Alpha', 'Charlie']);
    await (await page.rowMenuItem('Charlie', 'Move up')).click();
    await expect.poll(() => page.fieldLabels(), WRITE).toEqual(['Bravo', 'Charlie', 'Alpha']);

    // Kept after a reload, and saved in that order.
    await page.goto(nest.id);
    expect(await page.fieldLabels()).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect((await api.fieldDefs(nest.id)).map((f) => f.key)).toEqual(['bravo', 'charlie', 'alpha']);

    // The first row can't move up.
    await page.rowMenu('Bravo').click();
    await expect(page.page.getByRole('menuitem', { name: 'Move up', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await page.page.keyboard.press('Escape');
  });

  test('CN-FIELD-015: Verify that renaming, adding and removing priority levels changes the New task dialog\'s priorities, Add level stops at 8, and Back to defaults restores Urgent, High, Medium, Low', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-priorities');
    const { page, api, nest } = owner;
    const DEFAULTS = ['Urgent', 'High', 'Medium', 'Low'];

    await page.goto(nest.id);
    await page.customizeLevels.click();
    expect(await page.priorityLevels()).toEqual(DEFAULTS);
    await page.priorityInputs.nth(1).fill('Major');
    await page.addLevel.click();
    await page.priorityInputs.nth(4).fill('Trivial');
    await page.removeLevelButtons.first().click();
    expect(await page.priorityLevels()).toEqual(['Major', 'Medium', 'Low', 'Trivial']);
    await page.saveNumbering();
    await expect
      .poll(async () => ((await api.taskRules(nest.id))?.priorities ?? []).map((p) => p.label), WRITE)
      .toEqual(['Major', 'Medium', 'Low', 'Trivial']);

    await page.gotoBoard(nest.id);
    await page.openNewTask();
    expect(await page.selectOptions(page.prioritySelect)).toEqual(['No priority', 'Major', 'Medium', 'Low', 'Trivial']);
    await page.page.keyboard.press('Escape');

    // Add level stops at 8; Back to defaults restores the four defaults.
    await page.goto(nest.id);
    while (await page.addLevel.isEnabled()) {
      await page.addLevel.click();
      const n = await page.priorityInputs.count();
      await page.priorityInputs.nth(n - 1).fill(`Level ${n}`);
    }
    await expect(page.priorityInputs).toHaveCount(8);
    await expect(page.addLevel).toBeDisabled();
    await page.backToDefaults.click();
    await page.saveNumbering();
    await expect.poll(async () => ((await api.taskRules(nest.id))?.priorities ?? []).length, WRITE).toBe(0);

    await page.gotoBoard(nest.id);
    await page.openNewTask();
    expect(await page.selectOptions(page.prioritySelect)).toEqual(['No priority', ...DEFAULTS]);
    await page.page.keyboard.press('Escape');
  });

  test('CN-FIELD-016: Verify that a Number field with a Scale, a Person field and a Date field can be set on a task and are kept after a reload, and the board card shows the Number with its unit', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-types');
    const { page, api, nest } = owner;
    await api.createField(nest.id, { label: 'Owner', key: 'owner', type: 'user' });
    await api.createField(nest.id, { label: 'Due', key: 'due', type: 'date' });

    await page.goto(nest.id);
    await page.addField({ label: 'Hours spent', type: 'Number', unit: 'hours' });
    await expect(page.row('Hours spent')).toContainText('Number · hours');
    expect(await api.fieldDef(nest.id, 'hours_spent')).toMatchObject({ type: 'number', unit: 'hours' });

    const task = await api.createTaskNode(nest.id, { title: 'Hours Task' });
    const fieldsOf = async () => (await api.node(nest.id, task.id)).fields ?? {};
    await page.gotoDocument(nest.id, task.id);
    await page.setPanelValue('Hours spent', '4');
    await expect.poll(async () => (await fieldsOf()).hours_spent ?? null, WRITE).toBe(4);
    // The nest's only member is the owner, so the only person offered is the owner.
    await page.panelDropdown('Owner').click();
    const person = page.page.getByRole('menuitem').first();
    // The item shows the avatar's initials, then the name; keep the name.
    const personName = (await person.innerText()).trim().split('\n').pop().trim();
    expect(personName).not.toBe('');
    await person.click();
    await expect.poll(async () => (await fieldsOf()).owner ?? null, WRITE).toBe(primaryRole.email.toLowerCase());
    await page.setPanelValue('Due', '2026-12-01');
    await expect.poll(async () => (await fieldsOf()).due ?? null, WRITE).toBe('2026-12-01');

    // Kept after a reload.
    await page.gotoDocument(nest.id, task.id);
    await expect(page.panelInput('Hours spent')).toHaveValue('4');
    await expect(page.panelDropdown('Owner')).toContainText(personName);
    await expect(page.panelInput('Due')).toHaveValue('2026-12-01');

    // The board card shows the number with its unit.
    await page.gotoBoard(nest.id);
    await expect(page.card('Hours Task')).toContainText('4h');
  });

  test('CN-FIELD-017: Verify that a Select field appears in the Board\'s Columns list and as a filter chip, and task cards show its value', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-board');
    const { page, api, nest } = owner;
    await api.createField(nest.id, { label: 'Severity', key: 'severity', type: 'select', options: ['low', 'medium', 'high'] });
    await api.createTaskNode(nest.id, { title: 'Board Task', fields: { severity: 'medium' } });

    await page.gotoBoard(nest.id);
    await expect(page.columnsSelect.locator('option', { hasText: 'Severity' })).toHaveCount(1);
    await expect(page.fieldFilters.getByRole('button', { name: /Severity/ })).toBeVisible();
    await expect(page.card('Board Task')).toContainText('medium');
  });

  test("CN-FIELD-018: Verify that a nest-wide Reviewer can add and manage fields, and an archived nest's Fields tab and task values are read-only", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'fields-reviewer');
    const { api, nest } = owner;
    await api.createField(nest.id, { label: 'Customer', key: 'customer', type: 'text' });
    await api.createField(nest.id, { label: 'Scratch', key: 'scratch', type: 'text' });
    const task = await api.createTaskNode(nest.id, { title: 'Archive Task', fields: { customer: 'Acme' } });

    // A Viewer who is a nest-wide reviewer adds, edits, moves and removes fields.
    const reviewer = await shareAsViewer(owner, secondary_user);
    await api.governNest(nest.id);
    await api.addSteward(nest.id, { email: secondaryRole.email, role: 'reviewer', scope: 'nest' });
    const rp = reviewer.page;
    await rp.goto(nest.id);
    await expect(rp.addFieldButton).toBeVisible();
    await expect(rp.rowMenu('Customer')).toBeVisible();
    await expect(rp.prefixInput).toBeEnabled();

    await rp.addField({ label: 'Reviewer Note', type: 'Text' });
    await expect.poll(async () => (await api.fieldDef(nest.id, 'reviewer_note'))?.label ?? null, WRITE).toBe('Reviewer Note');

    await (await rp.rowMenuItem('Reviewer Note', 'Edit')).click();
    await rp.labelInput.fill('Review Note');
    await rp.saveFieldSubmit.click();
    await expectToast(rp, '“Review Note” saved');
    await expect.poll(async () => (await api.fieldDef(nest.id, 'reviewer_note'))?.label ?? null, WRITE).toBe('Review Note');

    await (await rp.rowMenuItem('Review Note', 'Move up')).click();
    await expect.poll(() => rp.fieldLabels(), WRITE).toEqual(['Customer', 'Review Note', 'Scratch']);

    await rp.removeField('Scratch');
    await expect(rp.row('Scratch')).toHaveCount(0, WRITE);
    await expect
      .poll(async () => (await api.fieldDefs(nest.id)).map((f) => f.key), WRITE)
      .toEqual(['customer', 'reviewer_note']);

    // Archived: read-only for the owner too.
    await api.archiveNest(nest.id);
    cleanups.push(() => api.restoreNest(nest.id));
    await owner.page.goto(nest.id);
    expect(await owner.page.fieldLabels()).toEqual(['Customer', 'Review Note']);
    await expect(owner.page.addFieldButton).toHaveCount(0);
    await expect(owner.page.rowMenus).toHaveCount(0);
    await expect(owner.page.numberingSave).toHaveCount(0);
    await expect(owner.page.prefixInput).toBeDisabled();
    await owner.page.gotoDocument(nest.id, task.id);
    await expect(owner.page.panelInput('Customer')).toHaveValue('Acme');
    await expect(owner.page.panelInput('Customer')).toBeDisabled();
  });
});
