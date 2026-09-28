# ContextNest Community — Playwright E2E Tests

End-to-end browser tests for the ContextNest Community server, built on the
same automation framework as PromptOwl (TheOwl): role-based stored sessions,
page-object model, a file-backed entity registry with orphan sweeping, and an
ordered test-suite chain with an always-run teardown.

## Layout

```
playwright.config.js          Test-run chain, projects, reporters
tests/
├── env.template              Copy into tests/.env/.local (or .dev) and fill in
├── .env/                     Environment files (gitignored)
├── TEST_IDS.md               data-testid reference
├── fixtures/                 Static test files (uploads etc.)
├── features/                 Spec files, one folder per functional area
│   ├── auth/
│   └── global-cleanup/       Orphan sweeper + always-run teardown
└── src/
    ├── lib/                  base_test (fixtures), roles, entity_registry,
    │                         cleanup_manager
    ├── helper/
    │   ├── logger/           Winston logger
    │   ├── utility/          CommonFunction helpers (AUTO_ name generator, …)
    │   └── setup/            environment_setup (auth), global_teardown
    ├── page_factory/         Page object model, one folder per area
    │   ├── auth/             login_page
    │   └── app/              app_shell_page, nests_page
    ├── reporter/             clean-reporter (compact console output)
    └── cookies_storage/      Stored sessions + entity registry (gitignored)
```

## Setup

1. Install dependencies and the browser:

   ```bash
   npm install
   npx playwright install chromium
   ```

2. Create an environment file:

   ```bash
   mkdir -p tests/.env
   cp tests/env.template tests/.env/.local
   # edit tests/.env/.local — BASE_URL + TEST_ACCOUNT1_* credentials
   ```

   The server under test must run in KEY auth mode with the test account
   registered (self-register on an open server, or an admin invite).

3. Start the server (for local runs): `npm run dev` or `npm start`.

## Running

```bash
# Full ordered suite (auth setup → orphan sweep → tests → teardown)
npm run test:playwright

# Same, explicit
npx playwright test --project=test-suite

# One suite standalone (auth setup still runs first)
npx playwright test --project=auth

# Different environment file
ENV=dev npx playwright test --project=test-suite

# Headed / debug
npx playwright test --project=test-suite --headed
PLAYWRIGHT_SLOW_MO=500 npx playwright test --project=auth --headed
```

Reports land in `tests/test-results/` (HTML report at
`tests/test-results/html/index.html`).

## How it works

- **setup-auth** logs each configured role in through the UI once and stores
  the session (`cnst_session` cookie) in `tests/src/cookies_storage/<alias>.json`.
  Later runs reuse the stored session while the cookie is valid.
- **Role fixtures** (`primary_user`, `secondary_user`) from
  `tests/src/lib/base_test.js` open a pre-authenticated context lazily:
  `await primary_user.initialize()` then `primary_user.page` /
  `primary_user.nestsPage` etc.
- **Entity registry**: every entity a test creates must be named with
  `commonFunction.generateEntityName()` (AUTO_ prefix) and registered via
  `registerEntity('nests', { id, name })`. The teardown deletes registered
  entities through the REST API; the pre-run **orphan sweeper** deletes stale
  registry entries and any AUTO_ nests left by crashed runs.
- **Test chain**: `testRun` in `playwright.config.js` defines file order,
  parallel/serial mode and independence. Add a new suite by dropping a spec
  under `tests/features/<area>/` and adding an entry to `testRun`.

## Writing tests

- Use the page-object model: locators and interactions live in
  `tests/src/page_factory/`, specs stay declarative.
- Prefer `data-testid` selectors; add missing test IDs to the UI (kebab-case,
  `{area}-{component}-{element}`) and document them in `tests/TEST_IDS.md`.
- Number test cases (`TC-0xx`) and keep titles behavior-focused.
- Never hardcode credentials — everything comes from `tests/.env/`.

## CI

`.github/workflows/contextnest-community-tests.yml` runs the suite on GitHub
Actions (PRs into development/main, push to main, and manual dispatch) against
the environment URL configured in
repository variables, with credentials from repository secrets
(`TEST_ACCOUNT1_USER`, `TEST_ACCOUNT1_PW`, …). The HTML report and traces are
uploaded as a workflow artifact.
