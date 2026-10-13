/**
 * Metacognition hardening: what an agent may reach, how it fails, and how it
 * stays quiet.
 *
 *  - The owner is pinned: a server admin saving an agent's settings does not
 *    become the person it answers to, and lends the persona nothing.
 *  - The persona's reach is its own scope, widened only by grants an admin
 *    gives the persona (an approved access request it filed).
 *  - A run cut off by its clock is a failure, and a failure tells the nest's
 *    channels.
 *  - It doesn't repeat itself (no second proposal for the same change, a
 *    comment budget) and doesn't pay to re-read an unchanged nest.
 *  - What a run spent is on the trace turn by turn, so a crash keeps it.
 *
 * Only the model call is scripted (as in metacognition.test.ts); the routes,
 * loop, tools, review queue and run trace are real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

type Turn = { content: any[]; stop_reason: string; usage?: Record<string, number> };

let script: Array<Turn | ((req: any) => Turn | Promise<Turn>)> = [];
let requests: any[] = [];

const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id: `tu_${name}_${Math.random().toString(36).slice(2, 8)}`,
  name,
  input,
});
const say = (text: string): Turn => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 20 },
});
const call = (...uses: any[]): Turn => ({
  content: uses,
  stop_reason: "tool_use",
  usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 400 },
});

const WEBHOOK = "https://hooks.slack.com/services/T9/B9/HARDEN";
const slack: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  vi.doMock("../src/metacognition/model.js", async () => {
    const actual = await vi.importActual<typeof import("../src/metacognition/model.js")>(
      "../src/metacognition/model.js",
    );
    return {
      ...actual,
      createTurn: async (params: any) => {
        requests.push(JSON.parse(JSON.stringify(params.request)));
        const next = script.shift();
        if (!next) return say("Nothing more to do.");
        if (typeof next !== "function") return next;
        return await new Promise((resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
          Promise.resolve(next(params.request)).then(resolve, reject);
        });
      },
    };
  });
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    if (String(url) === WEBHOOK) {
      slack.push(JSON.parse(init.body).text);
      return new Response("ok", { status: 200 });
    }
    return realFetch(url, init);
  });
});
afterAll(() => {
  vi.doUnmock("../src/metacognition/model.js");
  vi.unstubAllGlobals();
});

let env: ReturnType<typeof setupTestEnv>;
let app: any;
type U = { apiKey: string; email: string; userId: string };
let owner: U;
let root: U;
let adminUser: U;
let reviewer: U;
let nestId: string;
let otherNestId: string;
let adminCollabId: string;

async function waitForRun(runId: string) {
  for (let i = 0; i < 800; i++) {
    const r = await jsonRequest(app, "GET", `/runs/${runId}`, undefined, owner.apiKey);
    if (r.data?.run?.status && r.data.run.status !== "running") return r.data;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never finished`);
}

async function run(nodeId: string): Promise<any> {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/metacognition/${nodeId}/run`, {}, owner.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(202);
  return waitForRun(r.data.run_id);
}

/** The tool results the loop handed back to the model, in order. The last
 *  request carries the whole conversation. */
function toolResults(): string[] {
  const out: string[] = [];
  const last = requests[requests.length - 1];
  if (!last) return out;
  for (const m of last.messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(String(b.content));
  }
  return out;
}

// Read by the mocked license on every call (the seat-limit case).
const plan: { maxSubscribers?: number | null } = {};

