#!/usr/bin/env node
// @ts-check

/**
 * Starts the server under test for an e2e run against this checkout's own
 * build, instead of a deployed server.
 *
 *   npm run build
 *   node tests/e2e-server/start.mjs          # stays in the foreground
 *   node tests/e2e-server/start.mjs wait     # in another shell: returns once ready
 *   BASE_URL=http://localhost:3838 npx playwright test --project=test-suite
 *
 * What it does
 *   1. Answers the server's license check on 127.0.0.1 (a valid enterprise
 *      license owned by the first test account). Nothing leaves the machine.
 *   2. Starts `node dist/index.js` on a fresh SQLite data folder, key auth,
 *      feature switches on (see lib.mjs).
 *   3. Seeds what the suites expect: the test accounts (TEST_ACCOUNT1_* is the
 *      server admin, TEST_ACCOUNT2_* an ordinary member) and a few
 *      qa-…@example.com people in the directory.
 *   4. Reports ready on GET http://127.0.0.1:<license port>/ready.
 *
 * Test-only. Never point a real server's PROMPTOWL_API_URL at this.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIRECTORY_PEOPLE, licenseAnswer, readSettings, serverEnv } from './lib.mjs';

const settings = readSettings(process.env);
const log = (msg) => console.log(`[e2e-server] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── `wait`: block until a running launcher reports ready ─────────────────────
if (process.argv[2] === 'wait') {
  const deadline = Date.now() + Number(process.env.E2E_SERVER_WAIT_SECONDS || 180) * 1000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${settings.licenseUrl}/ready`);
      last = `${res.status} ${await res.text()}`;
      if (res.status === 200) {
        log(`ready: ${settings.baseUrl}`);
        process.exit(0);
      }
      if (res.status === 500) break; // the launcher gave up
    } catch (err) {
      last = String(err.cause?.code || err.message);
    }
    await sleep(1000);
  }
  console.error(`[e2e-server] not ready: ${last}`);
  process.exit(1);
}

// ── 1. License endpoint + readiness ──────────────────────────────────────────
/** @type {'starting' | 'ready' | 'failed'} */
let state = 'starting';
let failure = '';

const licenseServer = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  req.resume();
  if (req.method === 'GET' && req.url === '/ready') {
    if (state === 'ready') return send(200, { status: 'ready' });
    if (state === 'failed') return send(500, { status: 'failed', error: failure });
    return send(503, { status: 'starting' });
  }
  if (req.method === 'POST' && req.url === '/api/license/validate') {
    return send(200, licenseAnswer(settings.accounts[0].email));
  }
  // Anything else the server might send PromptOwl's way (telemetry, sign-in)
  // has no answer here.
  return send(404, { error: 'not served by the e2e launcher' });
});
await new Promise((resolve, reject) => {
  licenseServer.once('error', reject);
  licenseServer.listen(settings.licensePort, '127.0.0.1', () => resolve(undefined));
});

// ── 2. The server under test ─────────────────────────────────────────────────
const ownsDataRoot = !settings.dataRoot;
const dataRoot = settings.dataRoot || mkdtempSync(join(tmpdir(), 'cn-e2e-data-'));
log(`data folder: ${dataRoot}`);
log(`starting: ${settings.serverCommand.join(' ')}`);

const [cmd, ...args] = settings.serverCommand;
const server = spawn(cmd, args, {
  env: { ...process.env, ...serverEnv(settings, dataRoot) },
  stdio: 'inherit',
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  licenseServer.close();
  if (server.exitCode === null) server.kill('SIGTERM');
  if (ownsDataRoot) {
    try {
      rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  process.exitCode = code;
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
server.on('exit', (code) => {
  if (stopping) return;
  state = 'failed';
  failure = `the server exited with code ${code}`;
  console.error(`[e2e-server] ${failure}`);
  stop(1);
});

// ── 3. Seed ──────────────────────────────────────────────────────────────────
async function call(method, path, body, cookie) {
  const res = await fetch(`${settings.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

function must(what, res, ok) {
  if (!ok.includes(res.status)) {
    throw new Error(`${what} answered ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  return res;
}

async function seed() {
  // Wait for the server to answer.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(`${settings.baseUrl}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('the server did not answer /health within 120s');
    await sleep(500);
  }

  // The test accounts, through the same sign-up a person would use.
  let adminCookie = '';
  for (const [i, account] of settings.accounts.entries()) {
    const res = must(`POST /auth/register (${account.email})`, await call('POST', '/auth/register', account), [201]);
    if (i === 0) adminCookie = res.cookie;
    log(`account: ${account.email}${i === 0 ? ' (server admin)' : ''}`);
  }

  const status = must('GET /auth/admin-status', await call('GET', '/auth/admin-status', undefined, adminCookie), [200]);
  if (status.data?.me?.is_admin !== true) {
    throw new Error(`${settings.accounts[0].email} is not a server admin on the fresh server`);
  }

  // People the collaborator and steward suites add to nests.
  for (const email of DIRECTORY_PEOPLE) {
    must(`POST /auth/invite (${email})`, await call('POST', '/auth/invite', { email }, adminCookie), [200, 201]);
    log(`directory: ${email}`);
  }
}

try {
  await seed();
  state = 'ready';
  log(`ready: ${settings.baseUrl}`);
} catch (err) {
  state = 'failed';
  failure = err.message;
  console.error(`[e2e-server] seed failed: ${failure}`);
  // Stay up briefly so `wait` can read the failure, then stop.
  await sleep(3000);
  stop(1);
}
