/**
 * Stream as a feed (po-1214) — CN-ST-001 … CN-ST-005
 *
 * Page under test: ui/src/pages/app/stream/ (route `/stream`) and the
 * DocStream component it renders. Each case names the acceptance criterion
 * it checks (AC-ST-01, 04, 05, 10).
 *
 * Conventions
 * -----------
 * - The stream is experimental (EXPERIMENTAL_DOC_STREAM). While it is off on
 *   the server under test, GET /me/stream answers 404 and the suite skips.
 * - CI runs e2e against the deployed server (nest-dev), not this branch's
 *   build. Until that server ships the feed (a `facets=0` read then answers
 *   with `counts: null`), the suite skips rather than fails;
 *   CN_EXPECT_STREAM_FEED=1 turns that skip into a failure.
 * - Cases that need posts skip when the primary account's stream is empty.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;

test.describe('Stream: a dense feed', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  /** Is the feed deployed and switched on for this account? */
  async function feedState(page) {
    const r = await page.request.get('/me/stream?limit=1&facets=0');
    if (r.status() !== 200) return { deployed: false, posts: 0 };
    const body = await r.json();
    return { deployed: body.counts === null, posts: body.total ?? 0 };
  }

  test.beforeEach(async ({ primary_user }) => {
    await primary_user.initialize();
    const state = await feedState(primary_user.page);
    if (process.env.CN_EXPECT_STREAM_FEED === '1') {
      expect(state.deployed, 'the server under test does not ship the stream feed (po-1214)').toBe(true);
    }
    test.skip(!state.deployed, 'The server under test does not ship the stream feed yet, or the stream is off (po-1214).');
    test.info().annotations.push({ type: 'posts', description: String(state.posts) });
  });

  const postsIn = (test) => Number(test.info().annotations.find((a) => a.type === 'posts')?.description ?? 0);

  test('CN-ST-001 (AC-ST-01): at 1440x1000 at least 7 posts are above the fold', async ({ primary_user }) => {
    const { page } = primary_user;
    test.skip(postsIn(test) < 7, 'Fewer than 7 posts in this account\'s stream.');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/stream');
    await expect(page.getByTestId('stream-post').first()).toBeVisible();
    const above = await page.getByTestId('stream-post').evaluateAll(
      (els) => els.filter((e) => e.getBoundingClientRect().bottom <= window.innerHeight).length,
    );
    expect(above).toBeGreaterThanOrEqual(7);
  });

  test('CN-ST-002 (AC-ST-04): the filters are one row with a people / agents toggle and a Filter menu', async ({ primary_user }) => {
    const { page } = primary_user;
    await page.goto('/stream');
    await expect(page.getByRole('radiogroup', { name: 'Who wrote it' })).toBeVisible();
    await expect(page.getByTestId('stream-source-agents')).toBeVisible();
    await expect(page.getByText('Author:', { exact: true })).toHaveCount(0);
    if (postsIn(test) > 0) {
      await page.getByTestId('stream-filter-menu').click();
      await expect(page.getByRole('menuitemcheckbox').first()).toBeVisible();
    }
  });

  test('CN-ST-003 (AC-ST-05): every post has reply, open and copy-link actions; reply opens a composer in place', async ({ primary_user }) => {
    const { page } = primary_user;
    test.skip(postsIn(test) < 1, 'The stream is empty for this account.');
    await page.goto('/stream');
    const post = page.getByTestId('stream-post').first();
    await expect(post.getByTestId('stream-open')).toBeVisible();
    await expect(post.getByTestId('stream-copy-link')).toBeVisible();
    await post.getByTestId('stream-reply').click();
    await expect(post.getByTestId('stream-composer')).toBeVisible();
    await expect(page).toHaveURL(/\/stream/);
  });

  test('CN-ST-004 (AC-ST-02): a post names a person, not an email', async ({ primary_user }) => {
    const { page } = primary_user;
    test.skip(postsIn(test) < 1, 'The stream is empty for this account.');
    await page.goto('/stream');
    const firstLine = page.getByTestId('stream-post').first().locator('div.min-w-0 > div').first();
    await expect(firstLine).not.toContainText('@');
  });

  test('CN-ST-005 (AC-ST-10): at 390px there is no horizontal scroll', async ({ primary_user }) => {
    const { page } = primary_user;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/stream');
    await expect(page.getByTestId('doc-stream')).toBeVisible();
    const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