const CONFIG = {
  persona: { name: "Curator", avatar: "🦉" },
  scope: { read: ["gtm"], propose: ["gtm"] },
  caps: { max_steps: 8, max_tokens: 200_000, max_seconds: 60, max_proposals: 3, max_comments: 1 },
  feeds: [],
  mcp_servers: [],
};

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.METACOGNITION_STARTS_PER_HOUR = "1000";
  process.env.METACOGNITION_CANCEL_POLL_MS = "50";
  process.env.SLACK_WEBHOOK_URL = WEBHOOK;
  env = setupTestEnv();
  app = await createTestApp("key", {
    entitlement: plan,
    superAdmins: ["root@acme.com"],
    gateway: { baseUrl: "https://gateway.promptowl.test", key: "po-key", defaultModel: "default-claude/claude-sonnet-5" },
  });
  owner = await registerUser(app, "owner@acme.com", "Owner");
  root = await registerUser(app, "root@acme.com", "Root");
  await resetAuthRateLimit();
  adminUser = await registerUser(app, "admin@acme.com", "Admin");
  reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Home" }, owner.apiKey)).data.nest.id;
  const collab = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: adminUser.email, permission: "admin" },
    owner.apiKey,
  );
  adminCollabId = collab.data?.collaborator?.id ?? collab.data?.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: reviewer.email, permission: "read" }, owner.apiKey);

  for (const title of ["Curator", "Second Agent", "Quiet Agent"]) {
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: "Keep GTM current.", type: "agent" }, owner.apiKey);
  }
  for (const [folder, title, body] of [
    ["gtm", "Pricing", "# Pricing\n\nTeam plan is $8 per seat."],
    ["gtm", "Positioning", "# Positioning\n\nGoverned context."],
    ["private", "Board Notes", "# Board Notes\n\nConfidential."],
  ]) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: body, folder }, owner.apiKey);
    expect(r.status).toBe(201);
  }
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] },
    owner.apiKey,
  );

  // A second nest the persona must never reach, whoever saves its settings.
  otherNestId = (await jsonRequest(app, "POST", "/nests", { name: "Elsewhere" }, root.apiKey)).data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${otherNestId}/nodes`,
    { title: "Plan", content: "# Plan\n\nSecret plan.", folder: "gtm" },
    root.apiKey,
  );
});

afterAll(async () => {
  for (const k of ["FEATURE_WORKFLOW_PLANE", "FEATURE_METACOGNITION", "SLACK_WEBHOOK_URL"]) delete process.env[k];
  await env.cleanup();
});

describe("the owner is pinned; the persona's reach is its own", () => {
  it("a server admin saving the settings does not become the owner", async () => {
    const made = await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/nodes/curator`, CONFIG, owner.apiKey);
    expect(made.status).toBe(200);
    expect(made.data.agent.configured_by).toBe(owner.email);

    const saved = await jsonRequest(
      app,
      "PUT",
      `/nests/${nestId}/metacognition/nodes/curator`,
      { ...CONFIG, caps: { ...CONFIG.caps, max_steps: 9 } },
      root.apiKey,
    );
    expect(saved.status).toBe(200);
    expect(saved.data.agent.caps.max_steps).toBe(9);
    expect(saved.data.agent.configured_by).toBe(owner.email);
    expect(saved.data.agent.owner_changed).toBe(false);
  });

  it("after a server admin saved it, the persona still reads only its own scope in its own nest", async () => {
    requests = [];
    script = [
      call(
        toolUse("read_node", { id: "nodes/private/board-notes" }), // its nest, outside scope.read
        toolUse("read_node", { id: "nodes/gtm/plan" }), // only exists in the other nest
        toolUse("read_node", { id: "nodes/gtm/pricing" }),
      ),
      say("Done."),
    ];
    const done = await run("nodes/curator");
    expect(done.run.status).toBe("succeeded");
    const results = toolResults();
    expect(results[0]).toMatch(/outside your read scope/);
    expect(results[1]).toMatch(/No document nodes\/gtm\/plan/);
    expect(results[1]).not.toContain("Secret plan");
    expect(results[2]).toContain("$8 per seat");
    expect(JSON.stringify(results)).not.toContain("Confidential");
  });

  it("the persona can ask for access, and an approved ask widens its reach", async () => {
    requests = [];
    script = [
      call(toolUse("request_access", { target: "nodes/private", kind: "folder", level: "read", reason: "Board notes cite pricing." })),
      say("Asked."),
    ];
    const first = await run("nodes/curator");
    expect(first.run.status).toBe("succeeded");
    const asked = first.steps.find((s: any) => s.detail?.kind === "access_request");
    expect(asked?.detail.access_request_id).toBeTruthy();
    expect(toolResults()[0]).toMatch(/^Asked\./);

    const queue = await jsonRequest(app, "GET", `/nests/${nestId}/access-requests`, undefined, owner.apiKey);
    const mine = (queue.data.requests ?? queue.data).find((r: any) => r.id === asked.detail.access_request_id);
    expect(mine?.target_type).toBe("folder");
    expect(mine?.level).toBe("read");

    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests/${asked.detail.access_request_id}/approve`,
      {},
      owner.apiKey,
    );
    expect(approve.status, JSON.stringify(approve.data)).toBe(200);

    requests = [];
    script = [call(toolUse("read_node", { id: "nodes/private/board-notes" })), say("Read it.")];
    await run("nodes/curator");
    expect(toolResults()[0]).toContain("Confidential");
  });

  it("approving a persona's propose request takes no seat, even on a full plan", async () => {
    requests = [];
    script = [
      call(toolUse("request_access", { target: "nodes/private", kind: "folder", level: "propose", reason: "Fix board notes." })),
      say("Asked."),
    ];
    const asked = (await run("nodes/curator")).steps.find((s: any) => s.detail?.kind === "access_request");
    plan.maxSubscribers = 0;
    try {
      const approve = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/access-requests/${asked.detail.access_request_id}/approve`,
        {},
        owner.apiKey,
      );
      expect(approve.status, JSON.stringify(approve.data)).toBe(200);
    } finally {
      delete plan.maxSubscribers;
    }
    const { resolveNodeGrant } = await import("../src/governance/grants-service.js");
    const { getAgent } = await import("../src/metacognition/store.js");
    const agent = (await getAgent(nestId, "nodes/curator"))!;
    expect(await resolveNodeGrant(nestId, agent.persona.user_id, "nodes/private/board-notes")).toBe("write");
  });

  it("a persona may not ask for a whole nest, nor for anything in a nest it doesn't live in", async () => {
    const { createAccessRequest } = await import("../src/governance/access-request-service.js");
    const { getAgent } = await import("../src/metacognition/store.js");
    const agent = (await getAgent(nestId, "nodes/curator"))!;
    const base = { requesterId: agent.persona.user_id, requesterEmail: agent.persona.email };
    await expect(createAccessRequest({ ...base, nestId, targetType: "nest" })).rejects.toThrow(/not the whole nest/);
    await expect(
      createAccessRequest({ ...base, nestId: otherNestId, targetType: "node", targetId: "nodes/gtm/plan" }),
    ).rejects.toThrow(/Sign in/);
  });

  it("ownership moves only when the owner can no longer run the agent", async () => {
    const made = await jsonRequest(
      app,
      "PUT",
      `/nests/${nestId}/metacognition/nodes/second-agent`,
      CONFIG,
      adminUser.apiKey,
    );
    expect(made.data.agent.configured_by).toBe(adminUser.email);
    const demoted = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/collaborators/${adminCollabId}`,
      { permission: "read" },
      owner.apiKey,
    );
    expect(demoted.status, JSON.stringify(demoted.data)).toBe(200);
    const taken = await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/nodes/second-agent`, CONFIG, owner.apiKey);
    expect(taken.data.agent.configured_by).toBe(owner.email);
    expect(taken.data.agent.owner_changed).toBe(true);
  });
});

