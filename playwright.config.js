// @ts-check

/**
 * Playwright configuration for ContextNest Community e2e tests.
 *
 * Mirrors the PromptOwl (TheOwl) automation framework:
 *   - `setup-auth` project logs in each configured role once and stores the
 *     session (tests/src/cookies_storage/<alias>.json) for reuse by all tests.
 *   - `orphan-sweep` project cleans AUTO_ entities left by previous runs.
 *   - The `test-suite` project orchestrates the ordered `testRun` chain below.
 *   - A teardown project always runs last (even on failure) to clean up.
 *
 * This repo is ESM ("type": "module"), so the config and all test sources use
 * import/export with relative paths instead of module-alias.
 */

import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load environment-specific configuration from tests/.env/ folder.
 * Files are dot-prefixed (e.g. .dev, .local) — resolve with leading dot unless
 * the caller already passed a full dotfile name (starts with '.').
 * Copy tests/env.template to tests/.env/.local (or .dev) to get started.
 */
const envFile = process.env.ENV || 'local';
const envFileName = envFile.startsWith('.') ? envFile : `.${envFile}`;
dotenv.config({ path: path.resolve(__dirname, `tests/.env/${envFileName}`) });

/**
 * =============================================================================
 * TEST RUN CONFIGURATION
 * =============================================================================
 *
 * Define which spec files to run, their order, and execution mode.
 *
 * Options:
 *   - file: Path relative to tests/features/
 *   - mode: 'parallel' (tests within file run simultaneously) or 'serial'
 *   - enabled: true/false to include/skip this file
 *   - teardown: true to always run this file even if previous tests fail
 *   - independent: true if this suite creates its own test data and should NOT
 *     be blocked by a previous suite's failure. Independent suites depend on
 *     orphan-sweep instead of the previous test in the chain.
 *   - baseURL: optional per-suite base URL override
 *
 * Usage:
 *   npx playwright test --project=test-suite
 */
const testRun = [
  {
    file: 'auth/email_login.spec.js',
    mode: 'parallel',
    enabled: true,
    independent: true, // Self-contained auth tests
  },
  {
    // Community Dashboard (CN-DASH-001 … CN-DASH-062). Serial on purpose: the
    // cases share one account, so a parallel run would have them filtering,
    // counting and deleting each other's nests.
    file: 'dashboard/community_dashboard.spec.js',
    mode: 'serial',
    enabled: true,
    independent: true, // Arranges its own nests; depends only on the orphan sweep
  },
  {
    // My Work (CN-WORK-001 … CN-WORK-020). Serial on purpose: the cases share
    // one inbox and one seeded nest, so a parallel run would have them
    // approving, selecting and counting each other's reviews.
    file: 'my-work/my_work.spec.js',
    mode: 'serial',
    enabled: true,
    independent: true, // Arranges its own nest, reviews and requests
  },
  {
    // My Drafts (CN-DRAFT-001 … CN-DRAFT-013). Serial on purpose: the cases
    // share one account's draft list and one seeded nest, so a parallel run
    // would have them selecting, submitting and discarding each other's drafts.
    file: 'my-drafts/my_drafts.spec.js',
    mode: 'serial',
    enabled: true,
    independent: true, // Arranges its own nest and drafts
  },
  {
    // Request access on a denied write (CN-ACCESS-001 … CN-ACCESS-004).
    // Serial: the cases share one seeded nest and build on each other's
    // requests (ask → approve → deny → refused save).
    file: 'access-requests/access_requests.spec.js',
    mode: 'serial',
    enabled: true,
    independent: true, // Arranges its own nest; needs secondary_user
  },
  {
    // Metacognition agents (CN-META-001 … CN-META-003). Skips unless the
    // server has FEATURE_METACOGNITION on. Serial: one seeded nest.
    file: 'metacognition/metacognition_agents.spec.js',
    mode: 'serial',
    enabled: true,
    independent: true, // Arranges its own nest
  },
  {
    // Annotations keep your place + highlights in every view (CN-ANNO-001 …
    // CN-ANNO-004). Serial: the cases share one seeded nest. Skips itself on
    // a server that doesn't serve the viewer bridge yet.
    file: 'annotations/annotate_keep_place.spec.js',
    mode: 'serial',
    enabled: true,
    independent: true, // Arranges its own nest, artifact, doc and comments
  },
  // ── Add new suites here (governance, documents, …) ────────────────────────
  // ── Teardown (always runs last, even on failure) ───────────────────────────
  {
    file: 'global-cleanup/global_cleanup.spec.js',
    mode: 'serial',
    enabled: true,
    teardown: true, // Always runs even if previous tests fail
  },
];

