/**
 * Runs ("turing" track): trigger returns the executable bundle; steps
 * append monotonically; terminal status is final; traces redact for read
 * tier. The server never executes — it records.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

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

  it("read tier sees steps but not detail; write tier sees all", async () => {
    const asReader = await jsonRequest(app, "GET", `/runs/${runId}`, undefined, reader.apiKey);
    expect(asReader.status).toBe(200);
    expect(asReader.data.steps.length).toBe(2);
    expect(asReader.data.steps[1].detail).toBeNull();
    const asOwner = await jsonRequest(app, "GET", `/runs/${runId}`, undefined, owner.apiKey);
    expect(asOwner.data.steps[1].detail.rationale).toContain("price");
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

  it("flag off → 404 on trigger", async () => {
    delete process.env.FEATURE_WORKFLOW_PLANE;
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/run/nodes/digest-agent`,
      {},
      owner.apiKey,
    );
    expect(res.status).toBe(404);
    process.env.FEATURE_WORKFLOW_PLANE = "true";
  });
});
