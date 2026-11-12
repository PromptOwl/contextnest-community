/**
 * po-1186 CR1 — review follow-ups on the decision ledger and the agent event
 * API: the Postgres `surface_windows.run_id` backfill (once, bounded), ledger
 * aggregates in SQL over denormalised run totals, a batched page and export,
 * the export's order of checks and its audit row on failure, the race-safe
 * concurrent-roots cap, and one timestamp format on both drivers.
 *
 * Runs on SQLite by default; set TEST_SUITE_PG_URL to run the app suites on
 * Postgres and TEST_DATABASE_URL for the Postgres migration case.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const T0 = "2026-11-01T00:00:00.000Z";

// ─── App suites ────────────────────────────────────────────────────────────

let env: ReturnType<typeof setupTestEnv>;
let app: any;
type U = { apiKey: string; userId: string; email: string };
let alice: U;
let bob: U;
let N: string;
let RACE: string;
let writeKey: string;
let raceKey: string;

const getDb = async () => (await import("../src/db/client.js")).getDb();
const one = async (sql: string, p: any[] = []) => (await getDb()).get(sql, p) as Promise<any>;
const run = async (sql: string, p: any[] = []) => (await getDb()).run(sql, p);

async function req(method: string, path: string, body: unknown, key: string, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text, headers: res.headers };
}

/** Count the queries a block makes, and keep their SQL. */
async function counting<T>(fn: () => Promise<T>): Promise<{ out: T; n: number; sql: string[] }> {
  const db = (await getDb()) as any;
  const sql: string[] = [];
  const orig = { get: db.get, all: db.all };
  db.get = function (s: string, p?: unknown[]) {
    sql.push(s);
    return orig.get.call(this, s, p);
  };
  db.all = function (s: string, p?: unknown[]) {
    sql.push(s);
    return orig.all.call(this, s, p);
  };
  try {
    const out = await fn();
    return { out, n: sql.length, sql };
  } finally {
    db.get = orig.get;
    db.all = orig.all;
  }
}

