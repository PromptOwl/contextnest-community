/**
 * Activity Trace Page Object Model
 *
 * Page location: ui/src/pages/app/trace/page.tsx → ui/src/components/ActivityTracePage.tsx
 * Route: /trace (rail → Admin → Activity trace, server admins only)
 *
 * Every API request and MCP tool call on the server, newest first, 25 rows a
 * page: Time, Kind (an "api" / "mcp" badge), Call, Nest, Caller, Status, ms.
 * The title row holds a kind filter (All / API / MCP), a "Filter by user…"
 * box (debounced; Enter applies at once) and a Refresh button; under the
 * table, a "{from}–{to} of {total}" counter with Previous / Next.
 *
 * The page carries no data-testids, so everything is addressed by role,
 * placeholder, icon or text.
 */

import logger from '../../helper/logger/logger.js';

/** Column headers, in order, of the server-wide trace. */
export const TRACE_COLUMNS = ['Time', 'Kind', 'Call', 'Nest', 'Caller', 'Status', 'ms'];

class ActivityTracePage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // ── Rail entry (ui/src/components/DocumentSidebar.tsx) ────────────────
    this.railItem = page.getByTestId('document-sidebar-dashboard-trace');

    // ── Title row ─────────────────────────────────────────────────────────
    this.pageTitle = page.getByTestId('page-title');
    this.kindSelect = page.locator('main').getByRole('combobox').first();
    this.userFilter = page.getByPlaceholder('Filter by user…');
    this.refreshButton = page.locator('main button').filter({ has: page.locator('svg.lucide-refresh-cw, svg.animate-spin') }).first();
    this.refreshSpinner = this.refreshButton.locator('svg.animate-spin');

    // ── Table ─────────────────────────────────────────────────────────────
    this.table = page.locator('main table').first();
    this.headers = this.table.locator('thead th');
    this.rows = this.table.locator('tbody tr').filter({ has: page.locator('td:nth-child(2) span') });
    this.emptyState = page.getByText('No activity recorded yet.', { exact: true });
    this.error = page.locator('main p.text-red-500');

    // ── Footer ────────────────────────────────────────────────────────────
    this.counter = page.locator('main span').filter({ hasText: /^\d+–\d+ of \d+$/ }).first();
    this.prevButton = page.locator('main button').filter({ has: page.locator('svg.lucide-chevron-left') }).first();
    this.nextButton = page.locator('main button').filter({ has: page.locator('svg.lucide-chevron-right') }).first();
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  /** True for the page's own read of the trace (not the HTML shell). */
  static isTraceRead(res) {
    try {
      const url = new URL(res.url());
      return url.pathname === '/admin/trace' && res.request().method() === 'GET' && res.request().resourceType() !== 'document';
    } catch {
      return false;
    }
  }

  /** The query a trace read was sent with: `{ kind, user, limit, offset }`. */
  static queryOf(res) {
    const q = new URL(res.url()).searchParams;
    return { kind: q.get('kind'), user: q.get('user'), limit: q.get('limit'), offset: q.get('offset') };
  }

  /**
   * Wait for the page's next trace read (optionally the next one whose query
   * matches `where`); `{ query, body }`. A filter change on a later page first
   * re-reads that page, then resets to page 1 — `where` picks the read that
   * settles it.
   */
  async nextRead(action = async () => {}, where = () => true) {
    const [res] = await Promise.all([
      this.page.waitForResponse((r) => ActivityTracePage.isTraceRead(r) && where(ActivityTracePage.queryOf(r))),
      action(),
    ]);
    return { query: ActivityTracePage.queryOf(res), body: await res.json().catch(() => null) };
  }

  /**
   * Open the trace (by URL, or by `open` — e.g. a rail click) and return the
   * first read the page made, so rows and counts are checked against exactly
   * what the page received.
   */
  async gotoAndRead(open = () => this.page.goto('/trace')) {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Opening Activity trace`);
    const read = await this.nextRead(open);
    await this.pageTitle.filter({ hasText: 'Activity trace' }).waitFor({ state: 'visible' });
    await this.waitIdle();
    return read;
  }

  /** Wait until no load is in flight (Refresh enabled again). */
  async waitIdle() {
    await this.refreshSpinner.waitFor({ state: 'detached' }).catch(() => {});
  }

  // ── Filters ─────────────────────────────────────────────────────────────

  /** Pick All / API / MCP in the kind filter; returns the read it caused. */
  async chooseKind(label) {
    await this.kindSelect.click();
    const kind = label === 'All' ? null : label.toLowerCase();
    const read = await this.nextRead(
      () => this.page.getByRole('option', { name: label, exact: true }).click(),
      (q) => q.kind === kind && q.offset === '0'
    );
    await this.waitIdle();
    return read;
  }

  // ── Rows ────────────────────────────────────────────────────────────────

  row(i) {
    return this.rows.nth(i);
  }

  /** A row's cell by column name (server-wide layout). */
  cell(i, column) {
    return this.row(i).locator('td').nth(TRACE_COLUMNS.indexOf(column));
  }

  kindBadge(i) {
    return this.cell(i, 'Kind').locator('span').first();
  }
}

export default ActivityTracePage;
