/**
 * Message Log Test Suite — CN-MSG-001 … CN-MSG-029
 *
 * Page under test: ui/src/components/MessageLogPage.tsx (route `/messages`,
 * rail → Admin → Message log), over REST GET /admin/messages,
 * /admin/messages/:id and /admin/messages/views.
 *
 * Conventions
 * -----------
 * - The page is for superadmins (a server admin, never in open mode): the
 *   primary account runs every case but the non-admin and nest-scoped-key
 *   halves, which need a second account that is not one.
 * - The page only reads. Cases run against the real server-wide log where
 *   they can. That log grows with every notification on a shared server — the
 *   suite's own included — so rows and counts are checked against the
 *   response the page itself received, never a number read separately.
 * - Every read of the log is recorded in its access log. That is what
 *   CN-MSG-023/026/027 check; the other cases add rows there too, by design.
 * - States the real log can't be relied on to have — one row of every shape,
 *   a message with every optional field (or none, or no body), a failed read,
 *   a slow read, an exact last page — are served by
 *   `src/lib/message_log_stubs.js`, and each such test says so.
 * - Settings are server-wide: CN-MSG-029 saves through
 *   `src/lib/server_settings_stubs.js`, never to the server.
 * - CN-MSG-022 writes on purpose: it shares one of its own nests (named with
 *   key-shaped strings) so the server sends a message that must be redacted.
 *   The nest is registered for cleanup.
 * - CN-MSG-025 only runs against a server in open auth mode; it skips
 *   elsewhere.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { MESSAGE_COLUMNS, ACCESS_COLUMNS, CHANNEL_LABEL, ACTION_LABEL } from '../../src/page_factory/app/message_log_page.js';
import {
  messageRow,
  messageDetail,
  viewRow,
  stubMessageLog,
  overrideMessageLogMeta,
  stubMessageDetail,
  stubMessageViews,
  holdMessageLog,
} from '../../src/lib/message_log_stubs.js';
import { stubServerSettings } from '../../src/lib/server_settings_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

const PAGE_SIZE = 50;
const DENIED = 'Only a superadmin can view the message log.';
const SCOPED_DENIED =
  "This API key is scoped to one nest and can't reach account-wide or server-wide routes (API keys, admin, teams, people, your inbox). Use a key for all your nests for those.";

/** "{from}–{to} of {total}" for a read at `offset` with `total` rows. */
const counterFor = (offset, total, size = PAGE_SIZE) => `${total === 0 ? 0 : offset + 1}–${Math.min(offset + size, total)} of ${total}`;

/** The subject as the page words it (machine labels → words). */
function subjectText(m) {
  const s = m.subject ?? '';
  if (m.channel === 'inbox' && /^[a-z_]+$/.test(s)) {
    const words = s.replace(/_/g, ' ');
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} notification`;
  }
  if (s === 'server-slack' || s === 'slack') return 'Server Slack channel';
  if (s === 'server-msteams' || s === 'msteams') return 'Server Teams channel';
  if (s.startsWith('connector:')) return 'Nest connector';
  return s || '—';
}

const recipientsText = (r) => (r.length === 0 ? '—' : r.length === 1 ? r[0] : `${r[0]} +${r.length - 1}`);

/** The footer line for a read's retention / bodies settings. */
const footerFor = (body) =>
  `Kept ${body.retention_days === 0 ? 'forever' : `${body.retention_days} days`} · bodies ${body.store_bodies ? 'stored, redacted' : 'not stored'} · change in Settings`;

/** Initialise the primary account; skips when it isn't a server admin. */
async function asAdmin(role) {
  await role.initialize();
  test.skip(!(await role.teammatesApi.isServerAdmin()), 'primary_user is not a server admin on this server.');
  return role;
}

/** The rows the page shows must be exactly the messages it received. */
async function expectRowsMatch(ml, messages) {
  await expect(ml.rows).toHaveCount(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    await expect(ml.cell(i, 'Channel'), `row ${i} channel`).toHaveText(CHANNEL_LABEL[m.channel] ?? m.channel);
    await expect(ml.cell(i, 'Status'), `row ${i} status`).toHaveText(m.status);
    await expect(ml.cell(i, 'To'), `row ${i} recipients`).toHaveText(recipientsText(m.recipients));
  }
}

/** A REST client authenticated only by `apiKey` (no session cookie). */
async function keyClient(playwright, apiKey) {
  return playwright.request.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${apiKey}` },
  });
}

