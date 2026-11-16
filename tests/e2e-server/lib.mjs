// @ts-check

/**
 * The pure parts of the e2e server launcher (start.mjs): what the server is
 * started with, what the license check is answered with, and who is seeded.
 * Kept apart so test/e2e-server.test.ts can check them without starting anything.
 */

/** Feature switches turned on for the server under test, so no suite skips for "off here". */
export const FEATURE_ENV = Object.freeze({
  FEATURE_WORKFLOW_PLANE: 'true',
  FEATURE_METACOGNITION: 'true',
  FEATURE_SURFACES: 'true',
  EXPERIMENTAL_DOC_STREAM: 'true',
  EXPERIMENTAL_DOC_PINS: 'true',
  HOOTIE_ENABLED: 'true',
});

/**
 * People added to the server's directory besides the two test accounts.
 * qa-viewer stays on the free seat: the suites pick it first when they want to
 * see the "this raises what someone is billed" step.
 */
export const FREE_SEAT_PEOPLE = Object.freeze(['qa-viewer@example.com']);
/** These already hold a paid seat, so granting them a role asks nothing. */
export const PAID_SEAT_PEOPLE = Object.freeze(['qa-editor@example.com', 'qa-reviewer@example.com']);
export const DIRECTORY_PEOPLE = Object.freeze([...FREE_SEAT_PEOPLE, ...PAID_SEAT_PEOPLE]);

/** The standing nest that gives the seeded people a paid seat. No AUTO_ prefix: the orphan sweep keeps it. */
export const SEATS_NEST_NAME = 'E2E seats (seeded, keep)';

/**
 * Read the launcher's settings from the environment.
 * The two accounts are the same variables Playwright reads (tests/env.template),
 * so the seed and the specs cannot disagree.
 * @param {Record<string, string | undefined>} env
 */
export function readSettings(env) {
  const port = Number(env.E2E_SERVER_PORT || 3838);
  const licensePort = Number(env.E2E_LICENSE_PORT || 4010);
  const smtpPort = Number(env.E2E_SMTP_PORT || 4025);
  const accounts = [
    { email: env.TEST_ACCOUNT1_USER, password: env.TEST_ACCOUNT1_PW, name: 'E2E Admin' },
    { email: env.TEST_ACCOUNT2_USER, password: env.TEST_ACCOUNT2_PW, name: 'E2E Member' },
  ].filter((a) => a.email || a.password);

  if (!accounts[0]?.email || !accounts[0]?.password) {
    throw new Error('TEST_ACCOUNT1_USER and TEST_ACCOUNT1_PW are required: the first account is the server admin.');
  }
  for (const a of accounts) {
    if (!a.email || !a.password) throw new Error('Each test account needs both _USER and _PW.');
  }
  return {
    port,
    licensePort,
    smtpPort,
    baseUrl: `http://127.0.0.1:${port}`,
    licenseUrl: `http://127.0.0.1:${licensePort}`,
    dataRoot: env.E2E_DATA_ROOT || null,
    accounts: /** @type {Array<{email: string, password: string, name: string}>} */ (accounts),
    serverCommand: (env.E2E_SERVER_CMD || 'node dist/index.js').split(' ').filter(Boolean),
  };
}

/**
 * Environment for the server under test: a fresh SQLite data folder, key auth,
 * every feature switch on, and nothing that reaches outside the machine.
 * @param {ReturnType<typeof readSettings>} settings
 * @param {string} dataRoot
 */
export function serverEnv(settings, dataRoot) {
  return {
    PORT: String(settings.port),
    DATA_ROOT: dataRoot,
    DB_DRIVER: 'sqlite',
    AUTH_MODE: 'key',
    MANUAL_SIGN_IN: 'open',
    NEST_CREATION: 'everyone',
    PUBLIC_BASE_URL: `http://localhost:${settings.port}`,
    // The license check goes to the launcher's own endpoint, never to PromptOwl.
    PROMPTOWL_KEY: 'pk_e2e_local_server',
    PROMPTOWL_API_URL: settings.licenseUrl,
    TELEMETRY_ENABLED: 'false',
    // Mail goes to the launcher's sink, which discards it. With mail set up the
    // server writes its message log and shows the mail-dependent UI.
    SMTP_URL: `smtp://127.0.0.1:${settings.smtpPort}`,
    NOTIFY_EMAIL_FROM: 'e2e-server@example.com',
    DRIFT_SCAN_INTERVAL_MS: '0',
    ...FEATURE_ENV,
  };
}

/**
 * The answer to the server's license check: a valid enterprise license owned by
 * the first test account, which makes that account the server admin.
 * @param {string} ownerEmail
 */
export function licenseAnswer(ownerEmail) {
  return {
    valid: true,
    tier: 'enterprise',
    org: 'E2E (local server)',
    limits: { maxNests: 0, maxUsers: 0, plan: 'enterprise', maxAccountOwners: null, maxSubscribers: null },
    suspended: false,
    owner_email: ownerEmail,
  };
}
