/**
 * Task relations: blocks / blocked_by / relates_to / duplicates, stored as
 * typed edges with reserved `task:*` types. Works with FEATURE_WORKFLOW_PLANE
 * off; hides related nodes the caller can't read; badges blocked cards until
 * the blocker reaches a done column; MCP at parity with REST.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function callTool(
  app: any,
  nestId: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean; data?: any }> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  expect(payload.error).toBeUndefined();
  return {
    text: payload.result.content.map((c: any) => c.text).join(""),
    isError: payload.result.isError,
    data: payload.result.structuredContent,
  };
}

async function listTools(app: any, nestId: string, apiKey: string): Promise<string[]> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  return payload.result.tools.map((t: any) => t.name);
}

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: any, writer: any, reader: any, guest: any;
let nestId: string;
let otherNestId: string;

const rel = (u: any, id: string) =>
  jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}/relations`, undefined, u.apiKey);
const addRel = (u: any, id: string, type: string, node: string) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/relations`, { type, node }, u.apiKey);
const delRel = (u: any, id: string, relId: string) =>
  jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/${id}/relations/${relId}`, undefined, u.apiKey);
const task = (title: string, tags: string[] = ["todo"], type = "task") =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: "x", type, tags }, owner.apiKey);
const move = (slug: string, tags: string[]) =>
  jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/${slug}`, { tags }, owner.apiKey);
const blockersOf = async (u: any, slug: string) => {
  const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/nodes?content=0`, undefined, u.apiKey);
  return data.nodes.find((n: any) => n.id === `nodes/${slug}`)?.open_blockers;
};

beforeAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE; // relations must work with the plane off
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  writer = await registerUser(app, "writer@acme.com", "Writer");
  reader = await registerUser(app, "reader@acme.com", "Reader");
  await resetAuthRateLimit(); // more than REGISTER_LIMIT users from one IP
  guest = await registerUser(app, "guest@acme.com", "Guest");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Launch" }, owner.apiKey)).data.nest.id;
  otherNestId = (await jsonRequest(app, "POST", "/nests", { name: "Elsewhere" }, owner.apiKey)).data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: writer.email, permission: "write" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: reader.email, permission: "read" }, owner.apiKey);
  for (const t of ["design", "build", "ship", "polish", "docs", "secret"]) await task(t);
  await jsonRequest(app, "POST", `/nests/${otherNestId}/nodes`, { title: "faraway", content: "x" }, owner.apiKey);
});

afterAll(() => env.cleanup());

describe("CRUD + inverse view", () => {
  let blocksId: string;

  it("adds a blocks relation and shows it as blocked_by from the other side", async () => {
    const r = await addRel(writer, "nodes/design", "blocks", "nodes/build");
    expect(r.status).toBe(201);
    expect(r.data.relation).toMatchObject({ type: "blocks", node: { id: "nodes/build", title: "build", done: false } });
    blocksId = r.data.relation.id;

    const fromBuild = (await rel(writer, "nodes/build")).data;
    expect(fromBuild.relations).toEqual([
      expect.objectContaining({ id: blocksId, type: "blocked_by", node: expect.objectContaining({ id: "nodes/design" }) }),
    ]);
    expect(fromBuild).toMatchObject({ blocked: true, open_blockers: 1, hidden_count: 0 });
    expect((await rel(writer, "nodes/design")).data.blocked).toBe(false);
  });

  it("blocked_by is the same stored edge, not a second one", async () => {
    // build blocked_by design == design blocks build — refused as a duplicate.
    const dup = await addRel(writer, "nodes/build", "blocked_by", "nodes/design");
    expect(dup.status).toBe(409);
    const r = await addRel(writer, "nodes/ship", "blocked-by", "nodes/build");
    expect(r.status).toBe(201);
    expect(r.data.relation.type).toBe("blocked_by");
    const fromBuild = (await rel(writer, "nodes/build")).data.relations.map((x: any) => x.type).sort();
    expect(fromBuild).toEqual(["blocked_by", "blocks"]);
  });

  it("relates_to is symmetric and stored once", async () => {
    expect((await addRel(writer, "nodes/polish", "relates_to", "nodes/docs")).status).toBe(201);
    expect((await addRel(writer, "nodes/docs", "relates_to", "nodes/polish")).status).toBe(409);
    const fromDocs = (await rel(writer, "nodes/docs")).data.relations;
    expect(fromDocs).toHaveLength(1);
    expect(fromDocs[0]).toMatchObject({ type: "relates_to", node: { id: "nodes/polish" } });
  });

  it("duplicates shows duplicated_by on the original", async () => {
    expect((await addRel(writer, "nodes/docs", "duplicates", "nodes/design")).status).toBe(201);
    const fromDesign = (await rel(writer, "nodes/design")).data.relations;
    expect(fromDesign.map((x: any) => x.type).sort()).toEqual(["blocks", "duplicated_by"]);
  });

  it("removes a relation from either end", async () => {
    const before = (await rel(writer, "nodes/docs")).data.relations;
    const dup = before.find((x: any) => x.type === "duplicates");
    const r = await delRel(writer, "nodes/design", dup.id);
    expect(r.status).toBe(200);
    expect(r.data.relations.map((x: any) => x.type)).toEqual(["blocks"]);
    // Gone, and a relation id that doesn't touch the named task is a 404.
    expect((await delRel(writer, "nodes/design", dup.id)).status).toBe(404);
    expect((await delRel(writer, "nodes/polish", blocksId)).status).toBe(404);
  });
});

describe("validation", () => {
  it("refuses self-relations, unknown types and missing nodes", async () => {
    expect((await addRel(owner, "nodes/design", "blocks", "nodes/design")).status).toBe(400);
    expect((await addRel(owner, "nodes/design", "parent_of", "nodes/build")).status).toBe(400);
    expect((await addRel(owner, "nodes/design", "blocks", "nodes/nope")).status).toBe(404);
    expect((await addRel(owner, "nodes/nope", "blocks", "nodes/design")).status).toBe(404);
  });

  it("is same-nest only", async () => {
    // A node that exists only in another nest is "not found" here …
    expect((await addRel(owner, "nodes/design", "relates_to", "nodes/faraway")).status).toBe(404);
    // … and a cross-nest URI is refused outright.
    const r = await addRel(owner, "nodes/design", "relates_to", `contextnest://${otherNestId}/nodes/faraway`);
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/same nest/);
  });

  it("refuses a blocks relation that would close a loop", async () => {
    // design → build → ship already; ship → design closes the loop.
    const r = await addRel(owner, "nodes/ship", "blocks", "nodes/design");
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/loop/);
    // Two-node loop, from the inverse side.
    expect((await addRel(owner, "nodes/design", "blocked_by", "nodes/build")).status).toBe(409);
  });
});

describe("blocked badge follows done columns", () => {
  it("open_blockers is on the listing until the blocker is done", async () => {
    expect(await blockersOf(owner, "build")).toBe(1);
    expect(await blockersOf(owner, "design")).toBeUndefined();
    await move("design", ["done"]);
    expect(await blockersOf(owner, "build")).toBeUndefined();
    expect((await rel(owner, "nodes/build")).data.relations.find((x: any) => x.type === "blocked_by").node.done).toBe(true);
    // Reopening the blocker blocks again.
    await move("design", ["doing"]);
    expect(await blockersOf(owner, "build")).toBe(1);
    const single = (await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/build`, undefined, owner.apiKey)).data.node;
    expect(single.open_blockers).toBe(1);
  });

  it("honours the nest's custom done tags, for documents as well as tasks", async () => {
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { done_tags: ["shipped"] }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "spec", content: "x", tags: ["draft"] }, owner.apiKey);
    await addRel(owner, "nodes/polish", "blocked_by", "nodes/spec");
    expect(await blockersOf(owner, "polish")).toBe(1);
    await move("spec", ["shipped"]);
    expect(await blockersOf(owner, "polish")).toBeUndefined();
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { done_tags: ["done"] }, owner.apiKey);
  });

  it("My Work rows carry the badge too", async () => {
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/build`, { assignee: writer.email }, owner.apiKey);
    const { data } = await jsonRequest(app, "GET", "/me/work", undefined, writer.apiKey);
    expect(data.assigned.find((a: any) => a.node_id === "nodes/build").open_blockers).toBe(1);
  });
});

describe("permissions", () => {
  it("never names a related node the caller can't read", async () => {
    // guest can read only `build` (a document share); `design` blocks it.
    const g = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/build", email: guest.email, role: "read" },
      owner.apiKey,
    );
    expect(g.status).toBeLessThan(300);
    const r = await rel(guest, "nodes/build");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toMatch(/design|ship/);
    expect(r.data).toMatchObject({ relations: [], hidden_count: 2, blocked: true, open_blockers: 1 });
    expect(r.data.hidden).toEqual({ blocked_by: 1, blocks: 1 });
    // A task they can't read is not found, and its relations with it.
    expect((await rel(guest, "nodes/design")).status).toBeGreaterThanOrEqual(403);
  });

  it("read-only callers can list but not write", async () => {
    expect((await rel(reader, "nodes/build")).status).toBe(200);
    expect((await addRel(reader, "nodes/build", "relates_to", "nodes/docs")).status).toBe(403);
    const blocks = (await rel(owner, "nodes/design")).data.relations[0];
    expect((await delRel(reader, "nodes/design", blocks.id)).status).toBe(403);
    expect((await addRel(guest, "nodes/build", "relates_to", "nodes/docs")).status).toBe(403);
  });
});

describe("MCP parity", () => {
  it("advertises the relation tools with the plane off", async () => {
    const tools = await listTools(app, nestId, writer.apiKey);
    expect(tools).toEqual(expect.arrayContaining(["context_relations", "context_add_relation", "context_remove_relation"]));
    expect(tools).not.toContain("workflow_edge_create");
  });

  it("adds, lists and removes like REST", async () => {
    const add = await callTool(app, nestId, writer.apiKey, "context_add_relation", { id: "nodes/docs", type: "blocks", node: "nodes/ship" });
    expect(add.isError).toBeFalsy();
    expect(add.data.relation).toMatchObject({ type: "blocks", node: { id: "nodes/ship" } });
    // The REST view sees the same row.
    const rest = (await rel(owner, "nodes/ship")).data.relations;
    expect(rest.find((x: any) => x.id === add.data.relation.id)?.type).toBe("blocked_by");

    const list = await callTool(app, nestId, writer.apiKey, "context_relations", { title: "ship" });
    expect(list.text).toMatch(/Blocked: 2 open blockers/);
    expect(list.data.relations.map((x: any) => x.type)).toEqual(["blocked_by", "blocked_by"]);

    const loop = await callTool(app, nestId, writer.apiKey, "context_add_relation", { id: "nodes/ship", type: "blocks", node: "nodes/docs" });
    expect(loop.isError).toBe(true);
    expect(loop.text).toMatch(/loop/);

    const rm = await callTool(app, nestId, writer.apiKey, "context_remove_relation", { id: "nodes/docs", relation: add.data.relation.id });
    expect(rm.isError).toBeFalsy();
    expect(rm.data.relations.find((x: any) => x.id === add.data.relation.id)).toBeUndefined();
  });

  it("context_get carries relations so an agent sees what blocks a task", async () => {
    const r = await callTool(app, nestId, writer.apiKey, "context_get", { id: "nodes/build" });
    expect(r.text).toMatch(/\*\*Relations:\*\*/);
    expect(r.text).toMatch(/Blocked by: design/);
    expect(r.data).toMatchObject({ blocked: true, open_blockers: 1 });
    expect(r.data.relations.map((x: any) => x.type).sort()).toEqual(["blocked_by", "blocks"]);
  });

  // A document-share guest can't open the per-nest MCP transport at all, so
  // the per-tool gate is exercised directly (same module graph as the app).
  const toolAs = async (u: any, name: string, args: Record<string, unknown>) => {
    const { handleToolCall } = await import("../src/mcp/tools.js");
    const { engineCache } = await import("../src/nodes/engine.js");
    const e = await engineCache.get(nestId);
    const out = await handleToolCall(name, args, {
      storage: e.storage,
      queryEngine: e.query,
      versionManager: e.versions,
      nestId,
      userId: u.userId,
      userEmail: u.email,
    });
    return typeof out === "string" ? { text: out, data: undefined, isError: undefined } : out;
  };

  it("context_get hides what the caller can't read", async () => {
    const r: any = await toolAs(guest, "context_get", { id: "nodes/build" });
    expect(r.text).not.toMatch(/design|ship/);
    expect(r.text).toMatch(/2 hidden|1 hidden/);
    expect(r.data.relations).toEqual([]);
    expect(r.data.relations_hidden).toBe(2);
  });

  it("read-only keys can't write over MCP", async () => {
    const add = await callTool(app, nestId, reader.apiKey, "context_add_relation", { id: "nodes/build", type: "relates_to", node: "nodes/docs" });
    expect(add.isError).toBe(true);
    expect(add.text).toMatch(/permission/);
    const blocks = (await rel(owner, "nodes/design")).data.relations[0];
    const rm = await callTool(app, nestId, reader.apiKey, "context_remove_relation", { id: "nodes/design", relation: blocks.id });
    expect(rm.isError).toBe(true);
    expect((await rel(owner, "nodes/design")).data.relations).toHaveLength(1);
    // Reading is fine.
    expect((await callTool(app, nestId, reader.apiKey, "context_relations", { id: "nodes/build" })).isError).toBeFalsy();
  });

  it("a caller who can't read the task gets not-found, not its relations", async () => {
    const r: any = await toolAs(guest, "context_relations", { id: "nodes/design" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/build/);
    const w: any = await toolAs(guest, "context_add_relation", { id: "nodes/build", type: "relates_to", node: "nodes/design" });
    expect(w.isError).toBe(true);
  });
});

describe("workflow plane boundary", () => {
  beforeAll(() => {
    process.env.FEATURE_WORKFLOW_PLANE = "true";
  });
  afterAll(() => {
    delete process.env.FEATURE_WORKFLOW_PLANE;
  });

  it("relation types stay out of the registry, which still seeds its defaults", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/edge-types`, undefined, owner.apiKey);
    const names = data.edge_types.map((t: any) => t.name);
    expect(names).toContain("next");
    expect(names.some((n: string) => n.startsWith("task:"))).toBe(false);
  });

  it("the generic edge API can't write a relation type", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/edges`, { from_node: "nodes/docs", to_node: "nodes/polish", type: "task:blocks" }, owner.apiKey);
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/task relations API/);
    const mcp = await callTool(app, nestId, owner.apiKey, "workflow_edge_create", { from_node: "nodes/docs", to_node: "nodes/polish", type: "task:blocks" });
    expect(mcp.isError ?? /task relations API/.test(mcp.text)).toBeTruthy();
  });
});
