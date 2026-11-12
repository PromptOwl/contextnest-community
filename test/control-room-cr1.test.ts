/**
 * po-1186 CR1 — the agent control room backend: the decision ledger, its
 * trace, export and rollups, and the agent event API (register, report-only
 * run, typed steps, idempotent close), REST and MCP, through the real routes
 * and DB. Each test is named for the acceptance criterion it proves
 * (plan.md AC-CR-05..12). The listener-window cases that need the real judge
 * (AC-CR-05 Surfaces, AC-CR-05b, AC-CR-06) live in surfaces-s2b.test.ts,
 * which has the Slack + model fakes.
 *
 * Fixture rows for the read model (windows, proposals, metacognition runs,
 * personal nests) are seeded straight into the tables the ledger reads; the
 * external agent path goes through the HTTP API end to end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit, settleSeals } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
type U = { apiKey: string; userId: string; email: string };
let root: U; // server admin
let alice: U; // owner of the team nests
let bob: U; // reviewer on N
let pat: U; // owner of a personal (DM) nest
let N: string; // team nest
let N2: string; // another nest alice owns
let P: string; // pat's personal nest
let writeKey: string; // nest-scoped write key for N (the external agent)
let readKey: string; // nest-scoped read key for N
let n2Key: string; // nest-scoped write key for N2

const db = async () => (await import("../src/db/client.js")).getDb();
const all = async (sql: string, p: any[] = []) => (await db()).all(sql, p) as Promise<any[]>;
const one = async (sql: string, p: any[] = []) => (await db()).get(sql, p) as Promise<any>;
const run = async (sql: string, p: any[] = []) => (await db()).run(sql, p);

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

async function mcp(nestId: string | null, key: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(nestId ? `/nests/${nestId}/mcp` : "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text: string = body?.result?.content?.[0]?.text ?? JSON.stringify(body);
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { text, data, raw: body };
}

async function mcpTools(nestId: string | null, key: string): Promise<string[]> {
  const res = await app.request(nestId ? `/nests/${nestId}/mcp` : "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const body = await res.json();
  return (body?.result?.tools ?? []).map((t: any) => t.name);
}

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

// ─── Fixture seeding (read-model tables) ─────────────────────────────────────

let installId: string;
async function seedBinding(nestId: string, channel: string, listener: string): Promise<string> {
  const id = `bnd_${randomUUID()}`;
  await run(
    `INSERT INTO surface_bindings (id, install_id, org_id, nest_id, conversation_id, conversation_kind, conversation_name, listener_agent_node_id, status, capture_ok, surface_ok)
     VALUES (?, ?, 'org', ?, ?, 'private_channel', ?, ?, 'active', 1, 1)`,
    [id, installId, nestId, channel, channel.toLowerCase(), listener],
  );
  return id;
}

interface SeedItem {
  state: "approved" | "rejected" | "expired" | "pending" | "withdrawn";
  edited?: boolean;
  title?: string;
  by?: string;
  reason?: string | null;
}
async function seedWindow(o: {
  nestId: string;
  bindingId: string;
  listener: string;
  at: string;
  verdict: "no_op" | "proposed" | "error";
  reason?: string;
  costMicros?: number;
  items?: SeedItem[];
  commit?: { nodeId: string; version: number; by: string };
}) {
  const id = randomUUID();
  const runId = `run_${randomUUID()}`;
  await run(
    `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, trace, started_at, finished_at, claimed_by, source)
     VALUES (?, ?, ?, 'surfaces:window', 'succeeded', ?, ?, ?, 'server:surfaces', 'server:surfaces')`,
    [runId, o.nestId, o.listener, JSON.stringify({ kind: "surfaces_judge", est_cost_usd: (o.costMicros ?? 0) / 1e6 }), o.at, o.at],
  );
  await run(
    `INSERT INTO surface_windows (id, binding_id, nest_id, thread_key, opened_at, last_message_at, closed_at, message_count, status, verdict, reason_code, item_count, kinds, model, prompt_version, cost_micros, judged_at, run_id)
     VALUES (?, ?, ?, 'channel', ?, ?, ?, 6, 'judged', ?, ?, ?, ?, 'claude-haiku', 'v3', ?, ?, ?)`,
    [id, o.bindingId, o.nestId, o.at, o.at, o.at, o.verdict, o.reason ?? (o.verdict === "proposed" ? "proposed" : "chatter"), o.items?.length ?? 0, JSON.stringify(o.items?.length ? ["decision"] : []), o.costMicros ?? 0, o.at, runId],
  );
  if (o.items?.length) {
    const pid = `prop_${randomUUID()}`;
    await run(
      `INSERT INTO surface_proposals (id, window_id, binding_id, nest_id, card_kind, state, expires_at, posted_at)
       VALUES (?, ?, ?, ?, 'single', 'decided', ?, ?)`,
      [pid, id, o.bindingId, o.nestId, iso(Date.parse(o.at) + 7 * DAY), o.at],
    );
    for (const it of o.items) {
      const decided = it.state !== "pending";
      await run(
        `INSERT INTO surface_proposal_items (id, proposal_id, nest_id, item_kind, op, target_folder, title, state, edited, decided_by_user_id, decided_at, reason, node_id, version)
         VALUES (?, ?, ?, 'decision', 'new', 'inbox/', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `item_${randomUUID()}`,
          pid,
          o.nestId,
          it.title ?? `Decision ${randomUUID().slice(0, 6)}`,
          it.state,
          it.edited ? 1 : 0,
          decided ? it.by ?? null : null,
          decided ? iso(Date.parse(o.at) + 60_000) : null,
          it.reason ?? null,
          o.commit?.nodeId ?? null,
          o.commit?.version ?? null,
        ],
      );
    }
    if (o.commit) {
      await run(
        `INSERT INTO surface_commits (id, nest_id, node_id, version, proposal_id, window_id, approved_by_user_id, surface, install_id, conversation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'slack', ?, 'C9', ?)`,
        [`cmt_${randomUUID()}`, o.nestId, o.commit.nodeId, o.commit.version, pid, id, o.commit.by, installId, iso(Date.parse(o.at) + 60_000)],
      );
    }
  }
  return { windowId: id, runId };
}

async function seedRun(o: {
  nestId: string;
  agent: string;
  at: string;
  source: "server:metacognition" | "external" | "runner";
  status?: "succeeded" | "failed" | "running";
  verdict?: string | null;
  costUsd?: number;
  tokens?: number;
  reviews?: Array<"approved" | "rejected" | "pending" | "cancelled">;
}) {
  const id = `run_${randomUUID()}`;
  await run(
    // est_cost_micros / tokens: what closing the run stores from its trace.
    `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, trace, started_at, finished_at, claimed_by, source, verdict, reason_code, est_cost_micros, tokens)
     VALUES (?, ?, ?, 'agent@x.test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      o.nestId,
      o.agent,
      o.status ?? "succeeded",
      JSON.stringify({ est_cost_usd: o.costUsd ?? 0, usage: { input_tokens: o.tokens ?? 0 } }),
      o.at,
      o.at,
      o.source === "server:metacognition" ? "server:metacognition" : null,
      o.source,
      o.verdict ?? null,
      o.verdict ? "seeded" : null,
      Math.round((o.costUsd ?? 0) * 1_000_000),
      o.tokens ?? 0,
    ],
  );
  for (const st of o.reviews ?? []) {
    await run(
      `INSERT INTO review_requests (id, nest_id, node_id, version, requested_by, requested_at, status, resolved_by, resolved_at, run_id)
       VALUES (?, ?, ?, 1, 'agent@x.test', ?, ?, ?, ?, ?)`,
      [`rv_${randomUUID()}`, o.nestId, `nodes/seed/${randomUUID().slice(0, 8)}`, o.at, st, st === "pending" ? null : "bob@cr.test", st === "pending" ? null : o.at, id],
    );
  }
  return id;
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@cr.test"] });
  root = await registerUser(app, "root@cr.test", "Root");
  await resetAuthRateLimit();
  alice = await registerUser(app, "alice@cr.test", "Alice");
  await resetAuthRateLimit();
  bob = await registerUser(app, "bob@cr.test", "Bob");
  await resetAuthRateLimit();
  pat = await registerUser(app, "pat@cr.test", "Pat");
  await resetAuthRateLimit();
  N = (await jsonRequest(app, "POST", "/nests", { name: "Revenue" }, alice.apiKey)).data.nest.id;
  N2 = (await jsonRequest(app, "POST", "/nests", { name: "Ops" }, alice.apiKey)).data.nest.id;
  P = (await jsonRequest(app, "POST", "/nests", { name: "Pat DM" }, pat.apiKey)).data.nest.id;
  // Alice administers Pat's personal nest (she is not its owner: N1 applies to her).
  await jsonRequest(app, "POST", `/nests/${P}/collaborators`, { email: alice.email, permission: "admin" }, pat.apiKey);
  await jsonRequest(app, "POST", `/nests/${N}/collaborators`, { email: bob.email, permission: "read" }, alice.apiKey);
  // Governance on N, Bob reviews.
  await jsonRequest(app, "PATCH", `/nests/${N}/settings`, { stewardship_enabled: true }, alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${N}/stewards`, { scope: "nest", users: [{ email: bob.email, role: "reviewer" }] }, alice.apiKey);
  writeKey = (await jsonRequest(app, "POST", "/auth/keys", { label: "claude-code-agent", nest_id: N }, alice.apiKey)).data.api_key;
  readKey = (await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: N, capability: "read" }, alice.apiKey)).data.api_key;
  n2Key = (await jsonRequest(app, "POST", "/auth/keys", { label: "ops-agent", nest_id: N2 }, alice.apiKey)).data.api_key;
  installId = `inst_${randomUUID()}`;
  await run(
    `INSERT INTO surface_installs (id, org_id, surface, mode, tenant_key, team_id, status) VALUES (?, 'org', 'slack', 'manifest', 'T0CR', 'T0CR', 'active')`,
    [installId],
  );
  await run("INSERT INTO surface_personal_nests (install_id, community_user_id, nest_id) VALUES (?, ?, ?)", [installId, pat.userId, P]);
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  await env?.cleanup();
});

beforeEach(async () => {
  // The read/write limits are per minute; one suite makes many calls.
  await resetAuthRateLimit();
});

// ═══ Agent event API ═══════════════════════════════════════════════════════

describe("agent event API", () => {
  let runId: string;

  it("AC-CR-08: a nest-scoped write key registers an agent, starts a report_only run, posts a decision step and closes it; the run shows in /ledger and /rollups; replays create nothing; a changed body is 409 idempotency_conflict", async () => {
    const reg = await req("POST", `/nests/${N}/agents`, { name: "Claude Code (laptop)", runtime: "claude-code", description: "Coding agent." }, writeKey);
    expect(reg.status).toBe(201);
    expect(reg.data).toMatchObject({ node_id: "nodes/agents/claude-code-laptop", created: true, api_version: "2026-11" });
    const reg2 = await req("POST", `/nests/${N}/agents`, { name: "Claude Code (laptop)", runtime: "claude-code", description: "Coding agent." }, writeKey);
    expect(reg2.status).toBe(200);
    expect(reg2.data.created).toBe(false);
    const meta = await one("SELECT frontmatter_json FROM node_index WHERE nest_id = ? AND node_id = ?", [N, "nodes/agents/claude-code-laptop"]).catch(() => null);
    if (meta) expect(meta.frontmatter_json).toMatch(/"agent":\{"executes":"external","runtime":"claude-code","owner":"alice@cr.test"\}/);

    const startBody = { report_only: true, external_ref: "cc-session-1", inputs: { repo: "billing" } };
    const start = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-laptop`, startBody, writeKey, { "Idempotency-Key": "cc-s1" });
    expect(start.status).toBe(201);
    expect(start.data).toMatchObject({ api_version: "2026-11" });
    expect(start.data.run_id).toMatch(/^run_/);
    expect(start.data.agent).toBeUndefined(); // report-only: no bundle
    runId = start.data.run_id;
    const startAgain = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-laptop`, startBody, writeKey, { "Idempotency-Key": "cc-s1" });
    expect(startAgain.status).toBe(200);
    expect(startAgain.data).toMatchObject({ run_id: runId, idempotent_replay: true });
    const startConflict = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-laptop`, { ...startBody, external_ref: "other" }, writeKey, { "Idempotency-Key": "cc-s1" });
    expect(startConflict.status).toBe(409);
    expect(startConflict.data.code).toBe("idempotency_conflict");
    expect((await all("SELECT id FROM runs WHERE nest_id = ? AND idempotency_key = 'cc-s1'", [N])).length).toBe(1);
    const stored = await one("SELECT source, external_ref, triggered_by FROM runs WHERE id = ?", [runId]);
    expect(stored).toMatchObject({ source: "external", external_ref: "cc-session-1", triggered_by: alice.email });

    const step = {
      action: "decision",
      detail: { verdict: "propose", reason_code: "new_decision", summary: "Chose vitest over jest", evidence: [{ kind: "url", ref: "https://github.com/x/y/pull/412" }], confidence: 0.8 },
    };
    const s1 = await req("POST", `/runs/${runId}/steps`, step, writeKey, { "Idempotency-Key": "cc-s1-d1" });
    expect(s1.status).toBe(201);
    expect(s1.data.seq).toBe(1);
    const s1again = await req("POST", `/runs/${runId}/steps`, step, writeKey, { "Idempotency-Key": "cc-s1-d1" });
    expect(s1again.status).toBe(200);
    expect(s1again.data).toMatchObject({ seq: 1, idempotent_replay: true });
    const s1conflict = await req("POST", `/runs/${runId}/steps`, { ...step, detail: { ...step.detail, reason_code: "other" } }, writeKey, { "Idempotency-Key": "cc-s1-d1" });
    expect(s1conflict.status).toBe(409);
    expect(s1conflict.data.code).toBe("idempotency_conflict");
    expect((await all("SELECT seq FROM run_steps WHERE run_id = ?", [runId])).length).toBe(1);

    const close = { status: "succeeded", usage: { input_tokens: 1000, output_tokens: 200 }, est_cost_usd: 0.05, summary: "1 decision proposed" };
    const c1 = await req("PATCH", `/runs/${runId}`, close, writeKey);
    expect(c1.status).toBe(200);
    const c2 = await req("PATCH", `/runs/${runId}`, close, writeKey);
    expect(c2.status).toBe(200);
    expect(c2.data.idempotent_replay).toBe(true);
    const c3 = await req("PATCH", `/runs/${runId}`, { status: "failed" }, writeKey);
    expect(c3.status).toBe(409);

    const ledger = await req("GET", `/ledger`, undefined, alice.apiKey);
    expect(ledger.status).toBe(200);
    const row = ledger.data.entries.find((e: any) => e.entry_id === runId);
    expect(row).toBeTruthy();
    expect(row).toMatchObject({
      agent: { node_id: "nodes/agents/claude-code-laptop", name: "Claude Code (laptop)", source: "external" },
      run: { id: runId, outcome: "succeeded", cost_usd: 0.05 },
      verdict: { code: "propose", reason_code: "new_decision" },
      decision: { summary: "Chose vitest over jest" },
      source: { kind: "agent", label: "cc-session-1" },
    });
    const roll = await req("GET", `/rollups?by=agent&grain=day`, undefined, alice.apiKey);
    expect(roll.status).toBe(200);
    const r = roll.data.rows.find((x: any) => x.key === "nodes/agents/claude-code-laptop");
    expect(r).toMatchObject({ runs: 1, propose: 1, cost_usd: 0.05, tokens: 1200 });
  });

  it("AC-CR-08 (decision 2): an external report needs a key scoped to this nest — an unscoped personal key is refused", async () => {
    const res = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-laptop`, { report_only: true }, alice.apiKey);
    expect(res.status).toBe(403);
    expect(res.data.error).toMatch(/nest-scoped API key/);
    // A bundle run (the existing runner path) is unchanged for the same key.
  });

  it("AC-CR-08b: a key scoped to nest A posting to a run in nest B gets 403 'API key not authorized for this nest'", async () => {
    const res = await req("POST", `/runs/${runId}/steps`, { action: "decision", detail: { verdict: "no_op", reason_code: "x" } }, n2Key, { "Idempotency-Key": "x-1" });
    expect(res.status).toBe(403);
    expect(res.data.error).toBe("API key not authorized for this nest");
    const close = await req("PATCH", `/runs/${runId}`, { status: "succeeded", est_cost_usd: 1 }, n2Key);
    expect(close.status).toBe(403);
    const trace = await req("GET", `/ledger/${runId}`, undefined, n2Key);
    expect(trace.status).toBe(403);
  });

  it("AC-CR-08c: more than AGENT_EVENTS_RATE_PER_MIN step posts in a minute from one key → 429 with Retry-After", async () => {
    const start = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-laptop`, { report_only: true }, writeKey);
    expect(start.status).toBe(201);
    process.env.AGENT_EVENTS_RATE_PER_MIN = "5";
    try {
      const codes: number[] = [];
      let last: any = null;
      for (let i = 0; i < 7; i++) {
        last = await req("POST", `/runs/${start.data.run_id}/steps`, { action: "outcome", detail: { kind: "noted", status: "ok" } }, writeKey);
        codes.push(last.status);
      }
      expect(codes.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(codes.slice(5)).toEqual([429, 429]);
      expect(Number(last.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(last.data).toMatchObject({ code: "rate_limited", limit: 5, window_s: 60 });
      // MCP shares the bucket.
      const viaMcp = await mcp(N, writeKey, "context_agent_run_step", { run_id: start.data.run_id, action: "outcome", detail: { kind: "noted" } });
      expect(viaMcp.text).toMatch(/Too many requests/);
    } finally {
      delete process.env.AGENT_EVENTS_RATE_PER_MIN;
      await resetAuthRateLimit();
    }
    await req("PATCH", `/runs/${start.data.run_id}`, { status: "succeeded" }, writeKey);
  });

  it("AC-CR-08d: a decision step with an unknown field, a summary over 280 chars or more than 10 evidence refs → 422 naming the field", async () => {
    const start = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-laptop`, { report_only: true }, writeKey);
    const id = start.data.run_id;
    const post = (detail: unknown) => req("POST", `/runs/${id}/steps`, { action: "decision", detail }, writeKey);
    const unknown = await post({ verdict: "no_op", reason_code: "chatter", quote: "raw message text" });
    expect(unknown.status).toBe(422);
    expect(unknown.data).toMatchObject({ code: "invalid_field", field: "detail.quote" });
    const long = await post({ verdict: "no_op", reason_code: "chatter", summary: "x".repeat(281) });
    expect(long.status).toBe(422);
    expect(long.data.field).toBe("detail.summary");
    const many = await post({ verdict: "no_op", reason_code: "chatter", evidence: Array.from({ length: 11 }, (_, i) => ({ kind: "node", ref: `n${i}` })) });
    expect(many.status).toBe(422);
    expect(many.data.field).toBe("detail.evidence");
    const jsUrl = await post({ verdict: "no_op", reason_code: "chatter", evidence: [{ kind: "url", ref: "javascript:alert(1)" }] });
    expect(jsUrl.status).toBe(422);
    expect(jsUrl.data.field).toBe("detail.evidence.0.ref");
    const badVerdict = await post({ verdict: "maybe", reason_code: "chatter" });
    expect(badVerdict.status).toBe(422);
    expect(badVerdict.data.field).toBe("detail.verdict");
    // MCP refuses the same, with the same field name.
    const viaMcp = await mcp(N, writeKey, "context_agent_run_step", { run_id: id, action: "decision", detail: { verdict: "no_op", reason_code: "chatter", quote: "x" } });
    expect(viaMcp.text).toMatch(/detail\.quote/);
    expect((await all("SELECT seq FROM run_steps WHERE run_id = ?", [id])).length).toBe(0);
    // A started_at outside the 24 h window is a 422 too.
    const old = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-laptop`, { report_only: true, started_at: iso(Date.now() - 2 * DAY) }, writeKey);
    expect(old.status).toBe(422);
    expect(old.data.field).toBe("started_at");
    await req("PATCH", `/runs/${id}`, { status: "succeeded" }, writeKey);
  });

  it("AC-CR-05 (external): a node approved from an external run's proposal step has a complete chain and no gaps", async () => {
    const start = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-laptop`, { report_only: true, external_ref: "cc-session-2" }, writeKey, { "Idempotency-Key": "cc-s2" });
    const id = start.data.run_id;
    await req("POST", `/runs/${id}/steps`, { action: "decision", detail: { verdict: "propose", reason_code: "new_decision", summary: "Freeze Q4 deploys" } }, writeKey);
    // The agent opens a review through the normal document API.
    const created = await req("POST", `/nests/${N}/nodes`, { title: "Q4 freeze", content: "No deploys after Dec 15.", status: "draft" }, writeKey);
    expect(created.status).toBe(201);
    const nodeId = created.data.node.id;
    const sub = await req("POST", `/nests/${N}/nodes/${nodeId}/submit-review`, {}, writeKey);
    expect(sub.status).toBeLessThan(300);
    const rv = await one("SELECT id FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC LIMIT 1", [N, nodeId]);
    // A review in another nest is refused (it can't be claimed).
    const foreign = await req("POST", `/runs/${id}/steps`, { action: "proposal", detail: { review_id: "rv_not_here" } }, writeKey);
    expect(foreign.status).toBe(422);
    // A review someone else opened can't be claimed either.
    const bobNode = (await req("POST", `/nests/${N}/nodes`, { title: "Bob draft", content: "x", status: "draft" }, alice.apiKey)).data.node.id;
    await run("UPDATE review_requests SET requested_by = ? WHERE id = ?", ["someone@else.test", rv.id]);
    const notMine = await req("POST", `/runs/${id}/steps`, { action: "proposal", detail: { review_id: rv.id } }, writeKey);
    expect(notMine.status).toBe(422);
    await run("UPDATE review_requests SET requested_by = ? WHERE id = ?", [alice.email, rv.id]);
    void bobNode;
    const prop = await req("POST", `/runs/${id}/steps`, { action: "proposal", detail: { review_id: rv.id, node_id: nodeId } }, writeKey);
    expect(prop.status).toBe(201);
    expect((await one("SELECT run_id FROM review_requests WHERE id = ?", [rv.id])).run_id).toBe(id);
    await req("PATCH", `/runs/${id}`, { status: "succeeded", est_cost_usd: 0.02 }, writeKey);
    const ok = await req("POST", `/nests/${N}/nodes/${nodeId}/approve`, { note: "Agreed in standup" }, bob.apiKey);
    expect(ok.status).toBe(200);

    const tr = await req("GET", `/ledger/${id}`, undefined, alice.apiKey);
    expect(tr.status).toBe(200);
    for (const hop of ["run", "verdict", "proposal", "review", "version", "source"]) expect(tr.data.chain[hop], hop).toBeTruthy();
    expect(tr.data.chain.review).toMatchObject({ state: "approved", by: bob.email });
    expect("reason" in tr.data.chain.review).toBe(true);
    expect(tr.data.chain.version).toMatchObject({ node_id: nodeId });
    expect(tr.data.chain.source).toMatchObject({ kind: "agent", label: "cc-session-2" });
    expect(tr.data.gaps).toEqual([]);
    expect(tr.data.steps.map((s: any) => s.action)).toEqual(["decision", "proposal"]);
    // MCP twin returns the same chain.
    const viaMcp = await mcp(N, alice.apiKey, "context_agent_ledger_trace", { entry_id: id });
    expect(viaMcp.data?.gaps).toEqual([]);
    expect(viaMcp.data?.chain?.version?.node_id).toBe(nodeId);
  });

  it("AC-CR-05 (metacognition): a node approved from a metacognition run's review has a complete chain and no gaps", async () => {
    const created = await req("POST", `/nests/${N}/nodes`, { title: "Churn playbook", content: "Call within a day.", status: "draft" }, alice.apiKey);
    const nodeId = created.data.node.id;
    await req("POST", `/nests/${N}/nodes/${nodeId}/submit-review`, {}, alice.apiKey);
    const rv = await one("SELECT id FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC LIMIT 1", [N, nodeId]);
    const id = await seedRun({ nestId: N, agent: "nodes/agents/claude-code-laptop", at: iso(Date.now() - 3600_000), source: "server:metacognition" });
    // Metacognition back-links the review it opened (linkRunArtifacts).
    await run("UPDATE review_requests SET run_id = ? WHERE id = ?", [id, rv.id]);
    expect((await req("POST", `/nests/${N}/nodes/${nodeId}/approve`, {}, bob.apiKey)).status).toBe(200);
    const tr = await req("GET", `/ledger/${id}`, undefined, alice.apiKey);
    expect(tr.status).toBe(200);
    expect(tr.data.entry.agent.source).toBe("metacognition");
    expect(tr.data.entry.verdict.code).toBe("propose");
    expect(tr.data.gaps).toEqual([]);
    for (const hop of ["run", "verdict", "proposal", "review", "version", "source"]) expect(tr.data.chain[hop], hop).toBeTruthy();
  });

  it("MCP: context_agent_register / run_start (report_only by default) / run_step / run_close work end to end with idempotency", async () => {
    const reg = await mcp(N, alice.apiKey, "context_agent_register", { name: "Hootie" });
    expect(reg.data).toMatchObject({ node_id: "nodes/agents/hootie", created: true });
    const st = await mcp(N, writeKey, "context_agent_run_start", { agent: "nodes/agents/hootie", idempotency_key: "h-1" });
    expect(st.data?.run_id).toMatch(/^run_/);
    expect(st.data?.agent).toBeUndefined();
    const st2 = await mcp(N, writeKey, "context_agent_run_start", { agent: "nodes/agents/hootie", idempotency_key: "h-1" });
    expect(st2.data).toMatchObject({ run_id: st.data.run_id, idempotent_replay: true });
    const step = await mcp(N, writeKey, "context_agent_run_step", { run_id: st.data.run_id, action: "decision", detail: { verdict: "no_op", reason_code: "already_on_record" }, idempotency_key: "h-1-d" });
    expect(step.data).toMatchObject({ seq: 1 });
    const close = await mcp(N, writeKey, "context_agent_run_close", { run_id: st.data.run_id, status: "succeeded", est_cost_usd: 0.01 });
    expect(close.data).toMatchObject({ ok: true, status: "succeeded" });
    // Over MCP an unscoped personal key can't report as an external agent either.
    const unscoped = await mcp(N, alice.apiKey, "context_agent_run_start", { agent: "nodes/agents/hootie" });
    expect(unscoped.text).toMatch(/nest-scoped API key/);
    // A non-admin can't register.
    const bobReg = await mcp(N, bob.apiKey, "context_agent_register", { name: "Rogue" });
    expect(bobReg.data?.created).not.toBe(true);
  });
});

// ═══ Ledger read model, redaction, rollups ════════════════════════════════

describe("ledger, redaction and rollups", () => {
  const LISTENER = "nodes/agents/listener-revenue";
  const META = "nodes/agents/churn-watch";
  const EXT = "nodes/agents/claude-code-laptop";
  const PRIVATE_TITLE_TEXT = "Pat's private salary decision";
  let base: number;
  let pWindow: string;
  let pRun: string;

  beforeAll(async () => {
    base = Date.parse("2026-10-01T00:00:00.000Z");
    const bN = await seedBinding(N, "C_REV", LISTENER);
    const bP = await seedBinding(P, "D_PAT", "nodes/agents/listener-pat");
    // 14 days: listener windows (no-ops, proposals in every state, an error),
    // metacognition runs (one failed), external runs, and personal-nest rows.
    for (let d = 0; d < 14; d++) {
      const day = base + d * DAY;
      await seedWindow({ nestId: N, bindingId: bN, listener: LISTENER, at: iso(day + 3600_000), verdict: "no_op", reason: "chatter", costMicros: 1200 });
      await seedWindow({ nestId: N, bindingId: bN, listener: LISTENER, at: iso(day + 7200_000), verdict: "no_op", reason: "already_on_record", costMicros: 900 });
      if (d % 2 === 0) {
        await seedWindow({
          nestId: N,
          bindingId: bN,
          listener: LISTENER,
          at: iso(day + 10_800_000),
          verdict: "proposed",
          costMicros: 4000,
          items: [{ state: (["approved", "rejected", "expired", "pending", "withdrawn"] as const)[d % 5], edited: d % 4 === 0, by: bob.userId, reason: d % 5 === 1 ? "details_wrong" : null }],
        });
      }
      if (d % 3 === 0) await seedWindow({ nestId: N, bindingId: bN, listener: LISTENER, at: iso(day + 14_400_000), verdict: "error", reason: "timeout" });
      await seedRun({ nestId: N, agent: META, at: iso(day + 18_000_000), source: "server:metacognition", status: d === 5 ? "failed" : "succeeded", costUsd: 0.03, tokens: 5000, reviews: d % 4 === 0 ? ["approved", "rejected"] : [] });
      await seedRun({ nestId: N2, agent: EXT, at: iso(day + 21_600_000), source: "external", verdict: d % 2 ? "no_op" : "act", costUsd: 0.01, tokens: 800 });
      if (d % 5 === 0) {
        const w = await seedWindow({ nestId: P, bindingId: bP, listener: "nodes/agents/listener-pat", at: iso(day + 25_200_000), verdict: "proposed", costMicros: 2000, items: [{ state: "approved", title: PRIVATE_TITLE_TEXT, by: pat.userId, reason: "looks right" }], commit: { nodeId: "nodes/inbox/pat-salary", version: 1, by: pat.userId } });
        pWindow = w.windowId;
        pRun = await seedRun({ nestId: P, agent: "nodes/agents/pat-helper", at: iso(day + 28_800_000), source: "external", verdict: "propose", costUsd: 0.02 });
        await run(
          `INSERT INTO run_steps (run_id, seq, action, detail, at) VALUES (?, 1, 'decision', ?, ?)`,
          [pRun, JSON.stringify({ verdict: "propose", reason_code: "seeded", summary: "Pat secret summary", evidence: [{ kind: "url", ref: "https://pat.example/secret" }] }), iso(day + 28_800_000)],
        );
      }
    }
  });

  const range = () => ({ from: iso(base), to: iso(base + 14 * DAY) });
  const qs = (o: Record<string, string | undefined>) =>
    Object.entries(o)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
      .join("&");

  it("AC-CR-06 (seeded): a no_op window row has verdict + reason_code and no proposal, review or commit", async () => {
    const r = await req("GET", `/nests/${N}/ledger?${qs({ ...range(), verdict: "no_op", limit: "5" })}`, undefined, alice.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.entries.length).toBe(5);
    for (const e of r.data.entries) {
      expect(e.verdict.code).toBe("no_op");
      expect(["chatter", "already_on_record"]).toContain(e.verdict.reason_code);
      if (e.agent.source === "surfaces") {
        expect(e.proposal).toBeNull();
        expect(e.review).toBeNull();
        expect(e.commit).toBeNull();
      }
    }
  });

  it("keyset pagination walks every row exactly once and matches totals", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let totals: any;
    do {
      const r = await req("GET", `/nests/${N}/ledger?${qs({ ...range(), limit: "17", cursor })}`, undefined, alice.apiKey);
      expect(r.status).toBe(200);
      for (const e of r.data.entries) {
        expect(seen.has(e.entry_id)).toBe(false);
        seen.add(e.entry_id);
      }
      totals = r.data.totals;
      cursor = r.data.next_cursor ?? undefined;
    } while (cursor);
    expect(seen.size).toBe(totals.entries);
  });

  it("AC-CR-07: a personal-nest row is redacted for a non-owner (ledger, trace, export, rollups, MCP; server admin included); counts still sum; the owner sees it whole", async () => {
    const hidden = [PRIVATE_TITLE_TEXT, "Pat secret summary", "pat.example/secret", "#d_pat", "nodes/inbox/pat-salary", "looks right", pat.email];
    const assertRedacted = (e: any) => {
      expect(e.redacted).toBe("n1");
      expect(e.nest.label).toBe("DM · private nest · title hidden");
      expect(e).not.toHaveProperty("source");
      if (e.proposal) expect(e.proposal).not.toHaveProperty("title");
      if (e.decision) {
        expect(e.decision).not.toHaveProperty("summary");
        expect(e.decision).not.toHaveProperty("evidence");
      }
      if (e.review) expect(e.review).not.toHaveProperty("by");
      const s = JSON.stringify(e);
      for (const h of hidden) expect(s).not.toContain(h);
    };
    // Nest admin (not owner).
    const asAlice = await req("GET", `/nests/${P}/ledger?${qs(range())}`, undefined, alice.apiKey);
    expect(asAlice.status).toBe(200);
    expect(asAlice.data.entries.length).toBe(6);
    asAlice.data.entries.forEach(assertRedacted);
    expect(asAlice.data.totals).toMatchObject({ entries: 6, propose: 6, proposals: 3, approved: 3 });
    // Server admin, org-wide.
    const asRoot = await req("GET", `/ledger?${qs({ ...range(), limit: "200" })}`, undefined, root.apiKey);
    const pRows = asRoot.data.entries.filter((e: any) => e.nest.id === P);
    expect(pRows.length).toBe(6);
    pRows.forEach(assertRedacted);
    // Trace.
    for (const id of [`win_${pWindow}`, pRun]) {
      const tr = await req("GET", `/ledger/${id}`, undefined, alice.apiKey);
      expect(tr.status).toBe(200);
      assertRedacted(tr.data.entry);
      const s = JSON.stringify(tr.data);
      for (const h of hidden) expect(s).not.toContain(h);
    }
    // Export.
    const ex = await req("GET", `/nests/${P}/ledger/export?${qs({ ...range(), format: "ndjson" })}`, undefined, alice.apiKey);
    expect(ex.status).toBe(200);
    for (const h of hidden) expect(ex.text).not.toContain(h);
    // Rollups: labels redacted, counts still sum to the total.
    const roll = await req("GET", `/nests/${P}/rollups?${qs({ ...range(), by: "binding" })}`, undefined, alice.apiKey);
    expect(roll.status).toBe(200);
    for (const h of hidden) expect(JSON.stringify(roll.data)).not.toContain(h);
    expect(roll.data.rows.reduce((n: number, r: any) => n + r.entries, 0)).toBe(6);
    // MCP.
    const viaMcp = await mcp(P, alice.apiKey, "context_agent_ledger", range());
    expect(viaMcp.data?.entries?.length).toBe(6);
    viaMcp.data.entries.forEach(assertRedacted);
    const viaOrg = await mcp(null, root.apiKey, "context_agent_ledger_org", { ...range(), nest_id: P });
    expect(viaOrg.data?.entries?.length).toBe(6);
    viaOrg.data.entries.forEach(assertRedacted);
    // The owner sees full rows.
    const asPat = await req("GET", `/nests/${P}/ledger?${qs(range())}`, undefined, pat.apiKey);
    const win = asPat.data.entries.find((e: any) => e.entry_id === `win_${pWindow}`);
    expect(win.redacted).toBeNull();
    expect(win.proposal.title).toBe(PRIVATE_TITLE_TEXT);
    expect(win.commit.node_id).toBe("nodes/inbox/pat-salary");
    const ext = asPat.data.entries.find((e: any) => e.entry_id === pRun);
    expect(ext.decision.summary).toBe("Pat secret summary");
    // q never matches a redacted row.
    const search = await req("GET", `/nests/${P}/ledger?${qs({ ...range(), q: "salary" })}`, undefined, alice.apiKey);
    expect(search.data.entries.length).toBe(0);
    const searchOwner = await req("GET", `/nests/${P}/ledger?${qs({ ...range(), q: "salary" })}`, undefined, pat.apiKey);
    expect(searchOwner.data.entries.length).toBe(3);
  });

  it("AC-CR-07b: a read-tier key gets inputs, trace, steps[].detail, decision.summary and evidence as null", async () => {
    const start = await req("POST", `/nests/${N}/run/nodes/agents/claude-code-laptop`, { report_only: true, inputs: { task: "secret task" } }, writeKey);
    const id = start.data.run_id;
    await req("POST", `/runs/${id}/steps`, { action: "decision", detail: { verdict: "act", reason_code: "fixed", summary: "Fixed the flaky test", evidence: [{ kind: "url", ref: "https://ci.example/1" }] } }, writeKey);
    await req("PATCH", `/runs/${id}`, { status: "succeeded", summary: "done" }, writeKey);
    const page = await req("GET", `/nests/${N}/ledger?verdict=act`, undefined, readKey);
    expect(page.status).toBe(200);
    const e = page.data.entries.find((x: any) => x.entry_id === id);
    expect(e.decision).toMatchObject({ verdict: "act", summary: null, evidence: null });
    const tr = await req("GET", `/ledger/${id}`, undefined, readKey);
    expect(tr.status).toBe(200);
    expect(tr.data.chain.run.inputs).toBeNull();
    expect(tr.data.chain.run.trace).toBeNull();
    expect(tr.data.steps.every((s: any) => s.detail === null)).toBe(true);
    expect(tr.data.entry.decision.summary).toBeNull();
    expect(JSON.stringify(tr.data)).not.toContain("secret task");
    expect(JSON.stringify(tr.data)).not.toContain("Fixed the flaky test");
    const viaMcp = await mcp(N, readKey, "context_agent_ledger_trace", { entry_id: id });
    expect(viaMcp.data?.chain?.run?.inputs).toBeNull();
    expect(viaMcp.data?.entry?.decision?.evidence).toBeNull();
    // A write-tier caller sees it.
    const full = await req("GET", `/ledger/${id}`, undefined, alice.apiKey);
    expect(full.data.chain.run.inputs).toEqual({ task: "secret task" });
    expect(full.data.entry.decision.summary).toBe("Fixed the flaky test");
  });

  it("AC-CR-10: daily and weekly rollups by agent and by nest equal the ledger totals for the same range and filters, and buckets sum to the range total", async () => {
    const keys = ["runs", "failed", "no_op", "propose", "act", "error", "proposals", "approved", "edited", "rejected", "expired", "pending", "withdrawn", "tokens"] as const;
    const pick = (t: any) => Object.fromEntries([...keys.map((k) => [k, t[k]]), ["cost_usd", Math.round(t.cost_usd * 1e6)]]);
    for (const grain of ["day", "week"] as const) {
      for (const by of ["agent", "nest"] as const) {
        const roll = await req("GET", `/rollups?${qs({ ...range(), grain, by })}`, undefined, root.apiKey);
        expect(roll.status).toBe(200);
        const total = await req("GET", `/ledger?${qs({ ...range(), limit: "1" })}`, undefined, root.apiKey);
        // Buckets sum to the range total.
        const sum: Record<string, number> = {};
        for (const r of roll.data.rows) for (const [k, v] of Object.entries(pick(r))) sum[k] = (sum[k] ?? 0) + (v as number);
        expect(sum).toEqual(pick(total.data.totals));
        // Each bucket equals the ledger totals for that bucket's range + filter.
        for (const r of roll.data.rows) {
          const from = `${r.bucket}T00:00:00.000Z`;
          const to = iso(Date.parse(from) + (grain === "day" ? 1 : 7) * DAY);
          const path =
            by === "agent"
              ? `/nests/${r.nest_id}/ledger?${qs({ from, to, agent: r.key, limit: "1" })}`
              : `/nests/${r.key}/ledger?${qs({ from, to, limit: "1" })}`;
          // Alice administers every nest in the fixture (and sees P redacted:
          // counts are the same either way).
          const l = await req("GET", path, undefined, alice.apiKey);
          expect(l.status, path).toBe(200);
          expect(pick(l.data.totals), `${grain}/${by}/${r.bucket}/${r.key}`).toEqual(pick(r));
        }
        await resetAuthRateLimit();
      }
    }
    // The fixture really has every family in it.
    const t = (await req("GET", `/ledger?${qs({ ...range(), limit: "1" })}`, undefined, root.apiKey)).data.totals;
    expect(t.entries).toBe(14 * 2 + 7 + 5 + 14 + 14 + 3 * 2);
    expect(t.failed).toBeGreaterThan(0);
    expect(t.error).toBe(5 + 1);
  });

  it("AC-CR-12: a ledger export writes an export row to node_access_events, and the file has the same rows and redaction as the API", async () => {
    const before = Number((await one("SELECT COUNT(*) AS n FROM node_access_events WHERE nest_id = ? AND action = 'export'", [N])).n);
    const ex = await req("GET", `/nests/${N}/ledger/export?${qs({ ...range(), format: "ndjson" })}`, undefined, alice.apiKey);
    expect(ex.status).toBe(200);
    expect(ex.headers.get("Content-Type")).toMatch(/ndjson/);
    const lines = ex.text.trim().split("\n").map((l: string) => JSON.parse(l));
    const api: any[] = [];
    let cursor: string | undefined;
    do {
      const p = await req("GET", `/nests/${N}/ledger?${qs({ ...range(), limit: "200", cursor })}`, undefined, alice.apiKey);
      api.push(...p.data.entries);
      cursor = p.data.next_cursor ?? undefined;
    } while (cursor);
    expect(lines).toEqual(api);
    const { flushAccessLog } = await import("../src/governance/access-log.js");
    await flushAccessLog();
    const after = await all("SELECT * FROM node_access_events WHERE nest_id = ? AND action = 'export' ORDER BY id DESC", [N]);
    expect(after.length).toBe(before + 1);
    expect(after[0]).toMatchObject({ node_id: null, surface: "api", user_id: alice.userId });
    expect(after[0].detail).toMatch(/decision ledger export/);
    // CSV: same rows, formula cells neutralised.
    const csv = await req("GET", `/nests/${N}/ledger/export?${qs({ ...range(), format: "csv" })}`, undefined, alice.apiKey);
    expect(csv.status).toBe(200);
    expect(csv.text.trim().split("\n").length).toBe(api.length + 1);
    // Personal-nest export redacts like the API (checked in AC-CR-07).
  });

  it("AC-CR-09 (org scope, decision 3): org-wide reads cover every nest for a server admin, only administered nests for others, and a scoped key stays in its nest", async () => {
    const asBob = await req("GET", `/ledger?${qs({ ...range(), limit: "200" })}`, undefined, bob.apiKey);
    expect(asBob.status).toBe(200);
    expect(asBob.data.entries.length).toBe(0); // Bob only reads N; he administers nothing
    const asAlice = await req("GET", `/ledger?${qs({ ...range(), limit: "200" })}`, undefined, alice.apiKey);
    expect(new Set(asAlice.data.entries.map((e: any) => e.nest.id))).toEqual(new Set([N, N2, P]));
    const asKey = await req("GET", `/rollups?${qs({ ...range(), by: "nest" })}`, undefined, n2Key);
    expect(new Set(asKey.data.rows.map((r: any) => r.key))).toEqual(new Set([N2]));
    const asPat = await req("GET", `/rollups?${qs({ ...range(), by: "nest" })}`, undefined, pat.apiKey);
    expect(new Set(asPat.data.rows.map((r: any) => r.key))).toEqual(new Set([P]));
    const outsider = await req("GET", `/ledger/win_${pWindow}`, undefined, bob.apiKey);
    expect(outsider.status).toBe(404);
  });
});

// ═══ Parity, lint, migrations ═════════════════════════════════════════════

describe("AC-CR-09: MCP parity, API.md, lint and migrations", () => {
  it("AC-CR-09: every new REST route has a context_agent_* tool built from the same zod schema, advertised on MCP, and an API.md entry", async () => {
    const { AGENT_TOOL_DEFINITIONS, AGENT_ORG_TOOL_DEFINITIONS, AGENT_TOOL_REST } = await import("../src/mcp/agent-tools.js");
    const schema = await import("../src/workflow/agent-event-schema.js");
    const api = readFileSync(join(__dirname, "..", "API.md"), "utf8");
    const defs = [...AGENT_TOOL_DEFINITIONS, ...AGENT_ORG_TOOL_DEFINITIONS];
    expect(defs.map((d) => d.name).sort()).toEqual(Object.keys(AGENT_TOOL_REST).sort());
    for (const d of defs) {
      expect(d.inputSchema, d.name).toEqual(schema.mcpInputSchema((schema.AGENT_MCP_INPUTS as any)[d.name]));
      const route = (AGENT_TOOL_REST as any)[d.name] as string;
      expect(api.includes(route), `API.md: ${route}`).toBe(true);
      expect(api.includes(d.name), `API.md: ${d.name}`).toBe(true);
    }
    // The REST bodies are the same objects the MCP inputs extend.
    expect(Object.keys(schema.AGENT_MCP_INPUTS.context_agent_run_step.shape)).toEqual(expect.arrayContaining(Object.keys(schema.AgentRunStepBody.shape)));
    expect(Object.keys(schema.AGENT_MCP_INPUTS.context_agent_run_close.shape)).toEqual(expect.arrayContaining(Object.keys(schema.AgentRunCloseBody.shape)));
    expect(schema.AGENT_MCP_INPUTS.context_agent_register).toBe(schema.AgentRegisterBody);
    expect(schema.AGENT_MCP_INPUTS.context_agent_ledger).toBe(schema.LedgerQuery);
    expect(schema.AGENT_MCP_INPUTS.context_agent_rollups).toBe(schema.RollupsQuery);
    // Advertised: per-nest tools to an owner, read tools only to a read key, org tools on /mcp.
    const ownerTools = await mcpTools(N, alice.apiKey);
    for (const d of AGENT_TOOL_DEFINITIONS) expect(ownerTools, d.name).toContain(d.name);
    const roTools = await mcpTools(N, readKey);
    expect(roTools).toContain("context_agent_ledger");
    expect(roTools).not.toContain("context_agent_run_start");
    expect(roTools).not.toContain("context_agent_register");
    const serverTools = await mcpTools(null, root.apiKey);
    expect(serverTools).toEqual(expect.arrayContaining(["context_agent_ledger_org", "context_agent_rollups_org"]));
    // workflow_* tools gained the optional idempotency field.
    const { WORKFLOW_TOOL_DEFINITIONS } = await import("../src/mcp/workflow-tools.js");
    for (const n of ["workflow_run", "workflow_run_step"]) {
      const t = WORKFLOW_TOOL_DEFINITIONS.find((x: any) => x.name === n) as any;
      expect(t.inputSchema.properties.idempotency_key, n).toBeTruthy();
    }
  });

  it("AC-CR-09: lint:mcp-schemas stays at or below its baseline", () => {
    const out = execFileSync(process.execPath, [join(__dirname, "..", "scripts", "check-mcp-schemas.mjs")], { encoding: "utf8" });
    expect(out).toMatch(/No new inline MCP schemas/);
  });

  it("AC-CR-09: migration 086 applies from empty and from the previous release (SQLite), with the backfill", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { runMigrations } = await import("../src/db/migrations.js");
    const mem = new Database(":memory:");
    runMigrations(mem);
    const cols = (t: string) => (mem.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols("runs")).toEqual(expect.arrayContaining(["idempotency_key", "source", "external_ref", "verdict", "reason_code"]));
    expect(cols("run_steps")).toContain("client_key");
    expect(cols("surface_windows")).toContain("run_id");
    // "Previous release": the same database without 086 — drop it and rerun.
    for (const i of ["idx_runs_idempotency", "idx_run_steps_client_key", "idx_runs_source", "idx_surface_windows_run", "idx_surface_windows_judged"]) mem.exec(`DROP INDEX IF EXISTS ${i}`);
    for (const [t, c] of [["runs", "idempotency_key"], ["runs", "source"], ["runs", "external_ref"], ["runs", "verdict"], ["runs", "reason_code"], ["run_steps", "client_key"], ["surface_windows", "run_id"]]) mem.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    mem.prepare("DELETE FROM schema_migrations WHERE id = '086_control_room_ledger'").run();
    const uid = "u1";
    mem.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')").run(uid, "m@x.test");
    mem.prepare("INSERT INTO nests (id, user_id, name, slug) VALUES ('n1', ?, 'N', 'n')").run(uid);
    mem.prepare("INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, started_at, claimed_by) VALUES ('run_m', 'n1', 'nodes/a', 'x', 'succeeded', '2026-11-01T00:00:00.000Z', 'server:metacognition')").run();
    mem.prepare("INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, started_at, claimed_by) VALUES ('run_s', 'n1', 'nodes/l', 'surfaces:window', 'succeeded', '2026-11-01T00:00:05.000Z', 'server:surfaces')").run();
    mem.prepare("INSERT INTO surface_installs (id, org_id, surface, mode, tenant_key) VALUES ('i1', 'o', 'slack', 'manifest', 'T')").run();
    mem.prepare("INSERT INTO surface_bindings (id, install_id, org_id, nest_id, conversation_id, conversation_kind, listener_agent_node_id) VALUES ('b1', 'i1', 'o', 'n1', 'C1', 'private_channel', 'nodes/l')").run();
    mem.prepare("INSERT INTO surface_windows (id, binding_id, nest_id, thread_key, opened_at, last_message_at, status, verdict, model, judged_at) VALUES ('w1', 'b1', 'n1', 'channel', 'x', 'x', 'judged', 'no_op', 'm', '2026-11-01T00:00:00.000Z')").run();
    runMigrations(mem);
    expect(cols("runs")).toEqual(expect.arrayContaining(["idempotency_key", "source", "external_ref"]));
    expect(mem.prepare("SELECT source FROM runs WHERE id = 'run_m'").get()).toEqual({ source: "server:metacognition" });
    expect(mem.prepare("SELECT source FROM runs WHERE id = 'run_s'").get()).toEqual({ source: "server:surfaces" });
    expect(mem.prepare("SELECT run_id FROM surface_windows WHERE id = 'w1'").get()).toEqual({ run_id: "run_s" });
    // Idempotent: a third run changes nothing.
    runMigrations(mem);
    mem.close();
  });

  it("AC-CR-09: the Postgres set carries 086 (columns altered in, shared index DDL, seeded id)", () => {
    const pg = readFileSync(join(__dirname, "..", "src", "db", "migrations.postgres.ts"), "utf8");
    for (const c of ["runs ADD COLUMN IF NOT EXISTS idempotency_key", "runs ADD COLUMN IF NOT EXISTS source", "run_steps ADD COLUMN IF NOT EXISTS client_key", "surface_windows ADD COLUMN IF NOT EXISTS run_id"]) expect(pg).toContain(c);
    expect(pg).toMatch(/controlRoomLedgerIndexesAndBackfill\("postgres"\)/);
    expect(pg).toContain('"086_control_room_ledger"');
  });
});

void settleSeals;
