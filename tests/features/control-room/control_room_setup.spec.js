/**
 * Control Room → Setup and How it works (po-1186 CR3) — CN-CR-001 … CN-CR-007
 *
 * Page under test: ui/src/pages/app/control-room/ (route `/control-room`).
 * Each case names the acceptance criterion it checks (AC-CR-01, 02, 14, 15, 16).
 *
 * Conventions
 * -----------
 * - The primary account must be a server admin (installing is server-admin only).
 * - Slack is a fake (tests/src/lib/control_room_stubs.js): every /surfaces call
 *   the page makes is answered in this browser, Slack OAuth included, and
 *   `/health` reports Surfaces on. Nests come from the real server.
 * - CN-CR-007 (the public member page) reads the real server and skips while
 *   Surfaces is off there.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import ControlRoomPage from '../../src/page_factory/app/control_room_page.js';
import { stubSurfaces, stubSurfacesOn } from '../../src/lib/control_room_stubs.js';

const primaryRole = samples.primary_user ?? null;

async function firstNestId(page) {
  const r = await page.request.get('/nests');
  const body = await r.json();
  return body.nests?.[0]?.id ?? null;
}

test.describe('Control room: setup', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test('CN-CR-001: the Control room sits in the Workspace group of the rail while Surfaces is on', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    await stubSurfaces(page);
    const cr = new ControlRoomPage(page);
    await page.goto('/');
    await expect(cr.railItem).toBeVisible();
    await cr.railItem.click();
    await expect(page).toHaveURL(/\/control-room/);
    await expect(cr.tab('Setup')).toHaveAttribute('aria-selected', 'true');
    for (const t of ['Overview', 'Decision ledger', 'Agents', 'How it works']) await expect(cr.tab(t)).toBeVisible();
  });

  test('CN-CR-002 / AC-CR-01: with no install, each step says what happens and what is never captured, and setup finishes install → bind → seed → listening without the API', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    const fake = await stubSurfaces(page, { install: 'none' });
    const cr = new ControlRoomPage(page);
    await cr.goto('setup');

    // Step 1: what it will and will never do.
    await expect(cr.stepPane(1)).toBeVisible();
    for (const t of [
      "Read DMs between people, or channels it isn't in",
      'Import channel history',
      'Post recaps or summaries in the channel',
      'Propose pay, health, performance or personal matters',
      'Keep message text longer than 24 hours',
      'Wait until a thread has been quiet for 20 minutes',
    ]) await expect(cr.willNever).toContainText(t);
    for (let i = 1; i <= 5; i++) await expect(cr.stepButton(i)).toContainText(/\w/);

    // Install: manifest → credentials (write-only) → stubbed Slack OAuth.
    const download = page.waitForEvent('download');
    await cr.button('Download manifest').click();
    expect((await download).suggestedFilename()).toBe('nest-slack-manifest.json');
    for (const [id, v] of [['cred-client_id', 'cid.123'], ['cred-client_secret', 'shh-secret'], ['cred-signing_secret', 'sign-secret']]) {
      await page.locator(`#${id}`).fill(v);
      await expect(page.locator(`#${id}`)).toHaveAttribute('type', 'password');
    }
    await cr.button('Save values').click();
    await expect(page.getByTestId('cred-state-signing_secret')).toHaveText('Saved');
    await expect(page.locator('#cred-client_secret')).toHaveValue('');
    await cr.button('Open Slack to approve').click();
    await page.waitForURL(/\/control-room\?section=setup/);
    // Back from Slack, the page works out where it is: step 1 done, on step 2.
    await expect(cr.stepButton(1)).toHaveAttribute('data-done', 'true');
    await expect(cr.progress).toContainText('1 of 5 steps done.');

    // Step 2: pick two channels; the live check runs.
    await expect(cr.stepPane(2)).toBeVisible();
    await page.getByLabel('Listen in #acme-renewal').check();
    await page.getByLabel('Listen in #revops').check();
    await expect(page.getByTestId('guard-C_REVOPS')).toContainText('Proposals only');
    await expect(page.getByTestId('guard-C_REVOPS')).toContainText('11 of the 18 members');
    await cr.button('Check 2 channels').click();

    // Step 3: both can listen.
    await expect(page.getByTestId('setup-check-ok')).toContainText('2 channels can listen');
    await cr.button('Continue').click();

    // Step 4: preview, then apply.
    await cr.button('Preview changes').click();
    await expect(page.getByTestId('setup-dry-run')).toContainText('nothing written');
    await cr.button('Apply starter').click();
    await expect(page.getByTestId('setup-applied')).toBeVisible();
    await cr.button('Continue').click();

    // Step 5: the notice, then turn on.
    await expect(page.getByTestId('setup-notice')).toContainText('Notice posted to #acme-renewal, #revops');
    await expect(page.getByTestId('setup-notice')).toContainText('@Nest skip me');
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/surfaces/bindings')).toHaveLength(0);
    await page.getByTestId('setup-turn-on').click();
    await expect(page.getByTestId('setup-listening')).toContainText('Listening in 2 channels');
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/surfaces/bindings').map((c) => c.body.conversation_id)).toEqual(['C_RENEW', 'C_REVOPS']);
    await expect(cr.stepButton(5)).toHaveAttribute('data-done', 'true');
  });

  test('CN-CR-003 / AC-CR-02: a refused channel names the counts and offers the fixes; Continue stays off until it is resolved, and nothing is saved', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    const fake = await stubSurfaces(page, { install: 'active' });
    const cr = new ControlRoomPage(page);
    await cr.goto('setup');
    await expect(cr.stepPane(2)).toBeVisible();
    await page.getByLabel('Listen in #revops').check();
    await page.getByLabel('Listen in #leadership').check();
    await expect(page.getByTestId('guard-C_LEAD')).toContainText("Can't listen here");
    await cr.button('Check 2 channels').click();

    const refusal = page.getByTestId('refusal-C_LEAD');
    await expect(refusal).toContainText('refused');
    await expect(refusal).toContainText('is readable by 312 people, and 306 of them aren\'t in #leadership.');
    await expect(refusal.getByRole('button', { name: /Create a Leadership nest/ })).toBeVisible();
    await expect(refusal.getByRole('button', { name: 'Choose another nest' })).toBeVisible();
    await expect(refusal.getByRole('button', { name: 'Leave #leadership off' })).toBeVisible();
    await expect(page.getByTestId('setup-check-continue')).toBeDisabled();
    await expect(page.getByTestId('setup-check-continue')).toHaveText('Resolve 1 first');
    expect(fake.calls.filter((c) => c.path === '/surfaces/bindings' && c.method === 'POST')).toHaveLength(0);

    await refusal.getByRole('button', { name: 'Leave #leadership off' }).click();
    await expect(page.getByTestId('setup-check-continue')).toBeEnabled();
    await expect(page.getByTestId('setup-check-ok')).toContainText('#revops');
  });

  test('CN-CR-004 / AC-CR-02: "Create a nest for this channel" makes a nest the channel can save into', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    const fake = await stubSurfaces(page, { install: 'active' });
    const cr = new ControlRoomPage(page);
    await cr.goto('setup');
    await page.getByLabel('Listen in #leadership').check();
    await cr.button('Check 1 channel').click();
    await page.getByTestId('refusal-C_LEAD').getByRole('button', { name: /Create a Leadership nest/ }).click();
    await expect(page.getByTestId('setup-check-ok')).toContainText('#leadership → Leadership');
    await expect(page.getByTestId('setup-check-continue')).toBeEnabled();
    // Clean up the nest this case created.
    for (const id of fake.createdNests) await page.request.delete(`/nests/${id}`);
  });

  test('CN-CR-005 / AC-CR-14: "Preview changes" shows created vs already there, and nothing is written until "Apply starter"', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    await stubSurfacesOn(page);
    const fake = await stubSurfaces(page, { install: 'active' });
    const cr = new ControlRoomPage(page);
    await cr.goto('setup');
    await page.getByLabel('Listen in #acme-renewal').check();
    await cr.button('Check 1 channel').click();
    await cr.button('Continue').click();
    await expect(cr.stepPane(4)).toBeVisible();
    await expect(cr.button('Apply starter')).toBeDisabled();
    await cr.button('Preview changes').click();
    const tree = page.getByTestId('setup-seed-tree');
    await expect(tree.locator('[data-mark="same"]', { hasText: 'decisions/' })).toBeVisible();
    await expect(tree.locator('[data-mark="add"]', { hasText: 'people/' })).toBeVisible();
    await expect(tree.locator('[data-mark="same"]', { hasText: 'customers/' })).toBeVisible();
    await expect(page.getByTestId('setup-dry-run')).toContainText('4 folders, CONTEXT.md and 4 terms would be added. 2 folders already exist');
    const applies = () => fake.calls.filter((c) => c.path === '/surfaces/seeds/apply');
    expect(applies().map((c) => !!c.body.dry_run)).toEqual([true]);
    await cr.button('Apply starter').click();
    await expect(page.getByTestId('setup-applied')).toBeVisible();
    expect(applies().map((c) => !!c.body.dry_run)).toEqual([true, false]);
  });

  test('CN-CR-006 / AC-CR-15: an install with bindings but no seed opens on step 4 with steps 1–3 done and "3 of 5 steps done"', async ({ primary_user }) => {
    await primary_user.initialize();
    const { page } = primary_user;
    const nestId = await firstNestId(page);
    test.skip(!nestId, 'primary_user has no nest to bind.');
    await stubSurfacesOn(page);
    await stubSurfaces(page, { install: 'active', bindings: [{ conversation_id: 'C_RENEW', nest_id: nestId }] });
    const cr = new ControlRoomPage(page);
    await cr.goto('setup');
    await expect(cr.stepPane(4)).toBeVisible();
    await expect(cr.progress).toContainText('3 of 5 steps done.');
    for (const n of [1, 2, 3]) await expect(cr.stepButton(n)).toHaveAttribute('data-done', 'true');
    for (const n of [4, 5]) await expect(cr.stepButton(n)).toHaveAttribute('data-done', 'false');
    await expect(cr.stepButton(4)).toHaveAttribute('aria-current', 'step');
  });
});

test.describe('Control room: member page', () => {
  test('CN-CR-007 / AC-CR-16: /about/surfaces opens without signing in, with the never list and "@Nest skip me", and no nest, channel or user names', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const res = await page.goto('/about/surfaces');
    test.skip(res?.status() === 404, 'Surfaces is off on this server.');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'How Nest handles your messages' })).toBeVisible();
    await expect(page.locator('body')).toContainText('@Nest skip me');
    for (const t of ["Read DMs between people, or channels it isn't in", 'Import channel history', 'Post recaps or summaries in the channel', 'Propose pay, health, performance or personal matters']) {
      await expect(page.locator('ul')).toContainText(t);
    }
    if (primaryRole) await expect(page.locator('body')).not.toContainText(primaryRole.email);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await ctx.close();
  });
});