/**
 * Build dynamic projects from testRun config.
 * Handles teardown projects that always run (even on failure).
 */
function buildTestSuiteProjects() {
  const projects = [];
  let previousProject = 'setup-auth';

  const regularTests = testRun.filter((t) => t.enabled && !t.teardown);
  const teardownTests = testRun.filter((t) => t.enabled && t.teardown);

  // Chained tests depend on the previous test in order; independent tests
  // depend only on orphan-sweep and won't block on unrelated suite failures.
  regularTests.forEach((config, index) => {
    const projectName = `test-${index + 1}`;
    const dep = config.independent
      ? 'orphan-sweep'
      : (index === 0 ? 'orphan-sweep' : previousProject);
    const project = {
      name: projectName,
      dependencies: [dep],
      testMatch: `tests/features/${config.file}`,
      fullyParallel: config.mode === 'parallel',
      use: {
        ...devices['Desktop Chrome'],
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      },
    };

    // If this is the last regular test and there are teardown tests, link them
    if (index === regularTests.length - 1 && teardownTests.length > 0) {
      project.teardown = 'teardown-cleanup';
    }

    projects.push(project);
    if (!config.independent) {
      previousProject = projectName;
    }
  });

  // Teardown projects always run even on failure.
  // Note: teardown projects cannot have dependencies in Playwright.
  teardownTests.forEach((config, index) => {
    projects.push({
      name: index === 0 ? 'teardown-cleanup' : `teardown-${index + 1}`,
      testMatch: `tests/features/${config.file}`,
      fullyParallel: config.mode === 'parallel',
      use: {
        ...devices['Desktop Chrome'],
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
      },
    });
  });

  return projects;
}

/**
 * Detect which --project flags were passed on the CLI so we can conditionally
 * include the standalone shortcut projects only when explicitly targeted.
 * Without this guard, `npx playwright test` (no --project) would run every
 * spec file twice: once via the dynamic test-N chain and once via the
 * standalone project that matches the same glob.
 */
const cliProjects = process.argv
  .filter((arg, i, arr) => (arg === '--project' ? false : arr[i - 1] === '--project'))
  .concat(
    process.argv.filter((arg) => arg.startsWith('--project=')).map((a) => a.split('=')[1])
  );

const standaloneNames = ['auth', 'dashboard', 'my-work', 'my-drafts', 'access-requests'];

const includeStandalone =
  !!process.env.PLAYWRIGHT_INCLUDE_STANDALONE ||
  cliProjects.some((p) => standaloneNames.includes(p));

// Worker processes re-evaluate this config with a different argv (no
// --project flag), so an argv-only detection would make the standalone
// project vanish inside workers ("Project not found in the worker process").
// Persist the decision into the environment — workers inherit it.
if (includeStandalone) {
  process.env.PLAYWRIGHT_INCLUDE_STANDALONE = '1';
}

