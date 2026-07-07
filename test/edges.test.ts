/**
 * Edges ("turing" track): typed links with conditions, DAG-guarded for
 * flow types, filterable, and surfaced in the graph payload. Flagged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let reader: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  reader = await registerUser(app, "reader@acme.com", "Reader");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Flows" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: reader.email, permission: "read" },
    owner.apiKey,
  );
  for (const title of ["Alpha", "Beta", "Gamma", "Owner Doc"]) {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title, content: `# ${title}` },
      owner.apiKey,
    );
  }
});

afterAll(() => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  env.cleanup();
});

const mkEdge = (body: any, key = owner.apiKey) =>
  jsonRequest(app, "POST", `/nests/${nestId}/edges`, body, key);

describe("edge creation + validation", () => {
  it("creates a flow edge with the stock type", async () => {
    const res = await mkEdge({
      from_node: "nodes/alpha",
      to_node: "nodes/beta",
      type: "next",
    });
    expect(res.status).toBe(201);
    expect(res.data.edge.type.name).toBe("next");
    expect(res.data.edge.type.is_flow).toBe(true);
  });

  it("rejects unknown type and unknown nodes with 400s", async () => {
    const badType = await mkEdge({
      from_node: "nodes/alpha",
      to_node: "nodes/beta",
      type: "no-such-type",
    });
    expect(badType.status).toBe(400);
    expect(badType.data.error).toContain("no-such-type");

    const badNode = await mkEdge({
      from_node: "nodes/ghost",
      to_node: "nodes/beta",
      type: "next",
    });
    expect(badNode.status).toBe(400);
    expect(badNode.data.error).toContain("nodes/ghost");
  });

  it("carries conditions per mode; junk shapes 400", async () => {
    // Define a conditional type first.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/edge-types`,
      { name: "escalates-when", description: "guardrail", is_flow: true },
      owner.apiKey,
    );
    const ok = await mkEdge({
      from_node: "nodes/beta",
      to_node: "nodes/gamma",
      type: "escalates-when",
      condition_mode: "structured",
      condition: { term: "CAC", op: ">", value: 500 },
    });
    expect(ok.status).toBe(201);
    expect(ok.data.edge.condition).toEqual({ term: "CAC", op: ">", value: 500 });

    const nl = await mkEdge({
      from_node: "nodes/alpha",
      to_node: "nodes/gamma",
      type: "escalates-when",
      condition_mode: "nl",
      condition: "if we lost on price rather than product",
    });
    expect(nl.status).toBe(201);

    const noMode = await mkEdge({
      from_node: "nodes/alpha",
      to_node: "nodes/owner-doc",
      type: "next",
      condition: { term: "X" },
    });
    expect(noMode.status).toBe(400);

    const badShape = await mkEdge({
      from_node: "nodes/alpha",
      to_node: "nodes/owner-doc",
      type: "escalates-when",
      condition_mode: "structured",
      condition: "not-an-object",
    });
    expect(badShape.status).toBe(400);
  });

  it("rejects a flow cycle with a 409 that names the path", async () => {
    // alpha→beta exists; beta→gamma exists (flow). gamma→alpha closes a cycle.
    const res = await mkEdge({
      from_node: "nodes/gamma",
      to_node: "nodes/alpha",
      type: "next",
    });
    expect(res.status).toBe(409);
    // Names the exact closed cycle: alpha→beta→gamma (existing flow) then the
    // proposed gamma→alpha edge closing back to alpha.
    expect(res.data.error).toContain(
      'cycle: ["nodes/alpha","nodes/beta","nodes/gamma","nodes/alpha"]',
    );
  });

  it("allows cycles over NON-flow types (ownership isn't a DAG)", async () => {
    const a = await mkEdge({
      from_node: "nodes/gamma",
      to_node: "nodes/alpha",
      type: "owned-by",
    });
    expect(a.status).toBe(201);
  });

  it("read tier can list but not create or delete", async () => {
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/edges`, undefined, reader.apiKey);
    expect(list.status).toBe(200);
    const post = await mkEdge(
      { from_node: "nodes/alpha", to_node: "nodes/beta", type: "owned-by" },
      reader.apiKey,
    );
    expect(post.status).toBe(403);
  });
});

describe("filters + graph payload", () => {
  it("filters by type and by node", async () => {
    const byType = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/edges?type=next`,
      undefined,
      owner.apiKey,
    );
    expect(byType.data.edges.every((e: any) => e.type.name === "next")).toBe(true);

    const byNode = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/edges?node=nodes/gamma`,
      undefined,
      owner.apiKey,
    );
    expect(byNode.data.count).toBeGreaterThan(0);
    expect(
      byNode.data.edges.every(
        (e: any) => e.from_node === "nodes/gamma" || e.to_node === "nodes/gamma",
      ),
    ).toBe(true);
  });

  it("GET /graph carries typedEdges when the flag is on", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/graph`, undefined, owner.apiKey);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.typedEdges)).toBe(true);
    const e = res.data.typedEdges.find(
      (x: any) => x.source === "nodes/alpha" && x.target === "nodes/beta",
    );
    expect(e).toBeTruthy();
    expect(e.type).toBe("next");
    expect(e.is_flow).toBe(true);
  });

  it("deletes an edge", async () => {
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/edges?type=owned-by`, undefined, owner.apiKey);
    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/edges/${list.data.edges[0].id}`,
      undefined,
      owner.apiKey,
    );
    expect(del.status).toBe(200);
  });
});
