/**
 * Teammates Test Suite — CN-TMATE-001 … CN-TMATE-011
 *
 * Page under test: ui/src/pages/app/teammates/page.tsx (route `/teammates`,
 * rail → Admin → Teammates), with its Add Teammate, invite result, reset
 * password and confirm dialogs.
 *
 * Conventions
 * -----------
 * - The page is for server admins: the primary account runs every case but
 *   CN-TMATE-001, which needs a second account that is not one.
 * - Reads run against the real directory where the case is about what the
 *   server holds (CN-TMATE-002 checks the real list against the list the page
 *   itself received).
 * - Every write on this page acts on a real account — inviting creates one,
 *   Reset password replaces someone's password, Grant / Revoke change who is a
 *   server admin, and Remove deletes an account. On a shared server those
 *   would act on real people, so those cases are driven through
 *   `src/lib/teammates_stubs.js`: the real UI, against the real response
 *   shapes, with every write recorded so the test can check exactly what the
 *   page asked the server to do. The rosters they need (invited users, granted
 *   admins, stewards without an account) come from the same stub. Each such
 *   test says so.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { teammate, superAdmin, serverTimeAgo, stubTeammates, stubShareNest } from '../../src/lib/teammates_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * A small directory around the signed-in admin: the caller (a super admin),
 * a granted admin, two registered members and an invited member.
 */
function roster(myEmail) {
  return {
    teammates: [
      teammate(myEmail, { name: 'QA Admin', is_admin: true, key_count: 3, last_active: serverTimeAgo(10 * 1000) }),
      teammate('grace.granted@example.com', { name: 'Grace Granted', is_admin: true, key_count: 1, last_active: serverTimeAgo(3 * HOUR) }),
      teammate('mary.member@example.com', { name: 'Mary Member', key_count: 0, last_active: serverTimeAgo(5 * MIN) }),
      teammate('bob.builder@example.com', { name: 'Bob Builder', key_count: 2, last_active: serverTimeAgo(2 * DAY) }),
      teammate('ivy.invited@example.com', { is_invited: 1 }),
    ],
    super_admins: [superAdmin(myEmail, { source: 'license', self: true }), superAdmin('grace.granted@example.com')],
  };
}

/** Open Teammates for the primary account; skips when it isn't a server admin. */
async function openAsAdmin(role) {
  await role.initialize();
  test.skip(!(await role.teammatesApi.isServerAdmin()), `${role.roleInfo?.email ?? 'primary_user'} is not a server admin on this server.`);
  return role;
}

