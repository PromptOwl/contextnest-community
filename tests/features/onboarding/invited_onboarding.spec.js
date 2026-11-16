/**
 * An invited person is not a first run — CN-ONBOARD-001 … CN-ONBOARD-005
 *
 * Pages under test: Home (the nest list, or the first-run welcome screen in
 * its place: ui/src/pages/app/nests/page.tsx and WelcomeScreen.tsx) and the
 * deep-link entry in ui/src/App.tsx. PO-1391.
 *
 * The rule: a first run owns no nest and was let into nobody else's. Someone
 * invited to a nest lands on their nest list with that nest in it. Someone who
 * reaches nothing gets the welcome screen. A link to a nest or a document
 * always wins over the welcome screen.
 *
 * Conventions
 * -----------
 * - The suite makes its own two accounts, so it depends on no seeded account's
 *   onboarding state: the primary (a server admin) invites them, which returns
 *   a temporary password, and removes them at the end. One is added to a
 *   private nest as a viewer ("invited"); the other is given nothing
 *   ("newcomer") and can only read an org-visible nest.
 * - Preconditions go over REST; the UI is driven only for what is under test.
 * - Skips when the primary is not a server admin (it cannot make accounts) or
 *   the server does not serve the PO-1391 rule yet (a deployed server that
 *   predates it). CN_EXPECT_INVITED_ONBOARDING=1 turns those skips into
 *   failures.
 * - Serial: the cases share the two accounts and the invited one's session.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;

/** Sign-in and the first paint of a nest on a loaded server. */
const SLOW = { timeout: 30_000 };

/**
 * @type {{
 *   privateNest: { id: string, name: string },
 *   orgNest: { id: string, name: string },
 *   orgDoc: { id: string, title: string },
 *   invited: { id: string, email: string, password: string },
 *   newcomer: { id: string, email: string, password: string },
 * } | null}
 */
let seeded = null;
let skipReason = '';

/** A browser with no session, signed in through the login form. */
async function signedOutContext(browser) {
  return browser.newContext({ baseURL: test.info().project.use.baseURL });
}

async function signIn(page, account) {
  await page.getByTestId('login-email-input').fill(account.email);
  await page.getByTestId('login-password-input').fill(account.password);
  await page.getByTestId('login-submit-button').click();
  await expect(page.getByTestId('user-menu-trigger')).toBeVisible(SLOW);
}

