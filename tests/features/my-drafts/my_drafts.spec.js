/**
 * My Drafts Test Suite — CN-DRAFT-001 … CN-DRAFT-013
 *
 * Page under test: ui/src/pages/app/my-drafts/page.tsx (route `/my-drafts`),
 * plus the two dialogs it opens: the governance SubmitForReviewModal and the
 * discard confirmation.
 *
 * Conventions
 * -----------
 * - A draft is the caller's own unreviewed work, so one account is enough. The
 *   suite's nest is governed (stewardship on) with self-approve off: every
 *   document its owner writes there lands as a draft instead of publishing.
 *   "Rejected" and "restored to the approved version" need a verdict or a
 *   publish first, so those seeds switch self-approve on for that one step.
 * - Preconditions go through the REST API via `role.myDraftsApi`; the UI is
 *   only driven for the behaviour under test.
 * - The whole suite shares one seeded nest (AUTO_ name, registered for
 *   teardown) rather than a nest per test: the dashboard suite runs alongside
 *   this one on the same account and counts that account's nests. Each test
 *   discards whatever drafts it seeded, so the next one starts clean.
 * - The account's draft list is not assumed to be otherwise empty: each test
 *   titles its drafts with a token of its own and searches for it, so the
 *   page shows exactly the rows that test seeded.
 * - Two states cannot be arranged from a real account — the "no drafts at
 *   all" empty state and more than one page of drafts (a later page coming
 *   back empty included). Those are driven through `src/lib/my_drafts_stubs.js`,
 *   which serves the real response shape to the real UI. Each such test says so.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { getEntities } from '../../src/lib/entity_registry.js';
import {
  draftRows,
  listResponder,
  stubMyDrafts,
} from '../../src/lib/my_drafts_stubs.js';

const primaryRole = samples.primary_user ?? null;

/**
 * How long a write may take to land. On nest-dev a submit or discard commits
 * to the vault and answers in 5–11s, well past the 5s expect default; locally
 * it is well under a second. Only the first check after a write waits this
 * long — once it has landed, the rest read settled state.
 */
const WRITE = { timeout: 30_000 };

/**
 * The page re-reads the list through react-query with a 5s staleTime
 * (STALE.governance in ui/src/lib/queries.ts), so a read repeated inside that
 * window — paging back, re-sorting to a view already seen — is served from
 * the cache without a request. A discard does not invalidate that cache
 * either (POST …/discard falls under the generic node-write scope, which
 * leaves `keys.me` alone), so a discard confirmed within 5s of the last read
 * redraws the rows it just removed. The discard cases wait the window out
 * first, as a person reading the list before acting would.
 */
const LIST_CACHE_MS = 5_500;

function outlastListCache(page) {
  return page.waitForTimeout(LIST_CACHE_MS);
}

/** Body every seeded document starts from — what a discard restores. */
const SEEDED_BODY = 'Seeded by the My Drafts suite.';

// ── Shared helpers ─────────────────────────────────────────────────────────

/** Name suffix that marks this suite's shared nest in the entity registry. */
const DRAFTS_NEST_SUFFIX = 'my-drafts';

/**
 * Undo steps for whatever the running test left behind — run after it, last
 * in first out, each on a best-effort basis.
 * @type {Array<() => Promise<any>>}
 */
const cleanups = [];

/**
 * The suite's shared nest: owned by the primary, governed, self-approve off.
 * Created once per run and found again through the registry afterwards (a
 * retried test runs in a fresh worker). The posture is set on every test, so a
 * test that failed half-way through a self-approve seed leaves no trace.
 */
async function ensureDraftsNest(api, commonFunction) {
  const registered = new Set(
    getEntities('nests')
      .filter((e) => !e.deleted && e.name.endsWith(DRAFTS_NEST_SUFFIX))
      .map((e) => e.id)
  );
  let nest = (await api.listNests()).find((n) => registered.has(n.id));
  if (!nest) {
    nest = await api.createNest(
      commonFunction.generateEntityName(DRAFTS_NEST_SUFFIX),
      'Seeded by the My Drafts suite'
    );
  }
  await api.setGovernance(nest.id, { stewardship: true, selfApprove: false });
  return nest;
}

/**
 * Arrange a test: the primary's session, its page object and REST helper,
 * and the shared nest.
 * @returns {Promise<{page: import('@playwright/test').Page, drafts: any, api: any, nest: any}>}
 */