const LISTENER = "nodes/agents/listener-rv";
const META = "nodes/agents/meta-rv";
const ROWS_FROM = "2026-09-01T00:00:00.000Z";
const ROWS_TO = "2026-09-30T00:00:00.000Z";
const range = { from: ROWS_FROM, to: ROWS_TO };
const qs = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined) as Array<[string, string]>).toString();

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@rv.test", "Alice");
  await resetAuthRateLimit();
  bob = await registerUser(app, "bob@rv.test", "Bob");
  await resetAuthRateLimit();
  N = (await jsonRequest(app, "POST", "/nests", { name: "Review" }, alice.apiKey)).data.nest.id;
  RACE = (await jsonRequest(app, "POST", "/nests", { name: "Race" }, alice.apiKey)).data.nest.id;
  writeKey = (await jsonRequest(app, "POST", "/auth/keys", { label: "rv-agent", nest_id: N }, alice.apiKey)).data.api_key;
  raceKey = (await jsonRequest(app, "POST", "/auth/keys", { label: "race-agent", nest_id: RACE }, alice.apiKey)).data.api_key;
  expect((await req("POST", `/nests/${N}/agents`, { name: "Claude Code RV" }, writeKey)).status).toBe(201);
  expect((await req("POST", `/nests/${RACE}/agents`, { name: "Racer" }, raceKey)).status).toBe(201);

  // 60 ledger rows over September: windows with proposals, reviews and
  // commits; runs with decisions and review back-links; every lookup a row
  // can need.
  const installId = `inst_${randomUUID()}`;
  await run(`INSERT INTO surface_installs (id, org_id, surface, mode, tenant_key, team_id, status) VALUES (?, 'org', 'slack', 'manifest', 'T0RV', 'T0RV', 'active')`, [installId]);
  const bindings: string[] = [];
  for (const ch of ["CA", "CB", "CC"]) {
    const id = `bnd_${randomUUID()}`;
    await run(
      `INSERT INTO surface_bindings (id, install_id, org_id, nest_id, conversation_id, conversation_kind, conversation_name, listener_agent_node_id, status, capture_ok, surface_ok)
       VALUES (?, ?, 'org', ?, ?, 'private_channel', ?, ?, 'active', 1, 1)`,
      [id, installId, N, ch, ch.toLowerCase(), LISTENER],
    );
    bindings.push(id);
  }
  const base = Date.parse("2026-09-02T00:00:00.000Z");
  for (let i = 0; i < 30; i++) {
    const at = iso(base + i * 3600_000 * 7);
    const wid = randomUUID();
    await run(
      `INSERT INTO surface_windows (id, binding_id, nest_id, thread_key, opened_at, last_message_at, closed_at, message_count, status, verdict, reason_code, item_count, kinds, model, prompt_version, cost_micros, judged_at)
       VALUES (?, ?, ?, 'channel', ?, ?, ?, 4, 'judged', 'proposed', 'proposed', 1, '["decision"]', 'm', 'v3', 1500, ?)`,
      [wid, bindings[i % 3], N, at, at, at, at],
    );
    const pid = `prop_${randomUUID()}`;
    await run(`INSERT INTO surface_proposals (id, window_id, binding_id, nest_id, card_kind, state, expires_at, posted_at) VALUES (?, ?, ?, ?, 'single', 'decided', ?, ?)`, [pid, wid, bindings[i % 3], N, at, at]);
    await run(
      `INSERT INTO surface_proposal_items (id, proposal_id, nest_id, item_kind, op, target_folder, title, state, edited, decided_by_user_id, decided_at, reason, node_id, version)
       VALUES (?, ?, ?, 'decision', 'new', 'inbox/', ?, 'approved', 0, ?, ?, NULL, ?, 1)`,
      [`item_${randomUUID()}`, pid, N, `Decision ${i}`, bob.userId, at, `nodes/inbox/d${i}`],
    );
    await run(
      `INSERT INTO surface_commits (id, nest_id, node_id, version, proposal_id, window_id, approved_by_user_id, surface, install_id, conversation_id, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 'slack', ?, 'C_A', ?)`,
      [`cmt_${randomUUID()}`, N, `nodes/inbox/d${i}`, pid, wid, bob.userId, installId, at],
    );
    const rid = `run_${randomUUID()}`;
    const trace = { est_cost_usd: 0.004, usage: { input_tokens: 300, output_tokens: 20 } };
    await run(
      `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, trace, started_at, finished_at, claimed_by, source, verdict, reason_code, est_cost_micros, tokens)
       VALUES (?, ?, ?, 'agent@rv.test', 'succeeded', ?, ?, ?, 'server:metacognition', 'server:metacognition', 'propose', 'seeded', 4000, 320)`,
      [rid, N, META, JSON.stringify(trace), at, at],
    );
    await run(`INSERT INTO run_steps (run_id, seq, action, detail, at) VALUES (?, 1, 'decision', ?, ?)`, [rid, JSON.stringify({ verdict: "propose", reason_code: "seeded", summary: `S${i}` }), at]);
    await run(
      `INSERT INTO review_requests (id, nest_id, node_id, version, requested_by, requested_at, status, resolved_by, resolved_at, run_id)
       VALUES (?, ?, ?, 1, 'agent@rv.test', ?, 'approved', 'bob@rv.test', ?, ?)`,
      [`rv_${randomUUID()}`, N, `nodes/meta/r${i}`, at, at, rid],
    );
  }
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  await env?.cleanup();
});

beforeEach(async () => {
  await resetAuthRateLimit();
});

// ─── 2. Aggregates in SQL over denormalised run totals ─────────────────────

