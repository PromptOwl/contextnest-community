/**
 * Sub-agent runs ("turing" track, own flag FEATURE_SUBAGENT_RUNS): a run can
 * spawn nested runs (parent_run_id), bounded by depth and guarded against
 * re-entrancy so the call tree stays finite/haltable. Off by default.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let nestId: string;

async function trigger(agentSlug: string, body: any = {}) {
  return jsonRequest(app, "POST", `/nests/${nestId}/run/nodes/${agentSlug}`, body, owner.apiKey);
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_SUBAGENT_RUNS = "true";
  process.env.SUBAGENT_MAX_DEPTH = "2";
  process.env.SUBAGENT_MAX_CHILDREN = "2";
  process.env.RUN_MAX_STEPS = "10"; // clamp floor is 10 — the lowest testable cap
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Subagents" }, owner.apiKey);
  nestId = nest.data.nest.id;
  for (const t of ["Root Agent", "Child Agent", "Grandchild Agent", "Great Grandchild Agent"]) {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: t, content: `# ${t}`, type: "agent" },
      owner.apiKey,
    );
  }
});

afterAll(() => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_SUBAGENT_RUNS;
  delete process.env.SUBAGENT_MAX_DEPTH;
  delete process.env.SUBAGENT_MAX_CHILDREN;
  delete process.env.RUN_MAX_STEPS;
  env.cleanup();
});

describe("nested runs", () => {
  it("a top-level run has depth 0 and no parent", async () => {
    const res = await trigger("root-agent");
    expect(res.status).toBe(201);
    expect(res.data.depth).toBe(0);
    expect(res.data.parent_run_id).toBeNull();
  });

  it("spawns a child run under a running parent, depth increments", async () => {
    const root = await trigger("root-agent");
    const child = await trigger("child-agent", { parent_run_id: root.data.run_id });
    expect(child.status).toBe(201);
    expect(child.data.parent_run_id).toBe(root.data.run_id);
    expect(child.data.depth).toBe(1);
    // Surfaced in the trace tree.
    const detail = await jsonRequest(app, "GET", `/runs/${child.data.run_id}`, undefined, owner.apiKey);
    expect(detail.data.run.parent_run_id).toBe(root.data.run_id);
    expect(detail.data.run.depth).toBe(1);
  });

  it("enforces the depth cap (SUBAGENT_MAX_DEPTH=2), distinct agents", async () => {
    // root(0) → child(1) → grandchild(2) all within cap; great-grandchild
    // would be depth 3 > 2 → rejected. All distinct, so it's the DEPTH guard
    // firing, not re-entrancy.
    let parent = (await trigger("root-agent")).data.run_id;
    const chain = ["child-agent", "grandchild-agent"];
    for (let d = 0; d < 2; d++) {
      const r = await trigger(chain[d], { parent_run_id: parent });
      expect(r.status).toBe(201);
      expect(r.data.depth).toBe(d + 1);
      parent = r.data.run_id;
    }
    const tooDeep = await trigger("great-grandchild-agent", { parent_run_id: parent });
    expect(tooDeep.status).toBe(403);
    expect(tooDeep.data.error).toContain("depth");
  });

  it("caps fan-out per parent (SUBAGENT_MAX_CHILDREN=2) — bounds tree WIDTH", async () => {
    // Distinct children under one fresh root so it's the width cap firing, not
    // depth or re-entrancy. Depth bounds height; this bounds the fork-bomb.
    const root = (await trigger("root-agent")).data.run_id;
    const c1 = await trigger("child-agent", { parent_run_id: root });
    const c2 = await trigger("grandchild-agent", { parent_run_id: root });
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);
    const c3 = await trigger("great-grandchild-agent", { parent_run_id: root });
    expect(c3.status).toBe(403);
    expect(c3.data.error).toContain("children");
  });

  it("rejects re-entrancy: an agent already in the ancestor chain", async () => {
    const root = await trigger("root-agent");
    const child = await trigger("child-agent", { parent_run_id: root.data.run_id });
    // root-agent invoking itself down-chain → cycle.
    const cycle = await trigger("root-agent", { parent_run_id: child.data.run_id });
    expect(cycle.status).toBe(409);
    expect(cycle.data.error).toContain("re-entrancy");
  });

  it("refuses to graft onto a closed parent run", async () => {
    const root = await trigger("root-agent");
    await jsonRequest(app, "PATCH", `/runs/${root.data.run_id}`, { status: "succeeded" }, owner.apiKey);
    const child = await trigger("child-agent", { parent_run_id: root.data.run_id });
    expect(child.status).toBe(409);
  });

  it("unknown parent run 404s", async () => {
    const res = await trigger("child-agent", { parent_run_id: "run_does-not-exist" });
    expect(res.status).toBe(404);
  });

  it("a parent run in another nest 404s — no cross-nest existence oracle", async () => {
    // Same signal as an unknown id: a write-tier caller must not learn whether
    // an arbitrary run id exists in a nest they don't own by reading 403-vs-404.
    const other = await jsonRequest(app, "POST", "/nests", { name: "Other" }, owner.apiKey);
    const otherNestId = other.data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${otherNestId}/nodes`,
      { title: "Other Root", content: "# Other Root", type: "agent" },
      owner.apiKey,
    );
    const otherRoot = await jsonRequest(
      app,
      "POST",
      `/nests/${otherNestId}/run/nodes/other-root`,
      {},
      owner.apiKey,
    );
    expect(otherRoot.status).toBe(201);
    const child = await trigger("child-agent", { parent_run_id: otherRoot.data.run_id });
    expect(child.status).toBe(404);
  });

  it("caps the per-run step log at RUN_MAX_STEPS (fork-bomb of the trace)", async () => {
    const root = await trigger("root-agent");
    const runId = root.data.run_id;
    for (let i = 0; i < 10; i++) {
      const s = await jsonRequest(app, "POST", `/runs/${runId}/steps`, { action: "read" }, owner.apiKey);
      expect(s.status).toBe(201);
      expect(s.data.seq).toBe(i + 1);
    }
    const over = await jsonRequest(app, "POST", `/runs/${runId}/steps`, { action: "read" }, owner.apiKey);
    expect(over.status).toBe(409);
    expect(over.data.error).toContain("step limit");
  });

  it("cancelling a run cancels the whole branch under it", async () => {
    const root = await trigger("root-agent");
    const child = await trigger("child-agent", { parent_run_id: root.data.run_id });
    const grand = await trigger("grandchild-agent", { parent_run_id: child.data.run_id });
    const cancel = await jsonRequest(
      app,
      "PATCH",
      `/runs/${root.data.run_id}`,
      { status: "cancelled" },
      owner.apiKey,
    );
    expect(cancel.status).toBe(200);
    for (const id of [child.data.run_id, grand.data.run_id]) {
      const r = await jsonRequest(app, "GET", `/runs/${id}`, undefined, owner.apiKey);
      expect(r.data.run.status).toBe("cancelled");
      expect(r.data.run.finished_at).toBeTruthy();
    }
  });
});

describe("flag gating", () => {
  it("with FEATURE_SUBAGENT_RUNS off, passing parent_run_id is rejected", async () => {
    const root = await trigger("root-agent");
    delete process.env.FEATURE_SUBAGENT_RUNS;
    const child = await trigger("child-agent", { parent_run_id: root.data.run_id });
    expect(child.status).toBe(400);
    expect(child.data.error).toContain("not enabled");
    // A plain top-level run still works with the sub-agent flag off.
    const top = await trigger("child-agent");
    expect(top.status).toBe(201);
    expect(top.data.depth).toBe(0);
    process.env.FEATURE_SUBAGENT_RUNS = "true";
  });
});
