/**
 * API Keys Test Suite — CN-KEYS-001 … CN-KEYS-009
 *
 * Page under test: ui/src/pages/app/api-keys/page.tsx (route `/api-keys`),
 * plus the dialogs it opens: KeyRevealModal and the Rotate / Revoke
 * confirmations (ui/src/components/ConnectModal.tsx, governance ReasonDialog).
 *
 * Conventions
 * -----------
 * - The suite runs as `secondary_user` when one is configured, else as
 *   `primary_user`. Keys are per account and capped at 20, and a long-lived
 *   primary QA account tends to sit near that cap; a test that needs more free
 *   slots than the account has skips and says so.
 * - Every key a test makes is named with a token of that test and revoked
 *   after it (keys are not in the entity registry). Plaintext keys only ever
 *   live inside the test — they are never logged.
 * - The nest a one-nest key is scoped to is owned by `primary_user` (AUTO_
 *   name, registered for teardown) and shared with the key holder as a viewer.
 * - Two states cannot be arranged from a real account — the loading state and
 *   "No keys yet" on an account that holds keys. Those are driven through
 *   `src/lib/api_keys_stubs.js`, which serves the real response shape.
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import { getEntities } from '../../src/lib/entity_registry.js';
import { stubKeys, holdKeys } from '../../src/lib/api_keys_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;
/** The account whose keys are under test. */
const holderRole = secondaryRole ?? primaryRole;

/** On nest-dev a write answers in seconds; locally well under one. */
const WRITE = { timeout: 30_000 };

