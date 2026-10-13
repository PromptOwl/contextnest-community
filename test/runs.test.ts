/**
 * Runs ("turing" track): trigger returns the executable bundle; steps
 * append monotonically; terminal status is final; traces redact for read
 * tier. The server never executes — it records.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let reader: { apiKey: string; userId: string; email: string };
let nestId: string;
let runId: string;

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  reader = await registerUser(app, "reader@acme.com", "Reader");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Runs" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: reader.email, permission: "read" },
    owner.apiKey,
  );

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Digest Agent", content: "# Agent\n\nSummarize the day.", type: "agent" },
    owner.apiKey,
  );
  for (const t of ["Weekly Log", "Escalation Playbook", "Plain Doc"]) {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: t, content: `# ${t}` },
      owner.apiKey,
    );
  }
  // agent →(next)→ weekly-log →(escalates-when nl)→ escalation-playbook
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/edge-types`,
    { name: "escalates-when", description: "guardrail", is_flow: true },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/edges`,
    { from_node: "nodes/digest-agent", to_node: "nodes/weekly-log", type: "next" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/edges`,
    {
      from_node: "nodes/weekly-log",
      to_node: "nodes/escalation-playbook",
      type: "escalates-when",
      condition_mode: "nl",
      condition: "if the digest suggests we lost a deal on price",
    },
    owner.apiKey,
  );
});

afterAll(() => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  env.cleanup();
});

describe("trigger → bundle", () => {
  it("rejects non-runnable and missing nodes", async () => {
    const plain = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/run/nodes/plain-doc`,
      {},
      owner.apiKey,
    );
    expect(plain.status).toBe(400);
    const ghost = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/run/nodes/ghost`,
      {},
      owner.apiKey,
    );
    expect(ghost.status).toBe(404);
  });

  it("returns run_id + agent instructions + the reachable flow subgraph", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/run/nodes/digest-agent`,
      { inputs: { date: "2026-07-02" } },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    runId = res.data.run_id;
    expect(runId).toMatch(/^run_/);
    expect(res.data.agent.content).toContain("Summarize the day.");
    // BFS: both hops reachable from the agent are in the bundle.
    const pairs = res.data.edges.map((e: any) => `${e.from_node}→${e.to_node}`);
    expect(pairs).toContain("nodes/digest-agent→nodes/weekly-log");
    expect(pairs).toContain("nodes/weekly-log→nodes/escalation-playbook");
    const nl = res.data.edges.find((e: any) => e.condition_mode === "nl");
    expect(nl.condition).toContain("lost a deal on price");
    // An agent that names no model leaves the choice to the runner.
    expect(res.data.agent.model).toBeNull();
  });

  it("carries the agent's model in the bundle; model is runnable-only and clearable", async () => {
    const set = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/digest-agent`, { model: "claude-haiku-5" }, owner.apiKey);
    expect(set.status).toBe(200);
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/digest-agent`, undefined, owner.apiKey);
    expect(read.data.model ?? read.data.node?.model).toBe("claude-haiku-5");

    const run = await jsonRequest(app, "POST", `/nests/${nestId}/run/nodes/digest-agent`, {}, owner.apiKey);
    expect(run.data.agent.model).toBe("claude-haiku-5");

    const onDoc = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/plain-doc`, { model: "x" }, owner.apiKey);
    expect(onDoc.status).toBe(400);

    // The id goes to the runner as-is: non-strings, control characters and oversized values are refused.
    for (const bad of [{ a: 1 }, ["x"], 123, null, "claude\n--flag", "a b", "x".repeat(129)]) {
      const res = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/digest-agent`, { model: bad }, owner.apiKey);
      expect(res.status).toBe(400);
    }

    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/digest-agent`, { model: "" }, owner.apiKey);
    const cleared = await jsonRequest(app, "POST", `/nests/${nestId}/run/nodes/digest-agent`, {}, owner.apiKey);
    expect(cleared.data.agent.model).toBeNull();
  });
});

describe("steps + close", () => {
  it("appends steps with monotonic auto-seq", async () => {
    const s1 = await jsonRequest(
      app,
      "POST",
      `/runs/${runId}/steps`,
      { action: "read", node_id: "nodes/weekly-log", detail: { selector: "[[Weekly Log]]", hops: 1 } },
      owner.apiKey,
    );
    expect(s1.status).toBe(201);
    expect(s1.data.seq).toBe(1);
    const s2 = await jsonRequest(
      app,
      "POST",
      `/runs/${runId}/steps`,
      { action: "branch", edge_id: "e", detail: { result: true, rationale: "3 of 4 losses cite price" } },
      owner.apiKey,
    );
    expect(s2.data.seq).toBe(2);
  });

  it("read tier sees steps but not detail/inputs/trace; write tier sees all", async () => {
    const asReader = await jsonRequest(app, "GET", `/runs/${runId}`, undefined, reader.apiKey);
    expect(asReader.status).toBe(200);
    expect(asReader.data.steps.length).toBe(2);
    expect(asReader.data.steps[1].detail).toBeNull();
    // inputs + trace are as sensitive as step detail — redacted at read tier.
    expect(asReader.data.run.inputs).toBeNull();
    const asOwner = await jsonRequest(app, "GET", `/runs/${runId}`, undefined, owner.apiKey);
    expect(asOwner.data.steps[1].detail.rationale).toContain("price");
    expect(asOwner.data.run.inputs).toEqual({ date: "2026-07-02" });
  });

  it("closes the run; terminal is final (409 on further steps/PATCH)", async () => {
    const close = await jsonRequest(
      app,
      "PATCH",
      `/runs/${runId}`,
      { status: "succeeded", trace: { reads: 1, writes: 0 } },
      owner.apiKey,
    );
    expect(close.status).toBe(200);
    const lateStep = await jsonRequest(
      app,
      "POST",
      `/runs/${runId}/steps`,
      { action: "read" },
      owner.apiKey,
    );
    expect(lateStep.status).toBe(409);
    const rePatch = await jsonRequest(
      app,
      "PATCH",
      `/runs/${runId}`,
      { status: "failed" },
      owner.apiKey,
    );
    expect(rePatch.status).toBe(409);
  });

  it("lists runs filtered by status", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/runs?status=succeeded`,
      undefined,
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.runs.some((r: any) => r.id === runId)).toBe(true);
    expect(res.data.runs.every((r: any) => r.status === "succeeded")).toBe(true);
  });

  it("SECURITY: rejects path traversal in the agent-node param (no cross-nest read)", async () => {
    // A caller with write on this nest must not reach another nest's files by
    // tuning ../ segments. The guard 400s before storage.readDocument.
    for (const evil of [
      "..%2Fother%2Fnodes%2Fsecret",
      "nodes%2F..%2F..%2Fetc%2Fpasswd",
      "%2e%2e%2fnodes%2fx",
    ]) {
      const res = await app.request(`/nests/${nestId}/run/${evil}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.apiKey}` },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      expect([400]).toContain(res.status);
      expect(JSON.stringify(data)).toMatch(/invalid node id/i);
    }
  });

  it("flag off → 404 on both the trigger and the /runs/:id family", async () => {
    delete process.env.FEATURE_WORKFLOW_PLANE;
    const trigger = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/run/nodes/digest-agent`,
      {},
      owner.apiKey,
    );
    expect(trigger.status).toBe(404);
    const detail = await jsonRequest(app, "GET", `/runs/${runId}`, undefined, owner.apiKey);
    expect(detail.status).toBe(404);
    process.env.FEATURE_WORKFLOW_PLANE = "true";
  });
});

describe("/runs/:id access control (outside the nest gate)", () => {
  let outsiderNestRunId: string;

  it("a caller with no permission on the run's nest is refused", async () => {
    // This suite registers >3 users from one IP — clear the limiter first.
    await resetAuthRateLimit();
    // Build a fresh nest owned by a different user; owner has no grant on it.
    const stranger = await registerUser(app, "stranger@x.com", "Stranger");
    const priv = await jsonRequest(app, "POST", "/nests", { name: "Private" }, stranger.apiKey);
    const pid = priv.data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${pid}/nodes`,
      { title: "Sec Agent", content: "# a", type: "agent" },
      stranger.apiKey,
    );
    const run = await jsonRequest(
      app,
      "POST",
      `/nests/${pid}/run/nodes/sec-agent`,
      {},
      stranger.apiKey,
    );
    outsiderNestRunId = run.data.run_id;

    // owner@acme has zero permission on stranger's nest. Mirroring the nest
    // gate, "no permission at all" is 404 (hide the run's existence), not 403.
    const read = await jsonRequest(app, "GET", `/runs/${outsiderNestRunId}`, undefined, owner.apiKey);
    expect(read.status).toBe(404);
    const step = await jsonRequest(
      app,
      "POST",
      `/runs/${outsiderNestRunId}/steps`,
      { action: "read" },
      owner.apiKey,
    );
    expect(step.status).toBe(404);
  });

  it("a nest-scoped key is refused on a run in a DIFFERENT nest — even with permission there", async () => {
    // Roamer is a collaborator on BOTH this nest and the stranger's nest, so
    // permission alone wouldn't block them. Their key is scoped to `nestId`;
    // hitting the stranger-nest run must 403 on the scope check, not slip
    // through on permission. This is the exact guarantee nest-scoped keys exist
    // to provide, and the one /runs/:id previously skipped.
    await resetAuthRateLimit();
    const roamer = await registerUser(app, "roamer@x.com", "Roamer");
    // A key can only be scoped to a nest its owner can reach, so roamer needs
    // a seat on `nestId` before scoping a key to it.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: roamer.email, permission: "read" },
      owner.apiKey,
    );
    // Scope roamer's key to `nestId`, then hit the outsider-nest run. The
    // response must be the SCOPE 403 (not authorized for this nest), proving
    // the scope check runs on /runs/:id — the gap the review flagged.
    const rot = await jsonRequest(
      app,
      "POST",
      "/auth/keys/rotate",
      { nest_id: nestId },
      roamer.apiKey,
    );
    const scopedKey = rot.data.api_key as string;
    const res = await jsonRequest(
      app,
      "GET",
      `/runs/${outsiderNestRunId}`,
      undefined,
      scopedKey,
    );
    expect(res.status).toBe(403);
    expect(res.data.error).toContain("not authorized for this nest");
  });
});
