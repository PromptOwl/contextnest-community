/**
 * Teams Test Suite — CN-TEAM-001 … CN-TEAM-005
 *
 * Page under test: ui/src/pages/app/teams/page.tsx (route `/teams`), plus its
 * create modal and, with the PromptOwl Teams feature on, the PromptOwl Teams
 * tab (ui/src/components/PromptowlTeamsPanel.tsx).
 *
 * Conventions
 * -----------
 * - Teams are made through the REST API via `role.teamsApi` (and through the
 *   UI where creating one is the behaviour under test). Teams are not in the
 *   entity registry, so the helper remembers each one and the suite deletes
 *   them after every test. Every name is an AUTO_ name.
 * - The account's team list is not assumed to be otherwise empty: counts are
 *   asserted against the list the page itself received.
 * - A few states cannot be arranged from a real account — the loading
 *   spinner, the empty and failed list, a roster of invited placeholders, and
 *   the PromptOwl Teams feature switched on or off. Those are driven through
 *   `src/lib/teams_stubs.js`, which serves the real response shape to the
 *   real UI. Each such test says so.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import {
  member,
  teamRow,
  stubTeams,
  holdTeams,
  stubPromptowlTeamsFlag,
  stubPromptowlTeams,
} from '../../src/lib/teams_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

/**
 * How long a write may take to land. On nest-dev a write answers in seconds;
 * locally well under one. Only the first check after a write waits this long.
 */
const WRITE = { timeout: 30_000 };

/**
 * Hover `target` until the tooltip carrying `text` opens. Radix keeps the
 * previous tooltip mounted while it animates closed, so each attempt first
 * moves the pointer away and lets that one go.
 */
async function hoverForTooltip(page, target, text) {
  const tip = page.getByRole('tooltip').filter({ hasText: text });
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.mouse.move(0, 0);
    await page.getByRole('tooltip').first().waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    await target.hover();
    if (await tip.first().isVisible().catch(() => false)) return tip;
    if (await tip.first().waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false)) return tip;
  }
  return tip;
}