/** A name token no other key on the account will carry. */
function token() {
  return `AUTO_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** The key holder's fixture for this test. */
async function holder({ primary_user, secondary_user }) {
  const role = secondaryRole ? secondary_user : primary_user;
  await role.initialize();
  return role;
}

/** Skip unless the holder may create `n` more keys. */
async function needSlots(api, n) {
  const free = await api.freeSlots();
  test.skip(free < n, `${holderRole.alias} has only ${free} free API key slot(s) of 20; this test needs ${n}. Revoke unused keys on that account.`);
}

/**
 * A nest the key holder is a member of (viewer), owned by the primary.
 * Created once per run, found again through the registry afterwards.
 */
async function ensureMemberNest(primary_user, commonFunction) {
  await primary_user.initialize();
  const api = primary_user.dashboardApi;
  const registered = new Set(getEntities('nests').filter((e) => !e.deleted && e.name.endsWith('keys-member')).map((e) => e.id));
  let nest = (await api.listNests()).find((n) => registered.has(n.id));
  if (!nest) nest = await api.createNest(commonFunction.generateEntityName('keys-member'), 'Seeded by the API keys suite');
  if (secondaryRole) {
    const shared = (await api.listCollaborators(nest.id)).some((c) => (c.email ?? '').toLowerCase() === secondaryRole.email.toLowerCase());
    if (!shared) await api.addCollaborator(nest.id, secondaryRole.email, 'read');
  }
  return nest;
}

/** How the page renders a server timestamp as a date (`when()` in page.tsx). */
async function asShownDate(page, raw) {
  return page.evaluate((value) => {
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    return new Date(iso).toLocaleDateString();
  }, raw);
}

test.describe('API keys', () => {
  test.skip(!holderRole, 'No test account is configured. See tests/env.template.');

  // Keys this test made (by name token) — revoked afterwards, whatever happened.
  let cleanup = null;
  test.afterEach(async () => {
    if (cleanup) await cleanup().catch(() => {});
    cleanup = null;
  });

  test('CN-KEYS-001: the page displays the two scope info boxes and the create form', async ({ primary_user, secondary_user, commonFunction }) => {
    const role = await holder({ primary_user, secondary_user });
    const { apiKeysPage: keys } = role;

    await role.nestsPage.goto();
    await expect(keys.railItem).toBeVisible();
    await keys.railItem.click();
    await keys.pageTitle.filter({ hasText: 'API keys' }).waitFor();
    await expect(keys.railItem).toHaveAttribute('aria-current', 'page');
    await expect(keys.pageTitle).toContainText('Make one key per place you connect from');

    // What each scope reaches.
    await expect(keys.allNestsBox).toBeVisible();
    await expect(keys.allNestsBox).toContainText('Works on every nest you can see, the server-level MCP endpoint, and your account (including managing keys).');
    await expect(keys.oneNestBox).toBeVisible();
    await expect(keys.oneNestBox).toContainText('Reaches that one nest and nothing else');
    await expect(keys.oneNestBox).toContainText('answer 403');

    // The create form: a name, a scope (all nests by default), and Generate.
    await expect(keys.nameInput).toBeVisible();
    await expect(keys.nameInput).toHaveAttribute('placeholder', "What's this key for? e.g. Claude Desktop, laptop CLI");
    await expect(keys.nameInput).toHaveAttribute('maxlength', '60');
    await expect(keys.scopeSelect).toHaveText('All your nests');
    await expect(keys.generate).toBeVisible();
    await expect(keys.generate).toBeDisabled();
    await expect(role.page.getByText("A key is shown once, when it's created.")).toBeVisible();
  });

  test('CN-KEYS-002: an all-nests key is generated and its value is revealed once', async ({ primary_user, secondary_user, commonFunction }) => {
    const role = await holder({ primary_user, secondary_user });
    const { page, apiKeysPage: keys, apiKeysApi: api } = role;
    await needSlots(api, 1);
    const name = `${token()} all-nests`;
    cleanup = () => api.revokeKeysNamed(name);

    await keys.goto();
    const value = await keys.generateKey(name);

    // Shown once, with the warning that it can't be read back.
    await expect(keys.revealDialog).toContainText('API key generated');
    await expect(keys.revealDialog).toContainText('only once');
    expect(value).toMatch(/^cnst_/);

    await keys.revealClose.click();
    await expect(keys.revealDialog).toHaveCount(0);

    // Its row: all-nests scope, and a prefix of the value — never the value.
    await expect(keys.row(name)).toHaveCount(1, WRITE);
    await expect(keys.rowScope(name)).toHaveText('All your nests');
    await expect(keys.rowScope(name)).not.toHaveClass(/border-amber-200/);
    const prefix = (await keys.rowPrefix(name).innerText()).replace(/[.…]+$/, '');
    expect(value.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(value.length);
    expect(await page.locator('body').innerText()).not.toContain(value);

    // The server keeps no readable copy, and the key works on its own.
    const listed = await api.request('GET', '/auth/keys');
    expect(JSON.stringify(listed.data)).not.toContain(value);
    expect((listed.data.keys.find((k) => k.label === name) ?? {}).nest_id ?? null).toBeNull();
    expect(await api.statusWithKey(value, '/nests')).toBe(200);
  });

  test('CN-KEYS-003: a single-nest key is generated with the amber scope badge', async ({ primary_user, secondary_user, commonFunction }) => {
    const role = await holder({ primary_user, secondary_user });
    const { apiKeysPage: keys, apiKeysApi: api } = role;
    await needSlots(api, 1);
    const nest = await ensureMemberNest(primary_user, commonFunction);
    const name = `${token()} one-nest`;
    cleanup = () => api.revokeKeysNamed(name);

    await keys.goto();
    const value = await keys.generateKey(name, `Only ${nest.name}`);
    await expect(keys.revealDialog).toContainText('API key generated');
    await keys.revealClose.click();

    // Amber badge naming the one nest it reaches.
    await expect(keys.row(name)).toHaveCount(1, WRITE);
    await expect(keys.rowScope(name)).toHaveText(`Nest: ${nest.name}`);
    await expect(keys.rowScope(name)).toHaveClass(/border-amber-200/);
    await expect(keys.rowScope(name)).toHaveClass(/bg-amber-50/);
    await expect(keys.rowScope(name)).toHaveAttribute('title', 'This key reaches this one nest only.');
    // The form resets to all nests for the next key.
    await expect(keys.scopeSelect).toHaveText('All your nests');

    // Scoped for real: that nest answers; the account (and its keys) refuse it.
    expect((await api.listKeys()).find((k) => k.label === name)?.nest_id).toBe(nest.id);
    expect(await api.statusWithKey(value, `/nests/${nest.id}`)).toBe(200);
    expect(await api.statusWithKey(value, '/auth/keys')).toBe(403);
  });

  test('CN-KEYS-004: a duplicate key name is rejected inline', async ({ primary_user, secondary_user, commonFunction }) => {
    const role = await holder({ primary_user, secondary_user });
    const { apiKeysPage: keys, apiKeysApi: api } = role;
    await needSlots(api, 1);
    const name = `${token()} duplicate`;
    cleanup = () => api.revokeKeysNamed(name);
    await api.createKey(name);

    await keys.goto();
    await expect(keys.row(name)).toHaveCount(1);

    // Same name, different case and spacing: still a duplicate.
    await keys.nameInput.fill(`  ${name.toUpperCase()}  `);
    await expect(keys.duplicateError).toBeVisible();
    await expect(keys.nameInput).toHaveAttribute('aria-invalid', 'true');
    await expect(keys.generate).toBeDisabled();

    // A different name clears it.
    await keys.nameInput.fill(`${name} two`);
    await expect(keys.duplicateError).toHaveCount(0);
    await expect(keys.nameInput).not.toHaveAttribute('aria-invalid', 'true');
    await expect(keys.generate).toBeEnabled();
    // Nothing was created on the way.
    expect((await api.listKeys()).filter((k) => k.label?.includes(name))).toHaveLength(1);
  });

  test('CN-KEYS-005: Generate is disabled when the name is empty', async ({ primary_user, secondary_user, commonFunction }) => {
    const role = await holder({ primary_user, secondary_user });
    const { apiKeysPage: keys } = role;

    await keys.goto();
    await expect(keys.nameInput).toHaveValue('');
    await expect(keys.generate).toBeDisabled();

    // Spaces are not a name.
    await keys.nameInput.fill('     ');
    await expect(keys.generate).toBeDisabled();

    await keys.nameInput.fill('x');
    await expect(keys.generate).toBeEnabled();
    await keys.nameInput.fill('');
    await expect(keys.generate).toBeDisabled();
  });

  test('CN-KEYS-006: rows display the key prefix, created and last-used dates ("never" when unused)', async ({ primary_user, secondary_user, commonFunction }) => {
    const role = await holder({ primary_user, secondary_user });
    const { page, apiKeysPage: keys, apiKeysApi: api } = role;
    await needSlots(api, 2);
    const tok = token();
    cleanup = () => api.revokeKeysNamed(tok);
    const unused = await api.createKey(`${tok} unused`);
    const used = await api.createKey(`${tok} used`);
    // Use one of them once, with no session alongside it.
    expect(await api.statusWithKey(used.api_key, '/nests')).toBe(200);
    let usedRow;
    for (let i = 0; i < 15; i++) {
      usedRow = (await api.listKeys()).find((k) => k.label === `${tok} used`);
      if (usedRow?.last_used_at) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(usedRow?.last_used_at, 'the used key should record when it was last used').toBeTruthy();
    const unusedRow = (await api.listKeys()).find((k) => k.label === `${tok} unused`);

    await keys.goto();
    const created = await asShownDate(page, unusedRow.created_at);
    await expect(keys.rowPrefix(`${tok} unused`)).toHaveText(unusedRow.key_prefix);
    await expect(keys.rowMeta(`${tok} unused`)).toHaveText(`${unusedRow.key_prefix} · created ${created} · last used never`);

    const lastUsed = await asShownDate(page, usedRow.last_used_at);
    await expect(keys.rowMeta(`${tok} used`)).toHaveText(
      `${usedRow.key_prefix} · created ${await asShownDate(page, usedRow.created_at)} · last used ${lastUsed}`
    );
    // The prefix is the start of the key, never the whole of it.
    expect(unused.api_key.startsWith(unusedRow.key_prefix.replace(/[.…]+$/, ''))).toBe(true);
    expect(await page.locator('body').innerText()).not.toContain(unused.api_key);
  });

  test('CN-KEYS-007: rotating a key reveals the new value', async ({ primary_user, secondary_user, commonFunction }) => {
    const role = await holder({ primary_user, secondary_user });
    const { apiKeysPage: keys, apiKeysApi: api } = role;
    await needSlots(api, 1);
    const name = `${token()} rotate`;
    cleanup = () => api.revokeKeysNamed(name);
    const old = await api.createKey(name);
    const oldPrefix = (await api.listKeys()).find((k) => k.label === name).key_prefix;

    await keys.goto();
    await keys.rowRotate(name).click();
    const confirm = keys.confirmDialog(`Rotate "${name}"?`);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('The current key stops working immediately');
    await expect(keys.reasonConfirm).toHaveText('Rotate key');
    await keys.reasonConfirm.click();

    // The new value, once — and the old one is dead.
    await expect(keys.revealDialog).toContainText('API key rotated', WRITE);
    await expect(keys.revealDialog).toContainText('Your previous key has been invalidated');
    const fresh = (await keys.revealValue.innerText()).trim();
    expect(fresh).toMatch(/^cnst_/);
    expect(fresh).not.toBe(old.api_key);
    await keys.revealClose.click();

    await expect(keys.row(name)).toHaveCount(1);
    const newPrefix = (await api.listKeys()).find((k) => k.label === name).key_prefix;
    expect(newPrefix).not.toBe(oldPrefix);
    await expect(keys.rowPrefix(name)).toHaveText(newPrefix);
    expect(await api.statusWithKey(old.api_key, '/nests')).toBe(401);
    expect(await api.statusWithKey(fresh, '/nests')).toBe(200);
  });

  test('CN-KEYS-008: revoking a key requires confirmation and removes it', async ({ primary_user, secondary_user, commonFunction }) => {
    const role = await holder({ primary_user, secondary_user });
    const { apiKeysPage: keys, apiKeysApi: api } = role;
    await needSlots(api, 1);
    const name = `${token()} revoke`;
    cleanup = () => api.revokeKeysNamed(name);
    const minted = await api.createKey(name);

    await keys.goto();
    await keys.rowRevoke(name).click();
    const confirm = keys.confirmDialog(`Revoke "${name}"?`);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Anything still using this key stops working immediately.');
    await expect(keys.reasonConfirm).toHaveText('Revoke key');

    // Cancel: nothing happens.
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(keys.row(name)).toHaveCount(1);
    expect(await api.statusWithKey(minted.api_key, '/nests')).toBe(200);

    // Confirm: gone from the list, the account and the API.
    await keys.rowRevoke(name).click();
    await keys.reasonConfirm.click();
    await expect(keys.toast('Key revoked')).toBeVisible(WRITE);
    await expect(keys.row(name)).toHaveCount(0);
    expect((await api.listKeys()).some((k) => k.label === name)).toBe(false);
    expect(await api.statusWithKey(minted.api_key, '/nests')).toBe(401);
  });

  test('CN-KEYS-009: the loading and "No keys yet" empty states display correctly', async ({ primary_user, secondary_user }) => {
    // Forced states: the read resolves too fast to see "Loading", and the
    // test account may hold keys.
    const role = await holder({ primary_user, secondary_user });
    const { page, apiKeysPage: keys } = role;
    const release = await holdKeys(page, []);

    await page.goto('/api-keys');
    await expect(keys.loader).toBeVisible();
    await expect(keys.emptyState).toHaveCount(0);

    release();
    await expect(keys.emptyState).toBeVisible();
    await expect(keys.loader).toHaveCount(0);
    await expect(keys.rows).toHaveCount(0);
    // No keys, so no search / filter / sort controls.
    await expect(keys.searchInput).toHaveCount(0);
    // The create form is still there.
    await expect(keys.nameInput).toBeVisible();

    // And with keys, the empty state is gone.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubKeys(page, [
      { id: 'stub-key-1', key_prefix: 'cnst_stub1', nest_id: null, label: 'Stub key', created_at: new Date().toISOString(), last_used_at: null },
    ]);
    await page.reload();
    await expect(keys.row('Stub key')).toHaveCount(1);
    await expect(keys.emptyState).toHaveCount(0);
    await expect(keys.searchInput).toBeVisible();
  });
});
