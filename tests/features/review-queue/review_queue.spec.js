/**
 * Review Queue Test Suite — RQ-001 … RQ-035
 *
 * Page under test: review in My Work (ui/src/pages/app/my-work/page.tsx).
 * Since #582 the nest page has no Review Queue tab. Every change waiting on the
 * caller is listed in My Work, across nests; clicking a review row opens the
 * review pane beside the list (ui/src/components/MyWorkReviewPane.tsx →
 * ui/src/components/governance/ReviewPane.tsx), and an old link to a nest's
 * Review tab (/nest/<id>?tab=review[&review=<nodeId>]) lands there with the
 * change open (ui/src/App.tsx). Covered here: who sees which reviews, the
 * filter chips, the caller's own submissions (Waiting on others), the review
 * pane, decisions, the batch bar and deletion requests. The nest's "Your Review
 * Queue" stat card (Documents tab), its Activity tab and the header ribbon's My
 * Work count stand in for the old tab's stat card, Agent activity chip and
 * priority sort.
 *
 * Cases whose old behaviour #582 removed are rewritten to the closest thing it
 * shipped; each says so in a "Rewritten for #582" comment.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest and is the author; secondary_user is the
 *   reviewer, because a submitter can't review their own work.
 * - Preconditions (governed nests, stewards, submissions, comments, an agent's
 *   change, a seed) are arranged through the REST API (`reviewQueueApi`); the
 *   step under test goes through the UI. Outcomes are read back through the
 *   API too.
 * - My Work spans every nest and the accounts are shared with other suites, so
 *   the page object scopes rows to the test's nest (the nest filter, and rows
 *   that name the nest). Nothing here assumes an account's inbox is empty.
 * - Every nest is an AUTO_ name, deleted after the test
 *   (`reviewQueueApi.deleteCreatedNests()`), and is in the entity registry for
 *   the teardown and the orphan sweeper. The notifications a nest raised are
 *   marked read first, so neither account's inbox keeps them.
 * - RQ-027 needs two reviewers and an author, and there are two accounts: the
 *   reviewer opens the change in two tabs, so the second approval arrives after
 *   the first has been decided, as it would for a second person.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import ReviewQueuePage from '../../src/page_factory/app/review_queue_page.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/** A write on a shared server can take a while to land. */
const WRITE = { timeout: 60_000 };

const DOC_A = 'Review Doc Alpha';
const DOC_B = 'Review Doc Beta';
const NOTE = 'Please check the new wording.';
const COMMENT = 'A comment for the review feed.';
const TAG = 'qa-review';

