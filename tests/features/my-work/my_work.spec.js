/**
 * My Work Test Suite — CN-WORK-001 … CN-WORK-020
 *
 * Page under test: ui/src/pages/app/my-work/page.tsx (route `/my-work`), plus
 * the two dialogs it opens: ReviewActions and the governance ReasonDialog.
 *
 * Conventions
 * -----------
 * - My Work is an inbox: it shows what *other people* asked of the caller. So
 *   the rows are raised for real by a second account (`secondary_user`), which
 *   writes in a nest the primary owns — it submits documents for review and
 *   flags documents, folders and the nest for deletion or archiving. Every
 *   case that needs someone else's request skips when no second account is
 *   configured (see tests/env.template).
 * - Preconditions go through the REST API via `role.myWorkApi`; the UI is only
 *   driven for the behaviour under test.
 * - The whole suite shares one seeded nest (AUTO_ name, registered for
 *   teardown) rather than a nest per test: the dashboard suite runs alongside
 *   this one on the same account and counts that account's nests, so this
 *   suite changes that count as rarely as it can. Each test withdraws whatever
 *   it left pending, so the next one starts from a quiet nest.
 * - A few states cannot be arranged from a real account — the loading spinner,
 *   the empty inbox, more than 8 unread notifications, "Mark all read" (which
 *   would clear the account's real inbox), 51 reviews in one nest and a second
 *   page of them. Those are driven through `src/lib/my_work_stubs.js`, which
 *   serves the real response shape to the real UI. Each such test says so.
 * - The account's inbox is not assumed to be otherwise empty: rows are located
 *   by the unique titles and reasons a test seeded, and counts are asserted
 *   against the response the page itself rendered.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { getEntities } from '../../src/lib/entity_registry.js';
import MyWorkApi from '../../src/lib/my_work_api.js';
import {
  reviewItem,
  reviewItems,
  notificationRow,
  emptyWork,
  stubMyWork,
  stubNotifications,
  holdMyWork,
  captureNotificationsRead,
} from '../../src/lib/my_work_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

const NEEDS_SECOND_ACCOUNT =
  'secondary_user is not configured — My Work rows are raised by a second account. See tests/env.template.';

/**
 * How long a decision may take to land. On nest-dev an approve, reject or
 * delete commits to the vault and answers in 5–11s (a bulk approve of two took
 * 11s), well past the 5s expect default; locally it is well under a second.
 * Only the first check after a write waits this long — once it has landed,
 * the rest read settled state.
 */
const WRITE = { timeout: 30_000 };

// ── Shared helpers ─────────────────────────────────────────────────────────

/** Name suffix that marks this suite's shared nest in the entity registry. */
const WORK_NEST_SUFFIX = 'my-work';

/**
 * Undo steps for whatever the running test left pending — run after it, last
 * in first out, each on a best-effort basis.
 * @type {Array<() => Promise<any>>}
 */
const cleanups = [];

/**
 * The suite's shared nest: owned by the primary, with self-approve on so that
 * what collaborators submit lands in the owner's inbox. Created once per run
 * and found again through the registry afterwards (a retried test runs in a
 * fresh worker), or recreated if a test has archived it.
 */
async function ensureWorkNest(api, commonFunction) {
  const registered = new Set(
    getEntities('nests')
      .filter((e) => !e.deleted && e.name.endsWith(WORK_NEST_SUFFIX))
      .map((e) => e.id)
  );
  const live = (await api.listNests()).find((n) => registered.has(n.id));
  if (live) return live;

  const nest = await api.createNest(
    commonFunction.generateEntityName(WORK_NEST_SUFFIX),
    'Seeded by the My Work suite'
  );
  await api.setSelfApprove(nest.id, true);
  return nest;
}

/**
 * Arrange a test that only needs the primary account.
 * @returns {Promise<{page: import('@playwright/test').Page, myWork: any, api: any, nest: any}>}
 */
async function asReviewer(primary_user, commonFunction) {
  await primary_user.initialize();
  const api = primary_user.myWorkApi;
  const nest = await ensureWorkNest(api, commonFunction);
  return { page: primary_user.page, myWork: primary_user.myWorkPage, api, nest };
}

/**
 * Arrange a test where the secondary account raises work for the primary:
 * `author` is the secondary's REST helper, with write access to the nest.
 * @returns {Promise<{page: import('@playwright/test').Page, myWork: any, api: any, author: any, nest: any}>}
 */
async function withAuthor(primary_user, secondary_user, commonFunction) {
  const reviewer = await asReviewer(primary_user, commonFunction);
  await secondary_user.initialize();
  const author = secondary_user.myWorkApi;
  await reviewer.api.shareForAuthoring(reviewer.nest.id, secondaryRole.email);
  // Whatever the seeded requests and their verdicts put in either account's
  // notification inbox is settled by id once the test is over — never "all".
  cleanups.push(() => reviewer.api.settleNotificationsFor(reviewer.nest.id));
  cleanups.push(() => author.settleNotificationsFor(reviewer.nest.id));
  return { ...reviewer, author };
}

/** `author` writes a document and submits it for review. */
async function seedReview(author, nest, title, { note, folder } = {}) {
  const doc = await author.createDocument(nest.id, { title, folder });
  await author.submitForReview(nest.id, doc.id, note);
  cleanups.push(() => author.cancelReview(nest.id, doc.id));
  return doc;
}

/** `author` writes a document and flags it for deletion. */
async function seedDocumentDeletion(author, nest, title, reason, { folder } = {}) {
  const doc = await author.createDocument(nest.id, { title, folder });
  const request = await author.requestDocumentDeletion(nest.id, doc.id, reason);
  cleanups.push(() => author.withdrawDeletionRequest(nest.id, request.id));
  return { doc, request };
}

/** `author` flags a folder, or the nest itself, for deletion or archiving. */
async function seedNestRequest(author, nest, targetType, reason, target) {
  const request = await author.requestNestDeletion(nest.id, targetType, reason, target);
  cleanups.push(() => author.withdrawDeletionRequest(nest.id, request.id));
  return request;
}

/** Wait until the primary's inbox carries every one of these documents. */
async function waitForReviews(api, docs) {
  return api.waitForWork(
    (work) => docs.every((d) => work.items.some((i) => i.type === 'review' && i.node_id === d.id)),
    { what: `the review rows for ${docs.map((d) => d.title).join(', ')}` }
  );
}

