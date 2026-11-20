/**
 * Share a document (PO-1365) — CN-SHARE-001 … CN-SHARE-007
 *
 * Under test: the "Share public link" action in a document's ⋮ menu
 * (ui/src/lib/share-link.ts) and the public page it leads to (`/p/<slug>`,
 * src/nests/publish-render-routes.ts): the link-preview tags and the
 * "Make your own nest" strip.
 *
 * Conventions
 * -----------
 * - primary_user owns every nest. Each test creates its own AUTO_ nest and
 *   seeds its documents over REST; the UI is driven only for the action under
 *   test. Nests are deleted after each test.
 * - The link is read back from GET /nests/:id/publications rather than from
 *   the clipboard, which a headless browser may refuse to write.
 * - The public page is opened in a fresh browser context with no session, the
 *   way a stranger opens it.
 * - A server that does not ship the feature yet (the deployed nest-dev job,
 *   until this merges) skips; CN_EXPECT_SHARE_LINK=1 (the PR-build job) turns
 *   that skip into a failure.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;

/** A write (publish, revoke) may take a few seconds on a deployed server. */
const WRITE = { timeout: 30_000 };

const DOC_TITLE = 'Share Probe';
const DOC_BODY = '# Share Probe\n\nShared words for the preview excerpt.\n';