test.describe('An invited person is not a first run', () => {
  test.skip(!primaryRole, 'primary_user is needed. See tests/env.template.');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ primary_user, commonFunction }) => {
    await primary_user.initialize();
    const api = primary_user.myWorkApi;

    if (!(await api.isServerAdmin())) {
      skipReason = 'The primary account is not a server admin, so it cannot make the two accounts this suite needs.';
      return;
    }
    const state = await api.request('GET', '/onboarding');
    if (!state.ok || typeof state.data?.shared_nests !== 'number') {
      skipReason = 'The server under test does not serve the invited-person onboarding rule yet (pre-PO-1391).';
      return;
    }
    if (state.data.enabled !== true) {
      skipReason = 'The Getting started screen is turned off on the server under test.';
      return;
    }

    const privateNest = await api.createNest(commonFunction.generateEntityName('invited-private'));
    const orgNest = await api.createNest(commonFunction.generateEntityName('invited-org'));
    await api.setVisibility(orgNest.id, 'org');
    const docTitle = commonFunction.generateEntityName('handbook');
    const orgDoc = await api.createDocument(orgNest.id, { title: docTitle, content: `# ${docTitle}\n\nFor everyone.\n` });

    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const invite = async (label) => {
      const email = `auto-${label}-${stamp}@example.com`;
      const made = await api.expectOk('POST', '/auth/invite', { email });
      return { id: made.user.id, email, password: made.temporary_password };
    };
    const invited = await invite('invited');
    const newcomer = await invite('newcomer');
    // A viewer: the lightest grant, and enough to be let in.
    await api.addCollaborator(privateNest.id, invited.email, 'read');

    seeded = {
      privateNest: { id: privateNest.id, name: privateNest.name },
      orgNest: { id: orgNest.id, name: orgNest.name },
      orgDoc: { id: orgDoc.id, title: docTitle },
      invited,
      newcomer,
    };
  });

  test.beforeEach(() => {
    if (process.env.CN_EXPECT_INVITED_ONBOARDING === '1') {
      expect(skipReason, skipReason).toBe('');
    }
    test.skip(!!skipReason, skipReason);
  });

  test.afterAll(async ({ primary_user }) => {
    if (!seeded) return;
    await primary_user.initialize();
    const api = primary_user.myWorkApi;
    // The nests go with the run's teardown (entity registry); the accounts are
    // this suite's own.
    for (const account of [seeded.invited, seeded.newcomer]) {
      await api.request('DELETE', `/auth/users/${account.id}`).catch(() => {});
    }
  });

  test('CN-ONBOARD-001 an invited person who owns no nest lands on the nest list, not the welcome screen @smoke', async ({
    browser,
  }) => {
    const ctx = await signedOutContext(browser);
    try {
      const page = await ctx.newPage();
      await page.goto('/');
      await signIn(page, seeded.invited);

      // The nest they were invited to is there to open, and Getting started is
      // still offered.
      await expect(page.getByText(seeded.privateNest.name).first()).toBeVisible(SLOW);
      await expect(page.getByTestId('getting-started')).toBeVisible();
      await expect(page.getByTestId('welcome-screen')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('CN-ONBOARD-002 Getting started opens the welcome screen for an invited person, and Skip returns to the nest list', async ({
    browser,
  }) => {
    const ctx = await signedOutContext(browser);
    try {
      const page = await ctx.newPage();
      await page.goto('/');
      await signIn(page, seeded.invited);
      await page.getByTestId('getting-started').click();
      await expect(page.getByTestId('welcome-screen')).toBeVisible(SLOW);

      await page.getByTestId('welcome-skip').click();
      await expect(page.getByTestId('welcome-screen')).toHaveCount(0, SLOW);
      await expect(page.getByText(seeded.privateNest.name).first()).toBeVisible(SLOW);
    } finally {
      await ctx.close();
    }
  });

  test('CN-ONBOARD-003 a person who was invited to nothing still gets the welcome screen', async ({ browser }) => {
    const ctx = await signedOutContext(browser);
    try {
      const page = await ctx.newPage();
      await page.goto('/');
      await signIn(page, seeded.newcomer);
      // They can read the org-visible nest, but nobody let them into one.
      await expect(page.getByTestId('welcome-screen')).toBeVisible(SLOW);
      await expect(page.getByTestId('getting-started')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('CN-ONBOARD-004 a link to a nest or a document wins over the welcome screen for a first run', async ({ browser }) => {
    const ctx = await signedOutContext(browser);
    try {
      const page = await ctx.newPage();
      await page.goto('/');
      await signIn(page, seeded.newcomer);
      await expect(page.getByTestId('welcome-screen')).toBeVisible(SLOW);

      // The nest.
      await page.goto(`/nest/${seeded.orgNest.id}`);
      await expect(page.getByText(seeded.orgNest.name).first()).toBeVisible(SLOW);
      await expect(page.getByTestId('welcome-screen')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/nest/${seeded.orgNest.id}`));

      // One document in it.
      await page.goto(`/nest/${seeded.orgNest.id}?doc=${encodeURIComponent(seeded.orgDoc.id)}`);
      await expect(page.getByTestId('document-editor-topbar')).toBeVisible(SLOW);
      await expect(page.getByText(seeded.orgDoc.title).first()).toBeVisible(SLOW);
      await expect(page.getByTestId('welcome-screen')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('CN-ONBOARD-005 a link to a private nest followed while signed out opens that nest after sign-in', async ({
    browser,
  }) => {
    const ctx = await signedOutContext(browser);
    try {
      const page = await ctx.newPage();
      await page.goto(`/nest/${seeded.privateNest.id}`);
      // A stranger gets the sign-in form, and nothing about the nest.
      await expect(page.getByTestId('login-email-input')).toBeVisible(SLOW);
      await signIn(page, seeded.invited);

      await expect(page).toHaveURL(new RegExp(`/nest/${seeded.privateNest.id}`), SLOW);
      await expect(page.getByText(seeded.privateNest.name).first()).toBeVisible(SLOW);
      await expect(page.getByText("This nest doesn't exist or you don't have access.")).toHaveCount(0);
      await expect(page.getByTestId('welcome-screen')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});
