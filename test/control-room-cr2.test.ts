/**
 * po-1186 CR2 — the Control room dashboard's backend and figures. Each test is
 * named for the acceptance criterion it proves (plan.md):
 *   - AC-CR-03 the Overview tiles, computed by the page's own logic
 *     (ui/src/lib/control-room-overview.ts) from the ledger routes, equal
 *     /surfaces/windows, /surfaces/proposals, /surfaces/commits and the budget;
 *   - AC-CR-04 the cold-start read model (GET /surfaces/cold-start + MCP);
 *   - AC-CR-07c the private-nest wording the page renders;
 *   - AC-CR-09 parity for the new route (same zod schema, API.md, lint);
 *   - AC-CR-10 the rollup additions (by=reason, last_at, source) reconcile with
 *     the ledger.
 * The UI itself (charts, drawer, 390/1440 layout) is the Playwright spec
 * tests/features/control-room/control_room_dashboard.spec.js.
 *
 * Read-model rows (windows, proposals, commits, runs) are seeded straight into
 * the tables the ledger reads, as in control-room-cr1.test.ts; the seed itself
 * is applied through the real POST /surfaces/seeds/apply.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";
import * as OV from "../ui/src/lib/control-room-overview.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
type U = { apiKey: string; userId: string; email: string };
let root: U; // server admin
let alice: U; // owner of the team nests
let bob: U; // reads R only
let pat: U; // owner of a personal (DM) nest
let R: string; // Revenue: seeded, two channels, listener activity
let E: string; // Engineering: no seed
let P: string; // pat's personal nest, seeded
let installId: string;
let bAcme: string;
let bRevops: string;
let bPaused: string;

const db = async () => (await import("../src/db/client.js")).getDb();
const all = async (sql: string, p: any[] = []) => (await db()).all(sql, p) as Promise<any[]>;
const run = async (sql: string, p: any[] = []) => (await db()).run(sql, p);

async function req(method: string, path: string, body: unknown, key: string) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function mcp(nestId: string, key: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  return body?.result?.structuredContent ?? JSON.parse(body?.result?.content?.[0]?.text ?? "null");
}

async function mcpTools(nestId: string, key: string): Promise<string[]> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const body = await res.json();
  return (body?.result?.tools ?? []).map((t: any) => t.name);
}

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function seedBinding(nestId: string, channel: string, status = "active", guard: Record<string, number> = {}): Promise<string> {
  const id = `bnd_${randomUUID()}`;
  await run(
    `INSERT INTO surface_bindings (id, install_id, org_id, nest_id, conversation_id, conversation_kind, conversation_name, listener_agent_node_id, status, capture_ok, surface_ok, guard_detail)
     VALUES (?, ?, 'org', ?, ?, 'private_channel', ?, ?, ?, 1, 1, ?)`,
    [id, installId, nestId, `C_${channel.toUpperCase()}`, channel, `nodes/agents/listener-${nestId.slice(0, 6)}`, status, JSON.stringify(guard)],
  );
  return id;
}

type ItemState = "approved" | "rejected" | "expired" | "pending";
async function seedWindow(o: { nestId: string; bindingId: string; at: number; verdict: "no_op" | "proposed" | "error"; reason?: string; cost?: number; items?: Array<{ state: ItemState; edited?: boolean }> }) {
  const id = randomUUID();
  const runId = `run_${randomUUID()}`;
  const at = iso(o.at);
  const listener = `nodes/agents/listener-${o.nestId.slice(0, 6)}`;
  await run(
    `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, trace, started_at, finished_at, claimed_by, source)
     VALUES (?, ?, ?, 'surfaces:window', 'succeeded', '{}', ?, ?, 'server:surfaces', 'server:surfaces')`,
    [runId, o.nestId, listener, at, at],
  );
  await run(
    `INSERT INTO surface_windows (id, binding_id, nest_id, thread_key, opened_at, last_message_at, closed_at, message_count, status, verdict, reason_code, item_count, kinds, model, prompt_version, cost_micros, judged_at, run_id, created_at)
     VALUES (?, ?, ?, 'channel', ?, ?, ?, 9, 'judged', ?, ?, ?, ?, 'claude-haiku', 'v3', ?, ?, ?, ?)`,
    [id, o.bindingId, o.nestId, at, at, at, o.verdict, o.reason ?? (o.verdict === "proposed" ? "proposed" : "chatter"), o.items?.length ?? 0, JSON.stringify(o.items?.length ? ["decision"] : []), o.cost ?? 3000, at, runId, at],
  );
  if (o.items?.length) {
    const pid = `prop_${randomUUID()}`;
    await run(
      `INSERT INTO surface_proposals (id, window_id, binding_id, nest_id, card_kind, state, expires_at, posted_at, created_at) VALUES (?, ?, ?, ?, 'single', 'decided', ?, ?, ?)`,
      [pid, id, o.bindingId, o.nestId, iso(o.at + 7 * DAY), at, at],
    );
    for (const it of o.items) {
      const decided = it.state !== "pending";
      const nodeId = it.state === "approved" ? `nodes/decisions/d-${randomUUID().slice(0, 8)}` : null;
      await run(
        `INSERT INTO surface_proposal_items (id, proposal_id, nest_id, item_kind, op, target_folder, title, state, edited, decided_by_user_id, decided_at, node_id, version)
         VALUES (?, ?, ?, 'decision', 'new', 'decisions/', ?, ?, ?, ?, ?, ?, ?)`,
        [`item_${randomUUID()}`, pid, o.nestId, `Decision ${randomUUID().slice(0, 6)}`, it.state, it.edited ? 1 : 0, decided ? alice.userId : null, decided ? iso(o.at + 60_000) : null, nodeId, nodeId ? 1 : null],
      );
      if (nodeId) {
        await run(
          `INSERT INTO surface_commits (id, nest_id, node_id, version, proposal_id, window_id, approved_by_user_id, surface, install_id, conversation_id, edited, created_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, 'slack', ?, 'C9', ?, ?)`,
          [`cmt_${randomUUID()}`, o.nestId, nodeId, pid, id, alice.userId, installId, it.edited ? 1 : 0, iso(o.at + 60_000)],
        );
      }
    }
  }
  return id;
}

async function seedRun(nestId: string, agent: string, at: number, source: "external" | "server:metacognition", verdict: string, reason: string) {
  const id = `run_${randomUUID()}`;
  await run(
    // est_cost_micros: what closing the run stores from its trace.
    `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, trace, started_at, finished_at, claimed_by, source, verdict, reason_code, est_cost_micros)
     VALUES (?, ?, ?, 'agent@x.test', 'succeeded', '{"est_cost_usd":0.05}', ?, ?, ?, ?, ?, ?, 50000)`,
    [id, nestId, agent, iso(at), iso(at), source === "server:metacognition" ? "server:metacognition" : null, source, verdict, reason],
  );
  return id;
}

/** Seeded window plan for R: 14 days, two channels, a mix of verdicts and reasons. */
const NOOP_REASONS = ["chatter", "chatter", "question_only", "no_agreement", "already_on_record", "chatter", "sensitive"];
const seeded = { windows: 0, noop: 0, proposed: 0, reasons: new Map<string, number>(), approved: 0, edited: 0, rejected: 0, expired: 0 };

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  process.env.SURFACES_BUFFER_KEY = "a".repeat(64);
  process.env.PUBLIC_BASE_URL = "https://nest.cr2.test";
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@cr2.test"] });
  root = await registerUser(app, "root@cr2.test", "Root");
  await resetAuthRateLimit();
  alice = await registerUser(app, "alice@cr2.test", "Alice");
  await resetAuthRateLimit();
  bob = await registerUser(app, "bob@cr2.test", "Bob");
  await resetAuthRateLimit();
  pat = await registerUser(app, "pat@cr2.test", "Pat");
  await resetAuthRateLimit();
  R = (await jsonRequest(app, "POST", "/nests", { name: "Revenue" }, alice.apiKey)).data.nest.id;
  E = (await jsonRequest(app, "POST", "/nests", { name: "Engineering" }, alice.apiKey)).data.nest.id;
  P = (await jsonRequest(app, "POST", "/nests", { name: "Pat DM" }, pat.apiKey)).data.nest.id;
  await jsonRequest(app, "POST", `/nests/${R}/collaborators`, { email: bob.email, permission: "read" }, alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${P}/collaborators`, { email: alice.email, permission: "admin" }, pat.apiKey);
  installId = `inst_${randomUUID()}`;
  await run(`INSERT INTO surface_installs (id, org_id, surface, mode, tenant_key, team_id, status) VALUES (?, 'org', 'slack', 'manifest', 'T0CR2', 'T0CR2', 'active')`, [installId]);
  await run("INSERT INTO surface_personal_nests (install_id, community_user_id, nest_id) VALUES (?, ?, ?)", [installId, pat.userId, P]);
  bAcme = await seedBinding(R, "acme-renewal", "active", { members_total: 7, readers_total: 7 });
  bRevops = await seedBinding(R, "revops", "active", { members_total: 18, readers_total: 18 });
  bPaused = await seedBinding(E, "onboarding", "paused_guard", { members_total: 25, readers_total: 312, members_not_readers: 0, readers_absent: 288, guests: 1 });

  // 14 days of listener windows on R.
  let k = 0;
  for (let d = 13; d >= 0; d--) {
    for (const b of [bAcme, bRevops]) {
      for (let j = 0; j < 3; j++) {
        const at = NOW - d * DAY - (j + 1) * 3_600_000;
        k += 1;
        seeded.windows += 1;
        if (k % 5 === 0) {
          const states: ItemState[] = ["approved", "rejected", "expired", "pending"];
          const st = states[(k / 5) % 4];
          const edited = st === "approved" && k % 10 === 0;
          seeded.proposed += 1;
          if (st === "approved") seeded.approved += 1;
          if (edited) seeded.edited += 1;
          if (st === "rejected") seeded.rejected += 1;
          if (st === "expired") seeded.expired += 1;
          await seedWindow({ nestId: R, bindingId: b, at, verdict: "proposed", items: [{ state: st, edited }] });
        } else {
          const reason = NOOP_REASONS[k % NOOP_REASONS.length];
          seeded.noop += 1;
          seeded.reasons.set(reason, (seeded.reasons.get(reason) ?? 0) + 1);
          await seedWindow({ nestId: R, bindingId: b, at, verdict: "no_op", reason });
        }
      }
    }
  }
  // Other agents: an external agent and a metacognition agent on R.
  await seedRun(R, "nodes/agents/claude-code-priya", NOW - 2 * DAY, "external", "propose", "new_decision");
  await seedRun(R, "nodes/agents/claude-code-priya", NOW - 3 * 3_600_000, "external", "no_op", "duplicate");
  await seedRun(R, "nodes/agents/renewal-risk", NOW - 5 * DAY, "server:metacognition", "no_op", "already_on_record");
  // Budget for this month: $11.42 of $40.
  await req("PATCH", `/surfaces/nests/${R}/budget`, { cap_micros: 40_000_000 }, alice.apiKey);
  await run("UPDATE surface_nest_budgets SET spent_micros = 11420000 WHERE nest_id = ?", [R]);
});

afterAll(async () => {
  for (const k of ["FEATURE_WORKFLOW_PLANE", "FEATURE_METACOGNITION", "FEATURE_SURFACES", "SURFACES_BUFFER_KEY", "PUBLIC_BASE_URL"]) delete process.env[k];
  await env?.cleanup();
});

beforeEach(async () => {
  await resetAuthRateLimit();
});

// ═══ AC-CR-03: the tiles equal the Surfaces read models ════════════════════

describe("AC-CR-03: Overview tiles", () => {
  it("AC-CR-03: conversations reviewed, % no proposal, saved/edited/rejected/expired and spend — computed by the page's logic from the ledger — equal /surfaces/windows, /surfaces/proposals, /surfaces/commits and the budget", async () => {
    const range = OV.rangeFor(14, NOW);
    const roll = await req("GET", `/rollups?${qs({ from: range.from, to: range.to, by: "none", grain: "day", source: "surfaces" })}`, undefined, alice.apiKey);
    expect(roll.status).toBe(200);
    const bindings = (await req("GET", "/surfaces/bindings", undefined, alice.apiKey)).data.bindings as OV.BindingLite[];
    const budget = (await req("GET", `/surfaces/nests/${R}/budget`, undefined, alice.apiKey)).data.budget as OV.BudgetLite;
    const tiles = OV.overviewTiles({
      surfaces: roll.data.totals,
      activeChannels: bindings.filter((b) => b.status === "active").length,
      days: 14,
      budgets: [budget],
    });

    const windows = (await req("GET", `/surfaces/windows?${qs({ from: range.from, to: range.to })}`, undefined, alice.apiKey)).data.windows as any[];
    const judged = windows.filter((w) => w.status === "judged");
    expect(tiles.reviewed).toBe(judged.length);
    expect(tiles.reviewed).toBe(seeded.windows);
    expect(tiles.noProposalPct).toBe(Math.round((judged.filter((w) => w.verdict === "no_op").length / judged.length) * 100));

    const items = ((await req("GET", `/surfaces/proposals?nest_id=${R}`, undefined, alice.apiKey)).data.proposals as any[]).flatMap((p) => p.items);
    const commits = (await req("GET", `/surfaces/commits?nest_id=${R}`, undefined, alice.apiKey)).data.commits as any[];
    expect(tiles.saved).toBe(items.filter((i) => i.state === "approved").length);
    expect(tiles.saved).toBe(commits.length);
    expect(tiles.edited).toBe(items.filter((i) => i.state === "approved" && i.edited).length);
    expect(tiles.rejected).toBe(items.filter((i) => i.state === "rejected").length);
    expect(tiles.expired).toBe(items.filter((i) => i.state === "expired").length);
    expect([tiles.saved, tiles.edited, tiles.rejected, tiles.expired]).toEqual([seeded.approved, seeded.edited, seeded.rejected, seeded.expired]);
    expect(tiles.spendUsd).toBeCloseTo(budget.spent_micros / 1e6, 6);
    expect(tiles.capUsd).toBe(40);
    // Cards per channel per day: proposing windows ÷ listening channels ÷ days.
    expect(tiles.cardsPerChannelDay).toBe(Math.round((seeded.proposed / 2 / 14) * 10) / 10);
  });

  it("AC-CR-03b: a paused_guard binding yields an alert naming the channel and the reason in counts only", async () => {
    const bindings = (await req("GET", "/surfaces/bindings", undefined, alice.apiKey)).data.bindings as OV.BindingLite[];
    const alerts = OV.pausedAlerts(bindings, (id) => (id === E ? "Engineering" : "Revenue"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ bindingId: bPaused, channel: "onboarding", nestId: E });
    expect(alerts[0].reason).toContain("Engineering is readable by 312 people");
    expect(alerts[0].reason).toContain("1 guest");
    expect(alerts[0].reason).not.toMatch(/@|alice|bob/i);
  });
});

// ═══ AC-CR-04: cold start ═══════════════════════════════════════════════════

describe("AC-CR-04: cold start", () => {
  const applied = NOW - 3 * DAY;
  async function approvedNode(nestId: string, folder: string, title: string, at: number, key = alice.apiKey) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `# ${title}\n\nBody.`, folder }, key);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.node?.id ?? r.data.id;
    await run("UPDATE node_versions SET status = 'published', created_at = ? WHERE nest_id = ? AND node_id = ?", [iso(at), nestId, id]);
    await run("UPDATE approved_versions SET approved_at = ? WHERE nest_id = ? AND node_id = ?", [iso(at), nestId, id]);
    return id as string;
  }

  beforeAll(async () => {
    const a = await req("POST", "/surfaces/seeds/apply", { nest_id: R, seed_id: "generic-team" }, alice.apiKey);
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    await run("UPDATE surface_seed_applications SET applied_at = ? WHERE nest_id = ?", [iso(applied), R]);
    // decisions/: one approved before the seed (counts as cover, not as "first"), two after.
    await approvedNode(R, "decisions", "Old pricing rule", applied - DAY);
    await approvedNode(R, "decisions", "Pipeline review moves to Thursdays", applied + 2 * 3_600_000 + 14 * 60_000);
    await approvedNode(R, "decisions", "Discount ceiling 18%", applied + DAY);
    // customers/: one.
    await approvedNode(R, "customers", "Acme renewal terms", applied + 2 * DAY);
    // A document the seed wrote itself inside a seed folder never counts.
    const own = await approvedNode(R, "how-we-work", "Seed example", applied);
    await run("INSERT INTO surface_seed_items (nest_id, kind, target, seed_id, seed_origin, seed_hash) VALUES (?, 'node', ?, 'generic-team', 'generic-team@1', 'x')", [R, own]);
    // A draft in projects/ is not approved.
    const draft = await jsonRequest(app, "POST", `/nests/${R}/nodes`, { title: "Draft project", content: "x", folder: "projects", status: "draft" }, alice.apiKey);
    const draftId = draft.data.node?.id ?? draft.data.id;
    await run("UPDATE node_versions SET status = 'draft' WHERE nest_id = ? AND node_id = ?", [R, draftId]);
    await run("DELETE FROM approved_versions WHERE nest_id = ? AND node_id = ?", [R, draftId]);
    // An approved document in the admin-only agents/ folder: not a seed folder for coverage.
    await approvedNode(R, "agents", "Listener notes", applied + DAY);
    // The org mirror: three people (two accepted), one area (accepted). The
    // apply above already mirrored R's channel groups; replace them with a
    // known set.
    await run("DELETE FROM surface_seed_mirror WHERE nest_id = ?", [R]);
    for (const [kind, subject, status] of [
      ["person", "u1", "approved"],
      ["person", "u2", "approved"],
      ["person", "u3", "pending"],
      ["area", "acme", "approved"],
    ]) {
      const rv = `rv_${randomUUID()}`;
      await run(`INSERT INTO review_requests (id, nest_id, node_id, version, requested_by, requested_at, status) VALUES (?, ?, ?, 1, 'alice@cr2.test', ?, ?)`, [
        rv,
        R,
        `nodes/${kind === "person" ? "people" : "projects"}/m-${subject}`,
        iso(applied),
        status,
      ]);
      await run("INSERT INTO surface_seed_mirror (nest_id, kind, subject_key, install_id, review_id) VALUES (?, ?, ?, ?, ?)", [R, kind, subject, installId, rv]);
    }
    // Pat's DM nest has the default seed.
    const p = await req("POST", "/surfaces/seeds/apply", { nest_id: P, seed_id: "generic-team" }, pat.apiKey);
    expect(p.status, JSON.stringify(p.data)).toBe(200);
  });

  it("AC-CR-04: coverage = seed folders with ≥ 1 approved document ÷ seed folders, excluding the seed's own documents and admin-only folders; time to first approved = first approval − applied_at; mirror people/areas", async () => {
    const r = await req("GET", `/surfaces/cold-start?nest_id=${R}`, undefined, alice.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const cs = r.data.nests[0];
    expect(cs).toMatchObject({ nest_id: R, nest_label: "Revenue", redacted: null, no_seed: false, seed: { id: "generic-team", version: 1 } });
    const byPath = Object.fromEntries(cs.folders.map((f: any) => [f.path, f.approved]));
    expect(byPath).toEqual({ "customers/": 1, "decisions/": 3, "how-we-work/": 0, "people/": 0, "projects/": 0 });
    expect(cs.coverage).toEqual({ covered: 2, total: 5 });
    expect(cs.first_approved.after_seed_ms).toBe(2 * 3_600_000 + 14 * 60_000);
    expect(OV.formatDuration(cs.first_approved.after_seed_ms)).toBe("2 h 14 m");
    expect(cs.mirror).toEqual({ people: { proposed: 3, accepted: 2 }, areas: { proposed: 1, accepted: 1 } });
    // Cumulative: one point per day from the seed's day to today, ending at the in-folder total.
    expect(cs.cumulative.length).toBe(4);
    expect(cs.cumulative[cs.cumulative.length - 1].approved).toBe(4);
    expect(cs.cumulative[0].approved).toBeGreaterThanOrEqual(1); // the pre-seed decision
  });

  it("AC-CR-04: a nest with no seed says so (no_seed, empty figures)", async () => {
    const r = await req("GET", `/surfaces/cold-start?nest_id=${E}`, undefined, alice.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.nests[0]).toMatchObject({ nest_id: E, no_seed: true, seed: null, folders: [], coverage: { covered: 0, total: 0 }, first_approved: null });
  });

  it("AC-CR-04: owner/admin only — a reader is refused; listing all covers administered seeded nests, and a personal nest only for its owner (N1)", async () => {
    expect((await req("GET", `/surfaces/cold-start?nest_id=${R}`, undefined, bob.apiKey)).status).toBe(403);
    const mine = await req("GET", "/surfaces/cold-start", undefined, alice.apiKey);
    expect(mine.data.nests.map((n: any) => n.nest_id)).toEqual([R]);
    const asAdminOfP = await req("GET", `/surfaces/cold-start?nest_id=${P}`, undefined, alice.apiKey);
    expect(asAdminOfP.data.nests[0]).toMatchObject({ nest_label: "DM · private nest · title hidden", redacted: "n1" });
    const owner = await req("GET", "/surfaces/cold-start", undefined, pat.apiKey);
    expect(owner.data.nests.map((n: any) => n.nest_id)).toEqual([P]);
    expect(owner.data.nests[0]).toMatchObject({ nest_label: "Pat DM", redacted: null });
    const server = await req("GET", "/surfaces/cold-start", undefined, root.apiKey);
    expect(server.data.nests.map((n: any) => n.nest_id)).toContain(R);
    expect(server.data.nests.map((n: any) => n.nest_id)).not.toContain(P);
  });

  it("AC-CR-04: the MCP twin context_surfaces_cold_start returns the same read model as REST", async () => {
    const rest = (await req("GET", `/surfaces/cold-start?nest_id=${R}`, undefined, alice.apiKey)).data.nests[0];
    const viaMcp = await mcp(R, alice.apiKey, "context_surfaces_cold_start", {});
    expect(viaMcp).toEqual(rest);
  });
});

