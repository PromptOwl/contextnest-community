/**
 * Metacognition agent activity tracking — what an agent did, and the way back
 * from what it produced to the run that produced it.
 *
 *   - run back-links (migration 060): a proposal, comment or access request a
 *     run made carries its run_id, scoped to the run's own nest;
 *   - GET /nests/:id/metacognition/:node/stats: outcomes, tokens and cost,
 *     proposal verdicts, recent runs;
 *   - RUN_RETENTION_DAYS: finished runs older than the window are pruned,
 *     running ones never; 0 keeps everything.
 *
 * The model is the only thing mocked (same harness as metacognition.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type Turn = { content: any[]; stop_reason: string; usage?: Record<string, number> };

let script: Turn[] = [];

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
  usage: { input_tokens: 1000, output_tokens: 50 },
});

beforeAll(() => {
  vi.doMock("../src/metacognition/model.js", async () => {
    const actual = await vi.importActual<typeof import("../src/metacognition/model.js")>(
      "../src/metacognition/model.js",
    );
    return { ...actual, createTurn: async () => script.shift() ?? say("Nothing more to do.") };
  });
});
afterAll(() => {
  vi.doUnmock("../src/metacognition/model.js");
});

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string; userId: string };
let reviewer: { apiKey: string; email: string; userId: string };
let reader: { apiKey: string; email: string; userId: string };
let nestId: string;
let otherNestId: string;

const AGENT = "nodes/archivist";
const CONFIG = {
  persona: { name: "Archivist", avatar: null },
  scope: { read: ["gtm"], propose: ["gtm"] },
  caps: { max_steps: 8, max_tokens: 200_000, max_seconds: 60, max_proposals: 3 },
  feeds: [],
  mcp_servers: [],
};

async function waitForRun(runId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await jsonRequest(app, "GET", `/runs/${runId}`, undefined, owner.apiKey);
    if (r.data?.run?.status && r.data.run.status !== "running") return r.data;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never finished`);
}

async function runAgent(turns: Turn[]) {
  script = turns;
  const start = await jsonRequest(app, "POST", `/nests/${nestId}/metacognition/${AGENT}/run`, {}, owner.apiKey);
  expect(start.status).toBe(202);
  await waitForRun(start.data.run_id);
  return start.data.run_id as string;
}

const stats = (key: string, qs = "") =>
  jsonRequest(app, "GET", `/nests/${nestId}/metacognition/${AGENT}/stats${qs}`, undefined, key);

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.METACOGNITION_STARTS_PER_HOUR = "1000";
  process.env.METACOGNITION_CANCEL_POLL_MS = "50";
  env = setupTestEnv();
  app = await createTestApp("key", {
    superAdmins: ["owner@acme.com"],
    gateway: { baseUrl: "https://gateway.promptowl.test", key: "po-key", defaultModel: "default-claude/claude-sonnet-5" },
  });
  owner = await registerUser(app, "owner@acme.com", "Owner");
  reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
  await resetAuthRateLimit();
  reader = await registerUser(app, "reader@acme.com", "Reader");

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Activity" }, owner.apiKey)).data.nest.id;
  otherNestId = (await jsonRequest(app, "POST", "/nests", { name: "Elsewhere" }, owner.apiKey)).data.nest.id;
  for (const [email, permission] of [
    [reviewer.email, "read"],
    [reader.email, "read"],
  ] as const) {
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email, permission }, owner.apiKey);
  }
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Archivist", content: "Keep the GTM folder current.", type: "agent" },
    owner.apiKey,
  );
  for (const [title, body] of [
    ["Pricing", "# Pricing\n\nTeam plan is $8 per seat."],
    ["Positioning", "# Positioning\n\nWe sell governed context."],
  ]) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: body, folder: "gtm" }, owner.apiKey);
    expect(r.status).toBe(201);
  }
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] },
    owner.apiKey,
  );
  const put = await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/${AGENT}`, CONFIG, owner.apiKey);
  expect(put.status).toBe(200);
}, 60_000);

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  delete process.env.RUN_RETENTION_DAYS;
  await env.cleanup();
});

describe("run back-links", () => {
  let runId: string;

  it("stamps the run on the proposal and the comment it made", async () => {
    runId = await runAgent([
      call(
        toolUse("propose_edit", {
          id: "nodes/gtm/pricing",
          content: "# Pricing\n\nTeam plan is $10 per seat.",
          note: "Price changed.",
        }),
      ),
      call(toolUse("comment", { id: "nodes/gtm/positioning", body: "This line is out of date." })),
      say("One proposal, one comment."),
    ]);

    const queue = await jsonRequest(app, "GET", `/nests/${nestId}/review-queue`, undefined, reviewer.apiKey);
    const review = queue.data.requests.find((r: any) => r.nodeId === "nodes/gtm/pricing");
    expect(review.runId).toBe(runId);

    const threads = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/gtm/positioning/annotations`, undefined, owner.apiKey);
    const list = threads.data.threads ?? threads.data.annotations ?? threads.data;
    const comment = (Array.isArray(list) ? list : []).flatMap((t: any) => t.comments ?? [])[0];
    expect(comment?.runId).toBe(runId);
  });

  it("leaves people's own reviews without a run", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Human Note", content: "# Note\n\nWritten by a person.", folder: "gtm" },
      owner.apiKey,
    );
    expect(r.status).toBe(201);
    const queue = await jsonRequest(app, "GET", `/nests/${nestId}/review-queue`, undefined, reviewer.apiKey);
    for (const req of queue.data.requests) {
      if (!String(req.requestedBy).endsWith("@agents.invalid")) expect(req.runId).toBeUndefined();
    }
  });

  it("never claims a row in another nest, or one already linked", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { linkRunArtifacts } = await import("../src/workflow/run-service.js");
    const db = getDb();
    await db.run(
      `INSERT INTO review_requests (id, nest_id, node_id, version, requested_by) VALUES (?, ?, ?, ?, ?)`,
      ["rev_foreign", otherNestId, "nodes/x", 1, "someone@acme.com"],
    );
    await linkRunArtifacts(runId, { review_id: "rev_foreign" });
    const foreign = (await db.get("SELECT run_id FROM review_requests WHERE id = ?", ["rev_foreign"])) as any;
    expect(foreign.run_id).toBeNull();

    const own = (await db.get(
      "SELECT id FROM review_requests WHERE nest_id = ? AND run_id = ?",
      [nestId, runId],
    )) as { id: string };
    await linkRunArtifacts("run_some_other", { review_id: own.id });
    const still = (await db.get("SELECT run_id FROM review_requests WHERE id = ?", [own.id])) as any;
    expect(still.run_id).toBe(runId);

    // Junk detail is ignored, never thrown.
    await expect(linkRunArtifacts(runId, null)).resolves.toBeUndefined();
    await expect(linkRunArtifacts(runId, { review_id: 42 })).resolves.toBeUndefined();
  });
});

describe("GET /metacognition/:node/stats", () => {
  it("counts runs, tokens, cost and proposal verdicts", async () => {
    const before = await stats(owner.apiKey);
    expect(before.status).toBe(200);
    const s = before.data.stats;
    expect(s.node_id).toBe(AGENT);
    expect(s.window_days).toBe(30);
    expect(s.runs.total).toBeGreaterThanOrEqual(1);
    expect(s.runs.succeeded).toBe(s.runs.total);
    expect(s.proposals.made).toBe(1);
    expect(s.proposals.pending).toBe(1);
    expect(s.proposals.approval_rate).toBeNull();
    expect(s.comments).toBe(1);
    expect(s.tokens).toBeGreaterThan(0);
    expect(s.last_run_at).toBe(s.history[0].started_at);
    expect(s.history[0]).toMatchObject({ outcome: "succeeded", proposals: 1, comments: 1 });
    expect(s.history[0].duration_ms).toBeGreaterThanOrEqual(0);

    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/nodes/gtm/pricing/approve`, {}, reviewer.apiKey);
    expect(ok.status).toBe(200);
    const after = (await stats(owner.apiKey)).data.stats;
    expect(after.proposals).toMatchObject({ made: 1, approved: 1, pending: 0, approval_rate: 1 });
    expect(after.history[0].approved).toBe(1);
  });

  it("reports a failed run and its error", async () => {
    const { getDb } = await import("../src/db/client.js");
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, trace, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)`,
      ["run_failed_one", nestId, AGENT, "owner@acme.com", JSON.stringify({ error: "model gateway 502" }), at, at],
    );
    const s = (await stats(owner.apiKey)).data.stats;
    expect(s.runs.failed).toBe(1);
    expect(s.last_error).toMatchObject({ run_id: "run_failed_one", message: "model gateway 502" });
    expect(s.history.find((h: any) => h.id === "run_failed_one")).toMatchObject({ outcome: "failed", tokens: 0 });
  });

  it("honours limit and refuses a bad window", async () => {
    expect((await stats(owner.apiKey, "?limit=1")).data.stats.history).toHaveLength(1);
    expect((await stats(owner.apiKey, "?days=0")).status).toBe(400);
    expect((await stats(owner.apiKey, "?days=abc")).status).toBe(400);
  });

  it("takes write access, like viewing the agent", async () => {
    expect((await stats(reader.apiKey)).status).toBe(403);
  });

  it("is 404 for a document that is not an agent", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/gtm/pricing/stats`, undefined, owner.apiKey);
    expect(r.status).toBe(404);
  });
});

describe("outcomeOf", () => {
  it("tells timeouts and skips apart from failures and cancels", async () => {
    const { outcomeOf } = await import("../src/metacognition/stats.js");
    expect(outcomeOf("succeeded", { stopped_by: "max_seconds" })).toBe("timeout");
    expect(outcomeOf("failed", { timeout: true })).toBe("timeout");
    expect(outcomeOf("cancelled", { skipped: "no key" })).toBe("skipped");
    expect(outcomeOf("cancelled", null)).toBe("cancelled");
    expect(outcomeOf("failed", { error: "x" })).toBe("failed");
    expect(outcomeOf("running", null)).toBe("running");
    expect(outcomeOf("succeeded", { stopped_by: "end_turn" })).toBe("succeeded");
  });
});

describe("run retention", () => {
  it("keeps everything at 0, the default", async () => {
    delete process.env.RUN_RETENTION_DAYS;
    const { pruneOldRuns } = await import("../src/workflow/run-retention.js");
    expect(await pruneOldRuns()).toBe(0);
  });

  it("prunes finished runs (and their steps) older than the window, never a running one", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { pruneOldRuns } = await import("../src/workflow/run-retention.js");
    const db = getDb();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await db.run(
      `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, started_at, finished_at)
       VALUES (?, ?, ?, 'x', 'succeeded', ?, ?)`,
      ["run_old_done", nestId, AGENT, old, old],
    );
    await db.run(
      `INSERT INTO run_steps (run_id, seq, action, detail, at) VALUES (?, 1, 'read', NULL, ?)`,
      ["run_old_done", old],
    );
    await db.run(
      `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, started_at)
       VALUES (?, ?, ?, 'x', 'running', ?)`,
      ["run_old_running", nestId, "nodes/other-agent", old],
    );
    process.env.RUN_RETENTION_DAYS = "30";
    try {
      expect(await pruneOldRuns()).toBe(1);
    } finally {
      delete process.env.RUN_RETENTION_DAYS;
    }
    expect(await db.get("SELECT id FROM runs WHERE id = ?", ["run_old_done"])).toBeUndefined();
    expect(await db.get("SELECT run_id FROM run_steps WHERE run_id = ?", ["run_old_done"])).toBeUndefined();
    expect(await db.get("SELECT id FROM runs WHERE id = ?", ["run_old_running"])).toBeTruthy();
    // Recent runs survive.
    expect((await stats(owner.apiKey)).data.stats.runs.total).toBeGreaterThanOrEqual(1);
  });

  it("is a server setting a super admin can change, range-checked", async () => {
    const ok = await jsonRequest(app, "PATCH", "/admin/settings", { run_retention_days: 90 }, owner.apiKey);
    expect(ok.status).toBe(200);
    const got = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
    expect(got.data.run_retention_days ?? got.data.settings?.run_retention_days).toBe(90);
    const bad = await jsonRequest(app, "PATCH", "/admin/settings", { run_retention_days: 4000 }, owner.apiKey);
    expect(bad.status).toBe(400);
    const nope = await jsonRequest(app, "PATCH", "/admin/settings", { run_retention_days: 1 }, reader.apiKey);
    expect(nope.status).toBe(403);
    await jsonRequest(app, "PATCH", "/admin/settings", { run_retention_days: null }, owner.apiKey);
    delete process.env.RUN_RETENTION_DAYS;
  });
});