test.describe('Teammates', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test('CN-TMATE-001: non admins see no rail row and are redirected to Nests by direct URL', async ({
    secondary_user,
  }) => {
    test.skip(!secondaryRole, 'secondary_user is not configured. See tests/env.template.');
    await secondary_user.initialize();
    test.skip(await secondary_user.teammatesApi.isServerAdmin(), 'secondary_user is a server admin on this server, so it is not a non-admin.');
    const { page, nestsPage, teammatesPage: tm } = secondary_user;

    // No rail row: the rail is drawn (Teams is there), Teammates isn't.
    await nestsPage.goto();
    await expect(page.getByTestId('document-sidebar-dashboard-teams')).toBeVisible();
    await expect(tm.railItem).toHaveCount(0);
    await expect(page.getByTestId('document-sidebar-dashboard-settings')).toHaveCount(0);

    // Direct URL: the Nests page is shown instead, and nothing of Teammates.
    await page.goto('/teammates');
    await expect(tm.pageTitle).toContainText('Nests');
    await expect(tm.pageTitle).not.toContainText('Teammates');
    await expect(tm.inviteButton).toHaveCount(0);
    await expect(page.getByText('All Users', { exact: true })).toHaveCount(0);
    await expect(tm.railItem).toHaveCount(0);

    // And the directory itself stays closed to them.
    const res = await secondary_user.teammatesApi.request('GET', '/auth/teammates');
    expect(res.status, 'GET /auth/teammates as a non-admin').toBe(403);
  });

  test('CN-TMATE-002: the All Users list shows You/Admin/Invited badges, key count and last active', async ({
    primary_user,
  }) => {
    await openAsAdmin(primary_user);
    const { page, nestsPage, teammatesPage: tm } = primary_user;

    // ── The real directory, as the page received it ──
    await nestsPage.goto();
    await expect(tm.railItem).toBeVisible();
    const { teammates } = await tm.gotoAndReadTeammates(() => tm.railItem.click());
    await expect(tm.pageTitle).toContainText('Teammates');
    await expect(page.getByText('All Users', { exact: true })).toBeVisible();
    await expect(tm.rows).toHaveCount(teammates.length);

    // The caller's own row: You + Admin (a server admin is always one).
    const me = teammates.find((t) => t.email.toLowerCase() === primaryRole.email.toLowerCase());
    expect(me, 'the signed-in admin should be in the directory').toBeTruthy();
    await expect(tm.rowBadge(me.email, 'You')).toBeVisible();
    await expect(tm.rowBadge(me.email, 'Admin')).toBeVisible();
    await expect(tm.page.locator('main').getByText('You', { exact: true })).toHaveCount(1);

    // Every row: badges, key count and last active exactly as the server says.
    const unique = teammates.filter((t) => teammates.filter((o) => o.email.toLowerCase() === t.email.toLowerCase()).length === 1);
    for (const t of unique) {
      const label = `row for ${t.email}`;
      await expect(tm.rowBadge(t.email, 'Admin'), label).toHaveCount(t.is_admin ? 1 : 0);
      await expect(tm.rowBadge(t.email, 'Invited'), label).toHaveCount(t.is_invited ? 1 : 0);
      await expect(tm.rowMeta(t.email), label).toContainText(`${t.key_count} key${t.key_count !== 1 ? 's' : ''}`);
      if (t.last_active) await expect(tm.rowMeta(t.email), label).toContainText('last active');
      else await expect(tm.rowMeta(t.email), label).not.toContainText('last active');
    }

    // ── Every badge and format, on a known roster (stubbed: the real
    // directory may have no invited user, and its times are whatever they are) ──
    await stubTeammates(page, roster(primaryRole.email));
    await tm.goto();
    await expect(tm.rows).toHaveCount(5);
    const mine = primaryRole.email;
    await expect(tm.rowName(mine)).toHaveText('QA Admin');
    await expect(tm.rowBadge(mine, 'You')).toBeVisible();
    await expect(tm.rowBadge(mine, 'Admin')).toBeVisible();
    await expect(tm.rowMeta(mine)).toContainText('3 keys');
    await expect(tm.rowMeta(mine)).toContainText('last active Just now');

    await expect(tm.rowBadge('grace.granted@example.com', 'You')).toHaveCount(0);
    await expect(tm.rowBadge('grace.granted@example.com', 'Admin')).toBeVisible();
    await expect(tm.rowMeta('grace.granted@example.com')).toContainText(/(^|[^0-9])1 key(?!s)/);
    await expect(tm.rowMeta('grace.granted@example.com')).toContainText('last active 3h ago');

    await expect(tm.rowBadge('mary.member@example.com', 'Admin')).toHaveCount(0);
    await expect(tm.rowMeta('mary.member@example.com')).toContainText('0 keys');
    await expect(tm.rowMeta('mary.member@example.com')).toContainText('last active 5m ago');
    await expect(tm.rowMeta('bob.builder@example.com')).toContainText('2 keys');
    await expect(tm.rowMeta('bob.builder@example.com')).toContainText('last active 2d ago');

    // Invited, never active: the email stands in for the name, no "last active".
    const ivy = 'ivy.invited@example.com';
    await expect(tm.rowName(ivy)).toHaveText(ivy);
    await expect(tm.rowBadge(ivy, 'Invited')).toBeVisible();
    await expect(tm.rowBadge(ivy, 'Admin')).toHaveCount(0);
    await expect(tm.rowMeta(ivy)).toContainText('0 keys');
    await expect(tm.rowMeta(ivy)).not.toContainText('last active');
  });

  test('CN-TMATE-003: users can be searched by name or email', async ({ primary_user }) => {
    // Stubbed roster: the search runs in the browser over the list it read, so
    // a known list makes every match checkable.
    await openAsAdmin(primary_user);
    const { page, teammatesPage: tm } = primary_user;
    await stubTeammates(page, roster(primaryRole.email));
    await tm.goto();
    await expect(tm.rows).toHaveCount(5);

    // By name (part of it, any case).
    await tm.searchInput.fill('mary');
    await expect(tm.rows).toHaveCount(1);
    await expect(tm.row('mary.member@example.com')).toBeVisible();
    await tm.searchInput.fill('BUILDER');
    await expect(tm.rows).toHaveCount(1);
    await expect(tm.row('bob.builder@example.com')).toBeVisible();

    // By email (part of it), including a user with no name.
    await tm.searchInput.fill('ivy.inv');
    await expect(tm.rows).toHaveCount(1);
    await expect(tm.row('ivy.invited@example.com')).toBeVisible();
    await tm.searchInput.fill('@example.com');
    const expected = roster(primaryRole.email).teammates.filter((t) => t.email.includes('@example.com')).length;
    await expect(tm.rows).toHaveCount(expected);

    // Surrounding spaces are ignored; no match says so.
    await tm.searchInput.fill('  grace  ');
    await expect(tm.rows).toHaveCount(1);
    await expect(tm.row('grace.granted@example.com')).toBeVisible();
    await tm.searchInput.fill('nobody-by-this-name');
    await expect(tm.rows).toHaveCount(0);
    await expect(tm.noMatch).toBeVisible();

    // Clearing brings everyone back.
    await tm.searchInput.fill('');
    await expect(tm.noMatch).toHaveCount(0);
    await expect(tm.rows).toHaveCount(5);
  });

  test('CN-TMATE-004: the role filter (All/Superadmins/Members) works with a no-match message', async ({
    primary_user,
  }) => {
    // Stubbed roster: two super admins and three members, so each filter has
    // a known answer.
    await openAsAdmin(primary_user);
    const { page, teammatesPage: tm } = primary_user;
    await stubTeammates(page, roster(primaryRole.email));
    await tm.goto();

    // All is the default.
    await expect(tm.filterAll).toHaveClass(/bg-primary/);
    await expect(tm.rows).toHaveCount(5);

    await tm.filterSuperadmins.click();
    await expect(tm.filterSuperadmins).toHaveClass(/bg-primary/);
    await expect(tm.filterAll).not.toHaveClass(/bg-primary/);
    await expect(tm.rows).toHaveCount(2);
    await expect(tm.row(primaryRole.email)).toBeVisible();
    await expect(tm.row('grace.granted@example.com')).toBeVisible();

    await tm.filterMembers.click();
    await expect(tm.filterMembers).toHaveClass(/bg-primary/);
    await expect(tm.rows).toHaveCount(3);
    for (const email of ['mary.member@example.com', 'bob.builder@example.com', 'ivy.invited@example.com']) {
      await expect(tm.row(email)).toBeVisible();
    }
    await expect(tm.row('grace.granted@example.com')).toHaveCount(0);

    // Filter and search combine; nothing left → the no-match message.
    await tm.searchInput.fill('grace');
    await expect(tm.rows).toHaveCount(0);
    await expect(tm.noMatch).toBeVisible();
    await tm.filterSuperadmins.click();
    await expect(tm.noMatch).toHaveCount(0);
    await expect(tm.rows).toHaveCount(1);
    await expect(tm.row('grace.granted@example.com')).toBeVisible();

    await tm.searchInput.fill('');
    await tm.filterAll.click();
    await expect(tm.rows).toHaveCount(5);
  });

  test('CN-TMATE-005: inviting a teammate shows a one-time temporary password', async ({
    primary_user,
    commonFunction,
  }) => {
    // Stubbed write: a real invite creates an account on the server.
    await openAsAdmin(primary_user);
    const { page, teammatesPage: tm } = primary_user;
    const email = `${commonFunction.generateEntityName('invite').toLowerCase()}@example.com`;
    const { calls } = await stubTeammates(page, roster(primaryRole.email), { tempPassword: 'Stub-Temp-Pass-005' });
    await tm.goto();

    await tm.openInvite();
    await expect(tm.inviteDialog).toContainText('temporary password');
    // Nothing to send until there's an email.
    await expect(tm.inviteSubmit).toBeDisabled();
    await tm.inviteEmail.fill(email);
    await expect(tm.inviteSubmit).toBeEnabled();
    await tm.inviteSubmit.click();

    // The page asked for exactly this invite…
    await expect.poll(() => calls.filter((c) => c.path === '/auth/invite').length).toBe(1);
    expect(calls.find((c) => c.path === '/auth/invite').body).toEqual({ email });

    // …and shows the password once.
    await expect(tm.inviteDialog).toHaveCount(0);
    await expect(tm.resultDialog).toBeVisible();
    await expect(tm.resultDialog).toContainText(`Teammate added: ${email}`);
    await expect(tm.resultPassword).toHaveText('Stub-Temp-Pass-005');
    await expect(tm.resultDialog).toContainText("It won't be shown again.");
    await expect(tm.resultDialog).toContainText('Send them this temporary password');

    await tm.resultDone.click();
    await expect(tm.resultDialog).toHaveCount(0);
    // The new teammate is listed as invited, and the password is gone for good.
    await expect(tm.row(email)).toBeVisible();
    await expect(tm.rowBadge(email, 'Invited')).toBeVisible();
    await expect(page.getByText('Stub-Temp-Pass-005')).toHaveCount(0);
    await page.reload();
    await expect(tm.row(email)).toBeVisible();
    await expect(page.getByText('Stub-Temp-Pass-005')).toHaveCount(0);
  });

  test('CN-TMATE-006: the invite result offers sharing a nest with the new user', async ({
    primary_user,
    commonFunction,
  }) => {
    // Stubbed writes: the invite (creates an account) and the share (sharing
    // with an address that has no account creates a placeholder one). The
    // nest is real, so the picker lists what the admin can actually share.
    await openAsAdmin(primary_user);
    const { page, teammatesPage: tm, dashboardApi } = primary_user;
    const nestName = commonFunction.generateEntityName('share-nest');
    const nest = await dashboardApi.createNest(nestName);
    const email = `${commonFunction.generateEntityName('share').toLowerCase()}@example.com`;
    await stubTeammates(page, roster(primaryRole.email));
    const shares = await stubShareNest(page, email);
    await tm.goto();

    await tm.openInvite();
    await tm.inviteEmail.fill(email);
    await tm.inviteSubmit.click();
    await expect(tm.resultDialog).toBeVisible();

    // The offer: a new teammate has no nests yet.
    await expect(tm.resultDialog).toContainText('This person has no nests yet. Share one?');
    await expect(tm.shareNestSelect).toBeVisible();
    await expect(tm.shareButton).toBeDisabled();
    await expect(tm.shareNestSelect.locator('option', { hasText: nestName })).toHaveCount(1);
    await expect(tm.shareLevelSelect).toHaveValue('read');

    await tm.shareNestSelect.selectOption(nest.id);
    await tm.shareLevelSelect.selectOption('write');
    await expect(tm.shareButton).toBeEnabled();
    await tm.shareButton.click();

    // Shared with exactly that nest, at that level…
    await expect.poll(() => shares.length).toBe(1);
    expect(shares[0].path).toBe(`/nests/${nest.id}/collaborators`);
    expect(shares[0].body).toEqual({ email, permission: 'write' });

    // …and the result says so, then offers another.
    await expect(tm.resultDialog).toContainText('Shared with them');
    const sharedRow = tm.resultDialog.locator('li').filter({ hasText: nestName });
    await expect(sharedRow).toBeVisible();
    await expect(sharedRow).toContainText('Can edit');
    await expect(tm.resultDialog).toContainText('Share another nest?');
    await expect(tm.shareNestSelect.locator('option', { hasText: nestName })).toHaveCount(0);

    await tm.resultDone.click();
    await expect(tm.resultDialog).toHaveCount(0);
  });

  test("CN-TMATE-007: resetting a user's password shows a copyable temporary password", async ({
    primary_user,
  }) => {
    // Stubbed write: a real reset replaces the user's password.
    await openAsAdmin(primary_user);
    await primary_user.context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    const { page, teammatesPage: tm } = primary_user;
    const state = roster(primaryRole.email);
    const { calls } = await stubTeammates(page, state, { tempPassword: 'Stub-Reset-007' });
    await tm.goto();

    const mary = state.teammates.find((t) => t.email === 'mary.member@example.com');
    // Admins' rows carry no reset; members' (invited ones too) do.
    await expect(tm.rowReset(primaryRole.email)).toHaveCount(0);
    await expect(tm.rowReset('grace.granted@example.com')).toHaveCount(0);
    await expect(tm.rowReset('ivy.invited@example.com')).toBeVisible();

    await tm.rowReset(mary.email).click();
    await expect(tm.resetPanel).toBeVisible();
    await expect(tm.resetPassword).toHaveText('Stub-Reset-007-1');
    await expect(tm.resetPanel).toContainText(`Share this with ${mary.email} directly`);
    await expect(tm.resetPanel).toContainText("It won't be shown again.");
    expect(calls.filter((c) => c.path.startsWith('/auth/admin/reset-password/')).map((c) => c.path)).toEqual([
      `/auth/admin/reset-password/${encodeURIComponent(mary.id)}`,
    ]);
    // While the panel is open, no second reset can start.
    await expect(tm.rowReset('bob.builder@example.com')).toBeDisabled();

    // Copy: the button confirms, a toast says so, and the clipboard holds it.
    await tm.resetCopy.click();
    await expect(tm.resetCopy).toHaveText('Copied');
    await expect(tm.toast('Temporary password copied')).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    if (clip !== null) expect(clip).toBe('Stub-Reset-007-1');
    await expect(tm.resetCopy).toHaveText('Copy', { timeout: 5000 });

    await tm.resetDone.click();
    await expect(tm.resetPanel).toHaveCount(0);
    await expect(page.getByText('Stub-Reset-007-1')).toHaveCount(0);
    await expect(tm.rowReset('bob.builder@example.com')).toBeEnabled();
  });

  test('CN-TMATE-008: superadmin can be granted (not offered for invited users)', async ({ primary_user }) => {
    // Stubbed write: a real grant makes a real person a server admin.
    await openAsAdmin(primary_user);
    const { page, teammatesPage: tm } = primary_user;
    const { calls } = await stubTeammates(page, roster(primaryRole.email));
    await tm.goto();

    const mary = 'mary.member@example.com';
    // Offered to registered members only: not to invited users, not to admins.
    await expect(tm.rowGrant(mary)).toBeVisible();
    await expect(tm.rowGrant('bob.builder@example.com')).toBeVisible();
    await expect(tm.rowGrant('ivy.invited@example.com')).toHaveCount(0);
    await expect(tm.rowGrant('grace.granted@example.com')).toHaveCount(0);
    await expect(tm.rowGrant(primaryRole.email)).toHaveCount(0);

    // Cancel changes nothing.
    await tm.rowGrant(mary).click();
    await expect(tm.grantDialog).toBeVisible();
    await expect(tm.grantDialog).toContainText(`Grant superadmin to ${mary}?`);
    await expect(tm.grantDialog).toContainText('server-admin access everywhere');
    await tm.grantDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(tm.grantDialog).toHaveCount(0);
    expect(calls.filter((c) => c.path === '/admin/super-admins')).toHaveLength(0);
    await expect(tm.rowBadge(mary, 'Admin')).toHaveCount(0);

    // Grant: the page asks for exactly that user, and the row becomes an admin.
    await tm.rowGrant(mary).click();
    await tm.grantDialog.getByRole('button', { name: 'Grant', exact: true }).click();
    await expect(tm.grantDialog).toHaveCount(0);
    expect(calls.filter((c) => c.path === '/admin/super-admins').map((c) => [c.method, c.body])).toEqual([
      ['POST', { email: mary }],
    ]);
    await expect(tm.rowBadge(mary, 'Admin')).toBeVisible();
    await expect(tm.rowGrant(mary)).toHaveCount(0);
    await expect(tm.rowRevoke(mary)).toBeVisible();
    await expect(tm.rowReset(mary)).toHaveCount(0);
    await expect(tm.rowRemove(mary)).toHaveCount(0);
    await tm.filterSuperadmins.click();
    await expect(tm.row(mary)).toBeVisible();
  });

  test('CN-TMATE-009: superadmin can be revoked only from granted admins and never yourself', async ({
    primary_user,
  }) => {
    // Stubbed directory and write: admins from every source (licence, config
    // file, granted — including the caller), and a real revoke would demote a
    // real person.
    await openAsAdmin(primary_user);
    const { page, teammatesPage: tm } = primary_user;
    const state = {
      teammates: [
        teammate(primaryRole.email, { name: 'QA Admin', is_admin: true }),
        teammate('lena.license@example.com', { name: 'Lena License', is_admin: true }),
        teammate('carl.config@example.com', { name: 'Carl Config', is_admin: true }),
        teammate('grace.granted@example.com', { name: 'Grace Granted', is_admin: true }),
        teammate('mary.member@example.com', { name: 'Mary Member' }),
      ],
      super_admins: [
        superAdmin(primaryRole.email, { source: 'granted', self: true }),
        superAdmin('lena.license@example.com', { source: 'license' }),
        superAdmin('carl.config@example.com', { source: 'config' }),
        superAdmin('grace.granted@example.com', { source: 'granted' }),
      ],
    };
    const { calls } = await stubTeammates(page, state);
    await tm.goto();
    await expect(tm.rows).toHaveCount(5);

    // Only the granted admin who isn't you can be revoked.
    await expect(tm.rowRevoke('grace.granted@example.com')).toBeVisible();
    await expect(tm.rowRevoke(primaryRole.email)).toHaveCount(0);
    await expect(tm.rowRevoke('lena.license@example.com')).toHaveCount(0);
    await expect(tm.rowRevoke('carl.config@example.com')).toHaveCount(0);
    await expect(tm.rowRevoke('mary.member@example.com')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revoke superadmin', exact: true })).toHaveCount(1);

    // Cancel changes nothing.
    const grace = 'grace.granted@example.com';
    await tm.rowRevoke(grace).click();
    await expect(tm.revokeDialog).toContainText(`Revoke superadmin from ${grace}?`);
    await expect(tm.revokeDialog).toContainText('They immediately lose server-admin access');
    await tm.revokeDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(tm.revokeDialog).toHaveCount(0);
    expect(calls.filter((c) => c.path.startsWith('/admin/super-admins/'))).toHaveLength(0);

    // Revoke: exactly that admin; the row goes back to a member.
    await tm.rowRevoke(grace).click();
    await tm.revokeDialog.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(tm.revokeDialog).toHaveCount(0);
    expect(calls.filter((c) => c.path.startsWith('/admin/super-admins/')).map((c) => [c.method, c.path])).toEqual([
      ['DELETE', `/admin/super-admins/${encodeURIComponent(grace)}`],
    ]);
    await expect(tm.rowBadge(grace, 'Admin')).toHaveCount(0);
    await expect(tm.rowRevoke(grace)).toHaveCount(0);
    await expect(tm.rowGrant(grace)).toBeVisible();
    // You are still an admin, and still can't revoke yourself.
    await expect(tm.rowBadge(primaryRole.email, 'Admin')).toBeVisible();
    await expect(tm.rowRevoke(primaryRole.email)).toHaveCount(0);
  });

  test('CN-TMATE-010: removing a user requires destructive confirmation and revokes access', async ({
    primary_user,
  }) => {
    // Stubbed write: a real removal deletes a real account.
    await openAsAdmin(primary_user);
    const { page, teammatesPage: tm } = primary_user;
    const state = roster(primaryRole.email);
    const { calls } = await stubTeammates(page, state);
    await tm.goto();

    const bob = state.teammates.find((t) => t.email === 'bob.builder@example.com');
    // Admins (you included) can't be removed from here.
    await expect(tm.rowRemove(primaryRole.email)).toHaveCount(0);
    await expect(tm.rowRemove('grace.granted@example.com')).toHaveCount(0);
    await expect(tm.rowRemove('ivy.invited@example.com')).toBeVisible();

    // The confirmation spells out what removal revokes.
    await tm.rowRemove(bob.email).click();
    await expect(tm.removeDialog).toBeVisible();
    await expect(tm.removeDialog).toContainText(`Remove ${bob.email}?`);
    await expect(tm.removeDialog).toContainText('API keys, sessions, steward');
    await expect(tm.removeDialog).toContainText('This cannot be undone.');
    const confirm = tm.removeDialog.getByRole('button', { name: 'Remove', exact: true });
    await expect(confirm).toHaveClass(/destructive/);

    // Cancel and Escape change nothing.
    await tm.removeDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(tm.removeDialog).toHaveCount(0);
    await tm.rowRemove(bob.email).click();
    await page.keyboard.press('Escape');
    await expect(tm.removeDialog).toHaveCount(0);
    expect(calls.filter((c) => c.path.startsWith('/auth/users/'))).toHaveLength(0);
    await expect(tm.row(bob.email)).toBeVisible();

    // Confirm: the account is removed and the row goes.
    await tm.rowRemove(bob.email).click();
    await confirm.click();
    await expect(tm.removeDialog).toHaveCount(0);
    expect(calls.filter((c) => c.path.startsWith('/auth/users/')).map((c) => [c.method, c.path])).toEqual([
      ['DELETE', `/auth/users/${encodeURIComponent(bob.id)}`],
    ]);
    await expect(tm.row(bob.email)).toHaveCount(0);
    await expect(tm.rows).toHaveCount(4);
    await page.reload();
    await expect(tm.row(bob.email)).toHaveCount(0);
  });

  test('CN-TMATE-011: "Stewards without server access" offers a prefilled Invite', async ({
    primary_user,
  }) => {
    // Stubbed directory and write: a steward email with no account (assigning
    // a steward creates a placeholder account, so it can't be arranged for
    // real), and the invite itself creates one.
    await openAsAdmin(primary_user);
    const { page, teammatesPage: tm } = primary_user;
    const steward = 'sam.steward@example.com';
    const state = { ...roster(primaryRole.email), pending_stewards: [steward, 'pat.pending@example.com'] };
    const { calls } = await stubTeammates(page, state, { tempPassword: 'Stub-Steward-011' });
    await tm.goto();

    await expect(tm.pendingHeading).toBeVisible();
    await expect(page.getByText(/haven't registered to this server yet/)).toBeVisible();
    await expect(tm.pendingRow(steward)).toContainText('Assigned as steward · not registered yet');
    await expect(tm.pendingRow('pat.pending@example.com')).toBeVisible();
    // They aren't users yet.
    await expect(tm.row(steward)).toHaveCount(0);

    // Invite opens the Add Teammate modal with their email already in.
    await tm.pendingInvite(steward).click();
    await expect(tm.inviteDialog).toBeVisible();
    await expect(tm.inviteEmail).toHaveValue(steward);
    await expect(tm.inviteSubmit).toBeEnabled();
    // Cancelling and opening the header invite starts empty again.
    await tm.inviteCancel.click();
    await expect(tm.inviteDialog).toHaveCount(0);
    await tm.openInvite();
    await expect(tm.inviteEmail).toHaveValue('');
    await tm.inviteCancel.click();

    await tm.pendingInvite(steward).click();
    await tm.inviteSubmit.click();
    await expect(tm.resultDialog).toContainText(`Teammate added: ${steward}`);
    await expect(tm.resultPassword).toHaveText('Stub-Steward-011');
    expect(calls.filter((c) => c.path === '/auth/invite').map((c) => c.body)).toEqual([{ email: steward }]);
    await tm.resultDone.click();

    // Now a user (invited), no longer waiting; the other steward still is.
    await expect(tm.row(steward)).toBeVisible();
    await expect(tm.rowBadge(steward, 'Invited')).toBeVisible();
    await expect(tm.pendingRow(steward)).toHaveCount(0);
    await expect(tm.pendingRow('pat.pending@example.com')).toBeVisible();
  });
});
