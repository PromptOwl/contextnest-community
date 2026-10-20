/**
 * Message Log Page Object Model
 *
 * Page location: ui/src/pages/app/messages/page.tsx → ui/src/components/MessageLogPage.tsx
 * Route: /messages (rail → Admin → Message log, superadmins only)
 *
 * Every message the server sent — email, Slack, Teams, webhooks, inbox
 * notifications and agent comments — across every nest. Two tabs:
 *
 *   - Messages: a "Search subject or recipient…" box (debounced 300 ms; Enter
 *     applies at once), Channel / Sender / Status selects and a Refresh
 *     button; a table (Time, Channel, From, To, Subject, Status), 50 rows a
 *     page, newest first; a footer with the retention / bodies line and a
 *     "{from}–{to} of {total}" pager. A row opens the message in a dialog.
 *   - Access log: who looked at the log (Time, Who, What, Detail), 50 a page.
 *
 * The page carries no data-testids, so everything is addressed by role,
 * accessible name, placeholder or text.
 */

import logger from '../../helper/logger/logger.js';

/** Column headers, in order. */
export const MESSAGE_COLUMNS = ['Time', 'Channel', 'From', 'To', 'Subject', 'Status'];
export const ACCESS_COLUMNS = ['Time', 'Who', 'What', 'Detail'];

/** Channel / sender / status labels the selects use. */
export const CHANNEL_LABEL = { email: 'Email', slack: 'Slack', msteams: 'Teams', webhook: 'Webhook', inbox: 'Inbox', comment: 'Comment' };
export const SENDER_LABEL = { human: 'People', persona: 'Agents', system: 'System' };
export const STATUS_LABEL = { sent: 'Sent', failed: 'Failed', skipped: 'Skipped' };
export const ACTION_LABEL = { list: 'Searched the log', detail: 'Opened a message', views: 'Viewed the access log' };

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

class MessageLogPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail entry (ui/src/components/DocumentSidebar.tsx) ────────────────
    this.railItem = page.getByTestId('document-sidebar-dashboard-messages');

    // ── Page shell ────────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    this.notice = page.locator('main').getByText('Everything this server sent', { exact: false }).first();
    this.messagesTab = page.getByRole('tab', { name: 'Messages', exact: true });
    this.accessTab = page.getByRole('tab', { name: 'Access log', exact: true });
    this.panel = page.locator('[role="tabpanel"][data-state="active"]');

    // ── Messages tab: toolbar ─────────────────────────────────────────────
    this.search = page.getByRole('textbox', { name: 'Search subject or recipient' });
    this.channelSelect = page.getByRole('combobox', { name: 'Channel' });
    this.senderSelect = page.getByRole('combobox', { name: 'Sender' });
    this.statusSelect = page.getByRole('combobox', { name: 'Status' });
    this.refreshButton = page.getByRole('button', { name: 'Refresh', exact: true });
    this.refreshSpinner = this.refreshButton.locator('svg.animate-spin');

    // ── Table (whichever tab is open) ─────────────────────────────────────
    this.table = this.panel.locator('table').first();
    this.headers = this.table.locator('thead th');
    this.rows = this.table.locator('tbody tr').filter({ hasNot: page.locator('td[colspan]') });
    this.emptyMessages = page.getByText('No messages match.', { exact: true });
    this.emptyAccess = page.getByText('No access recorded yet.', { exact: true });
    this.error = this.panel.locator('p.text-red-600').first();

    // ── Footer ────────────────────────────────────────────────────────────
    this.footerNote = this.panel.getByText(/^(Kept .* change in Settings|Newest first\.)$/);
    this.accessNote = page.getByText('Every look at the message log, kept for a year. This view is recorded too.', { exact: true });
    this.counter = this.panel.locator('span').filter({ hasText: /^\d+–\d+ of \d+$/ }).first();
    this.prevButton = this.panel.getByRole('button', { name: 'Previous page' });
    this.nextButton = this.panel.getByRole('button', { name: 'Next page' });

    // ── Message dialog ────────────────────────────────────────────────────
    this.dialog = page.getByRole('dialog');
    this.dialogTitle = this.dialog.getByRole('heading').first();
    this.dialogDescription = this.dialog.getByText('Secrets are redacted before a message is stored. Opening it is recorded in the access log.', { exact: true });
    this.dialogBody = this.dialog.locator('pre');
    this.noBody = this.dialog.getByText('No body stored — bodies are off in Settings, or this message had none.', { exact: true });
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  /** True for the page's own read of the message list (not views, not one message). */
  static isListRead(res) {
    return pathOf(res.url()) === '/admin/messages' && res.request().method() === 'GET' && res.request().resourceType() !== 'document';
  }

  static isViewsRead(res) {
    return pathOf(res.url()) === '/admin/messages/views' && res.request().method() === 'GET';
  }

  static isDetailRead(res) {
    const p = pathOf(res.url());
    return p.startsWith('/admin/messages/') && p !== '/admin/messages/views' && res.request().method() === 'GET';
  }

  /** The query a list read was sent with, as strings (null when absent). */
  static queryOf(res) {
    const q = new URL(res.url()).searchParams;
    const get = (k) => q.get(k);
    return { channel: get('channel'), sender_kind: get('sender_kind'), status: get('status'), q: get('q'), limit: get('limit'), offset: get('offset') };
  }

  /**
   * Wait for the page's next read of a kind (`list` / `views` / `detail`),
   * optionally the next whose query matches `where`; `{ query, body, status }`.
   */
  async nextRead(action = async () => {}, { kind = 'list', where = () => true } = {}) {
    const test = { list: MessageLogPage.isListRead, views: MessageLogPage.isViewsRead, detail: MessageLogPage.isDetailRead }[kind];
    const [res] = await Promise.all([
      this.page.waitForResponse((r) => test(r) && (kind !== 'list' || where(MessageLogPage.queryOf(r)))),
      action(),
    ]);
    return {
      query: kind === 'list' ? MessageLogPage.queryOf(res) : null,
      status: res.status(),
      body: await res.json().catch(() => null),
    };
  }

  /** Open the log (by URL, or by `open`) and return the first list read the page made. */
  async gotoAndRead(open = () => this.page.goto('/messages')) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Opening Message log`);
    const read = await this.nextRead(open);
    await this.pageTitle.filter({ hasText: 'Message log' }).waitFor({ state: 'visible' });
    await this.waitIdle();
    return read;
  }

  /** Wait until no load is in flight (Refresh enabled again). */
  async waitIdle() {
    await this.refreshSpinner.waitFor({ state: 'detached' }).catch(() => {});
  }

  /** Open the Access log tab and return the views read it made. */
  async openAccessLog() {
    const read = await this.nextRead(() => this.accessTab.click(), { kind: 'views' });
    await this.accessNote.waitFor({ state: 'visible' });
    return read;
  }

  // ── Filters ─────────────────────────────────────────────────────────────

  /**
   * Pick an option in one of the three selects; returns the list read that
   * settles it (page 1 with the new value). `param` is the query key the
   * select drives, `value` its wire value (null for the "all" option).
   */
  async choose(select, label, param, value) {
    await select.click();
    const read = await this.nextRead(() => this.page.getByRole('option', { name: label, exact: true }).click(), {
      where: (q) => q[param] === value && q.offset === '0',
    });
    await this.waitIdle();
    return read;
  }

  /** Options listed in a select, in order. */
  async optionsOf(select) {
    await select.click();
    const options = await this.page.getByRole('option').allInnerTexts();
    await this.page.keyboard.press('Escape');
    return options.map((o) => o.trim());
  }

  // ── Rows ────────────────────────────────────────────────────────────────

  row(i) {
    return this.rows.nth(i);
  }

  /** A Messages-tab cell by column name. */
  cell(i, column) {
    return this.row(i).locator('td').nth(MESSAGE_COLUMNS.indexOf(column));
  }

  /** An Access-log cell by column name. */
  accessCell(i, column) {
    return this.row(i).locator('td').nth(ACCESS_COLUMNS.indexOf(column));
  }

  /** Open row `i`'s message; returns the detail read. */
  async openRow(i) {
    const read = await this.nextRead(() => this.row(i).click(), { kind: 'detail' });
    await this.dialog.waitFor({ state: 'visible' });
    return read;
  }

  /** A field value in the message dialog, by its label ("Sent", "Channel", …). */
  field(label) {
    return this.dialog.locator('dl > div').filter({ has: this.page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
  }

  /** Labels of every field the dialog shows, in order. */
  async fieldLabels() {
    return (await this.dialog.locator('dl dt').allInnerTexts()).map((t) => t.trim());
  }
}

export default MessageLogPage;
