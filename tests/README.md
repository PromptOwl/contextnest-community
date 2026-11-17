# ContextNest Community — Playwright E2E Tests

End-to-end browser tests for the ContextNest Community server, built on the same automation framework as PromptOwl (TheOwl): role-based stored sessions, page-object model, a file-backed entity registry with orphan sweeping, and an ordered test-suite chain with an always-run teardown.

## Layout

```
playwright.config.js          Projects, reporters (suites are discovered)
tests/
├── env.template              Copy into tests/.env/.local (or .dev) and fill in
├── .env/                     Environment files (gitignored)
├── TEST_IDS.md               data-testid reference
├── fixtures/                 Static test files (uploads etc.)
├── features/                 Spec files, one folder per functional area
│   ├── auth/                 (optional suite.json per folder, see below)
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

   The server under test must run in KEY auth mode with the test account registered (self-register on an open server, or an admin invite).

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

Reports land in `tests/test-results/` (HTML report at `tests/test-results/html/index.html`).

## How it works

- **setup-auth** logs each configured role in through the UI once and stores the session (`cnst_session` cookie) in `tests/src/cookies_storage/<alias>.json`. Later runs reuse the stored session while the cookie is valid.
- **Role fixtures** (`primary_user`, `secondary_user`) from `tests/src/lib/base_test.js` open a pre-authenticated context lazily: `await primary_user.initialize()` then `primary_user.page` / `primary_user.nestsPage` etc.
- **Entity registry**: every entity a test creates must be named with `commonFunction.generateEntityName()` (AUTO_ prefix) and registered via `registerEntity('nests', { id, name })`. The teardown deletes registered entities through the REST API; the pre-run **orphan sweeper** deletes stale registry entries and any AUTO_ nests left by crashed runs.
- **Test chain**: the suites are discovered from `tests/features/` (`tests/src/helper/setup/suite_discovery.js`). Every folder is a suite and every `*.spec.js` in it is one entry in the run.

## Adding a suite

Add a folder under `tests/features/<area>/` with its spec. That is all: the spec joins the full run, and `npx playwright test --project=<area>` runs it alone. Do not edit `playwright.config.js`.

A suite runs serial and independent of the other suites. If yours differs, put a `suite.json` next to the spec:

| Setting | Default | Meaning |
|---|---|---|
| `"mode": "parallel"` | `"serial"` | The tests in each file run at the same time. |
| `"independent": false` | `true` | Wait for the previous suite and stop if it failed. |
| `"enabled": false` | `true` | Leave the suite out of the full run. |
| `"standalone": false` | `true` | No `--project=<area>` shortcut. |
| `"baseURL": "https://…"` | the run's | Run against another server. |

`global-cleanup/` is not a suite: it holds the orphan sweep and the teardown, which the config wires up by hand.

## Writing tests

- Use the page-object model: locators and interactions live in `tests/src/page_factory/`, specs stay declarative.
- Prefer `data-testid` selectors; add missing test IDs to the UI (kebab-case, `{area}-{component}-{element}`) and document them in `tests/TEST_IDS.md`.
- Number test cases (`TC-0xx`) and keep titles behavior-focused.
- Never hardcode credentials — everything comes from `tests/.env/`.

## Running against your own build

`tests/e2e-server/start.mjs` starts this checkout's build on localhost with a fresh database, so the suite tests your code and not a deployed server. It needs no secrets.

```bash
npm run build

# The two accounts are created on the fresh server. Pick any values.
export TEST_ACCOUNT1_ALIAS=primary_user  TEST_ACCOUNT1_USER=e2e-admin@example.com   TEST_ACCOUNT1_PW='E2e-local-Admin-1!'
export TEST_ACCOUNT2_ALIAS=secondary_user TEST_ACCOUNT2_USER=e2e-member@example.com TEST_ACCOUNT2_PW='E2e-local-Member-1!'

node tests/e2e-server/start.mjs &          # server on http://localhost:3838
node tests/e2e-server/start.mjs wait       # returns once it is seeded

BASE_URL=http://localhost:3838 npx playwright test --project=test-suite
```

What the launcher sets up:

- The built server (`node dist/index.js`) on a fresh SQLite data folder in the system temp folder, in key auth mode, with the feature switches on (`tests/e2e-server/lib.mjs`).
- The first account as the server admin and the second as an ordinary member, plus three `qa-…@example.com` people in the directory for the collaborator and steward suites.
- The welcome screen closed for both accounts. Someone who owns no nest gets it in place of the nest list, and the second account owns none on a fresh server.
- Idle connections kept open for two minutes (`tests/e2e-server/keep-alive.mjs`). Node's default is five seconds, and an API call that reuses a connection just as the server closes it fails with `ECONNRESET`.
- A license answer served on `127.0.0.1:4010`, so the server runs as a licensed enterprise server without calling PromptOwl. This is for tests only.

Every launch is a new server, so a session saved by an earlier run is no longer valid and every API call answers 401 "Your session has expired". Delete `tests/src/cookies_storage/*.json` before the next run.

Set `E2E_SERVER_CMD="node --import tsx src/index.ts"` to run from source without building the server (the UI still needs `npm run build:ui`). `E2E_SERVER_PORT`, `E2E_LICENSE_PORT` and `E2E_DATA_ROOT` override the ports and the data folder.

## CI

Two workflows run the suite on a pull request:

- `.github/workflows/e2e-pr-build.yml` ("e2e (PR build)") builds the PR, starts it with `tests/e2e-server/start.mjs` and runs the suite against it. It tests the PR's own code, needs no secrets, and runs for every PR at once. Every `CN_EXPECT_*` is set to 1 there, so a spec that skips when "the server under test does not ship this yet" fails instead.
- The workflow below runs the same suite against the deployed server.

`.github/workflows/contextnest-community-tests.yml` runs the suite on GitHub Actions (PRs into development/main, push to main, and manual dispatch) against the environment URL configured in repository variables, with credentials from repository secrets (`TEST_ACCOUNT1_USER`, `TEST_ACCOUNT1_PW`, …). The HTML report and traces are uploaded as a workflow artifact.