async function asAuthor(primary_user, commonFunction) {
  await primary_user.initialize();
  const api = primary_user.myDraftsApi;
  const nest = await ensureDraftsNest(api, commonFunction);
  return { page: primary_user.page, drafts: primary_user.myDraftsPage, api, nest };
}

/** A search token no other draft on the account will carry. */
function token() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Draft edit times are stored to the second, and "Recently edited" orders by
 * them — seeds meant to sort apart must not share one.
 */
function nextSecond() {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}

/** The owner writes a document; in the governed nest it lands as a draft. */
async function seedDraft(api, nest, title, { folder } = {}) {
  const doc = await api.createDocument(nest.id, {
    title,
    folder,
    content: `# ${title}\n\n${SEEDED_BODY}\n`,
  });
  cleanups.push(() => api.discardDraft(nest.id, doc.id));
  expect(await api.isDraft(doc.id, title), `"${title}" should have landed as a draft`).toBe(true);
  return doc;
}

/**
 * A document that was approved, then edited again: the draft sits on top of
 * an approved version, so discarding it restores rather than deletes.
 */
async function seedDraftOverApproved(api, nest, title, editMark) {
  await api.setGovernance(nest.id, { selfApprove: true });
  let doc;
  try {
    doc = await api.createDocument(nest.id, {
      title,
      content: `# ${title}\n\n${SEEDED_BODY}\n`,
    });
  } finally {
    await api.setGovernance(nest.id, { selfApprove: false });
  }
  cleanups.push(() => api.discardDraft(nest.id, doc.id));
  expect(await api.isDraft(doc.id, title), `"${title}" v1 should have published`).toBe(false);
  await api.updateDocument(nest.id, doc.id, { content: `# ${title}\n\n${editMark}\n` });
  expect(await api.isDraft(doc.id, title), `"${title}" v2 should be a draft`).toBe(true);
  return doc;
}

/** A draft that went to review and came back rejected. */
async function seedRejected(api, nest, title) {
  const doc = await seedDraft(api, nest, title);
  await api.submitForReview(nest.id, doc.id);
  await api.setGovernance(nest.id, { selfApprove: true });
  try {
    await api.rejectReview(nest.id, doc.id, 'Seeded rejection');
  } finally {
    await api.setGovernance(nest.id, { selfApprove: false });
  }
  return doc;
}

/** Withdraw a submission once the test is over (before its draft is discarded). */
function cancelAfter(api, nest, doc) {
  cleanups.push(() => api.cancelReview(nest.id, doc.id));
}