/**
 * Playwright Test Configuration
 *
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',
  globalTeardown: './tests/src/helper/setup/global_teardown.js',

  // Test execution settings
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : (parseInt(process.env.PLAYWRIGHT_RETRIES) || 0),
  // Workers capped at 3 locally; override with PLAYWRIGHT_WORKERS=N.
  workers: process.env.CI ? 4 : (parseInt(process.env.PLAYWRIGHT_WORKERS) || 3),
  // 2 minutes per test — a self-hosted community server responds fast; tests
  // with known-long flows set larger budgets explicitly via test.setTimeout()
  timeout: 2 * 60 * 1000,

  // Test output directory
  outputDir: 'tests/test-results/artifacts',

  // Reporters
  reporter: [
    ['html', { outputFolder: 'tests/test-results/html', open: 'never' }],
    ['json', { outputFile: 'tests/test-results/results.json' }],
    ['./tests/src/reporter/clean-reporter.js'],
    // Adds inline failure annotations visible in the GitHub Actions log
    ...(process.env.CI ? [['github']] : []),
  ],

  // Shared settings for all projects
  use: {
    // Default: local community server (`npm run dev` / `npm start`, PORT=3838)
    baseURL: process.env.BASE_URL || 'http://localhost:3838',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: parseInt(process.env.PLAYWRIGHT_TIMEOUT) || 30000,
    // PromptOwl device-auth popups open dev.promptowl.ai, which sits behind
    // Vercel deployment protection for a fresh browser. Same escape hatch as
    // TheOwl's pipeline: send the bypass header on every request.
    ...(process.env.VERCEL_BYPASS_SECRET
      ? { extraHTTPHeaders: { 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS_SECRET } }
      : {}),
    // Optional overrides: PLAYWRIGHT_SLOW_MO slows every action for debugging;
    // PLAYWRIGHT_CHROMIUM_PATH points at a system Chromium when the
    // Playwright-managed download is unavailable (e.g. sandboxed CI).
    ...(process.env.PLAYWRIGHT_SLOW_MO || process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? {
        launchOptions: {
          ...(process.env.PLAYWRIGHT_SLOW_MO
            ? { slowMo: parseInt(process.env.PLAYWRIGHT_SLOW_MO) }
            : {}),
          ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
            : {}),
        },
      }
      : {}),
  },

  // Configure projects
  projects: [
    // Setup authentication (internal - used as dependency)
    {
      name: 'setup-auth',
      testMatch: 'tests/src/helper/setup/environment_setup.js',
      use: { ...devices['Desktop Chrome'] },
    },

    // Orphan sweep - cleans up AUTO_ entities from previous failed runs
    {
      name: 'orphan-sweep',
      dependencies: ['setup-auth'],
      testMatch: 'tests/features/global-cleanup/orphan_sweeper.spec.js',
      use: {
        ...devices['Desktop Chrome'],
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
      },
    },

    // Main test suite - runs all files defined in testRun array
    // Run with: npx playwright test --project=test-suite
    // Teardown projects run automatically after the last test (even on failure)
    {
      name: 'test-suite',
      dependencies: [
        'setup-auth',
        'orphan-sweep',
        ...testRun.filter((t) => t.enabled && !t.teardown).map((_, i) => `test-${i + 1}`),
      ],
      testMatch: /^$/, // Orchestrates the dynamic test projects
    },

    // Dynamic projects from testRun config (test-1, test-2, test-3, etc.)
    ...buildTestSuiteProjects(),

    // Standalone shortcut projects for running individual suites:
    //   npx playwright test --project=auth
    // Only included when explicitly targeted via --project to prevent
    // duplicate test runs when running the full suite.
    ...(includeStandalone
      ? [
        {
          name: 'auth',
          dependencies: ['setup-auth'],
          testMatch: 'tests/features/auth/**/*.spec.js',
          fullyParallel: false,
          use: {
            ...devices['Desktop Chrome'],
            screenshot: 'only-on-failure',
            trace: 'retain-on-failure',
          },
        },
        {
          name: 'dashboard',
          dependencies: ['setup-auth'],
          testMatch: 'tests/features/dashboard/**/*.spec.js',
          fullyParallel: false,
          use: {
            ...devices['Desktop Chrome'],
            screenshot: 'only-on-failure',
            trace: 'retain-on-failure',
          },
        },
        {
          name: 'my-work',
          dependencies: ['setup-auth'],
          testMatch: 'tests/features/my-work/**/*.spec.js',
          fullyParallel: false,
          use: {
            ...devices['Desktop Chrome'],
            screenshot: 'only-on-failure',
            trace: 'retain-on-failure',
          },
        },
        {
          name: 'my-drafts',
          dependencies: ['setup-auth'],
          testMatch: 'tests/features/my-drafts/**/*.spec.js',
          fullyParallel: false,
          use: {
            ...devices['Desktop Chrome'],
            screenshot: 'only-on-failure',
            trace: 'retain-on-failure',
          },
        },
        {
          name: 'access-requests',
          dependencies: ['setup-auth'],
          testMatch: 'tests/features/access-requests/**/*.spec.js',
          fullyParallel: false,
          use: {
            ...devices['Desktop Chrome'],
            screenshot: 'only-on-failure',
            trace: 'retain-on-failure',
          },
        },
      ]
      : []),
  ],
});
