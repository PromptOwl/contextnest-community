/**
 * Multi-nest writes (Stacey's partner-nest bug): update/delete must work on
 * EVERY nest the caller can write, not just the first one — through the
 * per-nest endpoint and the server-level /mcp endpoint alike.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let stacey: { apiKey: string };
const nests: Record<string, string> = {};

async function callTool(path: string, key: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  if (body.error) return { isError: true, text: JSON.stringify(body.error) };
  return { isError: !!body.result.isError, text: body.result.content.map((c: any) => c.text).join("") };
}

async function seed(nestId: string, key: string, title: string) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: "# v1\n\nOriginal.", tags: ["old"] }, key);
  expect(r.status).toBeLessThan(300);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  stacey = await registerUser(app, "stacey@acme.com", "Stacey");
  const partner = await registerUser(app, "partner@acme.com", "Partner");

  for (const name of ["Strategy", "Partner Alpha", "Partner Beta"]) {
    const r = await jsonRequest(app, "POST", "/nests", { name }, stacey.apiKey);
    nests[name] = r.data.nest.id;
  }
  // A nest someone else owns, shared to Stacey with write.
  const shared = await jsonRequest(app, "POST", "/nests", { name: "Partner Shared" }, partner.apiKey);
  nests["Partner Shared"] = shared.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nests["Partner Shared"]}/collaborators`, { email: "stacey@acme.com", permission: "write" }, partner.apiKey);
});

afterAll(() => env.cleanup());

describe.each(["Strategy", "Partner Alpha", "Partner Beta", "Partner Shared"])("nest %s", (name) => {
  it("per-nest /nests/:id/mcp — update then delete", async () => {
    const id = nests[name];
    const key = stacey.apiKey;
    await seed(id, key, "Per Nest Doc");
    const up = await callTool(`/nests/${id}/mcp`, key, "context_update", { title: "Per Nest Doc", content: "# v2\n\nChanged." });
    expect(up.isError).toBe(false);
    const del = await callTool(`/nests/${id}/mcp`, key, "context_delete", { title: "Per Nest Doc" });
    expect(del.isError).toBe(false);
  });

  it("server-level /mcp with nest=<name> — update then delete", async () => {
    const id = nests[name];
    await seed(id, stacey.apiKey, "Server Doc");
    const up = await callTool("/mcp", stacey.apiKey, "context_update", { nest: name, title: "Server Doc", content: "# v2\n\nChanged." });
    expect(up.isError).toBe(false);
    const got = await callTool(`/nests/${id}/mcp`, stacey.apiKey, "context_get", { title: "Server Doc" });
    expect(got.text).toContain("Changed.");
    const del = await callTool("/mcp", stacey.apiKey, "context_delete", { nest: name, title: "Server Doc" });
    expect(del.isError).toBe(false);
    const gone = await callTool(`/nests/${id}/mcp`, stacey.apiKey, "context_get", { title: "Server Doc" });
    expect(gone.text).not.toContain("Changed.");
  });
});

// Stacey's other two gaps, on a secondary nest.
describe("context_update on a secondary nest", () => {
  const path = () => `/nests/${nests["Partner Alpha"]}/mcp`;

  it("tags REPLACE the set, so a tag can be removed", async () => {
    await jsonRequest(app, "POST", `/nests/${nests["Partner Alpha"]}/nodes`, { title: "Tag Doc", content: "# t", tags: ["keep", "drop"] }, stacey.apiKey);
    const up = await callTool(path(), stacey.apiKey, "context_update", { title: "Tag Doc", tags: ["keep"] });
    expect(up.isError).toBe(false);
    const got = await jsonRequest(app, "GET", `/nests/${nests["Partner Alpha"]}/nodes/nodes/tag-doc`, undefined, stacey.apiKey);
    expect((got.data.node ?? got.data).tags).toEqual(["#keep"]);
  });

  it("refuses frontmatter pasted into content instead of storing a dead copy", async () => {
    const up = await callTool(path(), stacey.apiKey, "context_update", { title: "Tag Doc", content: "---\ntitle: Tag Doc\ntags: [x]\n---\n# body" });
    expect(up.isError).toBe(true);
    expect(up.text).toMatch(/frontmatter/);
  });

  it("still accepts a body that merely opens with a --- rule", async () => {
    const up = await callTool(path(), stacey.apiKey, "context_update", { title: "Tag Doc", content: "---\n\n# Section\n\nText." });
    expect(up.isError).toBe(false);
  });

  it("context_move returns the new id as data (what ctx move reads)", async () => {
    const res = await app.request(path(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${stacey.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_move", arguments: { id: "nodes/tag-doc", folder: "archive" } } }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
    expect(body.result.structuredContent).toMatchObject({ id: "nodes/archive/tag-doc", previous_id: "nodes/tag-doc" });
  });
});

// One server-level connection has to carry everything ctx sends.
describe("server-level /mcp as a ctx vault", () => {
  async function structured(name: string, args: Record<string, unknown>) {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${stacey.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return (line ? JSON.parse(line.slice(6)) : JSON.parse(text)).result;
  }

  beforeAll(async () => {
    for (const name of ["Partner Alpha", "Partner Shared"]) {
      await jsonRequest(app, "POST", `/nests/${nests[name]}/nodes`, { title: `Pricing ${name}`, content: "# pricing tiers", tags: ["pricing"] }, stacey.apiKey);
    }
  });

  it("fan-out search returns structured hits, each naming its nest", async () => {
    const r = await structured("context_search", { query: "pricing" });
    const byNest = new Set(r.structuredContent.results.map((h: any) => h.nest.id));
    expect(byNest).toContain(nests["Partner Alpha"]);
    expect(byNest).toContain(nests["Partner Shared"]);
  });

  it("fan-out list carries the per-nest filters (tag) and names the nest", async () => {
    const r = await structured("context_list", { tag: "pricing" });
    const docs = r.structuredContent.documents;
    expect(docs.length).toBeGreaterThanOrEqual(2);
    expect(docs.every((d: any) => d.nest?.id && d.nest?.name)).toBe(true);
  });

  it("targeted tools take the per-nest schema: context_versions exists, returns data", async () => {
    const r = await structured("context_versions", { nest: "Partner Alpha", title: "Pricing Partner Alpha" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.versions.length).toBeGreaterThanOrEqual(1);
  });

  it("a limit can't be filled by the first nest alone: hits interleave across nests", async () => {
    // Partner Alpha (owned, listed first) now has two pricing docs; Partner Shared has one.
    await jsonRequest(app, "POST", `/nests/${nests["Partner Alpha"]}/nodes`, { title: "More Alpha Pricing", content: "# pricing again" }, stacey.apiKey);
    const r = await structured("context_search", { query: "pricing", limit: 2 });
    const byNest = r.structuredContent.results.map((h: any) => h.nest.id);
    expect(new Set(byNest).size).toBe(2);
  });

  it("a fan-out read is attributed on the activity trace like a single-nest one", async () => {
    await structured("context_list", { tag: "pricing" }); // no `client` in the args
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get(
      "SELECT client_json FROM api_events WHERE tool = 'context_list' ORDER BY id DESC LIMIT 1",
    )) as { client_json: string | null };
    // Derived from the API key's label (registerUser names it "test").
    expect(JSON.parse(row.client_json ?? "null")).toMatchObject({ agent: "test" });
  });

  it("a write without `nest` is still refused", async () => {
    const r = await structured("context_delete", { title: "Pricing Partner Alpha" });
    expect(JSON.stringify(r)).toMatch(/nest/);
  });

  it("context_submit_review takes `id` like the other targeted tools", async () => {
    await jsonRequest(app, "POST", `/nests/${nests["Partner Beta"]}/nodes`, { title: "Review Me", content: "# r" }, stacey.apiKey);
    const r = await structured("context_submit_review", { nest: "Partner Beta", id: "nodes/review-me" });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).not.toMatch(/not found/i);
  });

  it("fan-out surfaces the error when every nest rejects the input", async () => {
    const r = await structured("context_query", { query: "((" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).not.toMatch(/No results found/);
  });

  it("fan-out search caps an out-of-range limit instead of slicing with it", async () => {
    const r = await structured("context_search", { query: "pricing", limit: -1 });
    expect(r.structuredContent.results.length).toBeGreaterThanOrEqual(3);
  });

  it("fan-out overview stays prose-only (no empty `documents` payload)", async () => {
    const r = await structured("context_overview", {});
    expect(r.structuredContent).toBeUndefined();
  });
});

describe("a nest shared read-only", () => {
  it("refuses writes through /mcp", async () => {
    const owner = await registerUser(app, "owner-ro@acme.com", "Owner RO");
    const ro = await jsonRequest(app, "POST", "/nests", { name: "Read Only Share" }, owner.apiKey);
    const id = ro.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${id}/nodes`, { title: "Locked", content: "# locked" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${id}/collaborators`, { email: "stacey@acme.com", permission: "read" }, owner.apiKey);
    const up = await callTool("/mcp", stacey.apiKey, "context_update", { nest: id, title: "Locked", content: "# hijacked" });
    expect(up.isError || /denied|permission|not allowed|cannot|read-only/i.test(up.text)).toBe(true);
    const got = await callTool(`/nests/${id}/mcp`, owner.apiKey, "context_get", { title: "Locked" });
    expect(got.text).not.toContain("hijacked");
  });
});