describe("ledger aggregates and the page", () => {
  it("closing a run stores its cost and tokens on the run (as the verdict is), and a cancelled run's usage too", async () => {
    const start = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-rv`, { report_only: true }, writeKey);
    expect(start.status).toBe(201);
    const id = start.data.run_id;
    const close = await req("PATCH", `/runs/${id}`, { status: "succeeded", usage: { input_tokens: 1000, output_tokens: 234 }, est_cost_usd: 0.0123 }, writeKey);
    expect(close.status).toBe(200);
    expect(await one("SELECT est_cost_micros, tokens FROM runs WHERE id = ?", [id])).toEqual({ est_cost_micros: 12300, tokens: 1234 });
    // A close without a trace keeps what is there.
    const s2 = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-rv`, { report_only: true }, writeKey);
    await req("PATCH", `/runs/${s2.data.run_id}`, { status: "succeeded" }, writeKey);
    const r2 = await one("SELECT est_cost_micros, tokens FROM runs WHERE id = ?", [s2.data.run_id]);
    expect(Number(r2.est_cost_micros ?? 0)).toBe(0);
    expect(Number(r2.tokens ?? 0)).toBe(0);
    // The ledger reports the stored totals.
    const page = await req("GET", `/nests/${N}/ledger?agent=nodes/agents/claude-code-rv&limit=200`, undefined, alice.apiKey);
    expect(page.data.totals).toMatchObject({ cost_usd: 0.0123, tokens: 1234 });
    expect(page.data.entries.find((e: any) => e.entry_id === id).run.cost_usd).toBe(0.0123);
  });

  it("totals and rollups are one SQL aggregate each that never reads run_trace", async () => {
    const { n, sql, out } = await counting(() => req("GET", `/nests/${N}/ledger?${qs({ ...range, limit: "1" })}`, undefined, alice.apiKey));
    expect(out.status).toBe(200);
    expect(out.data.totals).toMatchObject({ entries: 60, proposals: 60, approved: 60, tokens: 30 * 320 });
    expect(Math.round(out.data.totals.cost_usd * 1e6)).toBe(30 * 1500 + 30 * 4000);
    const totalsSql = sql.filter((s) => /COUNT\(\*\) AS entries/.test(s));
    expect(totalsSql.length).toBe(1);
    expect(totalsSql[0]).not.toMatch(/trace/);
    expect(n).toBeLessThan(25);
    const roll = await counting(() => req("GET", `/nests/${N}/rollups?${qs({ ...range, grain: "week", by: "agent" })}`, undefined, alice.apiKey));
    expect(roll.out.status).toBe(200);
    const rollSql = roll.sql.filter((s) => /COUNT\(\*\) AS entries/.test(s));
    expect(rollSql.length).toBe(1);
    expect(rollSql[0]).toMatch(/GROUP BY/);
    expect(rollSql[0]).not.toMatch(/trace/);
    const sum = roll.out.data.rows.reduce((a: number, r: any) => a + r.entries, 0);
    expect(sum).toBe(60);
    expect(roll.out.data.totals).toEqual(out.data.totals);
  });

  it("a 60-row page costs a fixed number of queries, not a few per row", async () => {
    const { n, out } = await counting(() => req("GET", `/nests/${N}/ledger?${qs({ ...range, limit: "200" })}`, undefined, alice.apiKey));
    expect(out.status).toBe(200);
    expect(out.data.entries.length).toBe(60);
    // Every hop still filled in.
    const win = out.data.entries.find((e: any) => e.agent.source === "surfaces");
    expect(win.review.by).toBe(bob.email);
    expect(win.commit).toMatchObject({ version: 1 });
    expect(win.source.url).toMatch(/app\.slack\.com\/client\/T0RV\//);
    expect(win.agent.name).toBeTruthy();
    const meta = out.data.entries.find((e: any) => e.agent.source === "metacognition");
    expect(meta.decision.summary).toMatch(/^S\d+$/);
    expect(meta.review.by).toBe("bob@rv.test");
    expect(meta.commit).toMatchObject({ version: 1 });
    expect(n).toBeLessThan(30);
  });
});

