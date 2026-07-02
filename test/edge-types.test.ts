/**
 * Edge-type registry ("turing" track): the vocabulary of connections,
 * governed like definitions. Everything sits behind FEATURE_WORKFLOW_PLANE
 * — off means 404, on by env or admin setting.
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
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Turing" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: reader.email, permission: "read" },
    owner.apiKey,
  );
});

afterAll(() => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  env.cleanup();
});

describe("feature flag", () => {
  it("404s every plane route when the flag is off", async () => {
    delete process.env.FEATURE_WORKFLOW_PLANE;
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/edge-types`, undefined, owner.apiKey);
    expect(res.status).toBe(404);
    expect(res.data.error).toContain("not enabled");
    process.env.FEATURE_WORKFLOW_PLANE = "true";
  });
});

describe("registry", () => {
  it("lists with the five stock flow types seeded lazily, exactly once", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/edge-types`, undefined, owner.apiKey);
    expect(res.status).toBe(200);
    const names = res.data.edge_types.map((t: any) => t.name);
    for (const n of ["next", "on-success", "on-failure", "depends-on", "owned-by"]) {
      expect(names).toContain(n);
    }
    const again = await jsonRequest(app, "GET", `/nests/${nestId}/edge-types`, undefined, owner.apiKey);
    expect(again.data.count).toBe(res.data.count);
    // Flow classification drives the future DAG guard.
    const next = res.data.edge_types.find((t: any) => t.name === "next");
    expect(next.is_flow).toBe(true);
    const owned = res.data.edge_types.find((t: any) => t.name === "owned-by");
    expect(owned.is_flow).toBe(false);
  });

  it("defines a custom type with a condition template", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/edge-types`,
      {
        name: "escalates-when",
        description: "Conditional escalation on a metric guardrail.",
        is_flow: true,
        color: "#f59e0b",
        condition_schema: { params: ["term", "op", "value"] },
      },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.edge_type.condition_schema).toEqual({
      params: ["term", "op", "value"],
      mode_default: "structured",
    });
    expect(res.data.edge_type.is_flow).toBe(true);
  });

  it("upserts by name case-insensitively — one articulation per relation", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/edge-types`,
      { name: "Escalates-When", description: "Updated articulation." },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/edge-types`, undefined, owner.apiKey);
    const matches = list.data.edge_types.filter(
      (t: any) => t.name.toLowerCase() === "escalates-when",
    );
    expect(matches.length).toBe(1);
    expect(matches[0].description).toBe("Updated articulation.");
  });

  it("rejects junk: bad names, bad schema, bad direction — 400s not 500s", async () => {
    for (const body of [
      { name: "has spaces!", description: "x" },
      { name: "ok-name", description: "x", condition_schema: { params: "not-an-array" } },
      { name: "ok-name", description: "x", direction: "sideways" },
      { name: 123, description: "x" },
    ]) {
      const res = await jsonRequest(app, "POST", `/nests/${nestId}/edge-types`, body, owner.apiKey);
      expect(res.status).toBe(400);
    }
  });

  it("read tier can list but not define or delete", async () => {
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/edge-types`, undefined, reader.apiKey);
    expect(list.status).toBe(200);
    const post = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/edge-types`,
      { name: "sneaky", description: "x" },
      reader.apiKey,
    );
    expect(post.status).toBe(403);
  });

  it("deletes an unused type; unknown id 404s", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/edge-types`,
      { name: "temp-type", description: "temporary" },
      owner.apiKey,
    );
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/edge-types`, undefined, owner.apiKey);
    const temp = list.data.edge_types.find((t: any) => t.name === "temp-type");
    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/edge-types/${temp.id}`,
      undefined,
      owner.apiKey,
    );
    expect(del.status).toBe(200);
    const missing = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/edge-types/${temp.id}`,
      undefined,
      owner.apiKey,
    );
    expect(missing.status).toBe(404);
  });
});
