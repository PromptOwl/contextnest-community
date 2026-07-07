/**
 * Workflow-plane MCP tools ("turing" track): an MCP agent can BUILD a graph
 * (edge types + edges) and EXECUTE it as a runner (trigger → step → close),
 * sharing the same service layer as the REST routes. Also asserts the tools
 * are hidden when FEATURE_WORKFLOW_PLANE is off.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let runId: string;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function mcpCall(
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): Promise<any> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected MCP response: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

/** tools/call that expects success — returns the concatenated text payload. */
async function callTool(name: string, args: Record<string, unknown> = {}, id = 100): Promise<string> {
  const res = await mcpCall("tools/call", { name, arguments: args }, id);
  expect(res.error).toBeUndefined();
  return res.result.content.map((c: any) => c.text).join("");
}

/** tools/call that expects a thrown/handler error (JSON-RPC error OR isError). */
async function callToolExpectingError(name: string, args: Record<string, unknown>, id = 200): Promise<string> {
  const res = await mcpCall("tools/call", { name, arguments: args }, id);
  const text = res.result?.content?.map((c: any) => c.text).join("") ?? "";
  expect(res.error !== undefined || res.result?.isError === true).toBe(true);
  return (res.error?.message ?? "") + text;
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  app = await createTestApp("open");

  const nest = await jsonRequest(app, "POST", "/nests", { name: "MCP Workflow" });
  nestId = nest.data.nest.id;

  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Digest Agent",
    content: "# Agent\n\nSummarize the day.",
    type: "agent",
  });
  for (const t of ["Weekly Log", "Escalation Playbook"]) {
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: t, content: `# ${t}` });
  }
});

afterAll(() => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  env.cleanup();
});

describe("workflow-plane MCP tools are advertised when the flag is on", () => {
  it("lists the build + execute tools", async () => {
    const res = await mcpCall("tools/list", {}, 1);
    const names = res.result.tools.map((t: any) => t.name);
    for (const n of [
      "workflow_run",
      "workflow_run_step",
      "workflow_run_close",
      "workflow_run_get",
      "workflow_runs_list",
      "workflow_edge_create",
      "workflow_edge_type_upsert",
    ]) {
      expect(names).toContain(n);
    }
  });
});

describe("build the graph via MCP", () => {
  it("upserts a flow edge type", async () => {
    const out = JSON.parse(
      await callTool("workflow_edge_type_upsert", {
        name: "escalates-when",
        description: "guardrail relation",
        is_flow: true,
      }),
    );
    expect(out.created).toBe(true);
    expect(out.edge_type.is_flow).toBe(true);
  });

  it("creates flow edges (stock 'next' is auto-seeded)", async () => {
    const e1 = JSON.parse(
      await callTool("workflow_edge_create", {
        from_node: "nodes/digest-agent",
        to_node: "nodes/weekly-log",
        type: "next",
      }),
    );
    expect(e1.edge.from_node).toBe("nodes/digest-agent");

    await callTool("workflow_edge_create", {
      from_node: "nodes/weekly-log",
      to_node: "nodes/escalation-playbook",
      type: "escalates-when",
      condition_mode: "nl",
      condition: "if the digest suggests we lost a deal on price",
    });

    const list = JSON.parse(await callTool("workflow_edges_list", {}));
    expect(list.count).toBe(2);
  });

  it("rejects a flow edge that would close a cycle", async () => {
    const msg = await callToolExpectingError("workflow_edge_create", {
      from_node: "nodes/escalation-playbook",
      to_node: "nodes/digest-agent",
      type: "next",
    });
    expect(msg.toLowerCase()).toContain("cycle");
  });
});

describe("execute the graph via MCP (runner contract)", () => {
  it("triggers a run and gets the reachable subgraph bundle", async () => {
    const bundle = JSON.parse(
      await callTool("workflow_run", {
        agent: "nodes/digest-agent",
        inputs: { date: "2026-07-02" },
      }),
    );
    runId = bundle.run_id;
    expect(runId).toMatch(/^run_/);
    expect(bundle.agent.content).toContain("Summarize the day.");
    const pairs = bundle.edges.map((e: any) => `${e.from_node}→${e.to_node}`);
    expect(pairs).toContain("nodes/digest-agent→nodes/weekly-log");
    expect(pairs).toContain("nodes/weekly-log→nodes/escalation-playbook");
  });

  it("appends monotonic steps", async () => {
    const s1 = JSON.parse(
      await callTool("workflow_run_step", {
        run_id: runId,
        action: "read",
        node_id: "nodes/weekly-log",
      }),
    );
    expect(s1.seq).toBe(1);
    const s2 = JSON.parse(
      await callTool("workflow_run_step", {
        run_id: runId,
        action: "branch",
        edge_id: "x",
        detail: { result: false, rationale: "no price signal" },
      }),
    );
    expect(s2.seq).toBe(2);
  });

  it("reads the trace back (detail visible at owner tier in open mode)", async () => {
    const trace = JSON.parse(await callTool("workflow_run_get", { run_id: runId }));
    expect(trace.steps.length).toBe(2);
    expect(trace.run.inputs).toEqual({ date: "2026-07-02" });
    expect(trace.steps[1].detail).toMatchObject({ result: false });
  });

  it("closes the run; a second close conflicts; no steps after terminal", async () => {
    const closed = JSON.parse(
      await callTool("workflow_run_close", { run_id: runId, status: "succeeded" }),
    );
    expect(closed.status).toBe("succeeded");

    const again = await callToolExpectingError("workflow_run_close", {
      run_id: runId,
      status: "failed",
    });
    expect(again.toLowerCase()).toContain("terminal");

    const step = await callToolExpectingError("workflow_run_step", {
      run_id: runId,
      action: "read",
    });
    expect(step.toLowerCase()).toContain("succeeded");
  });

  it("scopes run detail to the nest — a foreign run_id is not found", async () => {
    const msg = await callToolExpectingError("workflow_run_get", {
      run_id: "run_does-not-exist",
    });
    expect(msg.toLowerCase()).toContain("not found");
  });
});

describe("workflow-plane MCP tools are hidden when the flag is off", () => {
  it("omits them from tools/list", async () => {
    process.env.FEATURE_WORKFLOW_PLANE = "false";
    try {
      const res = await mcpCall("tools/list", {}, 9);
      const names = res.result.tools.map((t: any) => t.name);
      expect(names).not.toContain("workflow_run");
      expect(names).not.toContain("workflow_edge_create");
    } finally {
      process.env.FEATURE_WORKFLOW_PLANE = "true";
    }
  });
});