// ─── 3. Export ─────────────────────────────────────────────────────────────

describe("ledger export", () => {
  it("a bad request is a 422 that does not spend one of the hourly exports", async () => {
    for (let i = 0; i < 8; i++) {
      const bad = await req("GET", `/nests/${N}/ledger/export?format=xml`, undefined, alice.apiKey);
      expect(bad.status).toBe(422);
    }
    const good = await req("GET", `/nests/${N}/ledger/export?${qs({ ...range, format: "csv" })}`, undefined, alice.apiKey);
    expect(good.status).toBe(200);
  });

  it("a failed export is still written to the access log, as a failure", async () => {
    const { ledgerTestHooks } = await import("../src/governance/ledger-service.js");
    ledgerTestHooks.failExport = true;
    try {
      const res = await req("GET", `/nests/${N}/ledger/export?${qs({ ...range, format: "ndjson" })}`, undefined, alice.apiKey);
      expect(res.status).toBe(500);
    } finally {
      ledgerTestHooks.failExport = false;
    }
    const { flushAccessLog } = await import("../src/governance/access-log.js");
    await flushAccessLog();
    const row = await one("SELECT * FROM node_access_events WHERE nest_id = ? AND action = 'export' ORDER BY id DESC LIMIT 1", [N]);
    expect(row).toMatchObject({ user_id: alice.userId, surface: "api" });
    expect(row.detail).toMatch(/decision ledger export failed/);
  });

  it("an export is batched: a fixed number of queries per 200-row page, not ~4 per row", async () => {
    const { n, out } = await counting(() => req("GET", `/nests/${N}/ledger/export?${qs({ ...range, format: "ndjson" })}`, undefined, alice.apiKey));
    expect(out.status).toBe(200);
    expect(out.text.trim().split("\n").length).toBe(60);
    expect(n).toBeLessThan(30);
  });
});

// ─── 5. Concurrent-roots cap, timestamps ───────────────────────────────────

describe("agent event API: smaller points", () => {
  it("the concurrent-roots cap holds under a burst of report-only starts", async () => {
    const prev = process.env.RUN_MAX_CONCURRENT_ROOTS;
    process.env.RUN_MAX_CONCURRENT_ROOTS = "3";
    try {
      const res = await Promise.all(
        Array.from({ length: 10 }, () => req("POST", `/nests/${RACE}/run/nodes/agents/racer`, { report_only: true }, raceKey)),
      );
      expect(res.filter((r) => r.status === 201).length).toBe(3);
      expect(res.filter((r) => r.status === 409).length).toBe(7);
      const { n } = await one("SELECT COUNT(*) AS n FROM runs WHERE nest_id = ? AND status = 'running' AND parent_run_id IS NULL", [RACE]);
      expect(Number(n)).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.RUN_MAX_CONCURRENT_ROOTS;
      else process.env.RUN_MAX_CONCURRENT_ROOTS = prev;
    }
  });

  it("runs.started_at and surface_windows.judged_at share one format (ISO 8601, ms, Z) on this driver, so the ledger's string order is time order", async () => {
    const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    const s = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-rv`, { report_only: true, started_at: new Date(Date.now() - 60_000).toISOString().replace("Z", "+00:00") }, writeKey);
    expect(s.status).toBe(201);
    const db = await getDb();
    const runs = (await db.all("SELECT started_at FROM runs WHERE nest_id IN (?, ?)", [N, RACE])) as Array<{ started_at: string }>;
    const wins = (await db.all("SELECT judged_at FROM surface_windows WHERE nest_id = ?", [N])) as Array<{ judged_at: string }>;
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r.started_at).toMatch(ISO);
    for (const w of wins) expect(w.judged_at).toMatch(ISO);
  });
});
