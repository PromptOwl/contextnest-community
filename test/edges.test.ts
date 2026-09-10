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
  // Structured conditions validate their `term` against the glossary when the
  // definitions table is present (it is), so define CAC up front — otherwise
  // the structured-edge case below is correctly rejected as an undefined term.
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/definitions`,
    { term: "CAC", definition: "Customer acquisition cost." },
    owner.apiKey,
  );
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

  it("rejects an identical (from, to, type) edge with a 409", async () => {
    // alpha→beta/next was created above; the repeat would draw on top of it.
    const dup = await mkEdge({
      from_node: "nodes/alpha",
      to_node: "nodes/beta",
      type: "next",
    });
    expect(dup.status).toBe(409);
    expect(dup.data.error).toContain("already exists");

    // Same pair, different type is a distinct connection — still allowed.
    const other = await mkEdge({
      from_node: "nodes/alpha",
      to_node: "nodes/beta",
      type: "owned-by",
    });
    expect(other.status).toBe(201);
    await jsonRequest(
      app, "DELETE", `/nests/${nestId}/edges/${other.data.edge.id}`,
      undefined, owner.apiKey,
    );
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

  it("rejects path-traversal node ids before they reach storage", async () => {
    // `..` must be caught by assertSafeNodeId (400), not fall through to
    // storage.readDocument where it could escape the nest vault.
    const traversal = await mkEdge({
      from_node: "../other-nest/nodes/secret",
      to_node: "nodes/beta",
      type: "next",
    });
    expect(traversal.status).toBe(400);
    expect(traversal.data.error).toContain("traversal");
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

    // beta→owner-doc (not alpha→gamma): keep this flow edge off the
    // alpha→beta→gamma spine so it can't shortcut the cycle test below.
    const nl = await mkEdge({
      from_node: "nodes/beta",
      to_node: "nodes/owner-doc",
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
    // proposed gamma→alpha edge closing back to alpha — by the titles on the
    // canvas, not the ids behind them (CU-wdqcq018r1), and in plain language
    // rather than "must form a DAG" (CU-wdqcq01k1y).
    expect(res.data.error).toContain(
      'These steps loop back on each other: "Alpha" → "Beta" → "Gamma" → "Alpha"',
    );
    expect(res.data.error).not.toContain("DAG");
  });

  it("addresses the cards by id when two share a title", async () => {
    // Two cards called "Draft": titles alone name neither (CU-wdqcq01k29).
    // Same title, different folders — one title per folder is all the id
    // scheme allows, and that is exactly how a nest ends up with two "Draft".
    const ids: string[] = [];
    for (const folder of ["", "gtm"]) {
      const node = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Draft", content: "# Draft", folder },
        owner.apiKey,
      );
      expect(node.status).toBe(201);
      ids.push(node.data.node.id);
    }
    expect(ids[0]).not.toBe(ids[1]);

    const first = await mkEdge({ from_node: ids[0], to_node: ids[1], type: "next" });
    expect(first.status).toBe(201);

    const cycle = await mkEdge({ from_node: ids[1], to_node: ids[0], type: "next" });
    expect(cycle.status).toBe(409);
    // Every step in the trail carries its id, so each "Draft" is one card.
    expect(cycle.data.error).toContain(`"Draft" (${ids[0]})`);
    expect(cycle.data.error).toContain(`"Draft" (${ids[1]})`);

    await jsonRequest(
      app, "DELETE", `/nests/${nestId}/edges/${first.data.edge.id}`,
      undefined, owner.apiKey,
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

  it("PATCH retypes and reconditions an edge", async () => {
    const created = await jsonRequest(
      app, "POST", `/nests/${nestId}/edges`,
      { from_node: "nodes/beta", to_node: "nodes/gamma", type: "next" },
      owner.apiKey,
    );
    expect(created.status).toBe(201);
    const id = created.data.edge.id;

    const patched = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/edges/${id}`,
      {
        condition_mode: "structured",
        condition: { term: "CAC", op: ">", value: 500 },
      },
      owner.apiKey,
    );
    expect(patched.status).toBe(200);
    expect(patched.data.edge.condition_mode).toBe("structured");

    const badType = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/edges/${id}`,
      { type: "no-such-type" }, owner.apiKey,
    );
    expect(badType.status).toBe(400);

    const missing = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/edges/does-not-exist`,
      { condition_mode: null, condition: null }, owner.apiKey,
    );
    expect(missing.status).toBe(404);

    await jsonRequest(app, "DELETE", `/nests/${nestId}/edges/${id}`, undefined, owner.apiKey);
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