describe("noise", () => {
  it("does not propose the same change twice while the first is waiting", async () => {
    requests = [];
    script = [
      call(toolUse("read_node", { id: "nodes/gtm/positioning" })),
      call(
        toolUse("propose_edit", { id: "nodes/gtm/positioning", content: "# Positioning\n\nGoverned context, everywhere.", note: "Sharper." }),
      ),
      say("Proposed."),
    ];
    await run("nodes/curator");
    expect(toolResults()[1]).toMatch(/^Proposed\./);

    requests = [];
    script = [
      call(toolUse("propose_new", { folder: "gtm", title: "Pricing FAQ", content: "Q&A", note: "Missing." })),
      say("Done."),
    ];
    await run("nodes/curator");
    expect(toolResults()[0]).toMatch(/^Proposed new document nodes\/gtm\/pricing-faq/);

    requests = [];
    script = [
      call(toolUse("propose_new", { folder: "gtm", title: "Pricing FAQ", content: "Q&A again", note: "Missing." })),
      say("Done."),
    ];
    await run("nodes/curator");
    expect(toolResults()[0]).toMatch(/already proposed a change to nodes\/gtm\/pricing-faq/);
  });

  it("a rejected proposal is not proposed again this week", async () => {
    const rej = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/gtm/positioning/reject`,
      { note: "We don't say everywhere." },
      reviewer.apiKey,
    );
    expect(rej.status, JSON.stringify(rej.data)).toBe(200);

    requests = [];
    script = [
      call(toolUse("read_node", { id: "nodes/gtm/positioning" })),
      call(
        toolUse("propose_edit", { id: "nodes/gtm/positioning", content: "# Positioning\n\nGoverned context, everywhere.", note: "Again." }),
      ),
      say("Done."),
    ];
    await run("nodes/curator");
    expect(toolResults()[1]).toMatch(/rejected your proposal for nodes\/gtm\/positioning recently/);
    expect(toolResults()[1]).toContain("We don't say everywhere.");
  });

  it("comments stop at the comment budget", async () => {
    requests = [];
    script = [
      call(
        toolUse("comment", { id: "nodes/gtm/pricing", body: "Is $8 still right?" }),
        toolUse("comment", { id: "nodes/gtm/pricing", body: "And annual?" }),
      ),
      say("Done."),
    ];
    await run("nodes/curator");
    const [first, second] = toolResults();
    expect(first).toMatch(/^Commented/);
    expect(second).toMatch(/used this run's 1 comments/);
  });

  it("learns from verdicts: the memory carries its approval rate and where it lands", async () => {
    requests = [];
    script = [say("Looked.")];
    await run("nodes/curator");
    const memory = JSON.stringify(requests[0].messages[0].content);
    expect(memory).toMatch(/How reviewers have judged your proposals overall/);
    expect(memory).toMatch(/0 approved, 1 rejected \(0% approved\)/);
    expect(memory).toMatch(/nodes\/gtm\/: 0 approved, 1 rejected/);
  });
});

describe("failures, timeouts and cost", () => {
  it("a run cut off by its clock is failed (stopped_by timeout) and tells the nest's channels", async () => {
    await jsonRequest(
      app,
      "PUT",
      `/nests/${nestId}/metacognition/nodes/curator`,
      { ...CONFIG, caps: { ...CONFIG.caps, max_seconds: 10 } },
      owner.apiKey,
    );
    slack.length = 0;
    script = [() => new Promise<Turn>(() => {})];
    const done = await run("nodes/curator");
    expect(done.run.status).toBe("failed");
    expect(done.run.trace.stopped_by).toBe("timeout");
    expect(done.run.trace.error).toMatch(/10s limit/);
    await new Promise((r) => setTimeout(r, 100));
    expect(slack.some((t) => /Run of \*nodes\/curator\* failed/.test(t))).toBe(true);
    await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/nodes/curator`, CONFIG, owner.apiKey);
  }, 30_000);

  it("writes each turn's usage to the trace as it goes, and a crash keeps it", async () => {
    script = [call(toolUse("read_node", { id: "nodes/gtm/pricing" })), say("Done.")];
    const done = await run("nodes/curator");
    const turns = done.steps.filter((s: any) => s.detail?.kind === "turn");
    expect(turns.length).toBe(2);
    expect(turns[0].detail.usage.input_tokens).toBe(1000);
    expect(turns[0].detail.est_cost_usd).toBeGreaterThan(0);

    const { usageFromSteps } = await import("../src/metacognition/service.js");
    const rebuilt = await usageFromSteps(done.run.id);
    expect(rebuilt.usage).toEqual(done.run.trace.usage);
  });

  it("an orphaned run is closed failed with what it spent, and alerts", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { recoverOrphanedRuns } = await import("../src/metacognition/service.js");
    const id = `run_orphan_${Date.now()}`;
    const db = getDb();
    await db.run(
      `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, started_at, depth, claimed_by, claimed_at)
       VALUES (?, ?, 'nodes/quiet-agent', 'test', 'running', ?, 0, 'server:metacognition', ?)`,
      [id, nestId, new Date().toISOString(), new Date().toISOString()],
    );
    await db.run(
      "INSERT INTO run_steps (run_id, seq, action, detail, at) VALUES (?, 1, 'branch', ?, ?)",
      [id, JSON.stringify({ kind: "turn", model: "claude-sonnet-5", usage: { input_tokens: 500, output_tokens: 10 } }), new Date().toISOString()],
    );
    slack.length = 0;
    expect(await recoverOrphanedRuns({ nestId })).toBeGreaterThanOrEqual(1);
    const row = (await db.get("SELECT status, trace FROM runs WHERE id = ?", [id])) as any;
    expect(row.status).toBe("failed");
    const trace = JSON.parse(row.trace);
    expect(trace.usage.input_tokens).toBe(500);
    expect(trace.stopped_by).toBe("crashed");
    await new Promise((r) => setTimeout(r, 100));
    expect(slack.some((t) => /quiet-agent\* failed/.test(t))).toBe(true);
  });
});