/** The document the app has open (`?doc=`), or null on a nest / app page. */
function openDocument(page) {
  return new URL(page.url()).searchParams.get('doc');
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "edited just now" / "edited 3m ago" — a seed is never older than that. */
const EDITED = '· edited (just now|\\d+m ago)';

test.describe('My Drafts', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test.afterEach(async () => {
    for (const undo of cleanups.splice(0).reverse()) {
      await undo().catch(() => {});
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Getting there and the empty states
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Access and shell', () => {
    test('CN-DRAFT-001: My Drafts opens from the rail with a muted count badge', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      // At least one draft of the primary's own, so the badge has a count.
      const doc = await seedDraft(api, nest, `Draft ${token()} Badge`);
      expect((await api.myDrafts({ limit: 1 })).pagination.total).toBeGreaterThan(0);

      /**
       * Load `open` and check the badge shows the server's draft count. Other
       * suites write as this account in parallel and can move that count at
       * any moment, so the badge is held to the total read just before the
       * page loaded or the one read now — never to a number taken earlier.
       */
      const expectBadgeMatchesServer = async (open) => {
        const before = (await api.myDrafts({ limit: 1 })).pagination.total;
        await open();
        await expect(drafts.railItem).toBeVisible();
        await expect
          .poll(async () => {
            const shown = (await drafts.railBadge.count())
              ? Number(await drafts.railBadge.textContent())
              : 0;
            const now = (await api.myDrafts({ limit: 1 })).pagination.total;
            return shown === before || shown === now;
          }, { message: 'the rail badge should show the server draft count' })
          .toBe(true);
      };

      await expectBadgeMatchesServer(() => primary_user.nestsPage.goto());
      await expect(drafts.railItem).toContainText('My Drafts');
      // Muted: a list to tidy, not the primary pill of an inbox waiting on you.
      await expect(drafts.railBadge).toHaveClass(/bg-muted-foreground\/15/);
      await expect(drafts.railBadge).not.toHaveClass(/bg-primary/);

      // The badge follows the list: the seeded draft discarded, and the count
      // the page shows after a reload is the server's new one.
      expect((await api.discardDraft(nest.id, doc.id)).ok).toBe(true);
      expect(await api.isDraft(doc.id, doc.title)).toBe(false);
      await expectBadgeMatchesServer(() => page.reload());

      await drafts.openFromRail();

      await expect(page).toHaveURL(/\/my-drafts$/);
      await expect(drafts.pageTitle).toContainText('My Drafts');
      await expect(drafts.pageTitle).toContainText('Everything you started and never handed off.');
      await expect(drafts.railItem).toHaveAttribute('aria-current', 'page');
      await expect(drafts.search).toBeVisible();
    });

    test('CN-DRAFT-002: the no-drafts and no-search-match empty states display correctly', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, drafts } = await asAuthor(primary_user, commonFunction);

      // ── No match: a real search for something no draft carries ──
      await drafts.goto();
      const query = `no-such-draft-${token()}`;
      const body = await drafts.searchFor(query);
      expect(body.drafts).toHaveLength(0);

      await expect(drafts.root.getByText(`No drafts match "${query}".`)).toBeVisible();
      await expect(drafts.emptyState).toHaveCount(0);
      await expect(drafts.rows).toHaveCount(0);
      await expect(drafts.selectAll).toHaveCount(0);
      await expect(drafts.pageIndicator).toHaveCount(0);
      // The search stays put, so the reader can see what matched nothing.
      await expect(drafts.search).toHaveValue(query);

      // ── No drafts at all ──
      // Forced state: a shared test account has drafts of its own.
      await stubMyDrafts(page, ({ limit, offset }) => ({
        drafts: [],
        pagination: { total: 0, limit, offset, has_more: false },
      }));
      await drafts.goto();

      await expect(drafts.emptyState).toBeVisible();
      await expect(drafts.noMatchState).toHaveCount(0);
      await expect(drafts.loader).toHaveCount(0);
      await expect(drafts.rows).toHaveCount(0);
      await expect(drafts.selectAll).toHaveCount(0);
      await expect(drafts.pageIndicator).toHaveCount(0);
      await expect(drafts.search).toHaveValue('');
      // Nothing to count, so no badge either.
      await expect(drafts.railBadge).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // What a row says, and where it leads
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Rows', () => {
    test('CN-DRAFT-003: rows display the Draft/Rejected badge, nest/folder path and edited time', async ({
      primary_user,
      commonFunction,
    }) => {
      const { drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      const tok = token();
      const folder = `drafts-${tok}`;
      const atRoot = await seedDraft(api, nest, `Draft ${tok} Root`);
      const inFolder = await seedDraft(api, nest, `Draft ${tok} Foldered`, { folder });
      const rejected = await seedRejected(api, nest, `Draft ${tok} Turned down`);

      await drafts.goto();
      await drafts.searchFor(tok);
      await expect(drafts.rows).toHaveCount(3);

      // A plain draft: the muted badge.
      await expect(drafts.rowBadge(atRoot.title)).toHaveText(/^draft$/i);
      await expect(drafts.rowBadge(atRoot.title)).toHaveClass(/bg-muted/);
      await expect(drafts.rowBadge(atRoot.title)).not.toHaveClass(/bg-red-100/);

      // A rejected one says so, in red.
      await expect(drafts.rowBadge(rejected.title)).toHaveText(/^rejected$/i);
      await expect(drafts.rowBadge(rejected.title)).toHaveClass(/bg-red-100/);

      // Title on the first line, where it lives and when on the second.
      await expect(drafts.rowOpen(atRoot.title).locator('span.font-medium')).toHaveText(
        atRoot.title
      );
      await expect(drafts.rowLocation(atRoot.title)).toHaveText(
        new RegExp(`^${escapeRegExp(nest.name)} ${EDITED}$`)
      );
      await expect(drafts.rowLocation(inFolder.title)).toHaveText(
        new RegExp(`^${escapeRegExp(nest.name)} / ${escapeRegExp(folder)} ${EDITED}$`)
      );
      // The full path is one hover away, for when the line truncates.
      await expect(drafts.rowLocation(inFolder.title)).toHaveAttribute(
        'title',
        `${nest.name} / ${inFolder.id}`
      );

      // Every row carries its own actions.
      for (const doc of [atRoot, inFolder, rejected]) {
        await expect(drafts.rowSubmit(doc.title)).toBeVisible();
        await expect(drafts.rowDiscard(doc.title)).toBeVisible();
        await expect(drafts.rowCheckbox(doc.title)).toBeVisible();
      }
    });

    test('CN-DRAFT-004: clicking a draft opens the document', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      const doc = await seedDraft(api, nest, `Draft ${token()} Open me`);

      await drafts.goto();
      await drafts.searchFor(doc.title);
      await drafts.rowOpen(doc.title).click();

      // Straight into the document, in its nest.
      await expect.poll(() => openDocument(page)).toBe(doc.id);
      expect(new URL(page.url()).pathname).toContain(`/nest/${nest.id}`);
      // Opening is not acting: it is still a draft.
      expect(await api.isDraft(doc.id, doc.title)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Search and sort
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Search and sort', () => {
    test('CN-DRAFT-005: search matches drafts by title or nest (debounced, server-side)', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      const tok = token();
      const kestrel = await seedDraft(api, nest, `Draft ${tok} Kestrel`);
      const heron = await seedDraft(api, nest, `Draft ${tok} Heron`);

      await drafts.goto();

      // Every list read the page sends from here on (the badge's are not).
      const reads = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/me/drafts' && !url.searchParams.has('limit')) {
          reads.push(url.searchParams.get('q'));
        }
      });

      // ── By title, in any case ──
      const byTitle = `${tok} KESTREL`;
      const titleBody = await drafts.searchFor(byTitle);
      // Let any trailing debounce fire before counting.
      await page.waitForTimeout(600);

      // Debounced: far fewer requests than keystrokes (a slow machine can let
      // a pause slip past the debounce, so not always exactly one), each one
      // a piece of what was typed, and the last one the whole query — which
      // goes to the server rather than being filtered in the page.
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.length).toBeLessThan(byTitle.length / 3);
      expect(reads.every((q) => byTitle.startsWith(q))).toBe(true);
      expect(reads.at(-1)).toBe(byTitle);
      expect(titleBody.drafts.map((d) => d.node_id)).toEqual([kestrel.id]);
      await expect(drafts.row(kestrel.title)).toBeVisible();
      await expect(drafts.row(heron.title)).toHaveCount(0);
      await expect(drafts.rows).toHaveCount(1);

      // ── By nest ──
      const nestBody = await drafts.searchFor(nest.name);
      const shown = nestBody.drafts.map((d) => d.node_id);
      expect(shown).toEqual(expect.arrayContaining([kestrel.id, heron.id]));
      expect(nestBody.drafts.every((d) => d.nest_name === nest.name)).toBe(true);
      await expect(drafts.rows).toHaveCount(nestBody.drafts.length);
      await expect(drafts.row(kestrel.title)).toBeVisible();
      await expect(drafts.row(heron.title)).toBeVisible();
      await expect(drafts.rowLocation(heron.title)).toContainText(nest.name);
    });

    test('CN-DRAFT-006: sorting works by Recently edited (default) and by Title', async ({
      primary_user,
      commonFunction,
    }) => {
      const { drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      const tok = token();
      // Written out of alphabetical order, a second apart, so the two sorts
      // disagree about every position.
      const charlie = await seedDraft(api, nest, `Draft ${tok} Charlie`);
      await nextSecond();
      const alpha = await seedDraft(api, nest, `Draft ${tok} Alpha`);
      await nextSecond();
      const bravo = await seedDraft(api, nest, `Draft ${tok} Bravo`);

      await drafts.goto();
      await drafts.searchFor(tok);

      // Default: most recently edited first.
      await expect(drafts.sortGroup).toBeVisible();
      await expect(drafts.sortUpdated).toHaveAttribute('aria-pressed', 'true');
      await expect(drafts.sortTitle).toHaveAttribute('aria-pressed', 'false');
      await expect(drafts.rowTitles).toHaveText([bravo.title, alpha.title, charlie.title]);

      // Title: A–Z, asked of the server, search kept.
      const read = drafts.waitForList();
      await drafts.sortTitle.click();
      const url = new URL((await read).url());
      expect(url.searchParams.get('sort')).toBe('title');
      expect(url.searchParams.get('q')).toBe(tok);
      await expect(drafts.sortTitle).toHaveAttribute('aria-pressed', 'true');
      await expect(drafts.sortUpdated).toHaveAttribute('aria-pressed', 'false');
      await expect(drafts.rowTitles).toHaveText([alpha.title, bravo.title, charlie.title]);

      // And back (the default view was just read, so it may come from cache).
      await drafts.sortUpdated.click();
      await expect(drafts.sortUpdated).toHaveAttribute('aria-pressed', 'true');
      await expect(drafts.sortTitle).toHaveAttribute('aria-pressed', 'false');
      await expect(drafts.rowTitles).toHaveText([bravo.title, alpha.title, charlie.title]);
    });

    test('CN-DRAFT-007: changing search or sort clears the selection and returns to page 1', async ({
      primary_user,
    }) => {
      // Forced rows: a second page takes more than 25 drafts.
      await primary_user.initialize();
      const { page, myDraftsPage: drafts } = primary_user;
      const { calls } = await stubMyDrafts(
        page,
        listResponder(draftRows(40, { prefix: 'Stubbed draft' }))
      );

      await drafts.goto();
      await expect(drafts.pageIndicator).toHaveText('Page 1 of 2');

      // ── A new search ──
      await drafts.nextPage.click();
      await expect(drafts.pageIndicator).toHaveText('Page 2 of 2');
      await drafts.rowCheckbox('Stubbed draft 30').click();
      await expect(drafts.selectedLabel).toHaveText('1 selected');

      await drafts.searchFor('stubbed');

      await expect(drafts.pageIndicator).toHaveText('Page 1 of 2');
      await expect(drafts.row('Stubbed draft 01')).toBeVisible();
      await expect(drafts.selectedLabel).toHaveCount(0);
      await expect(drafts.selectAllLabel).toHaveText('Select all 25 on this page');
      await expect(drafts.selectAll).toHaveAttribute('aria-checked', 'false');
      await expect(drafts.bulkSubmit).toHaveCount(0);
      expect(calls.at(-1)).toMatchObject({ offset: 0, q: 'stubbed' });

      // ── A new sort ──
      await drafts.nextPage.click();
      await expect(drafts.pageIndicator).toHaveText('Page 2 of 2');
      await drafts.rowCheckbox('Stubbed draft 26').click();
      await drafts.rowCheckbox('Stubbed draft 27').click();
      await expect(drafts.selectedLabel).toHaveText('2 selected');

      const read = drafts.waitForList();
      await drafts.sortTitle.click();
      await read;

      await expect(drafts.pageIndicator).toHaveText('Page 1 of 2');
      await expect(drafts.rowTitles.first()).toHaveText('Stubbed draft 01');
      await expect(drafts.selectedLabel).toHaveCount(0);
      await expect(drafts.selectAllLabel).toHaveText('Select all 25 on this page');
      await expect(drafts.bulkDiscard).toHaveCount(0);
      expect(calls.at(-1)).toMatchObject({ offset: 0, q: 'stubbed', sort: 'title' });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // One draft at a time
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Single draft actions', () => {
    test('CN-DRAFT-008: a single draft can be submitted for review with note and priority', async ({
      primary_user,
      commonFunction,
    }) => {
      const { drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      const doc = await seedDraft(api, nest, `Draft ${token()} Hand off`);
      cancelAfter(api, nest, doc);
      const note = `Please check the figures ${token()}`;

      await drafts.goto();
      await drafts.searchFor(doc.title);
      // One draft on the page: no batch bar, no checkbox — just its actions.
      await expect(drafts.selectAll).toHaveCount(0);
      await expect(drafts.rowCheckbox(doc.title)).toHaveCount(0);

      await drafts.rowSubmit(doc.title).click();

      // The same dialog the editor uses, naming the document and its version.
      const dialog = drafts.submitDialogTitled(`Publish “${doc.title}” (requires approval)`);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Version 1 will move to pending review');
      await expect(drafts.submitPriority).toContainText('Normal');
      await expect(drafts.submitNote).toHaveValue('');
      await expect(dialog.locator('label[for="note"]')).toHaveText('Note for Reviewer (optional)');

      await drafts.choosePriority('High');
      await expect(drafts.submitPriority).toContainText('High');
      await drafts.submitNote.fill(note);
      await drafts.submitConfirm.click();

      // Handed off: the dialog closes and the draft leaves the list.
      await expect(dialog).toHaveCount(0, WRITE);
      await expect(drafts.row(doc.title)).toHaveCount(0);
      await expect(drafts.noMatchState).toBeVisible();

      const review = await api.latestReview(nest.id, doc.id);
      expect(review.status).toBe('pending');
      expect(review.priority).toBe('high');
      expect(review.requestNote).toBe(note);
      expect(await api.nodeStatus(nest.id, doc.id)).toBe('pending_review');
      expect(await api.isDraft(doc.id, doc.title)).toBe(false);
    });

    test('CN-DRAFT-009: discarding a draft restores the approved version or deletes it, with confirmation', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      const tok = token();
      const editMark = `Edited after approval ${tok}`;
      const restorable = await seedDraftOverApproved(api, nest, `Draft ${tok} Restorable`, editMark);
      const fresh = await seedDraft(api, nest, `Draft ${tok} Never approved`);
      const description =
        "The document goes back to its last approved version. A document that was never approved is deleted instead. This can't be undone.";

      await drafts.goto();
      await drafts.searchFor(tok);
      await expect(drafts.rows).toHaveCount(2);

      // ── Asked first, and Cancel changes nothing ──
      await drafts.rowDiscard(fresh.title).click();
      await expect(drafts.discardDialog).toBeVisible();
      await expect(drafts.discardDialog).toContainText(`Discard "${fresh.title}"?`);
      await expect(drafts.discardDialog).toContainText(description);
      await expect(drafts.discardConfirm).toHaveText('Discard');
      await drafts.discardCancel.click();

      await expect(drafts.discardDialog).toHaveCount(0);
      await expect(drafts.row(fresh.title)).toBeVisible();
      expect((await api.getNode(nest.id, fresh.id)).status).toBe(200);

      // ── Never approved: there is nothing to go back to, so it is deleted ──
      await drafts.rowDiscard(fresh.title).click();
      await outlastListCache(page);
      await drafts.discardConfirm.click();

      const deleted = drafts.toast('1 deleted');
      await expect(deleted).toBeVisible(WRITE);
      await expect(deleted).toHaveAttribute('data-type', 'success');
      await expect(drafts.row(fresh.title)).toHaveCount(0);
      expect((await api.getNode(nest.id, fresh.id)).status).toBe(404);

      // ── Approved before: back to that version, not deleted ──
      await drafts.rowDiscard(restorable.title).click();
      await expect(drafts.discardDialog).toContainText(`Discard "${restorable.title}"?`);
      await outlastListCache(page);
      await drafts.discardConfirm.click();

      const restored = drafts.toast('1 restored to the approved version');
      await expect(restored).toBeVisible(WRITE);
      await expect(restored).toHaveAttribute('data-type', 'success');
      await expect(drafts.row(restorable.title)).toHaveCount(0);

      const { status, data } = await api.getNode(nest.id, restorable.id);
      expect(status).toBe(200);
      const body = JSON.stringify(data?.node ?? {});
      expect(body).toContain(SEEDED_BODY);
      expect(body).not.toContain(editMark);
      expect(await api.isDraft(restorable.id, restorable.title)).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Batch actions
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Bulk actions', () => {
    test('CN-DRAFT-010: multiple drafts can be selected and submitted for review in bulk', async ({
      primary_user,
      commonFunction,
    }) => {
      const { drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      const tok = token();
      const first = await seedDraft(api, nest, `Draft ${tok} Batch one`);
      const second = await seedDraft(api, nest, `Draft ${tok} Batch two`);
      const left = await seedDraft(api, nest, `Draft ${tok} Batch kept`);
      cancelAfter(api, nest, first);
      cancelAfter(api, nest, second);
      const note = `Batch hand-off ${tok}`;

      await drafts.goto();
      await drafts.searchFor(tok);
      await expect(drafts.rows).toHaveCount(3);

      // Nothing selected: the bar offers the page and no action yet.
      await expect(drafts.selectAllLabel).toHaveText('Select all 3 on this page');
      await expect(drafts.selectAll).toHaveAttribute('aria-checked', 'false');
      await expect(drafts.bulkSubmit).toHaveCount(0);
      await expect(drafts.bulkDiscard).toHaveCount(0);

      // One row: counted, and the header reads "some".
      await drafts.rowCheckbox(first.title).click();
      await expect(drafts.selectedLabel).toHaveText('1 selected');
      await expect(drafts.selectAll).toHaveAttribute('aria-checked', 'mixed');
      await expect(drafts.bulkSubmit).toHaveText('Submit 1 for review');
      await expect(drafts.bulkDiscard).toHaveText('Discard 1');

      // Select all, then drop one: two of three.
      await drafts.selectAll.click();
      await expect(drafts.selectedLabel).toHaveText('3 selected');
      await expect(drafts.selectAll).toHaveAttribute('aria-checked', 'true');
      await drafts.rowCheckbox(left.title).click();
      await expect(drafts.selectedLabel).toHaveText('2 selected');
      await expect(drafts.rowCheckbox(left.title)).toHaveAttribute('aria-checked', 'false');

      await expect(drafts.bulkSubmit).toHaveText('Submit 2 for review');
      await drafts.bulkSubmit.click();

      // One dialog for the lot — it names no single version.
      const dialog = drafts.submitDialogTitled('Publish 2 drafts (requires approval)');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Each selected draft moves to pending review');
      await expect(dialog).not.toContainText('Version');
      await drafts.choosePriority('Urgent');
      await drafts.submitNote.fill(note);
      await drafts.submitConfirm.click();

      const success = drafts.toast('2 submitted for review');
      await expect(success).toBeVisible(WRITE);
      await expect(success).toHaveAttribute('data-type', 'success');
      await expect(dialog).toHaveCount(0);
      await expect(drafts.row(first.title)).toHaveCount(0);
      await expect(drafts.row(second.title)).toHaveCount(0);
      // The unselected one stays — alone now, so the batch bar goes too.
      await expect(drafts.row(left.title)).toBeVisible();
      await expect(drafts.selectAll).toHaveCount(0);

      for (const doc of [first, second]) {
        const review = await api.latestReview(nest.id, doc.id);
        expect(review.status).toBe('pending');
        expect(review.priority).toBe('urgent');
        expect(review.requestNote).toBe(note);
      }
      expect(await api.isDraft(left.id, left.title)).toBe(true);
    });

    test('CN-DRAFT-011: a partial bulk-submit failure keeps the modal open with only the failed drafts', async ({
      primary_user,
      commonFunction,
    }) => {
      const { drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      const tok = token();
      const lands = await seedDraft(api, nest, `Draft ${tok} Goes through`);
      const refused = await seedDraft(api, nest, `Draft ${tok} Refused`);
      cancelAfter(api, nest, lands);
      cancelAfter(api, nest, refused);
      const note = `Partial batch ${tok}`;

      await drafts.goto();
      await drafts.searchFor(tok);
      await drafts.selectAll.click();
      await expect(drafts.selectedLabel).toHaveText('2 selected');
      await drafts.bulkSubmit.click();
      await expect(drafts.submitDialogTitled('Publish 2 drafts (requires approval)')).toBeVisible();

      // Submitted elsewhere after the list loaded, so the server refuses it
      // here (a review is already pending) while the other one goes through.
      await api.submitForReview(nest.id, refused.id);

      await drafts.submitNote.fill(note);
      await drafts.submitConfirm.click();

      // Still open, saying what landed and what didn't — and now about the
      // refused draft alone, so a retry can't resubmit the one that landed.
      await expect(drafts.submitError).toHaveText(
        `1 submitted. Couldn't submit 1: ${refused.title}`,
        WRITE
      );
      const narrowed = drafts.submitDialogTitled(`Publish “${refused.title}” (requires approval)`);
      await expect(narrowed).toBeVisible();
      await expect(narrowed).toContainText('Version 1 will move to pending review');
      await expect(drafts.toast('submitted for review')).toHaveCount(0);

      // The one that landed is under review with the dialog's note; the
      // refused one keeps the review it already had.
      const landed = await api.latestReview(nest.id, lands.id);
      expect(landed.status).toBe('pending');
      expect(landed.requestNote).toBe(note);
      expect((await api.latestReview(nest.id, refused.id)).requestNote).not.toBe(note);
      await expect(drafts.row(lands.title)).toHaveCount(0);

      await drafts.submitCancel.click();
      await expect(drafts.submitDialog).toHaveCount(0);
    });

    test('CN-DRAFT-012: bulk discard shows the combined "restored · deleted" toast', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, drafts, api, nest } = await asAuthor(primary_user, commonFunction);
      const tok = token();
      const editMark = `Edited after approval ${tok}`;
      const restorable = await seedDraftOverApproved(api, nest, `Draft ${tok} Goes back`, editMark);
      const fresh = await seedDraft(api, nest, `Draft ${tok} Goes away`);

      await drafts.goto();
      await drafts.searchFor(tok);
      await drafts.selectAll.click();
      await expect(drafts.selectedLabel).toHaveText('2 selected');
      await expect(drafts.bulkDiscard).toHaveText('Discard 2');
      await drafts.bulkDiscard.click();

      // One confirmation for the lot, naming both outcomes.
      await expect(drafts.discardDialog).toContainText('Discard 2 drafts?');
      await expect(drafts.discardDialog).toContainText(
        'Each document goes back to its last approved version. A document that was never approved is deleted instead.'
      );
      await outlastListCache(page);
      await drafts.discardConfirm.click();

      // One line for the batch: what went back, and what went.
      const combined = drafts.toast('1 restored to the approved version · 1 deleted');
      await expect(combined).toBeVisible(WRITE);
      await expect(combined).toHaveAttribute('data-type', 'success');
      await expect(drafts.rows).toHaveCount(0);
      await expect(drafts.root.getByText(`No drafts match "${tok}".`)).toBeVisible();

      expect((await api.getNode(nest.id, fresh.id)).status).toBe(404);
      const { status, data } = await api.getNode(nest.id, restorable.id);
      expect(status).toBe(200);
      expect(JSON.stringify(data?.node ?? {})).not.toContain(editMark);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Paging
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Paging', () => {
    test('CN-DRAFT-013: pagination preserves search/sort and an empty later page falls back to page 1', async ({
      primary_user,
    }) => {
      // Forced rows: three pages take more than 50 drafts, and a later page
      // coming back empty is a race (its drafts discarded elsewhere).
      await primary_user.initialize();
      const { page, myDraftsPage: drafts } = primary_user;
      const rows = draftRows(60, { prefix: 'Paged draft' });
      const { setResponder, calls } = await stubMyDrafts(page, listResponder(rows));

      await drafts.goto();
      await drafts.searchFor('paged');
      const read = drafts.waitForList();
      await drafts.sortTitle.click();
      await read;

      await expect(drafts.pageIndicator).toHaveText('Page 1 of 3');
      await expect(drafts.prevPage).toBeDisabled();
      await expect(drafts.rows).toHaveCount(25);
      await expect(drafts.rowTitles.first()).toHaveText('Paged draft 01');

      // Forward: each page asks with the same search and sort.
      await drafts.nextPage.click();
      await expect(drafts.pageIndicator).toHaveText('Page 2 of 3');
      await expect(drafts.rowTitles.first()).toHaveText('Paged draft 26');
      expect(calls.at(-1)).toMatchObject({ offset: 25, q: 'paged', sort: 'title' });

      await drafts.nextPage.click();
      await expect(drafts.pageIndicator).toHaveText('Page 3 of 3');
      await expect(drafts.rows).toHaveCount(10);
      await expect(drafts.nextPage).toBeDisabled();
      expect(calls.at(-1)).toMatchObject({ offset: 50, q: 'paged', sort: 'title' });

      // Back: page 2 again (just read, so it may come from cache).
      await drafts.prevPage.click();
      await expect(drafts.pageIndicator).toHaveText('Page 2 of 3');
      await expect(drafts.rowTitles.first()).toHaveText('Paged draft 26');
      // Paging never resets the controls it is paging under.
      await expect(drafts.search).toHaveValue('paged');
      await expect(drafts.sortTitle).toHaveAttribute('aria-pressed', 'true');

      // ── Page 3 has emptied out while the total still counts drafts ──
      const live = listResponder(rows);
      setResponder((params) =>
        params.offset >= 50
          ? {
            drafts: [],
            pagination: { total: rows.length, limit: params.limit, offset: params.offset, has_more: false },
          }
          : live(params)
      );
      // Page 3 and page 1 were both read moments ago; outlast the cache so
      // the page really asks the server for them again.
      await page.waitForTimeout(LIST_CACHE_MS);
      const before = calls.length;
      await drafts.nextPage.click();

      // Back on page 1 rather than stranded on a blank one.
      await expect(drafts.pageIndicator).toHaveText('Page 1 of 3');
      await expect(drafts.rowTitles.first()).toHaveText('Paged draft 01');
      await expect(drafts.rows).toHaveCount(25);
      await expect(drafts.noMatchState).toHaveCount(0);
      await expect(drafts.emptyState).toHaveCount(0);
      const after = calls.slice(before);
      expect(after.map((c) => c.offset)).toEqual([50, 0]);
      expect(after.every((c) => c.q === 'paged' && c.sort === 'title')).toBe(true);
    });
  });
});
