/**
 * Fields Page Object Model
 *
 * Page under test: the nest page's Fields tab at /nest/<id>?tab=fields
 * (ui/src/components/nest/FieldsTab.tsx). It holds two cards:
 *   - Task numbering (TaskNumberingCard.tsx): ticket prefix and start number,
 *     surfaces, one-per-task tag groups, the start stage, the stage column
 *     order, priority levels, Save and "Number existing tasks".
 *   - Custom fields: the Add field menu (New field and the presets), the field
 *     list with each row's Edit / Move up / Move down / Remove menu, and the
 *     New field / Edit dialog.
 *
 * Where the setup shows up is covered too: the Fields panel on a task or
 * document (NodeFieldsPanel.tsx), the ticket number and tags on the task page,
 * and the Board (MaturityBoard.tsx) with its New task dialog, Columns control,
 * field filters and cards.
 *
 * Admins, owners and nest-wide reviewers manage the tab; everyone else sees it
 * read-only. An archived nest is read-only for everyone.
 */

import logger from '../../helper/logger/logger.js';

class FieldsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;
    this.main = page.locator('main');

    // ── Fields tab ─────────────────────────────────────────────────────────
    this.fieldsTab = page.getByRole('tab', { name: 'Fields', exact: true });
    this.customFieldsTitle = page.getByText('Custom fields', { exact: true });
    this.emptyFields = page.getByText('No custom fields yet', { exact: true });
    this.fieldList = page.getByTestId('field-list');
    this.fieldRows = this.fieldList.locator('li');
    this.fieldNames = this.fieldList.locator('li span.text-sm.font-medium');
    this.rowMenus = this.fieldList.getByRole('button', { name: / options$/ });

    // Add field menu
    this.addFieldButton = page.getByTestId('add-field');
    this.newFieldItem = page.getByRole('menuitem', { name: /New field/ });
    this.estimatePointsItem = page.getByRole('menuitem', { name: /Estimate · points/ });
    this.estimateHoursItem = page.getByRole('menuitem', { name: /Estimate · hours/ });
    this.timeInStatusItem = page.getByRole('menuitem', { name: /Time in status/ });

    // New field / Edit dialog
    // Once Fields opens as a dialog from the nest's ⋯ menu (po-1213), that
    // dialog stays open under this one; leave it out. A no-op where Fields is
    // still a tab.
    this.fieldDialog = page.locator('[role="dialog"]:not([data-testid="nest-fields-dialog"])');
    this.labelInput = page.locator('#field-label');
    this.keyInput = page.locator('#field-key');
    this.typeSelect = page.getByRole('combobox', { name: 'Type' });
    this.optionsInput = page.locator('#field-options');
    this.unitInput = page.locator('#field-unit');
    this.allTypesSwitch = this.fieldDialog.getByRole('switch').nth(0);
    this.requiredSwitch = this.fieldDialog.getByRole('switch').nth(1);
    this.defaultSelect = page.locator('#field-default');
    this.addFieldSubmit = this.fieldDialog.getByRole('button', { name: 'Add field', exact: true });
    this.saveFieldSubmit = this.fieldDialog.getByRole('button', { name: 'Save', exact: true });
    this.dialogError = this.fieldDialog.locator('p.text-destructive');
    this.removeDialog = page.getByRole('alertdialog');
    this.removeConfirm = this.removeDialog.getByRole('button', { name: 'Remove field', exact: true });

    // ── Task numbering card ────────────────────────────────────────────────
    this.numberingCard = page.getByTestId('task-numbering');
    this.numberingSwitch = this.numberingCard.getByLabel('Number tasks');
    this.prefixInput = this.numberingCard.getByLabel('Ticket prefix');
    this.startAtInput = this.numberingCard.getByLabel('Start at');
    this.prefixWarning = this.numberingCard.getByText(/Pick a prefix/);
    this.numberingSave = this.numberingCard.getByRole('button', { name: 'Save', exact: true });
    this.numberExisting = this.numberingCard.getByRole('button', { name: 'Number existing tasks', exact: true });
    this.saveFirstHint = this.numberingCard.getByText('Save before numbering existing tasks.');
    this.numberingError = this.numberingCard.getByRole('alert');
    this.engineeringPreset = this.numberingCard.getByRole('button', { name: 'Engineering tickets', exact: true });
    // Surfaces
    this.addSurfaceButton = this.numberingCard.getByRole('button', { name: 'Add surface' });
    this.surfaceNames = this.numberingCard.getByLabel('Surface name');
    this.surfaceTags = this.numberingCard.getByLabel('Tags', { exact: true });
    this.removeSurfaceButtons = this.numberingCard.getByRole('button', { name: 'Remove surface' });
    this.preselectSurface = this.numberingCard.locator('select').first();
    // Tag groups and stages
    this.tagGroupsInput = this.numberingCard.getByPlaceholder('stage', { exact: true });
    this.startStageInput = this.numberingCard.getByPlaceholder('stage:backlog', { exact: true });
    this.stageOrderInput = this.numberingCard.getByPlaceholder('backlog, in-progress, in-review, done', { exact: true });
    // Priority levels
    this.customizeLevels = this.numberingCard.getByRole('button', { name: 'Customize levels' });
    this.addLevel = this.numberingCard.getByRole('button', { name: 'Add level' });
    this.backToDefaults = this.numberingCard.getByRole('button', { name: 'Back to defaults' });
    this.priorityInputs = this.numberingCard.locator('input[aria-label^="Priority "]');
    this.removeLevelButtons = this.numberingCard.getByRole('button', { name: 'Remove level' });

    // ── Task / document page ───────────────────────────────────────────────
    this.fieldsPanel = page.getByTestId('node-fields-panel');
    this.editButton = page.getByTestId('document-editor-start-edit');
    this.tagInput = page.getByTestId('document-editor-tag-input');
    this.documentMenu = page.getByTestId('document-editor-more');
    this.ticketChips = page.getByTestId('ticket-chip');

    // ── Board ──────────────────────────────────────────────────────────────
    this.columnsSelect = page.getByLabel('Group columns by');
    this.fieldFilters = page.getByTestId('board-field-filters');
    this.addTaskButton = this.main.getByRole('button', { name: /Add task/ }).first();
    this.createTaskDialog = page.getByTestId('create-task-dialog');
    this.taskTitleInput = this.createTaskDialog.getByPlaceholder('Task title');
    this.createTaskButton = this.createTaskDialog.getByRole('button', { name: 'Create task', exact: true });
    this.surfaceSelect = this.createTaskDialog.getByLabel('Surface');
    this.prioritySelect = this.createTaskDialog
      .locator('select')
      .filter({ has: page.locator('option', { hasText: 'No priority' }) });
    this.columnHeaders = this.main.locator('[class*="group/header"]');
    this.boardCards = this.main.locator('div.cursor-pointer.bg-card');

    // Sonner toasts (mounted at the app root in ui/src/main.tsx)
    this.toasts = page.locator('[data-sonner-toast]');
  }

  _log(msg) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}${msg}`);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /**
   * Open a nest's Fields tab and wait until both cards have their saved
   * state. The task numbering form starts blank (numbering off, no prefix)
   * and fills itself from the nest settings a moment after they arrive; a
   * click before then edits the blank form, and the saved values never load
   * over it. So wait until the form shows what the server sent.
   */
  async goto(nestId) {
    this._log(`Opening the Fields tab of nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}?tab=fields`);
    await this.customFieldsTitle.waitFor({ state: 'visible' });
    await this.fieldList.or(this.emptyFields).first().waitFor({ state: 'visible' });

    // The saved settings, read as this user. (Not from the page's own
    // response: the page being left — the Board reads them too — can still
    // be finishing a read, and its body is gone once the navigation starts.)
    const res = await this.page.request.get(`/nests/${nestId}/settings`, { timeout: 60_000 });
    if (!res.ok()) throw new Error(`GET /nests/${nestId}/settings → HTTP ${res.status()}`);
    const body = await res.json();
    const rules = (body.settings ?? body).task_rules ?? {};

    const want = {
      numbering: String(Boolean(rules.ticket_numbering)),
      prefix: rules.ticket_prefix ?? '',
      startAt: rules.ticket_start_at ? String(rules.ticket_start_at) : '',
      stageOrder: (rules.stage_order ?? []).join(', '),
    };
    const shown = async () => ({
      numbering: await this.numberingSwitch.getAttribute('aria-checked'),
      prefix: await this.prefixInput.inputValue(),
      startAt: await this.startAtInput.inputValue(),
      stageOrder: await this.stageOrderInput.inputValue(),
    });
    const deadline = Date.now() + 30_000;
    while (JSON.stringify(await shown()) !== JSON.stringify(want)) {
      if (Date.now() > deadline) throw new Error(`Task numbering never showed the saved settings: ${JSON.stringify(want)}`);
      await this.page.waitForTimeout(200);
    }
  }

  /** Open one task or document of a nest and wait for its Fields panel. */
  async gotoDocument(nestId, nodeId) {
    this._log(`Opening ${nodeId}`);
    await this.page.goto(`/nest/${nestId}?doc=${encodeURIComponent(nodeId)}`);
    await this.documentMenu.waitFor({ state: 'visible' });
  }

  /**
   * Open a nest's Board and wait for its cards. The board loads its saved
   * layout with the cards, so changing Columns before then gets undone. Every
   * nest in the suite has at least one document, so there is always a card.
   */
  async gotoBoard(nestId) {
    this._log(`Opening the Board of nest ${nestId}`);
    await this.page.goto(`/nest/${nestId}/board`);
    await this.columnsSelect.waitFor({ state: 'visible' });
    await this.boardCards.first().waitFor({ state: 'visible' });
  }

  // ── Custom fields ──────────────────────────────────────────────────────────

  /** The labels of the field list, top to bottom. */
  async fieldLabels() {
    return (await this.fieldNames.allInnerTexts()).map((t) => t.trim());
  }

  /** One field's row in the list. */
  row(label) {
    return this.fieldRows.filter({ has: this.page.locator('span.text-sm.font-medium', { hasText: new RegExp(`^${label}$`) }) });
  }

  /** The ⋯ menu button on a field's row. */
  rowMenu(label) {
    return this.page.getByRole('button', { name: `${label} options`, exact: true });
  }

  /** Open a field's row menu and return the item with this name. */
  async rowMenuItem(label, item) {
    await this.rowMenu(label).click();
    return this.page.getByRole('menuitem', { name: item, exact: true });
  }

  /**
   * Open the Add field menu. Right after a field is added the list is still
   * refreshing, and on a slow server (CI) a click then can be lost or the
   * menu closed again at once, so try again until the menu shows.
   */
  async openAddFieldMenu() {
    const deadline = Date.now() + 60_000;
    while (!(await this.newFieldItem.isVisible())) {
      if (Date.now() > deadline) throw new Error('The Add field menu never opened');
      await this.addFieldButton.click();
      const open = await this.newFieldItem.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
      if (!open) await this.page.keyboard.press('Escape');
    }
  }

  /** Open Add field → New field. */
  async openNewField() {
    this._log('Opening Add field → New field');
    await this.openAddFieldMenu();
    await this.newFieldItem.click();
    await this.labelInput.waitFor({ state: 'visible' });
  }

  /** Pick a type in the New field dialog (Text, Number, Select, Person, Date, …). */
  async chooseType(typeLabel) {
    await this.typeSelect.click();
    await this.page.getByRole('option', { name: new RegExp(`^${typeLabel}$`) }).click();
  }

  /**
   * Fill the New field dialog. The dialog opens on the Select type; `type`
   * switches it first, so options and defaults are filled for the right type.
   */
  async fillNewField({ label, type, key, options, unit, allTypes, required, defaultValue }) {
    if (type) await this.chooseType(type);
    await this.labelInput.fill(label);
    if (key !== undefined) await this.keyInput.fill(key);
    if (options) await this.optionsInput.fill(options.join('\n'));
    if (unit) await this.unitInput.fill(unit);
    if (allTypes) await this.allTypesSwitch.click();
    if (required) await this.requiredSwitch.click();
    if (defaultValue) {
      await this.defaultSelect.click();
      await this.page.getByRole('option', { name: defaultValue, exact: true }).click();
    }
  }

  /** Add a field through the New field dialog and wait for its row. */
  async addField(spec) {
    this._log(`Adding field "${spec.label}"`);
    await this.openNewField();
    await this.fillNewField(spec);
    await this.addFieldSubmit.click();
    await this.row(spec.label).waitFor({ state: 'visible', timeout: 60_000 });
  }

  /** Remove a field from its row menu, confirming the dialog. */
  async removeField(label) {
    this._log(`Removing field "${label}"`);
    await (await this.rowMenuItem(label, 'Remove')).click();
    await this.removeConfirm.click();
  }

  // ── Task numbering card ────────────────────────────────────────────────────

  /** Save the Task numbering card. */
  async saveNumbering() {
    this._log('Saving Task numbering');
    await this.numberingSave.click();
  }

  /** Add a surface row and fill its name and tags. */
  async addSurface(name, tags) {
    await this.addSurfaceButton.click();
    const i = (await this.surfaceNames.count()) - 1;
    await this.surfaceNames.nth(i).fill(name);
    if (tags) await this.surfaceTags.nth(i).fill(tags);
  }

  /** The values of the priority level inputs, top to bottom. */
  async priorityLevels() {
    return this.priorityInputs.evaluateAll((inputs) => inputs.map((i) => i.value));
  }

  // ── Task / document page ───────────────────────────────────────────────────

  /**
   * Switch the open task into edit mode when it isn't already. The page can
   * re-render into edit mode by itself just after it opens, taking the Edit
   * button away mid-click, so either way counts.
   */
  async startEditing() {
    const deadline = Date.now() + 30_000;
    while (!(await this.tagInput.isVisible()) && Date.now() < deadline) {
      if (await this.editButton.isVisible()) await this.editButton.click({ timeout: 2_000 }).catch(() => {});
      await this.tagInput.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
    }
    await this.tagInput.waitFor({ state: 'visible' });
  }

  /** The Fields panel row for a field (its label cell). */
  panelLabel(label) {
    return this.fieldsPanel.locator('dt', { hasText: new RegExp(`^${label}\\*?$`) });
  }

  /** A Text, Number or Date box in the Fields panel. */
  panelInput(label) {
    return this.fieldsPanel.getByLabel(label, { exact: true });
  }

  /** The dropdown of a Select or Person field in the Fields panel. */
  panelDropdown(label) {
    return this.panelLabel(label).locator('xpath=following-sibling::dd[1]').getByRole('button');
  }

  /** The switch of a Checkbox field in the Fields panel. */
  panelSwitch(label) {
    return this.fieldsPanel.getByRole('switch', { name: label, exact: true });
  }

  /** Type a value into a Text, Number or Date box and commit it with Enter. */
  async setPanelValue(label, value) {
    this._log(`Setting ${label} = ${value}`);
    const box = this.panelInput(label);
    await box.fill(value);
    await box.press('Enter');
  }

  /** Pick a value from a Select or Person dropdown (by item name, or the first item). */
  async choosePanelOption(label, option = null) {
    this._log(`Choosing ${label} = ${option ?? 'the first choice'}`);
    await this.panelDropdown(label).click();
    const item = option
      ? this.page.getByRole('menuitem', { name: option, exact: true })
      : this.page.getByRole('menuitem').first();
    await item.click();
  }

  /** Add a tag from the task page's tag box. */
  async addTag(tag) {
    this._log(`Adding tag ${tag}`);
    await this.tagInput.fill(tag);
    await this.tagInput.press('Enter');
  }

  /** The Remove button of a tag chip on the task page. */
  removeTagButton(tag) {
    return this.page.getByRole('button', { name: `Remove ${tag}`, exact: true });
  }

  /** Open the document menu's Version history. */
  async openVersionHistory() {
    await this.documentMenu.click();
    await this.page.getByRole('menuitem', { name: 'Version history' }).click();
    const dialog = this.page.getByRole('dialog').filter({ hasText: 'Version History' });
    await dialog.waitFor({ state: 'visible' });
    return dialog;
  }

  // ── Board ──────────────────────────────────────────────────────────────────

  /** Open the Board's New task dialog. */
  async openNewTask() {
    await this.addTaskButton.click();
    await this.createTaskDialog.waitFor({ state: 'visible' });
  }

  /**
   * Create a task from the Board's New task dialog, optionally on a surface.
   * Creating a task opens it, so this opens the Board first every time.
   */
  async createTask(nestId, title, { surface } = {}) {
    this._log(`Creating task "${title}" from the Board`);
    await this.gotoBoard(nestId);
    await this.openNewTask();
    if (surface) await this.surfaceSelect.selectOption({ label: surface });
    await this.taskTitleInput.fill(title);
    await this.createTaskButton.click();
    await this.createTaskDialog.waitFor({ state: 'hidden', timeout: 60_000 });
  }

  /** The options of a native select, as shown. */
  async selectOptions(select) {
    return (await select.locator('option').allInnerTexts()).map((o) => o.trim());
  }

  /** A task's card on the Board. */
  card(title) {
    return this.boardCards.filter({ hasText: title });
  }

  /** The column titles of the Board, left to right. */
  async columnTitles() {
    return (await this.columnHeaders.allInnerTexts()).map((t) => t.trim().split(/\s+/)[0]);
  }
}

export default FieldsPage;