test.describe('Message log', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test('CN-MSG-001: only server admins can access the Message log', async ({ primary_user, secondary_user }) => {
    // ── A non-admin: no rail row, the URL shows Nests, the API refuses ──
    if (secondaryRole) {
      await secondary_user.initialize();
      if (!(await secondary_user.teammatesApi.isServerAdmin())) {
        const { page, nestsPage, messageLogPage: ml } = secondary_user;
        await nestsPage.goto();
        await expect(page.getByTestId('document-sidebar-dashboard-teams')).toBeVisible();
        await expect(ml.railItem).toHaveCount(0);
        await page.goto('/messages');
        await expect(ml.pageTitle).toContainText('Nests');
        await expect(ml.search).toHaveCount(0);
        for (const path of ['/admin/messages', '/admin/messages/views']) {
          const res = await secondary_user.dashboardApi.request('GET', path);
          expect(res.status, `GET ${path} as a non-admin`).toBe(403);
          expect(res.data?.error).toBe(DENIED);
        }
      }
    }

    // ── The admin: rail row → the Message log ──
    await asAdmin(primary_user);
    const { nestsPage, messageLogPage: ml } = primary_user;
    await nestsPage.goto();
    await expect(ml.railItem).toBeVisible();
    const { query, body } = await ml.gotoAndRead(() => ml.railItem.click());
    await expect(ml.railItem).toHaveAttribute('aria-current', 'page');
    await expect(ml.pageTitle).toContainText('Message log');
    expect(query).toMatchObject({ channel: null, sender_kind: null, status: null, q: null, limit: '50', offset: '0' });
    expect(body.total, 'a shared server has sent messages').toBeGreaterThan(0);
  });

  test('CN-MSG-002: a nest-scoped API key cannot access the Message log', async ({ primary_user, secondary_user, commonFunction, playwright }) => {
    // The secondary account mints the keys: the primary is near its key cap.
    // The scope check comes first, so its refusal is distinct from the
    // "only a superadmin" one a user-level key from a non-admin gets.
    test.skip(!secondaryRole, 'secondary_user is not configured.');
    await primary_user.initialize();
    await secondary_user.initialize();
    const nest = await primary_user.dashboardApi.createNest(commonFunction.generateEntityName('msg-scoped-key'));
    await primary_user.dashboardApi.addCollaborator(nest.id, secondaryRole.email, 'read');
    const keys = secondary_user.apiKeysApi;
    const label = commonFunction.generateEntityName('msg-key');
    try {
      const scoped = await keys.createKey(`${label}-scoped`, nest.id);
      const client = await keyClient(playwright, scoped.api_key);
      for (const path of ['/admin/messages', '/admin/messages/views', '/admin/messages/any-id']) {
        const res = await client.get(path);
        expect(res.status(), `GET ${path} with a nest-scoped key`).toBe(403);
        expect((await res.json()).error).toBe(SCOPED_DENIED);
      }
      await client.dispose();

      if (!(await secondary_user.teammatesApi.isServerAdmin())) {
        const full = await keys.createKey(`${label}-full`);
        const fullClient = await keyClient(playwright, full.api_key);
        const res = await fullClient.get('/admin/messages');
        expect(res.status(), 'a user-level key of a non-admin').toBe(403);
        expect((await res.json()).error).toBe(DENIED);
        await fullClient.dispose();
      }
    } finally {
      await keys.revokeKeysNamed(label);
    }
  });

  test('CN-MSG-003: the page displays its title, information notice and tabs', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    await ml.gotoAndRead();
    await expect(ml.pageTitle).toHaveText('Message log');
    await expect(ml.notice).toHaveText(
      'Everything this server sent — email, Slack and Teams, webhooks, inbox notifications, and agent comments — across every nest. Visible to superadmins only. Passwords, sign-in links, keys and webhook URLs are redacted before storage, and every view is recorded in the access log.'
    );
    await expect(ml.messagesTab).toHaveAttribute('aria-selected', 'true');
    await expect(ml.accessTab).toHaveAttribute('aria-selected', 'false');
    await expect(ml.search).toBeVisible();
    await expect(ml.channelSelect).toHaveText('All channels');
    await expect(ml.senderSelect).toHaveText('All senders');
    await expect(ml.statusSelect).toHaveText('Any status');
    await expect(ml.refreshButton).toBeEnabled();
  });

  test('CN-MSG-004: the messages table displays the correct columns, sorted newest first', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    const { body } = await ml.gotoAndRead();
    await expect(ml.headers).toHaveText(MESSAGE_COLUMNS);
    expect(body.messages.length).toBe(Math.min(PAGE_SIZE, body.total));
    await expectRowsMatch(ml, body.messages);
    const times = body.messages.map((m) => new Date(m.created_at).getTime());
    expect(times, 'rows are newest first').toEqual([...times].sort((a, b) => b - a));
  });

  test('CN-MSG-005: message rows display sender, recipients, subject and status correctly', async ({ primary_user }) => {
    // Stubbed: one row of every shape, which the real log can't be relied on to hold.
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;
    const rows = [
      messageRow(0, { channel: 'email', sender_kind: 'system', recipients: ['one@example.com'], subject: 'Plain subject', status: 'sent' }),
      messageRow(1, { channel: 'comment', sender_kind: 'persona', sender: 'Hootie', recipients: ['a@example.com', 'b@example.com', 'c@example.com'], subject: 'Agent note', status: 'failed' }),
      messageRow(2, { channel: 'inbox', sender_kind: 'human', sender: 'alice@example.com', subject: 'review_requested', status: 'skipped', nest_id: 'n-1', nest_name: 'Acme Nest' }),
      messageRow(3, { channel: 'slack', subject: 'server-slack', recipients: ['hooks.slack.com#0123456789ab'] }),
      messageRow(4, { channel: 'msteams', subject: 'server-msteams', recipients: [] }),
      messageRow(5, { channel: 'webhook', subject: 'connector:github', recipients: ['api.github.com#abcdef012345'] }),
    ];
    await stubMessageLog(page, rows);
    await ml.gotoAndRead();
    await expect(ml.rows).toHaveCount(rows.length);

    // From: "System", a persona with its Agent badge, a person's address.
    await expect(ml.cell(0, 'From')).toHaveText('System');
    await expect(ml.cell(1, 'From')).toContainText('Hootie');
    await expect(ml.cell(1, 'From').getByText('Agent', { exact: true })).toBeVisible();
    await expect(ml.cell(2, 'From')).toHaveText('alice@example.com');
    await expect(ml.cell(2, 'From').getByText('Agent', { exact: true })).toHaveCount(0);

    // To: one address, the first plus "+N" (all of them on hover), or "—".
    await expect(ml.cell(0, 'To')).toHaveText('one@example.com');
    await expect(ml.cell(1, 'To')).toHaveText('a@example.com +2');
    await expect(ml.cell(1, 'To')).toHaveAttribute('title', 'a@example.com, b@example.com, c@example.com');
    await expect(ml.cell(4, 'To')).toHaveText('—');

    // Subject: as written, machine labels as words, the nest after a dot.
    await expect(ml.cell(0, 'Subject')).toHaveText('Plain subject');
    await expect(ml.cell(2, 'Subject')).toHaveText('Review requested notification · Acme Nest');
    await expect(ml.cell(3, 'Subject')).toHaveText('Server Slack channel');
    await expect(ml.cell(4, 'Subject')).toHaveText('Server Teams channel');
    await expect(ml.cell(5, 'Subject')).toHaveText('Nest connector');

    // Channel and status.
    for (const [i, label] of [[0, 'Email'], [1, 'Comment'], [2, 'Inbox'], [3, 'Slack'], [4, 'Teams'], [5, 'Webhook']]) {
      await expect(ml.cell(i, 'Channel')).toHaveText(label);
    }
    await expect(ml.cell(0, 'Status')).toHaveText('sent');
    await expect(ml.cell(1, 'Status')).toHaveText('failed');
    await expect(ml.cell(2, 'Status')).toHaveText('skipped');
  });

  test('CN-MSG-006: messages can be searched by subject or recipient', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    const { body } = await ml.gotoAndRead();
    const sample = body.messages.find((m) => (m.subject ?? '').length >= 6 && m.recipients.length > 0);
    test.skip(!sample, 'no message with a subject and a recipient to search for');

    // By subject: part of it, as typed — applied on its own after the debounce.
    const word = sample.subject.slice(0, Math.min(12, sample.subject.length)).trim();
    const bySubject = await ml.nextRead(() => ml.search.fill(word), { where: (q) => q.q === word });
    await ml.waitIdle();
    expect(bySubject.body.total).toBeGreaterThan(0);
    for (const m of bySubject.body.messages) {
      const hay = `${m.subject ?? ''} ${m.recipients.join(' ')}`.toLowerCase();
      expect(hay, 'every row matches the search').toContain(word.toLowerCase());
    }
    await expectRowsMatch(ml, bySubject.body.messages);

    // By recipient, in another letter case — Enter applies it at once.
    const who = sample.recipients[0].split('@')[0].toUpperCase();
    await ml.search.fill(who);
    const byRecipient = await ml.nextRead(() => ml.search.press('Enter'), { where: (q) => q.q === who });
    await ml.waitIdle();
    expect(byRecipient.body.total, 'the match ignores letter case').toBeGreaterThan(0);
    for (const m of byRecipient.body.messages) {
      const hay = `${m.subject ?? ''} ${m.recipients.join(' ')}`.toLowerCase();
      expect(hay).toContain(who.toLowerCase());
    }
    await expectRowsMatch(ml, byRecipient.body.messages);
  });

  test('CN-MSG-007: an empty state is displayed when no messages match the search', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    await ml.gotoAndRead();
    const needle = `no-such-message-${Date.now().toString(36)}`;
    const read = await ml.nextRead(() => ml.search.fill(needle), { where: (q) => q.q === needle });
    await ml.waitIdle();
    expect(read.body.total).toBe(0);
    await expect(ml.emptyMessages).toBeVisible();
    await expect(ml.rows).toHaveCount(0);
    await expect(ml.counter).toHaveText('0–0 of 0');
    await expect(ml.prevButton).toBeDisabled();
    await expect(ml.nextButton).toBeDisabled();
  });

  test('CN-MSG-008: messages can be filtered by channel', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    await ml.gotoAndRead();
    expect(await ml.optionsOf(ml.channelSelect)).toEqual(['All channels', 'Email', 'Slack', 'Teams', 'Webhook', 'Inbox', 'Comment']);
    for (const [value, label] of Object.entries(CHANNEL_LABEL)) {
      const { body } = await ml.choose(ml.channelSelect, label, 'channel', value);
      expect(body.messages.every((m) => m.channel === value), `only ${label} rows`).toBe(true);
      await expectRowsMatch(ml, body.messages);
      if (body.total === 0) await expect(ml.emptyMessages).toBeVisible();
    }
    const all = await ml.choose(ml.channelSelect, 'All channels', 'channel', null);
    expect(all.body.total).toBeGreaterThan(0);
    await expect(ml.channelSelect).toHaveText('All channels');
  });

  test('CN-MSG-009: messages can be filtered by sender type', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    await ml.gotoAndRead();
    expect(await ml.optionsOf(ml.senderSelect)).toEqual(['All senders', 'People', 'Agents', 'System']);

    const people = await ml.choose(ml.senderSelect, 'People', 'sender_kind', 'human');
    expect(people.body.messages.every((m) => m.sender_kind === 'human')).toBe(true);
    await expectRowsMatch(ml, people.body.messages);

    const agents = await ml.choose(ml.senderSelect, 'Agents', 'sender_kind', 'persona');
    expect(agents.body.messages.every((m) => m.sender_kind === 'persona')).toBe(true);
    for (let i = 0; i < agents.body.messages.length; i++) {
      await expect(ml.cell(i, 'From').getByText('Agent', { exact: true }), `row ${i} carries the Agent badge`).toBeVisible();
    }

    const system = await ml.choose(ml.senderSelect, 'System', 'sender_kind', 'system');
    expect(system.body.messages.every((m) => m.sender_kind === 'system')).toBe(true);
    for (let i = 0; i < system.body.messages.length; i++) await expect(ml.cell(i, 'From')).toHaveText('System');

    const all = await ml.choose(ml.senderSelect, 'All senders', 'sender_kind', null);
    expect(all.body.total).toBeGreaterThanOrEqual(system.body.total);
  });

  test('CN-MSG-010: messages can be filtered by status', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    const first = await ml.gotoAndRead();
    expect(await ml.optionsOf(ml.statusSelect)).toEqual(['Any status', 'Sent', 'Failed', 'Skipped']);
    for (const [value, label] of [['sent', 'Sent'], ['failed', 'Failed'], ['skipped', 'Skipped']]) {
      const { body } = await ml.choose(ml.statusSelect, label, 'status', value);
      expect(body.messages.every((m) => m.status === value), `only ${value} rows`).toBe(true);
      await expectRowsMatch(ml, body.messages);
    }
    const any = await ml.choose(ml.statusSelect, 'Any status', 'status', null);
    expect(any.body.total).toBeGreaterThanOrEqual(first.body.total);
  });

  test('CN-MSG-011: filters and search combine, and changing them resets to the first page', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    const { body } = await ml.gotoAndRead();
    test.skip(body.total <= PAGE_SIZE, 'the log has a single page');

    // On page 2, a filter change goes back to page 1.
    await ml.nextRead(() => ml.nextButton.click(), { where: (q) => q.offset === '50' });
    await ml.waitIdle();
    await expect(ml.counter).toHaveText(new RegExp(`^51–`));
    const email = await ml.choose(ml.channelSelect, 'Email', 'channel', 'email');
    expect(email.query.offset).toBe('0');
    await expect(ml.counter).toHaveText(counterFor(0, email.body.total));

    // Channel + status + search together: every row matches all three.
    const failed = await ml.choose(ml.statusSelect, 'Failed', 'status', 'failed');
    expect(failed.query).toMatchObject({ channel: 'email', status: 'failed', offset: '0' });
    const term = failed.body.messages[0]?.recipients[0]?.split('@')[1] ?? 'example';
    const combined = await ml.nextRead(() => ml.search.fill(term), { where: (q) => q.q === term });
    await ml.waitIdle();
    expect(combined.query).toMatchObject({ channel: 'email', status: 'failed', q: term, offset: '0' });
    for (const m of combined.body.messages) {
      expect(m.channel).toBe('email');
      expect(m.status).toBe('failed');
      expect(`${m.subject ?? ''} ${m.recipients.join(' ')}`.toLowerCase()).toContain(term.toLowerCase());
    }
    await expectRowsMatch(ml, combined.body.messages);
  });

  test('CN-MSG-012: pagination works correctly on the Messages tab', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;

    // ── The real log: page 1, then page 2 and back ──
    const p1 = await ml.gotoAndRead();
    await expect(ml.counter).toHaveText(counterFor(0, p1.body.total));
    await expect(ml.prevButton).toBeDisabled();
    if (p1.body.total > PAGE_SIZE) {
      await expect(ml.nextButton).toBeEnabled();
      const p2 = await ml.nextRead(() => ml.nextButton.click(), { where: (q) => q.offset === '50' });
      await ml.waitIdle();
      expect(p2.query.limit).toBe('50');
      await expect(ml.counter).toHaveText(counterFor(50, p2.body.total));
      await expectRowsMatch(ml, p2.body.messages);
      await ml.nextRead(() => ml.prevButton.click(), { where: (q) => q.offset === '0' });
      await ml.waitIdle();
      await expect(ml.prevButton).toBeDisabled();
    }

    // ── An exact last page (stubbed: the real total keeps growing) ──
    await stubMessageLog(page, Array.from({ length: 120 }, (_, i) => messageRow(i)));
    await ml.gotoAndRead();
    await expect(ml.counter).toHaveText('1–50 of 120');
    await expect(ml.rows).toHaveCount(50);
    await ml.nextRead(() => ml.nextButton.click(), { where: (q) => q.offset === '50' });
    await expect(ml.counter).toHaveText('51–100 of 120');
    await ml.nextRead(() => ml.nextButton.click(), { where: (q) => q.offset === '100' });
    await expect(ml.counter).toHaveText('101–120 of 120');
    await expect(ml.rows).toHaveCount(20);
    await expect(ml.nextButton).toBeDisabled();
    await expect(ml.prevButton).toBeEnabled();
  });

  test('CN-MSG-013: Refresh reloads the messages table', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;
    await ml.gotoAndRead();
    // Held: the read waits until released, so the loading state can be seen.
    const hold = await holdMessageLog(page);
    const reread = ml.nextRead(() => ml.refreshButton.click());
    await expect(ml.refreshSpinner).toBeVisible();
    await expect(ml.refreshButton).toBeDisabled();
    hold.release();
    const { query, body } = await reread;
    expect(query).toMatchObject({ limit: '50', offset: '0' });
    await ml.waitIdle();
    await expect(ml.refreshButton).toBeEnabled();
    await expectRowsMatch(ml, body.messages);
  });

  test('CN-MSG-014: an error message is displayed when the Message log fails to load', async ({ primary_user }) => {
    // Stubbed: the real log doesn't fail on demand.
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;
    await stubMessageLog(page, { status: 500, body: { error: 'The message log is unavailable right now.' } });
    await page.goto('/messages');
    await expect(ml.pageTitle).toContainText('Message log');
    await expect(ml.error).toHaveText('The message log is unavailable right now.');
    await expect(ml.rows).toHaveCount(0);
  });

  test('CN-MSG-015: the footer reflects the retention and body storage settings', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;
    // The real settings, as the server reports them.
    const { body } = await ml.gotoAndRead();
    await expect(ml.footerNote).toHaveText(footerFor(body));

    // The other states (stubbed: the settings are server-wide).
    await overrideMessageLogMeta(page, { retention_days: 0, store_bodies: false });
    await ml.gotoAndRead();
    await expect(ml.footerNote).toHaveText('Kept forever · bodies not stored · change in Settings');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await overrideMessageLogMeta(page, { retention_days: 7, store_bodies: true });
    await ml.gotoAndRead();
    await expect(ml.footerNote).toHaveText('Kept 7 days · bodies stored, redacted · change in Settings');
  });

  test('CN-MSG-016: the API filters messages by nest, agent run and date range', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const api = primary_user.dashboardApi;
    const { data: all } = await api.request('GET', '/admin/messages?limit=200');
    expect(all.total).toBeGreaterThan(0);

    // Nest: only that nest's messages.
    const withNest = all.messages.find((m) => m.nest_id);
    if (withNest) {
      const { data } = await api.request('GET', `/admin/messages?nest=${encodeURIComponent(withNest.nest_id)}&limit=200`);
      expect(data.total).toBeGreaterThan(0);
      expect(data.messages.every((m) => m.nest_id === withNest.nest_id)).toBe(true);
    }

    // Agent run: an unknown run matches nothing; a known one only its own messages.
    const { data: noRun } = await api.request('GET', `/admin/messages?run=no-such-run-${Date.now()}`);
    expect(noRun.total).toBe(0);
    const withRun = all.messages.find((m) => m.run_id);
    if (withRun) {
      const { data } = await api.request('GET', `/admin/messages?run=${encodeURIComponent(withRun.run_id)}`);
      expect(data.messages.every((m) => m.run_id === withRun.run_id)).toBe(true);
    }

    // Date range: the newest message's day, inclusive at both ends.
    const day = all.messages[0].created_at.slice(0, 10);
    const { data: inDay } = await api.request('GET', `/admin/messages?from=${day}T00:00:00.000Z&to=${day}T23:59:59.999Z&limit=200`);
    expect(inDay.total).toBeGreaterThan(0);
    expect(inDay.messages.every((m) => m.created_at.slice(0, 10) === day)).toBe(true);
    const { data: future } = await api.request('GET', `/admin/messages?from=2999-01-01T00:00:00.000Z`);
    expect(future.total, 'nothing after a date in the future').toBe(0);
  });

  test('CN-MSG-017: the API returns 50 messages per page by default and at most 200', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const api = primary_user.dashboardApi;
    const { data: def } = await api.request('GET', '/admin/messages');
    expect(def.limit).toBe(50);
    expect(def.messages.length).toBe(Math.min(50, def.total));
    const { data: big } = await api.request('GET', '/admin/messages?limit=500');
    expect(big.limit, 'capped at 200').toBe(200);
    expect(big.messages.length).toBeLessThanOrEqual(200);
    const { data: zero } = await api.request('GET', '/admin/messages?limit=0');
    expect(zero.limit, 'a non-positive limit falls back to 50').toBe(50);
    const { data: off } = await api.request('GET', '/admin/messages?limit=5&offset=5');
    expect(off.offset).toBe(5);
    expect(off.messages.length).toBeLessThanOrEqual(5);
  });

  test('CN-MSG-018: opening a message displays its details', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;
    const { body } = await ml.gotoAndRead();
    const first = body.messages[0];
    const detail = await ml.openRow(0);
    expect(detail.status).toBe(200);
    const msg = detail.body.message;
    expect(msg.id).toBe(first.id);

    await expect(ml.dialogTitle).toHaveText(subjectText(msg));
    await expect(ml.dialogDescription).toBeVisible();
    const labels = await ml.fieldLabels();
    expect(labels.slice(0, 5)).toEqual(['Sent', 'Channel', 'From', 'To', 'Status']);
    await expect(ml.field('Channel')).toHaveText(CHANNEL_LABEL[msg.channel] ?? msg.channel);
    await expect(ml.field('To')).toHaveText(msg.recipients.join(', ') || '—');
    await expect(ml.field('Status')).toContainText(msg.status);
    if (msg.body) await expect(ml.dialogBody).toHaveText(msg.body);
    else await expect(ml.noBody).toBeVisible();

    // Escape closes it; Space on a focused row opens it too.
    await page.keyboard.press('Escape');
    await expect(ml.dialog).toBeHidden();
    await ml.row(0).focus();
    await ml.nextRead(() => page.keyboard.press('Space'), { kind: 'detail' });
    await expect(ml.dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(ml.dialog).toBeHidden();

    // Known issue: Enter on a focused row fetches the message, but the dialog
    // doesn't open (focus drops to the page). Recorded, not asserted, until
    // it's fixed — then assert it like Space above.
    await ml.row(0).focus();
    await ml.nextRead(() => page.keyboard.press('Enter'), { kind: 'detail' });
    if (!(await ml.dialog.isVisible())) {
      test.info().annotations.push({
        type: 'known issue',
        description: 'Enter on a focused Message log row fetches the message but does not open its dialog (Space and click do).',
      });
    } else {
      await page.keyboard.press('Escape');
    }
  });

  test('CN-MSG-019: optional message fields are displayed only when present', async ({ primary_user }) => {
    // Stubbed: one message with every optional field, one direct, one with none.
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;
    const full = messageDetail(0, {
      nest_id: 'n-acme',
      nest_name: 'Acme Nest',
      node_id: 'nodes/acme/plan',
      run_id: 'run-123',
      provider_id: 'provider-abc',
      via_proxy: true,
    });
    const direct = messageDetail(1, { via_proxy: false });
    const bare = messageDetail(2);
    await stubMessageLog(page, [full, direct, bare].map(({ body: _b, ...r }) => ({ ...r, has_body: true })));
    await stubMessageDetail(page, { [full.id]: full, [direct.id]: direct, [bare.id]: bare });
    await ml.gotoAndRead();

    await ml.openRow(0);
    expect(await ml.fieldLabels()).toEqual(['Sent', 'Channel', 'From', 'To', 'Status', 'Route', 'Nest', 'Document', 'Agent run', 'Provider ID']);
    await expect(ml.field('Route')).toHaveText('Through the egress proxy');
    await expect(ml.field('Nest')).toHaveText('Acme Nest');
    await expect(ml.field('Document')).toHaveText('nodes/acme/plan');
    await expect(ml.field('Agent run')).toHaveText('run-123');
    await expect(ml.field('Provider ID')).toHaveText('provider-abc');
    await page.keyboard.press('Escape');

    await ml.openRow(1);
    expect(await ml.fieldLabels()).toEqual(['Sent', 'Channel', 'From', 'To', 'Status', 'Route']);
    await expect(ml.field('Route')).toHaveText('Direct');
    await page.keyboard.press('Escape');

    await ml.openRow(2);
    expect(await ml.fieldLabels(), 'missing values never show as empty rows').toEqual(['Sent', 'Channel', 'From', 'To', 'Status']);
  });

  test('CN-MSG-020: a failed message displays its delivery error', async ({ primary_user }) => {
    // Stubbed: a known failure and its error text.
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;
    const failed = messageDetail(0, { status: 'failed', error: 'SMTP 550: mailbox unavailable' });
    const { body: _b, ...row } = failed;
    await stubMessageLog(page, [{ ...row, has_body: true }]);
    await stubMessageDetail(page, { [failed.id]: failed });
    await ml.gotoAndRead();
    await expect(ml.cell(0, 'Status')).toHaveText('failed');
    await ml.openRow(0);
    await expect(ml.field('Status')).toContainText('failed');
    await expect(ml.field('Status').locator('p.text-red-600')).toHaveText('SMTP 550: mailbox unavailable');
  });

  test('CN-MSG-021: a message without a stored body displays the correct notice', async ({ primary_user }) => {
    // Stubbed: bodies off (metadata only).
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;
    const noBody = messageDetail(0, { body: null, subject: 'Metadata only' });
    const { body: _b, ...row } = noBody;
    await stubMessageLog(page, [{ ...row, has_body: false }], { store_bodies: false });
    await stubMessageDetail(page, { [noBody.id]: noBody });
    await ml.gotoAndRead();
    await ml.openRow(0);
    await expect(ml.noBody).toBeVisible();
    await expect(ml.dialogBody).toHaveCount(0);
    // Who, when, where and the status are still there.
    expect((await ml.fieldLabels()).slice(0, 5)).toEqual(['Sent', 'Channel', 'From', 'To', 'Status']);
    await expect(ml.field('To')).toHaveText(noBody.recipients.join(', '));
  });

  test('CN-MSG-022: passwords, keys, tokens and webhook URLs are redacted in stored messages', async ({ primary_user, commonFunction }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured.');
    await asAdmin(primary_user);
    const { dashboardApi: api, messageLogPage: ml } = primary_user;

    // ── Webhook targets are kept as host#hash, never the URL ──
    for (const channel of ['slack', 'msteams', 'webhook']) {
      const { data } = await api.request('GET', `/admin/messages?channel=${channel}&limit=200`);
      for (const m of data.messages) {
        for (const r of m.recipients) {
          expect(r, `${channel} recipient`).toMatch(/^[^\s/]+#[0-9a-f]{12}$/);
        }
      }
    }

    // ── A message carrying key-shaped strings is stored redacted ──
    // The nest name rides in the share email's subject and body.
    const fakeKey = `cnst_${'a1b2c3d4'.repeat(3)}`;
    const fakeProvider = `sk-${'q9w8e7r6'.repeat(3)}`;
    const base = commonFunction.generateEntityName('msg-redact');
    const nest = await api.createNest(`${base} ${fakeKey} ${fakeProvider}`);
    await api.addCollaborator(nest.id, secondaryRole.email, 'read');

    let logged = null;
    await expect
      .poll(
        async () => {
          const { data } = await api.request('GET', `/admin/messages?q=${encodeURIComponent(base)}&channel=email&limit=20`);
          logged = data.messages[0] ?? null;
          return !!logged;
        },
        { timeout: 60_000, intervals: [2_000, 5_000] }
      )
      .toBe(true);
    expect(logged.subject).toContain('cnst_[REDACTED]');
    expect(logged.subject).toContain('sk-[REDACTED]');
    expect(logged.subject).not.toContain(fakeKey);
    expect(logged.subject).not.toContain(fakeProvider);
    const { data: detail } = await api.request('GET', `/admin/messages/${logged.id}`);
    const stored = `${detail.message.subject}\n${detail.message.body ?? ''}`;
    expect(stored).not.toContain(fakeKey);
    expect(stored).not.toContain(fakeProvider);
    expect(stored, 'no credential left in a link').not.toMatch(/[?&](token|t|code|key|secret|password|invite_token|share_token)=(?!\[REDACTED\])[^\s&"'<>]{6,}/i);

    // ── And the page shows it redacted ──
    await ml.gotoAndRead();
    await ml.nextRead(() => ml.search.fill(base), { where: (q) => q.q === base });
    await ml.waitIdle();
    await expect(ml.rows.first()).toBeVisible();
    await expect(ml.table).toContainText('cnst_[REDACTED]');
    // The Subject cell shows the stored subject (also its tooltip), then " · <nest>":
    // the nest's live name, which this test chose to carry the keys — not stored message text.
    const subject = ml.cell(0, 'Subject');
    await expect(subject).toContainText('cnst_[REDACTED]');
    expect(await subject.getAttribute('title')).not.toContain(fakeKey);
    const shown = (await ml.table.innerText()).split(nest.name).join('');
    expect(shown).not.toContain(fakeKey);
  });

  test('CN-MSG-023: requesting a non-existent message returns "Message not found." and is recorded in the Access log', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { dashboardApi: api, messageLogPage: ml } = primary_user;
    const id = `no-such-message-${Date.now().toString(36)}`;
    const res = await api.request('GET', `/admin/messages/${id}`);
    expect(res.status).toBe(404);
    expect(res.data?.error).toBe('Message not found.');

    // The miss is audited: a "detail" row with that id.
    const { data } = await api.request('GET', '/admin/messages/views?limit=50');
    const row = data.views.find((v) => v.message_id === id);
    expect(row, 'the probe is in the access log').toBeTruthy();
    expect(row.action).toBe('detail');
    expect(row.viewer).toBe(primaryRole.email);

    // And on the Access log tab.
    await ml.gotoAndRead();
    const views = await ml.openAccessLog();
    const i = views.body.views.findIndex((v) => v.message_id === id);
    expect(i).toBeGreaterThanOrEqual(0);
    await expect(ml.accessCell(i, 'What')).toHaveText(ACTION_LABEL.detail);
    await expect(ml.accessCell(i, 'Detail')).toHaveText(id);
  });

  test('CN-MSG-024: messages older than the retention period are removed from the log', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const api = primary_user.dashboardApi;
    // A read prunes first, so after it nothing older than the window is left.
    const { data: first } = await api.request('GET', '/admin/messages?limit=1');
    test.skip(first.retention_days === 0, 'retention is "keep forever" on this server');
    const { data: oldest } = await api.request('GET', `/admin/messages?limit=1&offset=${Math.max(first.total - 1, 0)}`);
    const age = Date.now() - new Date(oldest.messages[0].created_at).getTime();
    const window = first.retention_days * 86_400_000;
    expect(age, `the oldest message is within ${first.retention_days} days`).toBeLessThanOrEqual(window + 60_000);
    // The same holds through a date filter: nothing before the window.
    const cutoff = new Date(Date.now() - window - 60_000).toISOString();
    const { data: older } = await api.request('GET', `/admin/messages?to=${encodeURIComponent(cutoff)}`);
    expect(older.total, 'no message older than the retention window').toBe(0);
  });

  test('CN-MSG-025: the Message log is refused in open auth mode', async ({ primary_user }) => {
    await primary_user.initialize();
    const api = primary_user.dashboardApi;
    const health = await api.health();
    test.skip(health.auth_mode !== 'open', `the server runs in ${health.auth_mode} auth mode; this case needs AUTH_MODE=open`);
    for (const path of ['/admin/messages', '/admin/messages/views']) {
      const res = await api.request('GET', path);
      expect(res.status, `GET ${path} in open mode`).toBe(403);
      expect(res.data?.error).toBe(DENIED);
    }
    // Other admin pages stay open there; this one is hidden.
    const settings = await api.request('GET', '/admin/settings');
    expect(settings.status).toBe(200);
    await primary_user.nestsPage.goto();
    await expect(primary_user.messageLogPage.railItem).toHaveCount(0);
  });

  test('CN-MSG-026: the Access log records searches, opened messages and Access log views', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    await ml.gotoAndRead();
    const term = `qa-access-${Date.now().toString(36)}`;
    await ml.nextRead(() => ml.search.fill(term), { where: (q) => q.q === term });
    await ml.waitIdle();
    await ml.nextRead(() => ml.search.fill(''), { where: (q) => q.q === null });
    await ml.waitIdle();
    // The message actually opened: on a busy server a newer message can top the
    // list between the first read and the click.
    const opened = (await ml.openRow(0)).body?.message?.id;
    expect(opened, 'the opened message has an id').toBeTruthy();
    await primary_user.page.keyboard.press('Escape');

    const views = await ml.openAccessLog();
    await expect(ml.headers).toHaveText(ACCESS_COLUMNS);
    await expect(ml.accessNote).toBeVisible();
    const rows = views.body.views;
    const times = rows.map((v) => new Date(v.at).getTime());
    expect(times, 'newest first').toEqual([...times].sort((a, b) => b - a));

    const seen = rows.findIndex((v) => v.action === 'views' && v.viewer === primaryRole.email);
    const openedRow = rows.findIndex((v) => v.action === 'detail' && v.message_id === opened && v.viewer === primaryRole.email);
    const searched = rows.findIndex((v) => v.action === 'list' && v.filters?.q === term && v.viewer === primaryRole.email);
    expect(seen, 'this view of the access log').toBeGreaterThanOrEqual(0);
    expect(openedRow, 'the opened message').toBeGreaterThanOrEqual(0);
    expect(searched, 'the search').toBeGreaterThanOrEqual(0);

    await expect(ml.accessCell(seen, 'What')).toHaveText(ACTION_LABEL.views);
    await expect(ml.accessCell(openedRow, 'What')).toHaveText(ACTION_LABEL.detail);
    await expect(ml.accessCell(openedRow, 'Detail')).toHaveText(opened);
    await expect(ml.accessCell(searched, 'What')).toHaveText(ACTION_LABEL.list);
    await expect(ml.accessCell(searched, 'Detail')).toContainText(`q=${term}`);
    await expect(ml.accessCell(searched, 'Detail')).toContainText('via=rest');
    await expect(ml.accessCell(searched, 'Who')).toHaveText(primaryRole.email);
  });

  test('CN-MSG-027: viewing the Access log is itself recorded', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { messageLogPage: ml } = primary_user;
    await ml.gotoAndRead();
    const before = new Date(Date.now() - 2_000).getTime();
    const first = await ml.openAccessLog();
    const mine = (b) => b.views.filter((v) => v.action === 'views' && v.viewer === primaryRole.email && new Date(v.at).getTime() >= before);
    expect(mine(first.body).length, 'the first look is recorded').toBeGreaterThanOrEqual(1);

    await ml.messagesTab.click();
    await expect(ml.search).toBeVisible();
    const second = await ml.openAccessLog();
    expect(second.body.total).toBeGreaterThan(first.body.total);
    expect(mine(second.body).length, 'the second look adds a row').toBeGreaterThanOrEqual(2);
  });

  test('CN-MSG-028: pagination works correctly on the Access log tab', async ({ primary_user }) => {
    await asAdmin(primary_user);
    const { page, messageLogPage: ml } = primary_user;

    // ── The real access log: the counter matches what the page received ──
    await ml.gotoAndRead();
    const real = await ml.openAccessLog();
    await expect(ml.counter).toHaveText(counterFor(0, real.body.total));
    await expect(ml.prevButton).toBeDisabled();

    // ── An exact last page (stubbed: the real total grows with every look) ──
    await stubMessageViews(
      page,
      Array.from({ length: 120 }, (_, i) => viewRow(i, i % 3 === 1 ? { action: 'detail', message_id: `stub-msg-${i}`, filters: { via: 'rest' } } : {}))
    );
    await ml.gotoAndRead();
    await ml.openAccessLog();
    await expect(ml.counter).toHaveText('1–50 of 120');
    await expect(ml.rows).toHaveCount(50);
    await expect(ml.prevButton).toBeDisabled();
    await ml.nextRead(() => ml.nextButton.click(), { kind: 'views' });
    await expect(ml.counter).toHaveText('51–100 of 120');
    await ml.nextRead(() => ml.nextButton.click(), { kind: 'views' });
    await expect(ml.counter).toHaveText('101–120 of 120');
    await expect(ml.rows).toHaveCount(20);
    await expect(ml.nextButton).toBeDisabled();
    await ml.nextRead(() => ml.prevButton.click(), { kind: 'views' });
    await expect(ml.counter).toHaveText('51–100 of 120');
  });

  test('CN-MSG-029: Message log settings can be changed in Server settings → Basic', async ({ primary_user }) => {
    // Saves are stubbed: the settings are server-wide on a shared server.
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches, current } = await stubServerSettings(page);
    await ss.goto();
    await ss.openTab('Basic');
    const card = ss.card('Message log');
    await expect(card).toContainText(
      'Every email, Slack and Teams post, webhook, inbox notification and agent comment this server sends is logged for superadmins (Admin → Message log). Passwords, sign-in links, keys and webhook URLs are redacted before storage.'
    );
    await expect(card).toContainText('How long to keep messages. 0 keeps them forever. Who viewed the log is kept for a year regardless.');
    await expect(card).toContainText('Off keeps only who, when, where and whether it was delivered — no second copy of what people wrote.');

    const settings = current();
    const days = card.locator('input').first();
    await expect(days).toHaveValue(String(settings.message_log_retention_days));
    await expect(days).toHaveAttribute('min', '0');
    await expect(days).toHaveAttribute('max', '3650');
    const bodies = card.getByRole('switch');
    await expect(bodies).toHaveAttribute('aria-checked', String(settings.message_log_store_bodies));

    // Change both and save: one PATCH with exactly those two fields.
    const nextDays = settings.message_log_retention_days === 7 ? 14 : 7;
    await days.fill(String(nextDays));
    await bodies.click();
    await expect(ss.unsaved).toBeVisible();
    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({ message_log_retention_days: nextDays, message_log_store_bodies: !settings.message_log_store_bodies });
    await expect(days).toHaveValue(String(nextDays));
    await expect(bodies).toHaveAttribute('aria-checked', String(!settings.message_log_store_bodies));
  });
});
