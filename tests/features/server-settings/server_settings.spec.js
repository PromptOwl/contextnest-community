/**
 * Server Settings Test Suite — CN-SET-001 … CN-SET-014
 *
 * Page under test: ui/src/pages/app/settings/page.tsx (route `/settings`,
 * rail → Admin → Server settings): the global draft with its unsaved-changes
 * bar and tab dots, and the Basic, Features, Single sign-on, Hootie,
 * Notifications and Community sites tabs.
 *
 * Conventions
 * -----------
 * - The page is for server admins: the primary account runs every case but the
 *   non-admin half of CN-SET-001, which needs a second account that is not one.
 * - Every setting here is server-wide, so a real save on a shared server would
 *   change it for everyone (sign-in rules, SSO, the model gateway, email and
 *   Slack delivery, retention…) and "Send test" would post to a real channel.
 *   The page's writes are therefore answered by `src/lib/server_settings_stubs.js`
 *   and recorded: each test checks exactly what the page asked the server to
 *   change. Reads come from the real server, with overrides only where a case
 *   needs a known starting state (each such test says which).
 * - The suite runs serially (see `mode: 'serial'` in playwright.config.js).
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';
import {
  stubServerSettings,
  holdServerSettings,
  stubTestNotification,
  stubCommunitySites,
  communitySite,
} from '../../src/lib/server_settings_stubs.js';

const primaryRole = samples.primary_user ?? null;
const secondaryRole = samples.secondary_user ?? null;

const MB = 1024 * 1024;

/** Initialise the primary account; skips when it isn't a server admin. */
async function asAdmin(role) {
  await role.initialize();
  test.skip(!(await role.teammatesApi.isServerAdmin()), 'primary_user is not a server admin on this server.');
  return role;
}

/** Keys of the only save the page sent, and that save. */
function onlySave(patches) {
  expect(patches, 'the page should have sent exactly one save').toHaveLength(1);
  return patches[0];
}