test.describe('Review Queue', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Undo steps for this test, run newest first, whatever happened.
  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /**
   * Initialise the owner and create a governed nest. Skips unless the owner
   * may create nests.
   */
  async function ownerNest(role, commonFunction, suffix) {
    await role.initialize();
    const api = role.reviewQueueApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Review Queue suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    cleanups.push(() => api.settleNotificationsFor(nest.id));
    await api.governNest(nest.id);
    return { api, nest, page: role.reviewQueuePage };
  }

  /** Share the nest read-only with secondary_user and open their session. */
  async function addReader(owner, secondary) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await owner.api.addCollaborator(owner.nest.id, secondaryRole.email, 'read');
    await secondary.initialize();
    const api = secondary.reviewQueueApi;
    await api.settleInvitesFor(owner.nest.id);
    cleanups.push(() => api.settleNotificationsFor(owner.nest.id));
    return { api, page: secondary.reviewQueuePage };
  }

  /** Make secondary_user a reviewer of the whole nest. */
  async function addNestReviewer(owner, secondary) {
    const reviewer = await addReader(owner, secondary);
    await owner.api.addSteward(owner.nest.id, { email: secondaryRole.email });
    return reviewer;
  }

  /**
   * Give secondary_user an editor seat. Skips when the server has none (the
   * share would make them a nest admin, who can review everything).
   */
  async function addEditor(owner, secondary) {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const granted = await owner.api.shareForAuthoring(owner.nest.id, secondaryRole.email);
    test.skip(granted !== 'write', 'No editor seats on this server — secondary_user would be a nest admin.');
    await secondary.initialize();
    const api = secondary.reviewQueueApi;
    await api.settleInvitesFor(owner.nest.id);
    cleanups.push(() => api.settleNotificationsFor(owner.nest.id));
    return { api, page: secondary.reviewQueuePage };
  }

  /** Create a document and submit it for review as the owner. */
  async function submitted(owner, title, { note, tags, folder } = {}) {
    const doc = await owner.api.createDoc(owner.nest.id, { title, tags, folder });
    const review = await owner.api.submitForReview(owner.nest.id, doc.id, note);
    return { doc, review };
  }

  /** An approved document with a newer version waiting in the queue. */
  async function publishedThenEdited(owner, reviewer, title) {
    const { doc } = await submitted(owner, title);
    await reviewer.api.approve(owner.nest.id, doc.id);
    await owner.api.updateDocument(owner.nest.id, doc.id, { content: `# ${title}\n\nThe edited body.\n` });
    await owner.api.submitForReview(owner.nest.id, doc.id);
    return doc;
  }

  test('RQ-001: Verify that a reviewer sees a pending document', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-pending');
    const reviewer = await addNestReviewer(owner, secondary_user);
    await submitted(owner, DOC_A);

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.row(DOC_A)).toBeVisible();
  });

  test('RQ-002: Verify that each row shows the request details', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-details');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { review } = await submitted(owner, DOC_A, { note: NOTE });

    await reviewer.page.goto(owner.nest);
    const row = reviewer.page.row(DOC_A);
    await expect(row).toContainText(`in ${owner.nest.name}`);
    await expect(row).toContainText(primaryRole.email);
    await expect(row).toContainText(/just now|\d+m ago/i);
    // Rewritten for #582: a My Work row names the nest, requester and time but
    // not the version or the author's note; both are in the review pane.
    await reviewer.page.openRow(DOC_A);
    await expect(reviewer.page.paneNote).toContainText(NOTE);
    await expect(reviewer.page.approveButton).toHaveAttribute('title', `Publishes v${review.version} as the live version.`);
  });

  test("RQ-003: Verify that the empty state shows when there's nothing to review", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-empty');
    const reviewer = await addNestReviewer(owner, secondary_user);

    // Rewritten for #582: My Work's empty states ("You're all caught up",
    // "Nothing here.") cover every nest, and the shared accounts carry work
    // from other suites. The nest's own empty queue is the stat card's 0 and
    // no rows for the nest in My Work.
    await reviewer.page.gotoDocuments(owner.nest.id);
    await expect(reviewer.page.statCount).toHaveText('0');

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.inboxRows).toHaveCount(0);
  });

  test('RQ-004: Verify that the stat card count matches the rows', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-stat');
    const reviewer = await addNestReviewer(owner, secondary_user);
    await submitted(owner, DOC_A);
    await submitted(owner, DOC_B);

    // Rewritten for #582: the stat card is on the Documents tab and opens My
    // Work, where the nest's rows are counted.
    await reviewer.page.gotoDocuments(owner.nest.id);
    await expect(reviewer.page.statCount).toHaveText('2');
    await reviewer.page.statCard.click();
    await expect(reviewer.page.pageTitle.filter({ hasText: 'My Work' })).toBeVisible();

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.rows).toHaveCount(2);
  });

  test('RQ-005: Verify that the Changes chip shows only change requests', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-changes');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);
    // Rewritten for #582: there is no comment feed. A comment reaches the
    // reviewer in My Work when it @mentions them, and the Reviews chip (the
    // old Changes chip) shows the reviews without it.
    await owner.api.addComment(owner.nest.id, doc.id, `@${secondaryRole.email} ${COMMENT}`);

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.mentionRow(COMMENT)).toBeVisible();

    await reviewer.page.reviewsChip.click();
    await expect(reviewer.page.row(DOC_A)).toBeVisible();
    await expect(reviewer.page.mentionRows).toHaveCount(0);
  });

  test('RQ-006: Verify that the Changes chip sorts by priority', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-priority');
    const reviewer = await addNestReviewer(owner, secondary_user);
    // Rewritten for #582: My Work lists reviews newest first and does not sort
    // by priority. What it does with priority is turn the My Work count red
    // while an urgent review waits on you, so that is what is checked.
    for (const [title, priority] of [
      ['Priority Urgent', 'urgent'],
      ['Priority Low', 'low'],
    ]) {
      const doc = await owner.api.createDoc(owner.nest.id, { title });
      await owner.api.submitWithPriority(owner.nest.id, doc.id, priority);
    }

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.rows).toHaveCount(2);
    await expect(reviewer.page.ribbonCount).toHaveAttribute('data-urgent', 'true');
    await expect(reviewer.page.ribbonMyWork).toHaveAttribute('title', /\d+ waiting, \d+ urgent/);
  });

  test('RQ-007: Verify that the Comments chip shows only comments', async ({ primary_user, secondary_user, commonFunction }) => {
    // Rewritten for #582: the Comments chip is gone. My Work's other
    // single-kind chip is Requests, which shows only requests (here a
    // deletion request, decided by the owner) and no reviews; the Reviews
    // chip leaves the request out.
    const owner = await ownerNest(primary_user, commonFunction, 'rq-requests');
    const editor = await addEditor(owner, secondary_user);
    const flagged = await owner.api.createDoc(owner.nest.id, { title: DOC_B });
    const reason = 'Requests chip check.';
    await editor.api.requestDocumentDeletion(owner.nest.id, flagged.id, reason);

    await owner.page.goto(owner.nest);
    await expect(owner.page.requestRow(reason)).toBeVisible();

    await owner.page.reviewsChip.click();
    await expect(owner.page.requestRow(reason)).toHaveCount(0);

    await owner.page.requestsChip.click();
    await expect(owner.page.requestRow(reason)).toBeVisible();
    await expect(owner.page.rows).toHaveCount(0);
  });

  test('RQ-008: Verify that clicking a comment row opens the thread', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-thread');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);
    // Rewritten for #582: the comment row is a My Work mention row.
    const thread = await owner.api.addComment(owner.nest.id, doc.id, `@${secondaryRole.email} ${COMMENT}`);

    await reviewer.page.goto(owner.nest);
    await reviewer.page.mentionRow(COMMENT).getByRole('button').first().click();

    await expect(reviewer.page.page).toHaveURL(new RegExp(`thread=${thread.id}`));
    await expect(reviewer.page.page.getByText(COMMENT).first()).toBeVisible();
  });

  test('RQ-009: Verify that the Agent activity chip shows agent changes', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-agent');
    const agent = 'qa-review-agent';
    await owner.api.createAgentDocument(owner.nest.id, { title: DOC_A, agent });

    // Rewritten for #582: the Agent activity chip went with the Review tab.
    // What agents changed is listed on the nest's Activity tab, which filters
    // by agent.
    await owner.page.gotoActivity(owner.nest.id);
    await owner.page.activityAgentFilter.fill(agent);

    const row = owner.page.activityRows.filter({ hasText: DOC_A }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(agent);
  });

  test('RQ-010: Verify that an Entire Nest reviewer sees nest requests', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-nest-scope');
    const reviewer = await addNestReviewer(owner, secondary_user);
    await submitted(owner, DOC_A);
    await submitted(owner, DOC_B);

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.row(DOC_A)).toBeVisible();
    await expect(reviewer.page.row(DOC_B)).toBeVisible();
  });

  test('RQ-011: Verify that a document reviewer sees only their document', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-doc-scope');
    const reviewer = await addReader(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);
    await submitted(owner, DOC_B);
    await owner.api.addSteward(owner.nest.id, { email: secondaryRole.email, scope: 'document', nodeId: doc.id });

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.row(DOC_A)).toBeVisible();
    await expect(reviewer.page.rows).toHaveCount(1);
  });

  test('RQ-012: Verify that a tag reviewer sees matching documents', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-tag');
    const reviewer = await addReader(owner, secondary_user);
    await submitted(owner, DOC_A, { tags: [TAG] });
    await owner.api.addSteward(owner.nest.id, { email: secondaryRole.email, scope: 'tag', tag: TAG });

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.row(DOC_A)).toBeVisible();
  });

  test("RQ-013: Verify that a tag reviewer doesn't see untagged documents", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-untagged');
    const reviewer = await addReader(owner, secondary_user);
    await submitted(owner, DOC_A, { tags: [TAG] });
    await submitted(owner, DOC_B);
    await owner.api.addSteward(owner.nest.id, { email: secondaryRole.email, scope: 'tag', tag: TAG });

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.row(DOC_A)).toBeVisible();
    await expect(reviewer.page.row(DOC_B)).toHaveCount(0);
  });

  test("RQ-014: Verify that a viewer doesn't see the tab", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-viewer');
    const viewer = await addReader(owner, secondary_user);
    await submitted(owner, DOC_A);

    // Rewritten for #582: no one has a Review tab now. A viewer's old Review
    // Queue link lands on My Work like anyone's, and nothing in the nest
    // waits on them there.
    await viewer.page.gotoLink(owner.nest);
    await expect(viewer.page.page).not.toHaveURL(/tab=review/);
    await expect(viewer.page.page.getByRole('tab', { name: /^Review Queue/ })).toHaveCount(0);
    await expect(viewer.page.rows).toHaveCount(0);
  });

  test('RQ-015: Verify that an editor sees the tab but no rows', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-editor');
    const editor = await addEditor(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);

    // Rewritten for #582: there is no tab, and the old "pending reviews in
    // this nest, but…" note went with it. The editor's Review Queue link lands
    // on My Work, which lists nothing in the nest for them to decide, though
    // the nest does have a change pending.
    await editor.page.gotoLink(owner.nest);
    await expect(editor.page.pageTitle.filter({ hasText: 'My Work' })).toBeVisible();
    await expect(editor.page.rows).toHaveCount(0);
    expect(await owner.api.nodeStatus(owner.nest.id, doc.id)).toBe('pending_review');
  });

  test("RQ-016: Verify that an admin-only draft isn't in a non-admin reviewer's rows", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-admin-only');
    test.skip(!(await owner.api.applyGenericTeamSeed(owner.nest.id)), 'This server does not offer seeds.');
    const reviewer = await addNestReviewer(owner, secondary_user);
    await submitted(owner, DOC_A, { folder: 'agents' });

    // The stat card, and its note, are on the Documents tab now.
    await reviewer.page.gotoDocuments(owner.nest.id);
    await expect(reviewer.page.statCard).toContainText('assigned to other reviewers');

    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.row(DOC_A)).toHaveCount(0);
  });

  test("RQ-017: Verify that a submitter can't approve their own submission", async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-own');
    const { doc } = await submitted(owner, DOC_A);

    // The submitter's own change is under Waiting on others; opening it shows
    // the pane read-only. (A shared ?review= link would be the other way in,
    // but #582's redirect drops the change on a cold load — see RQ-022.)
    await owner.page.goto(owner.nest);
    await owner.page.waitingRow(DOC_A).locator('button.text-left').click();
    await expect(owner.page.pane).toContainText(doc.id);
    await expect(owner.page.readOnlyNote).toContainText('You submitted this change');
    await expect(owner.page.approveButton).toHaveCount(0);
    await expect(owner.page.rows).toHaveCount(0);
  });

  test('RQ-018: Verify that your own item shows under Submitted by you', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-submitted');
    await submitted(owner, DOC_A);

    // Rewritten for #582: "Submitted by you — awaiting review" is My Work's
    // "Waiting on others", where the row says "Pending Review".
    await owner.page.goto(owner.nest);
    await expect(owner.page.waitingRow(DOC_A)).toBeVisible();
    await expect(owner.page.waitingRow(DOC_A)).toContainText('Pending Review');
    await expect(owner.page.rows).toHaveCount(0);
  });

  test('RQ-019: Verify that Withdraw returns a submission to Draft', async ({ primary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-withdraw');
    const { doc } = await submitted(owner, DOC_A);

    await owner.page.goto(owner.nest);
    await owner.page.waitingRow(DOC_A).getByRole('button', { name: 'Withdraw', exact: true }).click();

    await expect(owner.page.toasts.filter({ hasText: 'Submission withdrawn' })).toBeVisible(WRITE);
    expect(await owner.api.nodeStatus(owner.nest.id, doc.id)).toBe('draft');
    await expect(owner.page.waitingRow(DOC_A)).toHaveCount(0);
  });

  test('RQ-020: Verify that clicking a row opens the review pane', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-pane');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);

    await reviewer.page.goto(owner.nest);
    await reviewer.page.openRow(DOC_A);

    // The pane opens beside the list. My Work keeps no ?review= in its URL,
    // so the pane is identified by the document id it shows.
    await expect(reviewer.page.pane).toContainText(DOC_A);
    await expect(reviewer.page.pane).toContainText(doc.id);
    await expect(reviewer.page.rows).toHaveCount(1);
  });

  test('RQ-021: Verify that an edit to a published document opens on the Changes tab', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-diff');
    const reviewer = await addNestReviewer(owner, secondary_user);
    await publishedThenEdited(owner, reviewer, DOC_A);

    await reviewer.page.goto(owner.nest);
    await reviewer.page.openRow(DOC_A);

    await expect(reviewer.page.changesTab).toHaveAttribute('aria-selected', 'true');
    await expect(reviewer.page.previewTab).toBeVisible();
    await expect(reviewer.page.publishedTab).toBeVisible();
  });

  test('RQ-022: Verify that a decided change link shows the banner', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-stale');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);
    await reviewer.api.approve(owner.nest.id, doc.id);

    // The banner is My Work's "no longer waiting" note in the pane column.
    await reviewer.page.gotoReview(owner.nest, doc.id);
    await expect(reviewer.page.notWaiting).toBeVisible();
    await expect(reviewer.page.pane).toHaveCount(0);
  });

  test('RQ-023: Verify that an out-of-scope change opens read-only', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-scope');
    const reviewer = await addReader(owner, secondary_user);
    const first = await submitted(owner, DOC_A);
    const second = await submitted(owner, DOC_B);
    await owner.api.addSteward(owner.nest.id, { email: secondaryRole.email, scope: 'document', nodeId: first.doc.id });

    await reviewer.page.gotoReview(owner.nest, second.doc.id);
    await expect(reviewer.page.readOnlyNote).toContainText('outside your steward scope');
    await expect(reviewer.page.approveButton).toHaveCount(0);
  });

  test('RQ-024: Verify that a reviewer can approve a document', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-approve');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);

    await reviewer.page.goto(owner.nest);
    await reviewer.page.openRow(DOC_A);
    await reviewer.page.approveButton.click();

    await expect(reviewer.page.toasts.filter({ hasText: 'Approved and published' })).toBeVisible(WRITE);
    expect((await owner.api.latestReview(owner.nest.id, doc.id)).status).toBe('approved');
  });

  test('RQ-025: Verify that a reviewer can approve with a comment', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-approve-note');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);
    const comment = 'Approved with this comment.';

    await reviewer.page.goto(owner.nest);
    await reviewer.page.openRow(DOC_A);
    await reviewer.page.approveWith(comment);

    await expect(reviewer.page.toasts.filter({ hasText: 'Approved and published' })).toBeVisible(WRITE);
    const review = await owner.api.latestReview(owner.nest.id, doc.id);
    expect(review.status).toBe('approved');
    expect(review.resolutionNote).toBe(comment);
  });

  test('RQ-026: Verify that an approved item leaves the queue', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-leaves');
    const reviewer = await addNestReviewer(owner, secondary_user);
    await submitted(owner, DOC_A);

    await reviewer.page.goto(owner.nest);
    await reviewer.page.openRow(DOC_A);
    await reviewer.page.approveButton.click();

    await expect(reviewer.page.row(DOC_A)).toHaveCount(0, WRITE);
    // My Work's empty state is account-wide; the nest's own queue is empty
    // when a fresh read lists nothing for it.
    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.inboxRows).toHaveCount(0);
  });

  test("RQ-027: Verify that a second reviewer can't approve an approved request", async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-second');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);

    // The later session: opened before the first approval lands.
    // Both sessions open the change from its My Work row.
    const later = new ReviewQueuePage(await secondary_user.page.context().newPage(), 'second-session');
    await later.goto(owner.nest);
    await later.openRow(DOC_A);
    await later.approveButton.waitFor({ state: 'visible' });

    await reviewer.page.goto(owner.nest);
    await reviewer.page.openRow(DOC_A);
    await reviewer.page.approveButton.click();
    await expect(reviewer.page.toasts.filter({ hasText: 'Approved and published' })).toBeVisible(WRITE);

    await later.approveButton.click();
    await expect(later.paneActions).toContainText('No pending review', WRITE);
  });

  test('RQ-028: Verify that Request Changes requires feedback', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-feedback');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);

    await reviewer.page.goto(owner.nest);
    await reviewer.page.openRow(DOC_A);
    await reviewer.page.requestChangesButton.click();
    await reviewer.page.requestChangesButton.click();

    await expect(reviewer.page.paneActions).toContainText('Add a reason so the author knows what to change.');
    expect(await owner.api.nodeStatus(owner.nest.id, doc.id)).toBe('pending_review');
  });

  test('RQ-029: Verify that a reviewer can request changes', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-reject');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const { doc } = await submitted(owner, DOC_A);
    const reason = 'Please add the missing section.';

    await reviewer.page.goto(owner.nest);
    await reviewer.page.openRow(DOC_A);
    await reviewer.page.requestChanges(reason);

    await expect(reviewer.page.toasts.filter({ hasText: 'Sent back to the author' })).toBeVisible(WRITE);
    const review = await owner.api.latestReview(owner.nest.id, doc.id);
    expect(review.status).toBe('rejected');
    expect(review.resolutionNote).toBe(reason);
  });

  test('RQ-030: Verify that bulk approve publishes the selected documents', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-bulk');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const first = await submitted(owner, DOC_A);
    const second = await submitted(owner, DOC_B);

    // The nest's two rows are ticked one by one: My Work's select-all would
    // also take any other nest's reviews on the page.
    await reviewer.page.goto(owner.nest);
    await reviewer.page.selectRow(DOC_A);
    await reviewer.page.selectRow(DOC_B);
    await reviewer.page.bulkApprove.click();
    await reviewer.page.reasonConfirm.click();

    await expect(reviewer.page.toasts.filter({ hasText: '2 documents approved' })).toBeVisible(WRITE);
    expect(await owner.api.nodeStatus(owner.nest.id, first.doc.id)).toBe('published');
    expect(await owner.api.nodeStatus(owner.nest.id, second.doc.id)).toBe('published');
  });

  test('RQ-031: Verify that Reject all stays disabled until a reason is entered', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-bulk-reason');
    const reviewer = await addNestReviewer(owner, secondary_user);
    await submitted(owner, DOC_A);
    await submitted(owner, DOC_B);

    await reviewer.page.goto(owner.nest);
    await reviewer.page.selectRow(DOC_A);
    await reviewer.page.selectRow(DOC_B);
    await reviewer.page.bulkReject.click();

    await expect(reviewer.page.reasonConfirm).toBeDisabled();
    await reviewer.page.reasonInput.fill('Needs another pass.');
    await expect(reviewer.page.reasonConfirm).toBeEnabled();
  });

  test('RQ-032: Verify that a bulk partial failure is reported', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-bulk-partial');
    const reviewer = await addNestReviewer(owner, secondary_user);
    const first = await submitted(owner, DOC_A);
    const second = await submitted(owner, DOC_B);
    // Two more stay pending, so the batch bar is still there after the batch.
    await submitted(owner, 'Review Doc Gamma');
    await submitted(owner, 'Review Doc Delta');

    await reviewer.page.goto(owner.nest);
    await reviewer.page.selectRow(DOC_A);
    await reviewer.page.selectRow(DOC_B);
    await expect(reviewer.page.selectedLabel).toHaveText('2 selected');
    // The author withdraws one after the inbox loaded, so that one must fail.
    await owner.api.cancelReview(owner.nest.id, second.doc.id);
    await reviewer.page.bulkApprove.click();
    await reviewer.page.reasonConfirm.click();

    await expect(reviewer.page.toasts.filter({ hasText: '1 approved, 1 could not be' })).toBeVisible(WRITE);
    // Rewritten for #582: My Work keeps a failure selected only while its row
    // is listed, and the withdrawn change leaves the list on the reload after
    // the batch, so the old "1 selected" can't stay. Both decided rows leave
    // and the two untouched ones stay.
    await expect(reviewer.page.row(DOC_A)).toHaveCount(0, WRITE);
    await expect(reviewer.page.row(DOC_B)).toHaveCount(0, WRITE);
    await expect(reviewer.page.rows).toHaveCount(2);
    expect((await owner.api.latestReview(owner.nest.id, first.doc.id)).status).toBe('approved');
    expect(await owner.api.nodeStatus(owner.nest.id, second.doc.id)).toBe('draft');
  });

  test('RQ-033: Verify that only admins and owners see Deletion requests', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-del-see');
    const editor = await addEditor(owner, secondary_user);
    const doc = await owner.api.createDoc(owner.nest.id, { title: DOC_A });
    const reason = 'No longer needed here.';
    await editor.api.requestDocumentDeletion(owner.nest.id, doc.id, reason);

    await owner.page.goto(owner.nest);
    await expect(owner.page.requestRow(reason)).toBeVisible();
    await expect(owner.page.requestRow(reason).locator('span.uppercase')).toHaveText(/^deletion$/i);

    // The editor who asked sees it only as their own ask, under Waiting on
    // others, never as a request to decide.
    await editor.page.goto(owner.nest);
    await expect(editor.page.waitingRow(DOC_A)).toContainText('Deletion Requested');
    await expect(editor.page.requestRow(reason)).toHaveCount(0);
  });

  test('RQ-034: Verify that Delete removes the document in a document deletion request', async ({ primary_user, secondary_user, commonFunction }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    const owner = await ownerNest(primary_user, commonFunction, 'rq-del');
    await owner.api.shareForAuthoring(owner.nest.id, secondaryRole.email);
    await secondary_user.initialize();
    const editorApi = secondary_user.reviewQueueApi;
    await editorApi.settleInvitesFor(owner.nest.id);
    cleanups.push(() => editorApi.settleNotificationsFor(owner.nest.id));
    const doc = await owner.api.createDoc(owner.nest.id, { title: DOC_A });
    const reason = 'Flagged for removal.';
    await editorApi.requestDocumentDeletion(owner.nest.id, doc.id, reason);

    await owner.page.goto(owner.nest);
    await owner.page.deleteFromRequest(reason);

    await expect(owner.page.requestRow(reason)).toHaveCount(0, WRITE);
    expect((await owner.api.getNode(owner.nest.id, doc.id)).status).toBe(404);
  });

  test('RQ-035: Verify that counts update after a decision', async ({ primary_user, secondary_user, commonFunction }) => {
    const owner = await ownerNest(primary_user, commonFunction, 'rq-counts');
    const reviewer = await addNestReviewer(owner, secondary_user);
    await submitted(owner, DOC_A);
    await submitted(owner, DOC_B);

    // Rewritten for #582: the counts are the stat card (Documents tab) and My
    // Work's Reviews chip narrowed to the nest, in place of the old Changes
    // chip and the Review Queue tab's badge.
    await reviewer.page.gotoDocuments(owner.nest.id);
    await expect(reviewer.page.statCount).toHaveText('2');
    await reviewer.page.goto(owner.nest);
    await expect(reviewer.page.rows).toHaveCount(2);
    await expect.poll(() => reviewer.page.chipCount(reviewer.page.reviewsChip)).toBe('2');

    await reviewer.page.openRow(DOC_A);
    await reviewer.page.approveButton.click();

    await expect(reviewer.page.rows).toHaveCount(1, WRITE);
    await expect.poll(() => reviewer.page.chipCount(reviewer.page.reviewsChip), WRITE).toBe('1');
    await reviewer.page.gotoDocuments(owner.nest.id);
    await expect(reviewer.page.statCount).toHaveText('1', WRITE);
  });
});