test.describe('Share a document', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  const cleanups = [];
  test.afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()().catch(() => {});
    }
  });

  /** Every public link of a nest, newest first. */
  async function links(api, nestId) {
    const data = await api.expectOk('GET', `/nests/${nestId}/publications`);
    return data.publishes ?? [];
  }

  /**
   * An owner's nest with one approved document, open on that document.
   * Skips when the account may not create nests, or when the server under
   * test does not ship the share action.
   */
  async function ownerDocument(role, commonFunction, suffix) {
    await role.initialize();
    const api = role.newDocumentApi;
    test.skip(!(await api.canCreateNests()), 'This account may not create nests here.');
    const nest = await api.createNest(commonFunction.generateEntityName(suffix), 'Share suite (safe to delete)');
    cleanups.push(() => api.deleteCreatedNests());
    const doc = await api.createDocument(nest.id, { title: DOC_TITLE, content: DOC_BODY });

    const { page } = role;
    await page.goto(`/nest/${nest.id}?doc=${encodeURIComponent(doc.id)}`);
    const share = await openMoreMenu(page);
    const shipped = await share.isVisible().catch(() => false);
    if (process.env.CN_EXPECT_SHARE_LINK === '1') {
      expect(shipped, 'the server under test does not ship Share public link (PO-1365)').toBe(true);
    }
    test.skip(!shipped, 'The server under test does not ship Share public link yet (PO-1365).');
    return { api, nest, doc, page, share };
  }

  /**
   * Open the document's ⋮ menu and return its Share public link item, scoped
   * to the menu Radix has settled open. A menu that was just used stays in the
   * page as data-state="closed" until its exit animation ends (past the toast
   * coming up), and its items are still visible then: an unscoped locator can
   * resolve to the dying item and be detached mid-click.
   */
  async function openMoreMenu(page) {
    // The item waits for the document (PO-1396). On a deployed server the menu
    // is on the page while "Loading document..." still shows, so wait for the
    // title, which renders only once the document has loaded.
    await page.getByTestId('document-editor-title').first().waitFor({ state: 'visible', ...WRITE });
    const trigger = page.getByTestId('document-editor-more');
    await expect(page.getByRole('menu')).toHaveCount(0, WRITE);
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = page.locator('[role="menu"][data-state="open"]');
    await expect(menu).toBeVisible();
    return menu.getByTestId('document-editor-share-link');
  }

  /** Open a URL the way a stranger does: no session, no cookies. */
  async function asStranger(browser, viewport = { width: 1280, height: 800 }) {
    const context = await browser.newContext({ viewport });
    cleanups.push(() => context.close());
    return context.newPage();
  }

  test('CN-SHARE-001: Verify that Share public link publishes the document, says what became public, and the link opens for a stranger', async ({
    primary_user,
    commonFunction,
    browser,
  }) => {
    const { api, nest, page, share } = await ownerDocument(primary_user, commonFunction, 'share-publish');
    expect(await links(api, nest.id)).toHaveLength(0);

    await share.click();
    await expect(page.getByText(`“${DOC_TITLE}” is now public`)).toBeVisible(WRITE);
    await expect(page.getByText(/Anyone with the link can read the approved version/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Manage', exact: true })).toBeVisible();

    const made = await links(api, nest.id);
    expect(made).toHaveLength(1);
    expect(made[0].access_mode).toBe('public');
    expect(made[0].comments_enabled).toBe(false);
    expect(made[0].expires_at).toBeNull();

    const stranger = await asStranger(browser);
    await stranger.goto(made[0].link);
    await expect(stranger.getByRole('heading', { name: DOC_TITLE })).toBeVisible();
    await expect(stranger.getByText('Shared words for the preview excerpt.')).toBeVisible();
  });

  test('CN-SHARE-002: Verify that Share public link on a document that already has a link copies it and makes no second link', async ({
    primary_user,
    commonFunction,
  }) => {
    const { api, nest, page, share } = await ownerDocument(primary_user, commonFunction, 'share-again');
    await share.click();
    await expect(page.getByText(`“${DOC_TITLE}” is now public`)).toBeVisible(WRITE);
    const first = await links(api, nest.id);
    expect(first).toHaveLength(1);

    // The first click's menu is still closing as the toast comes up; reopen
    // it only once that one is gone, and click the item in the open menu.
    await (await openMoreMenu(page)).click();
    // Copied, or shown when the browser refuses the clipboard: never re-published.
    await expect(page.getByText(/Public link copied|This document has a public link/)).toBeVisible(WRITE);
    const second = await links(api, nest.id);
    expect(second).toHaveLength(1);
    expect(second[0].slug).toBe(first[0].slug);
  });

  test('CN-SHARE-003: Verify that Undo removes the link that Share public link just made', async ({
    primary_user,
    commonFunction,
    browser,
  }) => {
    const { api, nest, page, share } = await ownerDocument(primary_user, commonFunction, 'share-undo');
    await share.click();
    await expect(page.getByText(`“${DOC_TITLE}” is now public`)).toBeVisible(WRITE);
    const [made] = await links(api, nest.id);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText(`“${DOC_TITLE}” is no longer public`)).toBeVisible(WRITE);
    await expect.poll(async () => (await links(api, nest.id))[0]?.revoked_at ?? null, WRITE).not.toBeNull();

    const stranger = await asStranger(browser);
    const res = await stranger.goto(made.link);
    expect(res.status()).toBe(404);
    await expect(stranger.getByText('This link is no longer available')).toBeVisible();
  });

  test('CN-SHARE-004: Verify that Manage opens the publish dialog with the new link listed', async ({
    primary_user,
    commonFunction,
  }) => {
    const { page, share } = await ownerDocument(primary_user, commonFunction, 'share-manage');
    await share.click();
    await expect(page.getByText(`“${DOC_TITLE}” is now public`)).toBeVisible(WRITE);

    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(`Publish “${DOC_TITLE}”`)).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Links (1)' })).toBeVisible(WRITE);
  });

  test('CN-SHARE-007: Verify that switching off “Make your own nest” on a link removes the strip from its page, at the same URL', async ({
    primary_user,
    commonFunction,
    browser,
  }) => {
    const { api, nest, page, share } = await ownerDocument(primary_user, commonFunction, 'share-invite');
    await share.click();
    await expect(page.getByText(`“${DOC_TITLE}” is now public`)).toBeVisible(WRITE);
    const [made] = await links(api, nest.id);
    expect(made.show_invite).toBe(true);

    const stranger = await asStranger(browser);
    await stranger.goto(made.link);
    await expect(stranger.locator('[data-cn-cta]')).toBeVisible();

    // Manage opens the dialog on its Links tab, where the switch is.
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    const toggle = page.getByTestId(`publish-link-invite-${made.id}`);
    await expect(toggle).toHaveAttribute('aria-checked', 'true', WRITE);
    await toggle.click();
    await expect(page.getByText('“Make your own nest” removed from this link')).toBeVisible(WRITE);
    await expect.poll(async () => (await links(api, nest.id))[0].show_invite, WRITE).toBe(false);

    await stranger.reload();
    await expect(stranger.getByRole('heading', { name: DOC_TITLE })).toBeVisible();
    await expect(stranger.locator('[data-cn-cta]')).toHaveCount(0);
    expect(stranger.url()).toBe(made.link);
  });

  test('CN-SHARE-005: Verify that the public page carries link-preview tags and a Make your own nest strip that goes to sign-up', async ({
    primary_user,
    commonFunction,
    browser,
  }) => {
    const { api, nest, page, share } = await ownerDocument(primary_user, commonFunction, 'share-page');
    await share.click();
    await expect(page.getByText(`“${DOC_TITLE}” is now public`)).toBeVisible(WRITE);
    const [made] = await links(api, nest.id);
    const origin = new URL(made.link).origin;

    const stranger = await asStranger(browser);
    await stranger.goto(made.link);
    const meta = (key) => stranger.locator(`meta[property="${key}"], meta[name="${key}"]`).first().getAttribute('content');
    expect(await meta('og:title')).toBe(DOC_TITLE);
    expect(await meta('og:description')).toBe('Shared words for the preview excerpt.');
    expect(await meta('og:url')).toBe(made.link);
    expect(await meta('og:image')).toBe(`${made.link}/og-image`);
    expect(await meta('twitter:card')).toBeTruthy();
    const image = await stranger.request.get(`${made.link}/og-image`);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toContain('image/');

    // The sandboxed document view has neither the tags nor the strip.
    const view = await (await stranger.request.get(`${made.link}/view`)).text();
    expect(view).not.toContain('og:title');
    expect(view).not.toContain('ref=share');

    const cta = stranger.locator('[data-cn-cta] a');
    await expect(cta).toHaveText(/Make your own nest/);
    await expect(cta).toHaveAttribute('href', `${origin}/?ref=share`);
    await cta.click();
    await expect(stranger).toHaveURL(`${origin}/?ref=share`);
    await expect(stranger.getByTestId('login-submit-button').or(stranger.getByTestId('login-promptowl-button')).first()).toBeVisible();
  });

  test('CN-SHARE-006: Verify that a passcode link shows the gate with no document text, and that the public page fits a 390px screen', async ({
    primary_user,
    commonFunction,
    browser,
  }) => {
    const { api, nest, doc, page, share } = await ownerDocument(primary_user, commonFunction, 'share-gate');
    await share.click();
    await expect(page.getByText(`“${DOC_TITLE}” is now public`)).toBeVisible(WRITE);
    const [open] = await links(api, nest.id);
    const gated = await api.expectOk('POST', `/nests/${nest.id}/publications`, {
      node_id: doc.id,
      access_mode: 'code',
      code: 'e2e-share-code',
    });

    const phone = await asStranger(browser, { width: 390, height: 844 });
    await phone.goto(gated.link);
    await expect(phone.getByRole('heading', { name: 'Protected document' })).toBeVisible();
    const html = await phone.content();
    expect(html).not.toContain(DOC_TITLE);
    expect(html).not.toContain('Shared words');
    expect(await phone.locator('meta[property="og:title"]').getAttribute('content')).toBe('Protected document');
    await expect(phone.locator('meta[property="og:description"]')).toHaveCount(0);
    await expect(phone.locator('[data-cn-cta] a')).toBeVisible();

    await phone.goto(open.link);
    await expect(phone.locator('[data-cn-cta] a')).toBeVisible();
    const overflow = await phone.evaluate(() => document.scrollingElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