test.describe('Server settings', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test('CN-SET-003: saving succeeds with a toast and field errors jump to the offending tab', async ({
    primary_user,
  }) => {
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    // The stubbed server refuses a From address that isn't an email, with a
    // per-field reason, the way the real one does.
    const { patches } = await stubServerSettings(page, {
      overrides: { telemetry_enabled: true },
      onPatch: (patch) =>
        'notify_email_from' in patch && !/@/.test(patch.notify_email_from)
          ? {
              status: 400,
              body: {
                error: 'The From address must be a valid email address.',
                fieldErrors: { notify_email_from: 'The From address must be a valid email address.' },
              },
            }
          : null,
    });
    await ss.goto();

    // ── A good save: one PATCH with only the edited fields, a toast, clean bar ──
    const name = `QA Community ${Date.now().toString(36)}`;
    await ss.communityName.fill(name);
    await ss.openTab('Features');
    await ss.cardSwitch('Usage telemetry').click();
    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    expect(onlySave(patches)).toEqual({ community_name: name, telemetry_enabled: false });
    await expect(ss.unsaved).toHaveCount(0);
    await expect(ss.tabDot('Features')).toHaveCount(0);
    await expect(ss.cardSwitch('Usage telemetry')).toHaveAttribute('aria-checked', 'false');
    await ss.openTab('Basic');
    await expect(ss.communityName).toHaveValue(name);

    // ── A refused save: banner, the Notifications tab opens, the field says why ──
    await ss.openTab('Notifications');
    await ss.emailFrom.fill('not-an-email');
    await ss.openTab('Basic');
    await ss.communityName.fill(`${name} 2`);
    await ss.saveButton.click();
    await expect(ss.saveError).toBeVisible();
    await expect(ss.saveError).toContainText('The From address must be a valid email address.');
    await expect(ss.tab('Notifications')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('The From address must be a valid email address.', { exact: true }).last()).toBeVisible();
    await expect(ss.emailFrom).toHaveAttribute('aria-invalid', 'true');
    // Nothing was lost: the values stay for correcting, still unsaved.
    await expect(ss.emailFrom).toHaveValue('not-an-email');
    await expect(ss.unsaved).toBeVisible();
    expect(patches).toHaveLength(2);
    // An edit clears the error.
    await ss.emailFrom.fill('nest@example.com');
    await expect(ss.saveError).toHaveCount(0);
    await expect(ss.emailFrom).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('CN-SET-004: PromptOwl and Manual sign-in cannot both be turned Off', async ({ primary_user }) => {
    // Known start: both methods open to everyone.
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page, {
      overrides: { manual_sign_in: 'open', promptowl_sign_in_gate: 'open' },
    });
    await ss.goto();
    const manualOff = ss.option('Manual sign-in', 'Off');
    const poOff = ss.option('PromptOwl sign-in', 'Off');
    await expect(ss.option('Manual sign-in', 'Everyone')).toHaveAttribute('aria-pressed', 'true');
    await expect(ss.option('PromptOwl sign-in', 'Everyone')).toHaveAttribute('aria-pressed', 'true');
    await expect(manualOff).toBeEnabled();
    await expect(poOff).toBeEnabled();

    // Manual Off → PromptOwl's Off is locked.
    await manualOff.click();
    await expect(manualOff).toHaveAttribute('aria-pressed', 'true');
    await expect(poOff).toBeDisabled();
    await poOff.click({ force: true });
    await expect(poOff).toHaveAttribute('aria-pressed', 'false');
    await expect(ss.option('PromptOwl sign-in', 'Everyone')).toHaveAttribute('aria-pressed', 'true');

    // Back to Invite only → PromptOwl's Off frees up; choosing it locks Manual's Off.
    await ss.option('Manual sign-in', 'Invite only').click();
    await expect(poOff).toBeEnabled();
    await poOff.click();
    await expect(poOff).toHaveAttribute('aria-pressed', 'true');
    await expect(manualOff).toBeDisabled();

    // What gets saved is one Off and one on — never both Off.
    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    const saved = onlySave(patches);
    expect(saved).toEqual({ manual_sign_in: 'invite-only', promptowl_sign_in_gate: 'disabled' });
  });

  test('CN-SET-005: the Anthropic API key set/clear flow works with a masked status', async ({ primary_user }) => {
    // Known start: own keys available, a gateway with a key in use, and an own
    // Anthropic provider key — masked tails only, as the server reports them.
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page, {
      overrides: {
        byok_available: true,
        anthropic_base_url: 'https://gateway.example.com',
        anthropic_api_key_masked: '••••Ab12',
        model_source: 'own',
        own_providers: { claude: { masked: 'Zz99', updatedAt: null } },
      },
    });
    await ss.goto();
    await ss.openTab('Hootie');

    // ── Gateway key: masked status, never the key; clear then keep ──
    await expect(ss.gatewayStatus).toHaveText('Current: ••••Ab12 (in use)');
    await expect(ss.gatewayKey).toHaveValue('');
    await expect(ss.gatewayKey).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Clear key', exact: true }).last().click();
    await expect(ss.gatewayStatus).toHaveText('Will be cleared when you save.');
    await expect(ss.tabDot('Hootie')).toBeVisible();
    await page.getByRole('button', { name: 'Keep current key', exact: true }).last().click();
    await expect(ss.gatewayStatus).toHaveText('Current: ••••Ab12 (in use)');
    await expect(ss.unsaved).toHaveCount(0);

    // ── Set a new key: sent once, shown back only as its tail ──
    await ss.gatewayKey.fill('sk-qa-gateway-key-7788');
    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    expect(patches[0]).toEqual({ anthropic_api_key: 'sk-qa-gateway-key-7788' });
    await expect(ss.gatewayStatus).toHaveText('Current: ••••7788 (in use)');
    await expect(ss.gatewayKey).toHaveValue('');
    await expect(page.getByText('sk-qa-gateway-key-7788')).toHaveCount(0);

    // ── Clear it: saved as null; the gateway has no key any more ──
    await page.getByRole('button', { name: 'Clear key', exact: true }).last().click();
    await ss.saveButton.click();
    await expect(ss.toast('Settings saved').last()).toBeVisible();
    expect(patches[1]).toEqual({ anthropic_api_key: null });
    await expect(ss.gatewayStatus).toHaveText("No key yet: the gateway isn't used until it has one.");

    // ── The own Anthropic provider key: masked, clear → saved as null ──
    await expect(ss.anthropicProvider).toContainText('Current: ••••Zz99');
    await ss.anthropicProvider.getByRole('button', { name: 'Clear key', exact: true }).click();
    await expect(ss.anthropicProvider).toContainText('Will be cleared when you save.');
    await ss.saveButton.click();
    await expect.poll(() => patches.length).toBe(3);
    expect(patches[2]).toEqual({ provider_keys: { claude: null } });
    await expect(ss.anthropicProvider).toContainText('Not set.');
  });

  test('CN-SET-006: the Hootie, nest-creation and people-directory toggles work', async ({ primary_user }) => {
    // Known start: all three off.
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page, {
      overrides: { hootie_enabled: false, nest_creation: 'admins', people_suggest_all_users: false },
    });
    await ss.goto();

    await ss.openTab('Hootie');
    await expect(ss.hootieSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(ss.card('Hootie')).toContainText('Hootie in the nest — Off');
    await ss.hootieSwitch.click();
    await expect(ss.hootieSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(ss.card('Hootie')).toContainText('Hootie in the nest — On');

    await ss.openTab('Features');
    const nestSwitch = ss.cardSwitch('Nest creation');
    const peopleSwitch = ss.rowSwitch('People directory', 'Suggest everyone on this server');
    await expect(nestSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(peopleSwitch).toHaveAttribute('aria-checked', 'false');
    await nestSwitch.click();
    await peopleSwitch.click();
    await expect(nestSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(peopleSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(ss.tabDot('Features')).toBeVisible();
    await expect(ss.tabDot('Hootie')).toBeVisible();

    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    expect(onlySave(patches)).toEqual({ hootie_enabled: true, nest_creation: 'everyone', people_suggest_all_users: true });

    // And back off again in one save.
    await nestSwitch.click();
    await peopleSwitch.click();
    await ss.saveButton.click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({ nest_creation: 'admins', people_suggest_all_users: false });
  });

  test('CN-SET-007: enabling OIDC warns until issuer, client ID and secret are set', async ({ primary_user }) => {
    // Known start: SSO off and empty. The issuer comes from the provider the
    // admin picks (Google sets it; Enterprise takes a tenant or issuer URL).
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page, {
      overrides: {
        oidc_enabled: false,
        sso_token_exchange_enabled: false,
        oidc_issuer: '',
        oidc_client_id: '',
        oidc_client_secret_set: false,
        sso_available: true,
      },
    });
    await ss.goto();
    await expect(ss.tab('Single sign-on')).toHaveCount(0);

    // Turning it on adds the Single sign-on tab, which warns straight away.
    await ss.openTab('Features');
    await ss.cardSwitch('Single sign-on (OIDC)').click();
    await expect(ss.tab('Single sign-on')).toBeVisible();
    await ss.openTab('Single sign-on');
    await expect(ss.oidcNotReady).toBeVisible();
    await expect(ss.oidcNotReady).toContainText('until a provider is picked and its client ID and client secret are set');

    // Each piece alone is not enough: the issuer (picking Google), the client ID…
    await ss.googleSwitch.click();
    await expect(ss.googleSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(ss.oidcNotReady).toBeVisible();
    await ss.clientId.fill('qa-client-id.apps.googleusercontent.com');
    await expect(ss.oidcNotReady).toBeVisible();
    // …and with the secret too, the warning goes.
    await ss.clientSecret.fill('qa-client-secret-value');
    await expect(ss.oidcNotReady).toHaveCount(0);

    // Taking one away brings the warning back.
    await ss.clientId.fill('');
    await expect(ss.oidcNotReady).toBeVisible();
    await ss.clientId.fill('qa-client-id.apps.googleusercontent.com');
    await expect(ss.oidcNotReady).toHaveCount(0);
    // Unpicking the provider (no issuer) brings it back as well.
    await ss.googleSwitch.click();
    await expect(ss.oidcNotReady).toBeVisible();

    // Turning OIDC off again hides the tab and drops back to Features.
    await ss.openTab('Features');
    await ss.cardSwitch('Single sign-on (OIDC)').click();
    await expect(ss.tab('Single sign-on')).toHaveCount(0);
    expect(patches, 'nothing was saved').toHaveLength(0);
  });

  test('CN-SET-008: issuer presets and the redirect-URI copy work', async ({ primary_user }) => {
    // Known start: OIDC on with no issuer, an Enterprise licence, and a public base URL.
    await asAdmin(primary_user);
    await primary_user.context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page, {
      overrides: { oidc_enabled: true, oidc_issuer: '', sso_available: true, public_base_url: 'https://nest.example.com' },
    });
    await ss.goto();
    await ss.openTab('Single sign-on');
    await expect(ss.googleCard).toContainText('Available on every plan');
    await expect(ss.googleSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(ss.enterpriseSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(ss.ssoLocked).toHaveCount(0);

    // Google: one switch sets Google's issuer.
    await ss.googleSwitch.click();
    await expect(ss.googleSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(ss.enterpriseSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(ss.googleCard.locator('code').filter({ hasText: '/auth/oidc/callback' })).toBeVisible();
    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    expect(patches[0]).toEqual({ oidc_issuer: 'https://accounts.google.com' });

    // Enterprise: switching to it clears Google; the Entra tenant builds the issuer.
    await ss.enterpriseSwitch.click();
    await expect(ss.enterpriseSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(ss.googleSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(ss.entraTenant).toBeVisible();
    const tenant = '11111111-2222-3333-4444-555555555555';
    await ss.entraTenant.fill(tenant);
    await expect(ss.issuerInput).toHaveValue(`https://login.microsoftonline.com/${tenant}/v2.0`);
    await ss.entraTenant.fill('common');
    await expect(page.getByRole('alert').filter({ hasText: 'Use the tenant GUID' })).toBeVisible();
    // Any other issuer (Okta, Keycloak…) is typed in; it stays the Enterprise provider.
    await ss.issuerInput.fill('https://sso.acme.example/realms/acme');
    await expect(ss.enterpriseSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(ss.entraTenant).toHaveValue('');

    // Redirect URI: built from the public base URL; Copy copies it.
    const redirect = ss.enterpriseCard.locator('code').filter({ hasText: '/auth/oidc/callback' });
    await expect(redirect).toHaveText('https://nest.example.com/auth/oidc/callback');
    await ss.enterpriseCard.getByRole('button', { name: /^Copy$/ }).click();
    await expect(ss.enterpriseCard.getByRole('button', { name: /^Copied$/ })).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    if (clip !== null) expect(clip).toBe('https://nest.example.com/auth/oidc/callback');

    // It follows the (unsaved) public base URL.
    await ss.openTab('Basic');
    await ss.publicBaseUrl.fill('https://other.example.org/');
    await ss.openTab('Single sign-on');
    await expect(redirect).toHaveText('https://other.example.org/auth/oidc/callback');

    // Without the Enterprise licence the Enterprise card is locked; Google still works.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubServerSettings(page, { overrides: { oidc_enabled: true, oidc_issuer: '', sso_available: false } });
    await ss.goto();
    await ss.openTab('Single sign-on');
    await expect(ss.ssoLocked).toContainText('Needs an Enterprise licence');
    await expect(ss.enterpriseSwitch).toBeDisabled();
    await expect(ss.googleSwitch).toBeEnabled();
  });

  test('CN-SET-010: Slack/Teams "Send test" uses only the saved webhook URL', async ({ primary_user }) => {
    // Known start: no Slack webhook saved, a Teams one saved. "Send test" is
    // stubbed so nothing posts to a real channel.
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page, {
      overrides: { slack_webhook_url: '', msteams_webhook_url: 'https://qa.logic.azure.com/workflows/saved-teams' },
    });
    const sent = await stubTestNotification(page);
    await ss.goto();
    await ss.openTab('Notifications');

    const slackTest = ss.sendTest('Slack notifications');
    const teamsTest = ss.sendTest('Microsoft Teams notifications');
    // Nothing saved for Slack: no test to send, even after typing a URL.
    await expect(slackTest).toBeDisabled();
    await ss.slackUrl.fill('https://hooks.slack.com/services/T000/B000/qa-unsaved');
    await expect(slackTest).toBeDisabled();
    await expect(ss.card('Slack notifications')).toContainText('Save first — the test uses the saved URL.');

    // Teams is saved: the test sends just the channel — the server uses its saved URL.
    await expect(teamsTest).toBeEnabled();
    await ss.teamsUrl.fill('https://qa.logic.azure.com/workflows/unsaved-edit');
    await expect(ss.card('Microsoft Teams notifications')).toContainText('Save first — the test uses the saved URL.');
    await teamsTest.click();
    await expect(ss.toast('Test Teams notification sent — check the channel.')).toBeVisible();
    expect(sent).toEqual([{ channel: 'teams' }]);
    expect(JSON.stringify(sent), 'the unsaved URL is never sent with a test').not.toContain('unsaved');

    // Saving Slack's URL enables its test.
    await ss.teamsUrl.fill('https://qa.logic.azure.com/workflows/saved-teams');
    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    expect(onlySave(patches)).toEqual({ slack_webhook_url: 'https://hooks.slack.com/services/T000/B000/qa-unsaved' });
    await expect(slackTest).toBeEnabled();
    await expect(ss.card('Slack notifications')).not.toContainText('Save first');
    await slackTest.click();
    await expect(ss.toast('Test Slack notification sent — check the channel.')).toBeVisible();
    expect(sent).toEqual([{ channel: 'teams' }, { channel: 'slack' }]);
  });

  test('CN-SET-011: email can be configured via SMTP or AWS SES', async ({ primary_user }) => {
    // Known start: SMTP chosen, nothing configured.
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page, {
      overrides: {
        email_provider: 'smtp',
        smtp_url: '',
        ses_region: '',
        ses_access_key_id: '',
        ses_secret_access_key_set: false,
        notify_email_from: '',
        notify_email_to: '',
      },
    });
    await ss.goto();
    await ss.openTab('Notifications');

    // ── SMTP ──
    await expect(ss.smtpRadio).toBeChecked();
    await expect(ss.smtpUrl).toBeVisible();
    await expect(ss.sesRegion).toHaveCount(0);
    await expect(ss.smtpUrl).toHaveAttribute('type', 'password');
    await ss.smtpUrl.fill('smtps://qa:pw@smtp.example.com:465');
    await ss.emailFrom.fill('nest@example.com');
    await ss.emailTo.fill('team@example.com, ops@example.com');
    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    expect(patches[0]).toEqual({
      smtp_url: 'smtps://qa:pw@smtp.example.com:465',
      notify_email_from: 'nest@example.com',
      notify_email_to: 'team@example.com, ops@example.com',
    });

    // ── AWS SES ──
    await ss.sesRadio.check();
    await expect(ss.sesRadio).toBeChecked();
    await expect(ss.smtpUrl).toHaveCount(0);
    await expect(ss.sesRegion).toBeVisible();
    await expect(ss.sesAccessKeyId).toBeVisible();
    await expect(ss.sesSecret).toHaveAttribute('placeholder', "Secret access key — leave empty to use the server's IAM role");
    await ss.sesRegion.fill('us-east-1');
    await ss.sesAccessKeyId.fill('AKIAQAEXAMPLE');
    await ss.sesSecret.fill('qa-ses-secret-value');
    await ss.saveButton.click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({
      email_provider: 'ses',
      ses_region: 'us-east-1',
      ses_access_key_id: 'AKIAQAEXAMPLE',
      ses_secret_access_key: 'qa-ses-secret-value',
    });
    // The secret is write-only: it comes back as "set", never as its value.
    await expect(ss.sesSecret).toHaveValue('');
    await expect(ss.sesSecret).toHaveAttribute('placeholder', 'Secret access key is set — paste to replace');

    // Clear keys → saved as null (and the key id emptied), back to the IAM role.
    await page.getByRole('button', { name: 'Clear keys', exact: true }).click();
    await expect(ss.sesSecret).toHaveAttribute('placeholder', 'Secret access key — will be cleared when you save');
    await ss.saveButton.click();
    await expect.poll(() => patches.length).toBe(3);
    expect(patches[2]).toEqual({ ses_secret_access_key: null, ses_access_key_id: '' });
  });

  test('CN-SET-012: community sites can be added, edited and deleted, with the enable switch saving immediately', async ({
    primary_user,
  }) => {
    // Stubbed sites: adding one makes a real SSO trust anchor on the server.
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page);
    const main = communitySite('Main community', { url: 'https://main.example.com' });
    const { calls } = await stubCommunitySites(page, [main]);
    await ss.goto();
    await ss.openTab('Community sites');

    await expect(ss.siteRow('Main community')).toContainText('Enabled');
    await expect(ss.siteRow('Main community')).toContainText('https://main.example.com · secret set');

    // ── Add ──
    await ss.addSiteButton.click();
    await expect(ss.siteDialog).toContainText('Add community site');
    await ss.siteName.fill('QA forum');
    await ss.siteUrl.fill('https://forum.example.com');
    await ss.siteSecret.fill('qa-shared-secret-0123456789');
    await expect(ss.siteSecret).toHaveAttribute('type', 'password');
    await ss.siteDialog.getByRole('button', { name: 'Add site', exact: true }).click();
    await expect(ss.siteDialog).toHaveCount(0);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/admin/community-sites',
      body: { name: 'QA forum', url: 'https://forum.example.com', secret: 'qa-shared-secret-0123456789', is_active: true },
    });
    await expect(ss.siteRow('QA forum')).toContainText('Enabled');
    await expect(ss.siteRow('QA forum')).toContainText('https://forum.example.com · secret set');

    // ── Edit: prefilled, secret left blank keeps the current one ──
    await ss.siteEdit('QA forum').click();
    await expect(ss.siteDialog).toContainText('Edit community site');
    await expect(ss.siteName).toHaveValue('QA forum');
    await expect(ss.siteUrl).toHaveValue('https://forum.example.com');
    await expect(ss.siteSecret).toHaveValue('');
    await expect(ss.siteSecret).toHaveAttribute('placeholder', 'Leave blank to keep the current secret');
    await ss.siteName.fill('QA forum renamed');
    await ss.siteDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(ss.siteDialog).toHaveCount(0);
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].body).toEqual({ name: 'QA forum renamed', url: 'https://forum.example.com', is_active: true });
    await expect(ss.siteRow('QA forum renamed')).toBeVisible();

    // ── Enable switch: saves at once, no global Save involved ──
    await ss.siteSwitch('Main community').click();
    await expect(ss.siteRow('Main community')).toContainText('Disabled');
    expect(calls[2]).toEqual({ method: 'PATCH', path: `/admin/community-sites/${main.id}`, body: { is_active: false } });
    await expect(ss.unsaved).toHaveCount(0);
    expect(patches, 'community sites never go through the settings save').toHaveLength(0);
    await ss.siteSwitch('Main community').click();
    await expect(ss.siteRow('Main community')).toContainText('Enabled');

    // ── Delete: confirm, then gone ──
    await ss.siteRemove('QA forum renamed').click();
    const confirm = page.getByRole('dialog', { name: 'Remove QA forum renamed?' });
    await expect(confirm).toContainText('no longer be auto-signed-in');
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(ss.siteRow('QA forum renamed')).toBeVisible();
    await ss.siteRemove('QA forum renamed').click();
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(ss.siteRow('QA forum renamed')).toHaveCount(0);
    expect(calls.at(-1).method).toBe('DELETE');
  });

  test('CN-SET-013: the Advanced options (telemetry, upload size, retention, content types) save correctly', async ({
    primary_user,
  }) => {
    // Known start, so each saved value is checkable.
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page, {
      overrides: {
        telemetry_enabled: true,
        max_body_bytes: 10 * MB,
        trace_retention_days: 14,
        message_log_retention_days: 30,
        run_retention_days: 0,
        type_artifact_enabled: true,
        type_table_enabled: true,
      },
    });
    await ss.goto();

    // Upload size (MB) and the three retention windows on Basic.
    const mb = ss.card('Max upload size').locator('input[type="number"]');
    await expect(mb).toHaveValue('10');
    await mb.fill('25');
    const trace = ss.card('Activity trace retention').locator('input[type="number"]');
    const messages = ss.card('Message log').locator('input[type="number"]');
    const runs = ss.card('Agent run retention').locator('input[type="number"]');
    await expect(trace).toHaveValue('14');
    await expect(runs).toHaveValue('0');
    await trace.fill('30');
    await messages.fill('60');
    await runs.fill('90');

    // Telemetry and the content types on Features.
    await ss.openTab('Features');
    await ss.cardSwitch('Usage telemetry').click();
    const artifacts = ss.rowSwitch('Content types', 'Artifacts (hosted HTML)');
    const tables = ss.rowSwitch('Content types', 'Tables (CSV fact stores)');
    await artifacts.click();
    await tables.click();
    await expect(ss.card('Content types')).toContainText('Artifacts (hosted HTML) — Off');
    await expect(ss.card('Content types')).toContainText('Tables (CSV fact stores) — Off');
    await expect(ss.card('Usage telemetry')).toContainText('Off');

    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    expect(onlySave(patches)).toEqual({
      max_body_bytes: 25 * MB,
      trace_retention_days: 30,
      message_log_retention_days: 60,
      run_retention_days: 90,
      telemetry_enabled: false,
      type_artifact_enabled: false,
      type_table_enabled: false,
    });
    // The page shows the saved values, with nothing left unsaved.
    await expect(ss.unsaved).toHaveCount(0);
    await ss.openTab('Basic');
    await expect(mb).toHaveValue('25');
    await expect(runs).toHaveValue('90');
  });

  test('CN-SET-014: the workflow plane switch gates the sub-agent runs switch', async ({ primary_user }) => {
    // Known start: the workflow plane and everything that needs it off.
    await asAdmin(primary_user);
    const { page, serverSettingsPage: ss } = primary_user;
    const { patches } = await stubServerSettings(page, {
      overrides: {
        workflow_plane_enabled: false,
        subagent_runs_enabled: false,
        metacognition_enabled: false,
        surfaces_enabled: false,
      },
    });
    await ss.goto();
    await ss.openTab('Features');
    const plane = ss.cardSwitch('Workflow plane');
    const subagents = ss.cardSwitch('Sub-agent runs (recursion)');
    const metacog = ss.cardSwitch('Metacognition agents');

    // Plane off: sub-agent runs (and metacognition) can't be turned on.
    await expect(plane).toHaveAttribute('aria-checked', 'false');
    await expect(subagents).toBeDisabled();
    await expect(metacog).toBeDisabled();
    await expect(ss.card('Sub-agent runs (recursion)')).toContainText('enable the workflow plane first');
    await expect(ss.card('Sub-agent runs (recursion)')).not.toContainText('Max depth');

    // Plane on: the switch frees up; turning it on shows the recursion caps.
    await plane.click();
    await expect(subagents).toBeEnabled();
    await expect(ss.card('Sub-agent runs (recursion)')).not.toContainText('enable the workflow plane first');
    await subagents.click();
    await expect(subagents).toHaveAttribute('aria-checked', 'true');
    await expect(ss.card('Sub-agent runs (recursion)')).toContainText('Max depth');
    await expect(ss.card('Sub-agent runs (recursion)')).toContainText('Max sub-agents per run');

    // Plane off again: sub-agent runs switch off with it and lock.
    await plane.click();
    await expect(subagents).toHaveAttribute('aria-checked', 'false');
    await expect(subagents).toBeDisabled();
    await expect(ss.card('Sub-agent runs (recursion)')).not.toContainText('Max depth');

    // On, on, Save: both go out together.
    await plane.click();
    await subagents.click();
    await ss.saveButton.click();
    await expect(ss.toast('Settings saved')).toBeVisible();
    expect(onlySave(patches)).toEqual({ workflow_plane_enabled: true, subagent_runs_enabled: true });
  });
});