// ═══ AC-CR-04 (review): exact seed-own filter, bounded all-nests read ═══════

describe("AC-CR-04 (review): cold start", () => {
  const applied = NOW - 3 * DAY;

  it("a CONTEXT document a person writes and approves in a seed folder counts as cover; only the seed's own recorded documents are excluded", async () => {
    const Z = (await jsonRequest(app, "POST", "/nests", { name: "Ctx" }, root.apiKey)).data.nest.id;
    const a = await req("POST", "/surfaces/seeds/apply", { nest_id: Z, seed_id: "generic-team" }, root.apiKey);
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    await run("UPDATE surface_seed_applications SET applied_at = ? WHERE nest_id = ?", [iso(applied), Z]);
    const r = await jsonRequest(app, "POST", `/nests/${Z}/nodes`, { title: "CONTEXT", content: "# CONTEXT\n\nHow we decide.", folder: "decisions" }, root.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.node?.id ?? r.data.id;
    expect(id).toMatch(/decisions\/context$/i);
    await run("UPDATE node_versions SET status = 'published', created_at = ? WHERE nest_id = ? AND node_id = ?", [iso(applied + DAY), Z, id]);
    await run("UPDATE approved_versions SET approved_at = ? WHERE nest_id = ? AND node_id = ?", [iso(applied + DAY), Z, id]);
    const cs = (await req("GET", `/surfaces/cold-start?nest_id=${Z}`, undefined, root.apiKey)).data.nests[0];
    expect(cs.folders.find((f: any) => f.path === "decisions/").approved).toBe(1);
    expect(cs.first_approved.after_seed_ms).toBe(DAY);
  });

  it("listing every seeded nest costs a fixed number of queries, not a per-nest scan", async () => {
    const dbi = (await db()) as any;
    const count = async (fn: () => Promise<unknown>) => {
      let n = 0;
      const orig = { get: dbi.get, all: dbi.all };
      dbi.get = function (q: string, p?: unknown[]) {
        n++;
        return orig.get.call(this, q, p);
      };
      dbi.all = function (q: string, p?: unknown[]) {
        n++;
        return orig.all.call(this, q, p);
      };
      try {
        await fn();
      } finally {
        dbi.get = orig.get;
        dbi.all = orig.all;
      }
      return n;
    };
    const list = () => req("GET", "/surfaces/cold-start", undefined, root.apiKey);
    const before = await count(list);
    const n0 = (await list()).data.nests.length;
    for (let i = 0; i < 4; i++) {
      const id = (await jsonRequest(app, "POST", "/nests", { name: `Bulk ${i}` }, root.apiKey)).data.nest.id;
      expect((await req("POST", "/surfaces/seeds/apply", { nest_id: id, seed_id: "generic-team" }, root.apiKey)).status).toBe(200);
    }
    const res = await list();
    expect(res.data.nests.length).toBe(n0 + 4);
    const after = await count(list);
    expect(after - before).toBeLessThanOrEqual(2);
  });
});

// ═══ AC-CR-07c: private-nest wording ════════════════════════════════════════

describe("AC-CR-07c: private-nest rows", () => {
  it("AC-CR-07c: a redacted ledger row renders 'DM · private nest · title hidden' and source 'Private'", () => {
    const e: OV.LedgerEntry = {
      entry_id: "win_x",
      at: iso(NOW),
      nest: { id: P, label: "DM · private nest · title hidden" },
      agent: { node_id: "nodes/agents/listener-dm", name: "DM listener", source: "surfaces" },
      run: null,
      verdict: { code: "propose", reason_code: "proposed", kinds: ["decision"], message_count: 4 },
      decision: null,
      proposal: { id: "p", state: "approved", edited: false, counts: {} },
      review: { at: iso(NOW) },
      commit: { version: 1 },
      redacted: "n1",
    };
    expect(OV.whatCell(e)).toEqual({ title: "DM · private nest · title hidden", sub: null, redacted: true });
    expect(OV.sourceCell(e).text).toBe("Private");
  });
});

// ═══ AC-CR-09: parity for the new route ════════════════════════════════════

describe("AC-CR-09 (CR2): MCP parity for the cold-start route", () => {
  it("AC-CR-09: context_surfaces_cold_start is built from the shared zod schema, advertised to an owner, and documented with its route in API.md", async () => {
    const { SURFACES_TOOL_DEFINITIONS } = await import("../src/mcp/surfaces-tools.js");
    const { ColdStartMcpInput, ColdStartQuery } = await import("../src/surfaces/cold-start-schema.js");
    const { mcpInputSchema } = await import("../src/workflow/agent-event-schema.js");
    const t = SURFACES_TOOL_DEFINITIONS.find((d: any) => d.name === "context_surfaces_cold_start") as any;
    expect(t).toBeTruthy();
    expect(t.inputSchema).toEqual(mcpInputSchema(ColdStartMcpInput));
    // The MCP input is the REST query minus the nest the endpoint is bound to.
    expect(Object.keys(ColdStartQuery.shape)).toEqual(["nest_id"]);
    expect(Object.keys(ColdStartMcpInput.shape)).toEqual([]);
    expect(await mcpTools(R, alice.apiKey)).toContain("context_surfaces_cold_start");
    const api = readFileSync(join(__dirname, "..", "API.md"), "utf8");
    expect(api).toContain("GET /surfaces/cold-start");
    expect(api).toContain("context_surfaces_cold_start");
    expect(api).toMatch(/by=agent\|nest\|binding\|reason\|none/);
  });

  it("AC-CR-09: lint:mcp-schemas stays at its baseline (the new tool adds no inline schema)", () => {
    const out = execFileSync(process.execPath, [join(__dirname, "..", "scripts", "check-mcp-schemas.mjs")], { encoding: "utf8" });
    expect(out).toMatch(/No new inline MCP schemas/);
  });
});

// ═══ AC-CR-10: the rollup additions reconcile ══════════════════════════════

describe("AC-CR-10 (CR2): by=reason, last_at and source", () => {
  it("AC-CR-10: rollups by=reason over no-op listener windows sum to the ledger's no_op total, per reason as seeded", async () => {
    const range = OV.rangeFor(14, NOW);
    const f = { from: range.from, to: range.to, source: "surfaces", verdict: "no_op" };
    const roll = await req("GET", `/nests/${R}/rollups?${qs({ ...f, by: "reason", grain: "week" })}`, undefined, alice.apiKey);
    expect(roll.status).toBe(200);
    const ledger = await req("GET", `/nests/${R}/ledger?${qs({ ...f, limit: "1" })}`, undefined, alice.apiKey);
    const breakdown = OV.reasonBreakdown(roll.data.rows);
    expect(breakdown.reduce((s, r) => s + r.count, 0)).toBe(ledger.data.totals.no_op);
    expect(ledger.data.totals.no_op).toBe(seeded.noop);
    expect(Object.fromEntries(breakdown.map((r) => [r.code, r.count]))).toEqual(Object.fromEntries(seeded.reasons));
    expect(breakdown[0]).toMatchObject({ code: "chatter", label: "Chatter" });
    for (const r of roll.data.rows) expect(r.nest_id).toBeNull();
  });

  it("AC-CR-10: by=agent rows carry last_at (the latest ledger row) and source (its kind); the agents list sorts by last report", async () => {
    const range = OV.rangeFor(14, NOW);
    const roll = await req("GET", `/rollups?${qs({ from: range.from, to: range.to, by: "agent", grain: "week" })}`, undefined, alice.apiKey);
    const agents = OV.agentRows(roll.data.rows);
    const byNode = Object.fromEntries(agents.map((a) => [a.nodeId, a]));
    expect(byNode["nodes/agents/claude-code-priya"]).toMatchObject({ source: "external", lastAt: iso(NOW - 3 * 3_600_000) });
    expect(byNode["nodes/agents/renewal-risk"]).toMatchObject({ source: "metacognition", lastAt: iso(NOW - 5 * DAY) });
    expect(byNode[`nodes/agents/listener-${R.slice(0, 6)}`]).toMatchObject({ source: "surfaces", lastAt: iso(NOW - 3_600_000) });
    const sorted = [...agents].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)).map((a) => a.id);
    expect(agents.map((a) => a.id)).toEqual(sorted);
    // Each agent's runs equal the ledger total filtered to that agent.
    for (const a of agents) {
      const l = await req("GET", `/ledger?${qs({ from: range.from, to: range.to, agent: a.nodeId, limit: "1" })}`, undefined, alice.apiKey);
      expect(l.data.totals.entries, a.nodeId).toBe(a.totals.entries);
      const latest = await req("GET", `/ledger?${qs({ from: range.from, to: range.to, agent: a.nodeId, limit: "1" })}`, undefined, alice.apiKey);
      expect(latest.data.entries[0].at).toBe(a.lastAt);
    }
  });

  it("AC-CR-10: the channel table's counts equal the ledger filtered to each binding", async () => {
    const range = OV.rangeFor(14, NOW);
    const roll = await req("GET", `/rollups?${qs({ from: range.from, to: range.to, by: "binding", grain: "week", source: "surfaces" })}`, undefined, alice.apiKey);
    const bindings = (await req("GET", "/surfaces/bindings", undefined, alice.apiKey)).data.bindings as OV.BindingLite[];
    const rows = OV.channelRows(bindings, roll.data.rows, 14);
    expect(rows.map((r) => r.name).sort()).toEqual(["acme-renewal", "onboarding", "revops"]);
    expect(rows[rows.length - 1]).toMatchObject({ name: "onboarding", status: "paused_guard", reviewed: 0 });
    for (const r of rows.filter((x) => x.status === "active")) {
      const l = await req("GET", `/ledger?${qs({ from: range.from, to: range.to, binding: r.bindingId, limit: "1" })}`, undefined, alice.apiKey);
      expect(r.reviewed).toBe(l.data.totals.entries);
      expect(r.noProposalPct).toBe(Math.round((l.data.totals.no_op / l.data.totals.entries) * 100));
      expect(r.lastAt).toBe(l.data.entries[0].at);
    }
  });
});

// ═══ AC-CR-11: design tokens only ══════════════════════════════════════════

describe("AC-CR-11: colours are design-system tokens", () => {
  it("AC-CR-11: no hex colour in the Control room component files", () => {
    const dir = join(__dirname, "..", "ui", "src", "pages", "app", "control-room");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx") || n.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src.match(/#[0-9a-fA-F]{3,8}\b(?![-\w])/g), f).toBeNull();
    }
  });
});