test.describe('Teams', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  // Teams this test made — deleted afterwards, whatever happened.
  let teamsApi = null;
  test.afterEach(async () => {
    if (teamsApi) await teamsApi.deleteCreatedTeams().catch(() => {});
    teamsApi = null;
  });

  test('CN-TEAM-001: the Teams page lists team cards with member counts', async ({
    primary_user,
    commonFunction,
  }) => {
    await primary_user.initialize();
    const { teamsPage: teams } = primary_user;
    teamsApi = primary_user.teamsApi;
    const name = commonFunction.generateEntityName('team-list');
    const team = await teamsApi.createTeam(name);
    // A real member, so the card has a roster to count (only when a second
    // account exists — an unknown address would leave a placeholder account).
    if (secondaryRole) await teamsApi.addMember(team.id, secondaryRole.email, 'editor');

    await primary_user.nestsPage.goto();
    await expect(teams.railItem).toBeVisible();
    const { teams: listed } = await teams.gotoAndReadTeams(() => teams.railItem.click());
    await expect(teams.railItem).toHaveAttribute('aria-current', 'page');
    await expect(teams.pageTitle).toContainText('Teams');
    await expect(teams.newTeam).toBeVisible();

    // One card per team the page received, each counting its own roster.
    await expect(teams.cards).toHaveCount(listed.length);
    const unique = listed.filter((t) => listed.filter((o) => o.name === t.name).length === 1);
    for (const t of unique) {
      await expect(teams.cardCount(t.name), `count on "${t.name}"`).toHaveText(String(t.members.length));
    }

    // Our team: its name, its count, who made it, and its member.
    const mine = listed.find((t) => t.id === team.id);
    expect(mine, 'the new team should be in the list the page read').toBeTruthy();
    const card = teams.card(name);
    await expect(card).toBeVisible();
    await expect(teams.cardCount(name)).toHaveText(secondaryRole ? '1' : '0');
    await expect(card).toContainText(`Created by ${primaryRole.email}`);
    if (secondaryRole) {
      await expect(teams.cardMember(name, secondaryRole.email)).toContainText('Editor');
    } else {
      await expect(card).toContainText('No members yet.');
    }
    await expect(teams.cardEdit(name)).toBeVisible();
    await expect(teams.cardDelete(name)).toBeVisible();
  });

  test('CN-TEAM-002: the loading, empty and error states display correctly', async ({
    primary_user,
  }) => {
    // Forced states: the read resolves too fast to see the spinner, the test
    // account owns teams, and a real read doesn't fail on demand.
    await primary_user.initialize();
    const { page, teamsPage: teams } = primary_user;

    // ── Loading, then empty ──
    const release = await holdTeams(page, { teams: [] });
    await teams.goto();
    await expect(teams.loader).toBeVisible();
    await expect(teams.emptyState).toHaveCount(0);
    await expect(teams.cards).toHaveCount(0);

    release();
    await expect(teams.emptyState).toBeVisible();
    await expect(teams.loader).toHaveCount(0);
    await expect(teams.cards).toHaveCount(0);
    await expect(teams.errorAlert).toHaveCount(0);
    // Creating a team is still on offer from an empty list.
    await expect(teams.newTeam).toBeVisible();

    // ── Error ──
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubTeams(page, { status: 500, body: { error: 'Teams are temporarily unavailable' } });
    await page.reload();
    await expect(teams.errorAlert).toBeVisible();
    await expect(teams.errorAlert).toContainText('Teams are temporarily unavailable');
    await expect(teams.loader).toHaveCount(0);
    await expect(teams.cards).toHaveCount(0);
  });

  test('CN-TEAM-003: a card shows up to 5 members with status icons and a "+N more" tooltip', async ({
    primary_user,
  }) => {
    // Forced roster: invited members are placeholder accounts the server
    // creates on add, which a test shouldn't leave behind on a shared server.
    await primary_user.initialize();
    const { page, teamsPage: teams } = primary_user;
    const big = teamRow({
      name: 'Stub team seven',
      owner_email: primaryRole.email,
      members: [
        member('reg-one@example.com', { role: 'admin' }),
        member('inv-two@example.com', { role: 'editor', registered: false }),
        member('reg-three@example.com'),
        member('inv-four@example.com', { registered: false }),
        member('reg-five@example.com', { role: 'editor' }),
        member('reg-six@example.com', { role: 'viewer' }),
        member('inv-seven@example.com', { role: 'admin', registered: false }),
      ],
    });
    const six = teamRow({
      name: 'Stub team six',
      owner_email: primaryRole.email,
      members: ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => member(`six-${x}@example.com`)),
    });
    const five = teamRow({
      name: 'Stub team five',
      owner_email: primaryRole.email,
      members: ['a', 'b', 'c', 'd', 'e'].map((x) => member(`five-${x}@example.com`)),
    });
    await stubTeams(page, { body: { teams: [big, six, five] } });

    await teams.goto();
    await expect(teams.cards).toHaveCount(3);

    // Seven members: the count says 7, five are listed in order, two wait behind "+2 more".
    await expect(teams.cardCount('Stub team seven')).toHaveText('7');
    await expect(teams.cardMembers('Stub team seven')).toHaveCount(5);
    for (const m of big.members.slice(0, 5)) {
      await expect(teams.cardMember('Stub team seven', m.email)).toBeVisible();
    }
    await expect(teams.cardMember('Stub team seven', 'reg-six@example.com')).toHaveCount(0);
    await expect(teams.cardMember('Stub team seven', 'reg-one@example.com')).toContainText('Admin');

    // Status icons: green for a registered account, red for an invite.
    await expect(teams.memberStatus('Stub team seven', 'reg-one@example.com')).toHaveClass(/text-green-600/);
    await expect(teams.memberStatus('Stub team seven', 'inv-two@example.com')).toHaveClass(/text-red-500/);
    await expect(await hoverForTooltip(page, teams.memberStatus('Stub team seven', 'reg-one@example.com'), 'Registered account')).toBeVisible();
    await expect(await hoverForTooltip(page, teams.memberStatus('Stub team seven', 'inv-two@example.com'), "Invited — hasn't signed up yet")).toBeVisible();

    // "+2 more members": hovering lists the rest with their roles and status.
    const more = teams.cardOverflow('Stub team seven');
    await expect(more).toHaveText('+2 more members');
    const tip = await hoverForTooltip(page, more, 'inv-seven@example.com');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('reg-six@example.com');
    await expect(tip).toContainText('· Viewer');
    await expect(tip).toContainText('· Admin');
    await expect(tip.locator('svg.text-green-600')).toHaveCount(1);
    await expect(tip.locator('svg.text-red-500')).toHaveCount(1);
    await page.mouse.move(0, 0);

    // Six members: "+1 more member" (singular). Five: no overflow at all.
    await expect(teams.cardOverflow('Stub team six')).toHaveText('+1 more member');
    await expect(teams.cardMembers('Stub team five')).toHaveCount(5);
    await expect(teams.cardOverflow('Stub team five')).toHaveCount(0);
  });

  test('CN-TEAM-004: a team can be created with a name only', async ({
    primary_user,
    commonFunction,
  }) => {
    await primary_user.initialize();
    const { teamsPage: teams } = primary_user;
    teamsApi = primary_user.teamsApi;
    const name = commonFunction.generateEntityName('team-new');

    await teams.goto();
    await teams.openCreate();
    await expect(teams.createDialog).toContainText('Members (optional)');
    // No name, no team.
    await expect(teams.createSubmit).toBeDisabled();
    await teams.createName.fill('   ');
    await expect(teams.createSubmit).toBeDisabled();

    await teams.createName.fill(name);
    await expect(teams.createSubmit).toBeEnabled();
    await teams.createSubmit.click();

    await expect(teams.toast(`Team "${name}" created`)).toBeVisible(WRITE);
    await expect(teams.createDialog).toHaveCount(0);
    const card = teams.card(name);
    await expect(card).toBeVisible();
    await expect(teams.cardCount(name)).toHaveText('0');
    await expect(card).toContainText('No members yet.');
    await expect(card).toContainText(`Created by ${primaryRole.email}`);

    // Real, and empty: just the name and its owner.
    const created = (await teamsApi.listTeams()).teams.find((t) => t.name === name);
    expect(created, 'the team should exist on the server').toBeTruthy();
    teamsApi.track(created.id);
    expect(created.members).toHaveLength(0);
    expect(created.owner_email?.toLowerCase()).toBe(primaryRole.email.toLowerCase());
  });

  test('CN-TEAM-005: the PromptOwl Teams feature shows its tab only when enabled', async ({
    primary_user,
  }) => {
    // Forced flag: PROMPTOWL_TEAMS_ENABLED is a server setting, and the
    // PromptOwl side is a call out to PromptOwl — both answered here.
    await primary_user.initialize();
    const { page, teamsPage: teams } = primary_user;
    // The tab also needs a PromptOwl sign-in (a readable cnst_po_session
    // cookie). An account signed in another way gets the marker in the page
    // only — the server never sees it.
    const hasPoSession = (await primary_user.context.cookies()).some((c) => c.name === 'cnst_po_session');
    if (!hasPoSession) {
      await page.addInitScript(() => {
        const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        Object.defineProperty(document, 'cookie', {
          configurable: true,
          get() { return `${desc.get.call(this)}; cnst_po_session=qa-marker`; },
          set(v) { desc.set.call(this, v); },
        });
      });
    }
    await stubPromptowlTeams(page, []);

    // ── Enabled: two tabs, the local list first ──
    await stubPromptowlTeamsFlag(page, true);
    await teams.goto();
    await expect(teams.cnTab).toBeVisible();
    await expect(teams.poTab).toBeVisible();
    await expect(teams.cnTab).toHaveAttribute('aria-selected', 'true');
    await expect(teams.newTeam).toBeVisible();

    await teams.poTab.click();
    await expect(teams.poTab).toHaveAttribute('aria-selected', 'true');
    await expect(teams.poIntro).toBeVisible();
    await expect(teams.poEmpty).toBeVisible();

    await teams.cnTab.click();
    await expect(teams.poIntro).toHaveCount(0);

    // ── Disabled: no tabs — the list stands on its own ──
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubPromptowlTeams(page, []);
    await stubPromptowlTeamsFlag(page, false);
    await page.reload();
    await expect(teams.pageTitle).toContainText('Teams');
    await expect(teams.newTeam).toBeVisible();
    await expect(teams.cnTab).toHaveCount(0);
    await expect(teams.poTab).toHaveCount(0);
    await expect(teams.poIntro).toHaveCount(0);
  });
});