describe("scheduled runs into an unchanged nest", () => {
  it("skip without calling the model, and run again once something changes", async () => {
    await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/nodes/quiet-agent`, CONFIG, owner.apiKey);
    const { startMetacognitionRun } = await import("../src/metacognition/service.js");
    const start = async () =>
      waitForRun(
        await startMetacognitionRun({ nestId, nodeId: "nodes/quiet-agent", triggeredBy: `schedule:${owner.email}`, rateLimited: false }),
      );

    script = [say("First look.")];
    expect((await start()).run.status).toBe("succeeded");

    requests = [];
    const idle = await start();
    expect(idle.run.status).toBe("cancelled");
    expect(idle.run.trace.skipped).toMatch(/Nothing changed/);
    expect(requests.length).toBe(0);

    // A person pressing Run always runs. Its own proposal is not news to the next schedule.
    await new Promise((r) => setTimeout(r, 1100)); // second-resolution timestamps
    script = [
      call(toolUse("propose_new", { folder: "gtm", title: "Quiet Notes", content: "Notes.", note: "Missing." })),
      say("Proposed."),
    ];
    const manual = await run("nodes/quiet-agent");
    expect(manual.run.status).toBe("succeeded");
    expect(manual.run.trace.proposals).toBe(1);
    requests = [];
    expect((await start()).run.status).toBe("cancelled");
    expect(requests.length).toBe(0);

    // A settings save is news.
    await new Promise((r) => setTimeout(r, 1100));
    await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/nodes/quiet-agent`, CONFIG, owner.apiKey);
    script = [say("New settings.")];
    expect((await start()).run.status).toBe("succeeded");

    await new Promise((r) => setTimeout(r, 1100)); // second-resolution timestamps
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/gtm/pricing`,
      { content: "# Pricing\n\nTeam plan is $9 per seat." },
      owner.apiKey,
    );
    expect(edit.status, JSON.stringify(edit.data)).toBe(200);
    requests = [];
    script = [say("Saw the change.")];
    expect((await start()).run.status).toBe("succeeded");
    expect(requests.length).toBe(1);
  }, 30_000);
});

describe("persona avatar", () => {
  it("is a glyph, never a URL", async () => {
    const bad = await jsonRequest(
      app,
      "PUT",
      `/nests/${nestId}/metacognition/nodes/quiet-agent`,
      { ...CONFIG, persona: { name: "Quiet", avatar: "https://tracker.example/p.gif" } },
      owner.apiKey,
    );
    expect(bad.status).toBe(400);
    const ok = await jsonRequest(
      app,
      "PUT",
      `/nests/${nestId}/metacognition/nodes/quiet-agent`,
      { ...CONFIG, persona: { name: "Quiet", avatar: "👩‍💻" } },
      owner.apiKey,
    );
    expect(ok.status).toBe(200);
    expect(ok.data.agent.persona.avatar).toBe("👩‍💻");
  });
});