/** A reason / note no other row on the page will carry. */
function uniqueText(label) {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** How the page renders a server timestamp (formatServerDate in ui/src/lib/dates.ts). */
async function asShownDate(page, raw) {
  return page.evaluate((value) => {
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
    return new Date(iso).toLocaleString();
  }, raw);
}

/** The document the app has open (`?doc=`), or null on a nest / app page. */
function openDocument(page) {
  return new URL(page.url()).searchParams.get('doc');
}

test.describe('My Work', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test.afterEach(async () => {
    for (const undo of cleanups.splice(0).reverse()) {
      await undo().catch(() => {});
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Getting there, loading and the empty inbox
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Access and shell', () => {
    test('CN-WORK-001: My Work opens from the rail with a badge counting pending items', async ({
      primary_user,
      commonFunction,
    }) => {
      const { page, myWork, api, nest } = await asReviewer(primary_user, commonFunction);
      // Something of the primary's own is pending, so the badge has a count.
      const doc = await api.createDocument(nest.id, {
        title: commonFunction.generateEntityName('badge'),
      });
      await api.submitForReview(nest.id, doc.id);
      cleanups.push(() => api.cancelReview(nest.id, doc.id));

      // An open task assigned to the primary waits on them too, and the badge
      // counts it (CU-wdqcq05jg8 / PR #436; API.md "Assigned rows"). Seeded
      // here so the assigned half of the count is never just whatever other
      // suites left on the shared account.
      const task = await api.createTask(nest.id, {
        title: commonFunction.generateEntityName('badge-task'),
        assignee: primaryRole.email,
      });
      cleanups.push(() => api.deleteNode(nest.id, task.id));
      const seeded = await api.waitForWork(
        (work) => (work.assigned ?? []).some((a) => a.nest_id === nest.id && a.node_id === task.id),
        { what: `the assigned row for ${task.title}` }
      );
      expect(seeded.pagination.total).toBeGreaterThan(0);

      /**
       * Load `open` and check the badge shows what is waiting on the user:
       * the reviews and requests waiting on them, the tasks assigned to them
       * and their unread notifications (`waitingOnMeCount`). Other suites
       * raise and settle work on this account in parallel, so the badge is
       * held to the count read just before the page loaded or the one read
       * now — never to a number taken earlier.
       */
      const pendingTotal = async () => MyWorkApi.waitingOnMe(await api.myWork({ limit: 1 }));
      const expectBadgeMatchesServer = async (open) => {
        const before = await pendingTotal();
        await open();
        await expect(myWork.railItem).toBeVisible();
        await expect
          .poll(async () => {
            const shown = (await myWork.railBadge.count()) ? Number(await myWork.railBadge.textContent()) : 0;
            const now = await pendingTotal();
            return shown === before || shown === now;
          }, { message: 'the rail badge should show reviews + requests + assigned tasks + unread notifications', timeout: 30_000 })
          .toBe(true);
      };

      await expectBadgeMatchesServer(() => primary_user.nestsPage.goto());
      await expect(myWork.railItem).toContainText('My Work');

      // The badge follows the inbox: the submission withdrawn and the task
      // deleted, the count the page shows after a reload is the server's new one.
      await api.cancelReview(nest.id, doc.id);
      expect((await api.deleteNode(nest.id, task.id)).ok).toBe(true);
      const after = await api.myWork();
      expect(after.waiting.some((w) => w.node_id === doc.id)).toBe(false);
      expect((after.assigned ?? []).some((a) => a.nest_id === nest.id && a.node_id === task.id)).toBe(false);
      await expectBadgeMatchesServer(() => page.reload());

      await myWork.openFromRail();

      await expect(page).toHaveURL(/\/my-work$/);
      await expect(myWork.pageTitle).toContainText('My Work');
      await expect(myWork.pageTitle).toContainText(
        'Tasks, reviews and requests waiting on you, and what you handed off.'
      );
      await expect(myWork.railItem).toHaveAttribute('aria-current', 'page');
    });

    test('CN-WORK-002: the loading spinner and "all caught up" empty state display correctly', async ({
      primary_user,
    }) => {
      // Forced states: the read resolves too fast to observe the spinner, and
      // a shared test account has work waiting on it.
      await primary_user.initialize();
      const { page, myWorkPage: myWork } = primary_user;
      const release = await holdMyWork(page, emptyWork());

      await myWork.goto({ settle: false });

      // Still in flight: a loader, and nothing that reads as an answer yet.
      await expect(myWork.loader).toBeVisible();
      await expect(myWork.loader.locator('xpath=..').locator('svg.animate-spin')).toBeVisible();
      await expect(myWork.emptyState).toHaveCount(0);

      release();

      await expect(myWork.emptyState).toBeVisible();
      await expect(myWork.loader).toHaveCount(0);
      // An empty inbox has no strip, no rows, no batch bar and no hand-offs.
      await expect(myWork.notificationsStrip).toHaveCount(0);
      await expect(myWork.inboxRows).toHaveCount(0);
      await expect(myWork.selectAll).toHaveCount(0);
      await expect(myWork.waitingHeading).toHaveCount(0);
      await expect(myWork.pageIndicator).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Notifications strip
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Notifications', () => {
    test('CN-WORK-003: the notifications strip lists unread notifications with dates', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      test.skip(!secondaryRole, NEEDS_SECOND_ACCOUNT);
      const { page, myWork, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      // Flagging a document tells the nest's owner about it.
      const title = commonFunction.generateEntityName('notify-list');
      const reason = uniqueText('listed');
      await seedDocumentDeletion(author, nest, title, reason);

      const work = await myWork.gotoAndReadWork();
      const mine = work.notifications.find((n) => n.message.includes(title));
      expect(mine, 'the deletion request should have raised a notification').toBeTruthy();

      // Unread only, counted in the header, previewed eight at a time.
      expect(work.notifications.every((n) => n.read_at === null)).toBe(true);
      await expect(myWork.notificationsStrip).toBeVisible();
      await expect(myWork.notificationsStrip).toContainText('Notifications');
      await expect(myWork.notificationsCount).toHaveText(`(${work.notifications.length})`);
      await expect(myWork.notificationRows).toHaveCount(Math.min(work.notifications.length, 8));

      // The row says what happened, who asked and why — and when.
      const row = myWork.notificationRow(title);
      await expect(row).toBeVisible();
      await expect(row).toContainText(
        `"${title}" was flagged for deletion by ${secondaryRole.email} — "${reason}"`
      );
      await expect(row).toContainText(await asShownDate(page, mine.created_at));
      await expect(myWork.notificationMarkRead(title)).toBeVisible();
    });

    test('CN-WORK-004: clicking a notification opens its document (or nest) and marks it read', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      test.skip(!secondaryRole, NEEDS_SECOND_ACCOUNT);
      const { page, myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      // One notification about a document, one about a folder — which has no
      // document to open, so it leads to the nest.
      const folder = `mw-open-${Date.now().toString(36)}`;
      const title = commonFunction.generateEntityName('notify-open');
      const folderReason = uniqueText('folder ask');
      const { doc } = await seedDocumentDeletion(author, nest, title, uniqueText('doc ask'), {
        folder,
      });
      await seedNestRequest(author, nest, 'folder', folderReason, folder);

      let work = await myWork.gotoAndReadWork();
      const aboutDocument = work.notifications.find((n) => n.message.includes(title));
      const aboutFolder = work.notifications.find((n) => n.message.includes(folderReason));
      expect(aboutDocument?.node_id).toBe(doc.id);
      expect(aboutFolder?.node_id).toBeNull();

      await myWork.notificationOpen(title).click();

      // Straight into the document, and no longer unread.
      await expect.poll(() => openDocument(page)).toBe(doc.id);
      expect(new URL(page.url()).pathname).toContain(`/nest/${nest.id}`);
      await expect.poll(() => api.isNotificationUnread(aboutDocument.id)).toBe(false);

      work = await myWork.gotoAndReadWork();
      expect(work.notifications.some((n) => n.id === aboutDocument.id)).toBe(false);
      await expect(myWork.notificationRow(title)).toHaveCount(0);

      await myWork.notificationOpen(folderReason).click();

      // The nest itself — there is no document behind a folder request.
      await expect(page).toHaveURL(new RegExp(`/nest/${nest.id}`));
      expect(openDocument(page)).toBeNull();
      await expect.poll(() => api.isNotificationUnread(aboutFolder.id)).toBe(false);
    });

    test('CN-WORK-005: the per-row "Mark as read" button removes the notification', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      test.skip(!secondaryRole, NEEDS_SECOND_ACCOUNT);
      const { page, myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const kept = commonFunction.generateEntityName('notify-keep');
      const dismissed = commonFunction.generateEntityName('notify-dismiss');
      await seedDocumentDeletion(author, nest, kept, uniqueText('kept'));
      await seedDocumentDeletion(author, nest, dismissed, uniqueText('dismissed'));

      const work = await myWork.gotoAndReadWork();
      const target = work.notifications.find((n) => n.message.includes(dismissed));
      expect(target).toBeTruthy();
      await expect(myWork.notificationRow(kept)).toBeVisible();

      await myWork.notificationMarkRead(dismissed).click();

      // Only that row goes, and the page stays where it is.
      await expect(myWork.notificationRow(dismissed)).toHaveCount(0);
      await expect(myWork.notificationRow(kept)).toBeVisible();
      // One fewer than the page loaded with — or, if the strip refetched
      // while other suites raised notifications, the server's own count.
      const unreadNow = (await api.myWork()).notifications.length;
      await expect(myWork.notificationsCount).toHaveText(
        new RegExp(`^\\((${work.notifications.length - 1}|${unreadNow})\\)$`)
      );
      await expect(page).toHaveURL(/\/my-work$/);
      expect(await api.isNotificationUnread(target.id)).toBe(false);

      // Read on the server, so it does not come back.
      await page.reload();
      await expect(myWork.loader).toHaveCount(0);
      await expect(myWork.notificationRow(kept)).toBeVisible();
      await expect(myWork.notificationRow(dismissed)).toHaveCount(0);
    });

    test('CN-WORK-006: "Mark all read" clears the entire notifications strip', async ({
      primary_user,
    }) => {
      // Forced strip, intercepted write: for real, "Mark all read" would clear
      // every unread notification the account holds — its genuine ones, and
      // the pending invites the dashboard suite is counting at the same time.
      await primary_user.initialize();
      const { page, myWorkPage: myWork } = primary_user;
      await stubNotifications(page, [
        notificationRow({ message: 'Stub notification one' }),
        notificationRow({ message: 'Stub notification two' }),
        notificationRow({ message: 'Stub notification three' }),
      ]);
      const readCalls = await captureNotificationsRead(page);

      await myWork.goto();
      await expect(myWork.notificationsCount).toHaveText('(3)');
      await expect(myWork.notificationRows).toHaveCount(3);

      await myWork.markAllRead.click();

      // One call for the lot, and the strip is gone — not left empty.
      await expect(myWork.notificationsStrip).toHaveCount(0);
      await expect(myWork.notificationRows).toHaveCount(0);
      expect(readCalls).toEqual([{ ids: 'all' }]);
    });

    test('CN-WORK-007: the strip previews 8 notifications with Show all / Show less', async ({
      primary_user,
    }) => {
      // Forced strip: a dozen unread notifications takes a dozen real requests
      // to raise, for a rule that is entirely client-side.
      await primary_user.initialize();
      const { page, myWorkPage: myWork } = primary_user;
      const messages = Array.from(
        { length: 12 },
        (_, i) => `Stub notification ${String(i + 1).padStart(2, '0')}`
      );
      const setNotifications = await stubNotifications(
        page,
        messages.map((message) => notificationRow({ message }))
      );

      await myWork.goto();

      // The first eight, with the rest one click away.
      await expect(myWork.notificationsCount).toHaveText('(12)');
      await expect(myWork.notificationRows).toHaveCount(8);
      await expect(myWork.notificationRow(messages[7])).toBeVisible();
      await expect(myWork.notificationRow(messages[8])).toHaveCount(0);
      await expect(myWork.showAllNotifications).toHaveText('Show all (12)');

      await myWork.showAllNotifications.click();
      await expect(myWork.notificationRows).toHaveCount(12);
      await expect(myWork.notificationRow(messages[11])).toBeVisible();
      await expect(myWork.showLessNotifications).toBeVisible();
      await expect(myWork.showAllNotifications).toHaveCount(0);

      await myWork.showLessNotifications.click();
      await expect(myWork.notificationRows).toHaveCount(8);
      await expect(myWork.showAllNotifications).toHaveText('Show all (12)');

      // Exactly eight fits the preview, so there is nothing to toggle.
      setNotifications(messages.slice(0, 8).map((message) => notificationRow({ message })));
      await page.reload();
      await expect(myWork.notificationRows).toHaveCount(8);
      await expect(myWork.showAllNotifications).toHaveCount(0);
      await expect(myWork.showLessNotifications).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Rows waiting on the caller
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Inbox rows', () => {
    test.skip(!secondaryRole, NEEDS_SECOND_ACCOUNT);

    test('CN-WORK-008: review rows display kind badge, title, nest, requester, time and reason', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const reviewTitle = commonFunction.generateEntityName('row-review');
      const flaggedTitle = commonFunction.generateEntityName('row-flagged');
      const reason = uniqueText('no longer accurate');
      const review = await seedReview(author, nest, reviewTitle);
      await seedDocumentDeletion(author, nest, flaggedTitle, reason);
      await waitForReviews(api, [review]);

      await myWork.goto();

      // A review: what it is, which document, where, who asked and when.
      await expect(myWork.rowKind(reviewTitle)).toHaveText(/^review$/i);
      await expect(myWork.rowOpen(reviewTitle).locator('span.font-medium')).toHaveText(reviewTitle);
      await expect(myWork.rowOpen(reviewTitle)).toContainText(
        new RegExp(`in ${nest.name} · ${secondaryRole.email} · (just now|\\d+m ago)`)
      );
      await expect(myWork.rowApprove(reviewTitle)).toBeVisible();
      await expect(myWork.rowReject(reviewTitle)).toBeVisible();

      // A request reads the same way, and carries the reason it was raised for.
      await expect(myWork.rowKind(flaggedTitle)).toHaveText(/^deletion$/i);
      await expect(myWork.rowOpen(flaggedTitle).locator('span.font-medium')).toHaveText(
        flaggedTitle
      );
      await expect(myWork.rowOpen(flaggedTitle)).toContainText(
        new RegExp(`in ${nest.name} · ${secondaryRole.email} · (just now|\\d+m ago) · "${reason}"`)
      );
    });

    test('CN-WORK-009: reviews are listed before requests, separated by a count divider', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      // Raised request-first, so newest-first ordering alone would put the
      // review underneath it.
      const flaggedTitle = commonFunction.generateEntityName('order-flagged');
      await seedDocumentDeletion(author, nest, flaggedTitle, uniqueText('order'));
      const review = await seedReview(
        author,
        nest,
        commonFunction.generateEntityName('order-review')
      );
      await waitForReviews(api, [review]);

      const work = await myWork.gotoAndReadWork();
      const reviews = work.items.filter((i) => i.type === 'review').length;
      const requests = work.items.length - reviews;
      expect(reviews).toBeGreaterThan(0);
      expect(requests).toBeGreaterThan(0);

      // Every review, then the divider, then every request.
      const layout = await myWork.inboxLayout();
      expect(layout.slice(0, reviews)).toEqual(Array(reviews).fill('Review'));
      expect(layout[reviews]).toBe('divider');
      const afterDivider = layout.slice(reviews + 1);
      expect(afterDivider).toHaveLength(requests);
      // Requests are deletion, archive and access asks (the last raised by other
      // suites on the same account) — never a review.
      expect(afterDivider.every((kind) => ['Deletion', 'Archive', 'Access'].includes(kind))).toBe(true);

      // The divider counts what follows it.
      await expect(myWork.requestsDivider).toHaveText(
        `${requests} ${requests === 1 ? 'request' : 'requests'} · approve or reject each one`
      );
      await expect(myWork.rowKind(review.title)).toHaveText(/^review$/i);
      await expect(myWork.rowKind(flaggedTitle)).toHaveText(/^deletion$/i);
    });

    test('CN-WORK-010: a review can be approved with an optional note', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const plain = await seedReview(author, nest, commonFunction.generateEntityName('approve'));
      const noted = await seedReview(
        author,
        nest,
        commonFunction.generateEntityName('approve-note')
      );
      const note = uniqueText('Looks right');
      await waitForReviews(api, [plain, noted]);

      await myWork.goto();

      // Without a note: the field is offered, never demanded.
      await myWork.openApprove(plain.title);
      await expect(myWork.approveDialog).toContainText(`Approve "${plain.title}" (v1).`);
      await expect(myWork.reviewNoteLabel).toContainText('Note (optional)');
      await expect(myWork.reviewNote).toHaveValue('');
      await myWork.approveConfirm.click();

      await expect(myWork.approveDialog).toHaveCount(0, WRITE);
      await expect(myWork.workRow(plain.title)).toHaveCount(0);
      expect((await api.latestReview(nest.id, plain.id)).status).toBe('approved');

      // With one: it travels with the verdict.
      await myWork.openApprove(noted.title);
      await myWork.reviewNote.fill(note);
      await myWork.approveConfirm.click();

      await expect(myWork.approveDialog).toHaveCount(0, WRITE);
      await expect(myWork.workRow(noted.title)).toHaveCount(0);
      const verdict = await api.latestReview(nest.id, noted.id);
      expect(verdict.status).toBe('approved');
      expect(verdict.resolvedBy).toBe(primaryRole.email);
      expect(verdict.resolutionNote).toBe(note);
    });

    test('CN-WORK-011: rejecting a review requires feedback', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const doc = await seedReview(author, nest, commonFunction.generateEntityName('reject'));
      const feedback = uniqueText('Needs a source');
      await waitForReviews(api, [doc]);

      await myWork.goto();
      await myWork.openReject(doc.title);
      await expect(myWork.rejectDialog).toContainText(`Reject "${doc.title}" (v1).`);
      await expect(myWork.reviewNoteLabel).toContainText('Feedback (required)');

      // Nothing typed: refused in place, and nothing is sent.
      await myWork.rejectConfirm.click();
      await expect(myWork.reviewError).toHaveText(
        'Please provide feedback explaining why this document is being rejected.'
      );
      await expect(myWork.rejectDialog).toBeVisible();

      // Whitespace is not feedback either.
      await myWork.reviewNote.fill('   ');
      await myWork.rejectConfirm.click();
      await expect(myWork.reviewError).toBeVisible();
      await expect(myWork.rejectDialog).toBeVisible();
      expect((await api.latestReview(nest.id, doc.id)).status).toBe('pending');

      await myWork.reviewNote.fill(feedback);
      await myWork.rejectConfirm.click();

      await expect(myWork.rejectDialog).toHaveCount(0, WRITE);
      await expect(myWork.workRow(doc.title)).toHaveCount(0);
      const verdict = await api.latestReview(nest.id, doc.id);
      expect(verdict.status).toBe('rejected');
      expect(verdict.resolutionNote).toBe(feedback);
      expect(await api.nodeStatus(nest.id, doc.id)).toBe('rejected');
    });

    test('CN-WORK-012: approve/reject API errors are displayed inside the dialog', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const first = await seedReview(author, nest, commonFunction.generateEntityName('stale-a'));
      const second = await seedReview(author, nest, commonFunction.generateEntityName('stale-b'));
      await waitForReviews(api, [first, second]);

      await myWork.goto();
      await expect(myWork.workRow(first.title)).toBeVisible();
      await expect(myWork.workRow(second.title)).toBeVisible();

      // The author withdraws both behind the reviewer's back, so the server
      // genuinely refuses what the (now stale) page is about to ask for.
      await author.cancelReview(nest.id, first.id);
      await author.cancelReview(nest.id, second.id);

      await myWork.openApprove(first.title);
      await myWork.approveConfirm.click();

      // The server's own words, in the dialog — which stays open on them.
      await expect(myWork.reviewError).toHaveText('No pending review for this node');
      await expect(myWork.approveDialog).toBeVisible();
      await expect(myWork.approveConfirm).toBeEnabled();
      await myWork.reviewCancel.click();
      await expect(myWork.approveDialog).toHaveCount(0);

      await myWork.openReject(second.title);
      // A reopened dialog starts clean.
      await expect(myWork.reviewError).toHaveCount(0);
      await myWork.reviewNote.fill('Not ready');
      await myWork.rejectConfirm.click();

      await expect(myWork.reviewError).toHaveText('No pending review for this node');
      await expect(myWork.rejectDialog).toBeVisible();
      await expect(myWork.reviewNote).toHaveValue('Not ready');
      await myWork.reviewCancel.click();
    });

    test('CN-WORK-013: a deletion request row offers Delete/Reject with a reason dialog', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const honoured = commonFunction.generateEntityName('delete-honour');
      const refused = commonFunction.generateEntityName('delete-refuse');
      const honouredReason = uniqueText('superseded');
      const refusedReason = uniqueText('duplicate');
      const toDelete = await seedDocumentDeletion(author, nest, honoured, honouredReason);
      const toKeep = await seedDocumentDeletion(author, nest, refused, refusedReason);
      const note = uniqueText('Still referenced');

      await myWork.goto();

      // A request is decided one way or the other — it is not a review.
      await expect(myWork.rowKind(honoured)).toHaveText(/^deletion$/i);
      await expect(myWork.rowDelete(honoured)).toBeVisible();
      await expect(myWork.rowReject(honoured)).toBeVisible();
      await expect(myWork.rowApprove(honoured)).toHaveCount(0);

      // Delete: a confirmation that names the asker and their reason, no note.
      await myWork.rowDelete(honoured).click();
      const deleteDialog = myWork.reasonDialog(`Delete "${honoured}"?`);
      await expect(deleteDialog).toBeVisible();
      await expect(deleteDialog).toContainText(
        `${secondaryRole.email} asked for this: "${honouredReason}".`
      );
      await expect(deleteDialog).toContainText('It cannot be undone.');
      await expect(myWork.reasonInput).toHaveCount(0);
      await expect(myWork.reasonConfirm).toHaveText('Delete document');
      await myWork.reasonConfirm.click();

      await expect(deleteDialog).toHaveCount(0, WRITE);
      await expect(myWork.workRow(honoured)).toHaveCount(0);
      expect((await api.getNode(nest.id, toDelete.doc.id)).status).toBe(404);

      // Reject: the document stays, and the requester is owed a reason.
      await myWork.rowReject(refused).click();
      const rejectDialog = myWork.reasonDialog('Reject this deletion request');
      await expect(rejectDialog).toBeVisible();
      await expect(rejectDialog).toContainText(
        `${secondaryRole.email} asked for this: "${refusedReason}".`
      );
      await expect(rejectDialog).toContainText('The document stays');
      await expect(myWork.reasonLabel).toHaveText('Why are you rejecting?');
      await expect(myWork.reasonConfirm).toHaveText('Reject');
      await expect(myWork.reasonConfirm).toBeDisabled();
      await myWork.reasonInput.fill('   ');
      await expect(myWork.reasonConfirm).toBeDisabled();

      await myWork.reasonInput.fill(note);
      await expect(myWork.reasonConfirm).toBeEnabled();
      await myWork.reasonConfirm.click();

      await expect(rejectDialog).toHaveCount(0, WRITE);
      await expect(myWork.workRow(refused)).toHaveCount(0);
      expect((await api.getNode(nest.id, toKeep.doc.id)).status).toBe(200);
      const declined = (await api.deletionRequests(nest.id, 'declined')).find(
        (r) => r.id === toKeep.request.id
      );
      expect(declined?.resolutionNote).toBe(note);
    });

    test('CN-WORK-015: folder/nest request rows open the nest while document rows open the document', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      const { page, myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const folder = `mw-rows-${Date.now().toString(36)}`;
      const review = await seedReview(author, nest, commonFunction.generateEntityName('open-review'), {
        folder,
      });
      const flagged = await seedDocumentDeletion(
        author,
        nest,
        commonFunction.generateEntityName('open-flagged'),
        uniqueText('document ask')
      );
      const folderReason = uniqueText('folder ask');
      const nestReason = uniqueText('nest ask');
      await seedNestRequest(author, nest, 'folder', folderReason, folder);
      await seedNestRequest(author, nest, 'nest', nestReason);
      await waitForReviews(api, [review]);

      // A folder path and a nest id are not documents — those rows go to the nest.
      await myWork.goto();
      await expect(myWork.rowKind(folderReason)).toHaveText(/^deletion$/i);
      await myWork.rowOpen(folderReason).click();
      await expect(page).toHaveURL(new RegExp(`/nest/${nest.id}`));
      expect(openDocument(page)).toBeNull();

      await myWork.goto();
      await expect(myWork.rowOpen(nestReason).locator('span.font-medium')).toHaveText(nest.name);
      await myWork.rowOpen(nestReason).click();
      await expect(page).toHaveURL(new RegExp(`/nest/${nest.id}`));
      expect(openDocument(page)).toBeNull();

      // A flagged document and a review both open the document itself.
      await myWork.goto();
      await myWork.rowOpen(flagged.doc.title).click();
      await expect.poll(() => openDocument(page)).toBe(flagged.doc.id);
      expect(new URL(page.url()).pathname).toContain(`/nest/${nest.id}`);

      await myWork.goto();
      await myWork.rowOpen(review.title).click();
      await expect.poll(() => openDocument(page)).toBe(review.id);
      expect(new URL(page.url()).pathname).toContain(`/nest/${nest.id}`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Batch decisions
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Bulk review', () => {
    test('CN-WORK-016: select-all and per-row checkboxes work (disabled on request rows)', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      test.skip(!secondaryRole, NEEDS_SECOND_ACCOUNT);
      const { myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const first = await seedReview(author, nest, commonFunction.generateEntityName('pick-a'));
      const second = await seedReview(author, nest, commonFunction.generateEntityName('pick-b'));
      const flaggedTitle = commonFunction.generateEntityName('pick-flagged');
      await seedDocumentDeletion(author, nest, flaggedTitle, uniqueText('pick'));
      await waitForReviews(api, [first, second]);

      const work = await myWork.gotoAndReadWork();
      const reviews = work.items.filter((i) => i.type === 'review').length;

      // Nothing selected: the bar offers the lot and no decision yet.
      await expect(myWork.selectAllLabel).toHaveText(`Select all ${reviews} reviews`);
      await expect(myWork.selectAll).toHaveAttribute('aria-checked', 'false');
      await expect(myWork.bulkApprove).toHaveCount(0);
      await expect(myWork.bulkReject).toHaveCount(0);

      // One row: counted, and the header reads "some", not "none" or "all".
      await myWork.rowCheckbox(first.title).click();
      await expect(myWork.rowCheckbox(first.title)).toHaveAttribute('aria-checked', 'true');
      await expect(myWork.rowCheckbox(second.title)).toHaveAttribute('aria-checked', 'false');
      await expect(myWork.selectedLabel).toHaveText('1 selected');
      await expect(myWork.selectAll).toHaveAttribute('aria-checked', 'mixed');
      await expect(myWork.bulkApprove).toHaveText('Approve 1');
      await expect(myWork.bulkReject).toHaveText('Reject 1');

      // Unticking it takes it back out.
      await myWork.rowCheckbox(first.title).click();
      await expect(myWork.rowCheckbox(first.title)).toHaveAttribute('aria-checked', 'false');
      await expect(myWork.selectAllLabel).toBeVisible();

      // Select all: every review, and only reviews.
      await myWork.selectAll.click();
      await expect(myWork.selectedLabel).toHaveText(`${reviews} selected`);
      await expect(myWork.selectAll).toHaveAttribute('aria-checked', 'true');
      await expect(myWork.reviewCheckboxes).toHaveCount(reviews);
      await expect(myWork.inboxRows.locator('button[role="checkbox"][aria-checked="true"]')).toHaveCount(
        reviews
      );
      await expect(myWork.bulkApprove).toHaveText(`Approve ${reviews}`);

      // A request row holds the column but cannot be ticked or batch-decided.
      const requestCheckbox = myWork.rowCheckbox(flaggedTitle);
      await expect(requestCheckbox).toBeDisabled();
      await expect(requestCheckbox).toBeHidden();
      await expect(requestCheckbox).toHaveAttribute('aria-checked', 'false');

      // Select all again clears; so does Clear.
      await myWork.selectAll.click();
      await expect(myWork.selectAll).toHaveAttribute('aria-checked', 'false');
      await expect(myWork.bulkApprove).toHaveCount(0);

      await myWork.rowCheckbox(second.title).click();
      await expect(myWork.selectedLabel).toHaveText('1 selected');
      await myWork.clearSelection.click();
      await expect(myWork.rowCheckbox(second.title)).toHaveAttribute('aria-checked', 'false');
      await expect(myWork.selectAllLabel).toHaveText(`Select all ${reviews} reviews`);
    });

    test('CN-WORK-017: bulk approve/reject enforces the 50-per-nest cap with a warning', async ({
      primary_user,
    }) => {
      // Forced rows: the cap only bites at 51 pending reviews in one nest.
      await primary_user.initialize();
      const { page, myWorkPage: myWork } = primary_user;
      const crowded = reviewItems(51, {
        nestId: 'stub-nest-a',
        nestName: 'Stub Nest A',
        prefix: 'Crowded review',
      });
      const lone = reviewItem({
        nest_id: 'stub-nest-b',
        nest_name: 'Stub Nest B',
        node_id: 'nodes/stub-nest-b-doc',
        title: 'Lone review',
      });
      const items = [...crowded, lone];
      await stubMyWork(page, ({ limit, offset }) =>
        emptyWork({
          items: limit === 1 ? items.slice(0, 1) : items,
          pagination: { total: items.length, limit, offset, has_more: false },
        })
      );

      await myWork.goto();
      await expect(myWork.selectAllLabel).toHaveText('Select all 52 reviews');
      await expect(myWork.capWarning).toHaveCount(0);

      await myWork.selectAll.click();

      // One over in one nest: said where the selection is made, and neither
      // decision can be sent.
      await expect(myWork.selectedLabel).toHaveText('52 selected');
      await expect(myWork.capWarning).toHaveText('Up to 50 per nest — deselect 1.');
      await expect(myWork.bulkApprove).toBeDisabled();
      await expect(myWork.bulkReject).toBeDisabled();

      // The cap is per nest: dropping the other nest's row changes nothing.
      await myWork.rowCheckbox('Lone review').click();
      await expect(myWork.selectedLabel).toHaveText('51 selected');
      await expect(myWork.capWarning).toHaveText('Up to 50 per nest — deselect 1.');
      await expect(myWork.bulkApprove).toBeDisabled();

      // Dropping one from the crowded nest does.
      await myWork.rowCheckbox('Crowded review 51').click();
      await expect(myWork.selectedLabel).toHaveText('50 selected');
      await expect(myWork.capWarning).toHaveCount(0);
      await expect(myWork.bulkApprove).toBeEnabled();
      await expect(myWork.bulkReject).toBeEnabled();

      // And 51 selected is fine when no single nest is over.
      await myWork.rowCheckbox('Lone review').click();
      await expect(myWork.selectedLabel).toHaveText('51 selected');
      await expect(myWork.capWarning).toHaveCount(0);
      await expect(myWork.bulkApprove).toHaveText('Approve 51');
      await expect(myWork.bulkApprove).toBeEnabled();
    });

    test('CN-WORK-018: bulk result toasts distinguish full success from partial failure', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      test.skip(!secondaryRole, NEEDS_SECOND_ACCOUNT);
      const { myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const approveA = await seedReview(author, nest, commonFunction.generateEntityName('bulk-ok-a'));
      const approveB = await seedReview(author, nest, commonFunction.generateEntityName('bulk-ok-b'));
      const rejected = await seedReview(author, nest, commonFunction.generateEntityName('bulk-part-a'));
      const withdrawn = await seedReview(author, nest, commonFunction.generateEntityName('bulk-part-b'));
      const reason = uniqueText('Batch feedback');
      await waitForReviews(api, [approveA, approveB, rejected, withdrawn]);

      await myWork.goto();

      // ── Everything goes through: one plain success line ──
      await myWork.rowCheckbox(approveA.title).click();
      await myWork.rowCheckbox(approveB.title).click();
      await expect(myWork.bulkApprove).toHaveText('Approve 2');
      await myWork.bulkApprove.click();

      const approveDialog = myWork.reasonDialog('Approve 2 documents?');
      await expect(approveDialog).toBeVisible();
      await expect(myWork.reasonLabel).toHaveText('Comment (optional)');
      await expect(myWork.reasonConfirm).toHaveText('Approve all');
      // An approval comment is offered, never demanded.
      await expect(myWork.reasonConfirm).toBeEnabled();
      await myWork.reasonConfirm.click();

      const success = myWork.toast('2 documents approved');
      await expect(success).toBeVisible(WRITE);
      await expect(success).toHaveAttribute('data-type', 'success');
      await expect(approveDialog).toHaveCount(0);
      await expect(myWork.workRow(approveA.title)).toHaveCount(0);
      await expect(myWork.workRow(approveB.title)).toHaveCount(0);
      // On a loaded shared server the verdict can land a moment after the toast.
      for (const doc of [approveA, approveB]) {
        await expect
          .poll(async () => (await api.latestReview(nest.id, doc.id))?.status ?? null, { timeout: 30_000 })
          .toBe('approved');
      }

      // ── One of two is refused: a warning that says how many and why ──
      // From a freshly loaded inbox, as a second sitting would be.
      await myWork.goto();
      await myWork.rowCheckbox(rejected.title).click();
      await myWork.rowCheckbox(withdrawn.title).click();
      // Withdrawn by its author after the inbox loaded, so the server refuses it.
      await author.cancelReview(nest.id, withdrawn.id);
      await expect(myWork.bulkReject).toHaveText('Reject 2');
      await myWork.bulkReject.click();

      const rejectDialog = myWork.reasonDialog('Reject 2 documents?');
      await expect(rejectDialog).toBeVisible();
      await expect(myWork.reasonLabel).toHaveText('Why?');
      // A batch rejection owes a reason exactly as a single one does.
      await expect(myWork.reasonConfirm).toBeDisabled();
      await myWork.reasonInput.fill(reason);
      await expect(myWork.reasonConfirm).toHaveText('Reject all');
      await myWork.reasonConfirm.click();

      const warning = myWork.toast('1 rejected, 1 could not be');
      await expect(warning).toBeVisible(WRITE);
      await expect(warning).toContainText('No pending review for this node');
      await expect(warning).toHaveAttribute('data-type', 'warning');

      // The one that could be decided was; the other is the author's again.
      await expect
        .poll(async () => (await api.latestReview(nest.id, rejected.id))?.status ?? null, { timeout: 30_000 })
        .toBe('rejected');
      const verdict = await api.latestReview(nest.id, rejected.id);
      expect(verdict.resolutionNote).toBe(reason);
      await expect
        .poll(async () => (await api.latestReview(nest.id, withdrawn.id))?.status ?? null, { timeout: 30_000 })
        .toBe('cancelled');
      await expect(myWork.workRow(rejected.title)).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // What the caller handed off, and paging
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Waiting on others and paging', () => {
    test('CN-WORK-019: "Waiting on others" lists own submissions and Withdraw returns them to Draft', async ({
      primary_user,
      commonFunction,
    }) => {
      const { myWork, api, nest } = await asReviewer(primary_user, commonFunction);
      const doc = await api.createDocument(nest.id, {
        title: commonFunction.generateEntityName('handed-off'),
      });
      await api.submitForReview(nest.id, doc.id);
      cleanups.push(() => api.cancelReview(nest.id, doc.id));
      expect(await api.nodeStatus(nest.id, doc.id)).toBe('pending_review');

      const work = await myWork.gotoAndReadWork();

      // The caller's own submission is a hand-off, not something to decide.
      await expect(myWork.waitingHeading).toBeVisible();
      await expect(myWork.waitingCount).toHaveText(String(work.waiting.length));
      const row = myWork.waitingRow(doc.title);
      await expect(row).toBeVisible();
      await expect(row).toContainText(
        new RegExp(`in ${nest.name} · submitted (just now|\\d+m ago)`)
      );
      await expect(row).toContainText('Pending Review');
      await expect(myWork.workRow(doc.title)).toHaveCount(0);
      await expect(myWork.waitingWithdraw(doc.title)).toBeVisible();

      await myWork.waitingWithdraw(doc.title).click();

      await expect(myWork.toast('Submission withdrawn — back to Draft')).toBeVisible(WRITE);
      await expect(myWork.waitingRow(doc.title)).toHaveCount(0);
      await expect(myWork.page).toHaveURL(/\/my-work$/);
      // Back with its author as a draft — not deleted, not still pending.
      expect(await api.nodeStatus(nest.id, doc.id)).toBe('draft');
      expect((await api.latestReview(nest.id, doc.id)).status).toBe('cancelled');
      expect((await api.myWork()).waiting.some((w) => w.node_id === doc.id)).toBe(false);
    });

    test('CN-WORK-020: pagination controls work and disable correctly at the ends', async ({
      primary_user,
    }) => {
      // Forced rows: a second page takes more than 50 pending reviews.
      await primary_user.initialize();
      const { page, myWorkPage: myWork } = primary_user;
      const all = reviewItems(120, {
        nestId: 'stub-nest-a',
        nestName: 'Stub Nest A',
        prefix: 'Paged review',
      });
      const paged = (rows) => ({ limit, offset }) =>
        emptyWork({
          items: rows.slice(offset, offset + limit),
          pagination: {
            total: rows.length,
            limit,
            offset,
            has_more: offset + limit < rows.length,
          },
        });
      const setWork = await stubMyWork(page, paged(all));
      const title = (text) => myWork.root.getByText(text, { exact: true });

      await myWork.goto();

      // First page: nowhere to go back to.
      await expect(myWork.pageIndicator).toHaveText('Page 1 of 3');
      await expect(myWork.prevPage).toBeDisabled();
      await expect(myWork.nextPage).toBeEnabled();
      await expect(myWork.inboxRows).toHaveCount(50);
      await expect(title('Paged review 01')).toBeVisible();
      await expect(title('Paged review 51')).toHaveCount(0);

      // A middle page: both directions open.
      await myWork.nextPage.click();
      await expect(myWork.pageIndicator).toHaveText('Page 2 of 3');
      await expect(myWork.prevPage).toBeEnabled();
      await expect(myWork.nextPage).toBeEnabled();
      await expect(title('Paged review 51')).toBeVisible();
      await expect(title('Paged review 01')).toHaveCount(0);

      // Last page: the remainder, and nowhere further.
      await myWork.nextPage.click();
      await expect(myWork.pageIndicator).toHaveText('Page 3 of 3');
      await expect(myWork.nextPage).toBeDisabled();
      await expect(myWork.prevPage).toBeEnabled();
      await expect(myWork.inboxRows).toHaveCount(20);
      await expect(title('Paged review 120')).toBeVisible();

      // And back again.
      await myWork.prevPage.click();
      await expect(myWork.pageIndicator).toHaveText('Page 2 of 3');
      await expect(title('Paged review 100')).toBeVisible();
      await myWork.prevPage.click();
      await expect(myWork.pageIndicator).toHaveText('Page 1 of 3');
      await expect(myWork.prevPage).toBeDisabled();

      // A single page needs no pager at all.
      setWork(paged(all.slice(0, 50)));
      await page.reload();
      await expect(myWork.inboxRows).toHaveCount(50);
      await expect(myWork.pageIndicator).toHaveCount(0);
      await expect(myWork.prevPage).toHaveCount(0);
      await expect(myWork.nextPage).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Archive requests — last, because honouring one archives the shared nest
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('Archive requests', () => {
    test('CN-WORK-014: an archive request row offers Approve (archive) and Reject', async ({
      primary_user,
      secondary_user,
      commonFunction,
    }) => {
      test.skip(!secondaryRole, NEEDS_SECOND_ACCOUNT);
      const { myWork, api, author, nest } = await withAuthor(
        primary_user,
        secondary_user,
        commonFunction
      );
      const refusedReason = uniqueText('out of the way');
      const refused = await seedNestRequest(author, nest, 'nest_archive', refusedReason);
      const note = uniqueText('Still in use');

      await myWork.goto();

      // An archive ask is reversible and targets the nest, so the row says
      // Archive and Approve — never Deletion and Delete.
      await expect(myWork.rowKind(refusedReason)).toHaveText(/^archive$/i);
      await expect(myWork.rowOpen(refusedReason).locator('span.font-medium')).toHaveText(nest.name);
      await expect(myWork.rowApprove(refusedReason)).toBeVisible();
      await expect(myWork.rowReject(refusedReason)).toBeVisible();
      await expect(myWork.rowDelete(refusedReason)).toHaveCount(0);

      // Reject: the nest stays where it is, with a reason for the requester.
      await myWork.rowReject(refusedReason).click();
      const rejectDialog = myWork.reasonDialog('Reject this archive request');
      await expect(rejectDialog).toBeVisible();
      await expect(rejectDialog).toContainText(
        `${secondaryRole.email} asked for this: "${refusedReason}".`
      );
      await expect(rejectDialog).toContainText('The nest stays where it is');
      await expect(myWork.reasonConfirm).toBeDisabled();
      await myWork.reasonInput.fill(note);
      await myWork.reasonConfirm.click();

      await expect(rejectDialog).toHaveCount(0, WRITE);
      await expect(myWork.workRow(refusedReason)).toHaveCount(0);
      const declined = (await api.deletionRequests(nest.id, 'declined')).find(
        (r) => r.id === refused.id
      );
      expect(declined?.resolutionNote).toBe(note);
      expect((await api.listNests()).some((n) => n.id === nest.id)).toBe(true);

      // Approve: asked again, and this time honoured — the nest is archived.
      const honouredReason = uniqueText('really done with it');
      await seedNestRequest(author, nest, 'nest_archive', honouredReason);
      await myWork.goto();
      await myWork.rowApprove(honouredReason).click();

      const archiveDialog = myWork.reasonDialog(`Archive "${nest.name}"?`);
      await expect(archiveDialog).toBeVisible();
      await expect(archiveDialog).toContainText(
        `${secondaryRole.email} asked for this: "${honouredReason}".`
      );
      await expect(archiveDialog).toContainText(
        'The nest goes read-only and leaves the dashboard; nothing is deleted and you can restore it.'
      );
      await expect(myWork.reasonInput).toHaveCount(0);
      await expect(myWork.reasonConfirm).toHaveText('Archive nest');
      await myWork.reasonConfirm.click();

      await expect(archiveDialog).toHaveCount(0, WRITE);
      await expect(myWork.workRow(honouredReason)).toHaveCount(0);
      // Archived, not deleted: gone from the live list, present in the archive.
      expect((await api.listNests()).some((n) => n.id === nest.id)).toBe(false);
      expect((await api.listNests({ archived: true })).some((n) => n.id === nest.id)).toBe(true);
    });
  });
});
