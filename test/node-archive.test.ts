/**
 * Node archive: out of every list, count and read, kept whole, recoverable.
 * Also PDF moves, which the engine now carries as one unit.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed, resetAuthRateLimit } from "./helpers";
import { textPdf } from "./pdf-fixtures.js";

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let owner: User;
let writer: User;
let reader: User;
let id: string;
let n = 0;

async function mcp(apiKey: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const body = JSON.parse(text.includes("data:") ? text.split("data:").pop()! : text);
  return { text: body.result.content[0].text as string, isError: body.result.isError === true };
}

const post = (path: string, body: object = {}, key = owner.apiKey) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes/${path}`, body, key);
const listed = async (query = "", key = owner.apiKey) =>
  (await jsonRequest(app, "GET", `/nests/${nestId}/nodes${query}`, undefined, key)).data.nodes.map((d: any) => d.id);

beforeAll(async () => {
  env = setupTestEnv();
  await resetAuthRateLimit();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@archive.test");
  writer = await registerUser(app, "writer@archive.test");
  reader = await registerUser(app, "reader@archive.test");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Archive" }, owner.apiKey);
  nestId = nest.data.nest?.id ?? nest.data.id;
  for (const [user, permission] of [[writer, "write"], [reader, "read"]] as const) {
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: user.email, permission }, owner.apiKey);
  }
});

afterAll(() => env?.cleanup?.());

beforeEach(async () => {
  const created = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: `Plan ${++n}`, content: `Searchable body zebra${n}.`, folder: "gtm", publish: true },
    owner.apiKey,
  );
  id = created.data.id ?? created.data.node?.id;
  expect(id).toBeTruthy();
});

describe("archive", () => {
  it("leaves every list, count, search and agent read", async () => {
    const before = (await jsonRequest(app, "GET", `/nests/${nestId}/overview`, undefined, owner.apiKey)).data;

    const out = await post(`${id}/archive`, { reason: "Superseded" });

    expect(out.status).toBe(200);
    expect(out.data.archived).toMatchObject({ by: owner.email, reason: "Superseded" });
    expect(await listed()).not.toContain(id);
    expect(await listed("?folder=gtm")).not.toContain(id);
    const after = (await jsonRequest(app, "GET", `/nests/${nestId}/overview`, undefined, owner.apiKey)).data;
    expect(after.total ?? after.stats?.total).toBe((before.total ?? before.stats?.total) - 1);
    const folders = await jsonRequest(app, "GET", `/nests/${nestId}/folders`, undefined, owner.apiKey);
    const gtm = folders.data.folders.find((f: any) => f.path === "gtm");
    expect(gtm?.count ?? 0).toBe((await listed("?folder=gtm")).length);
    const search = await jsonRequest(app, "GET", `/nests/${nestId}/search?q=zebra${n}`, undefined, owner.apiKey);
    expect(JSON.stringify(search.data)).not.toContain(id);
    expect((await mcp(owner.apiKey, "context_get", { id })).text).toMatch(/not found/i);
    expect((await mcp(owner.apiKey, "context_list", {})).text).not.toContain(id);
  });

  it("still opens for a steward, marked archived, and for nobody else", async () => {
    await post(`${id}/archive`);
    const mine = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    expect(mine.status).toBe(200);
    expect(mine.data.node.archived.by).toBe(owner.email);
    const theirs = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, reader.apiKey);
    expect(theirs.status).toBe(404);
  });

  it("lists archived documents for stewards only", async () => {
    await post(`${id}/archive`);
    expect(await listed("?archived=1")).toContain(id);
    expect(await listed("?archived=1", reader.apiKey)).toEqual([]);
  });

  it("is a steward's action: a writer and a reader are refused, over REST and MCP", async () => {
    expect((await post(`${id}/archive`, {}, writer.apiKey)).status).toBe(403);
    expect((await post(`${id}/archive`, {}, reader.apiKey)).status).toBe(403);
    expect((await mcp(writer.apiKey, "context_archive", { id })).text).toMatch(/permission/);
    expect(await listed()).toContain(id);
  });

  it("freezes the document: no edit, no discard, no review, until restored", async () => {
    await post(`${id}/archive`);
    const edit = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "x" }, owner.apiKey);
    expect(edit.status).toBe(400);
    expect(edit.data.error).toMatch(/archived/);
    expect((await post(`${id}/discard`)).status).toBe(400);
    expect((await post(`${id}/submit-review`)).status).toBeGreaterThanOrEqual(400);
  });

  it("restores it exactly: same version, same content, back in every list", async () => {
    const before = (await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey)).data.node;
    await post(`${id}/archive`);

    const out = await post(`${id}/unarchive`);

    expect(out.status).toBe(200);
    expect(out.data.status).toBe("published");
    const node = (await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, reader.apiKey)).data.node;
    expect(node.archived).toBeUndefined();
    expect(before.version).toBeGreaterThan(0);
    expect(node.version).toBe(before.version);
    expect(node.content).toBe(before.content);
    expect(await listed()).toContain(id);
    expect((await mcp(owner.apiKey, "context_get", { id })).text).toContain(`zebra${n}`);
  });

  it("works end to end over MCP", async () => {
    expect((await mcp(owner.apiKey, "context_archive", { id, reason: "Old" })).text).toMatch(/Archived/);
    expect((await mcp(owner.apiKey, "context_unarchive", { id })).text).toMatch(/back as published/);
  });
});

describe("move", () => {
  it("moves a pdf with its binary", async () => {
    const form = new FormData();
    form.append("file", new File([textPdf()], `report-${n}.pdf`, { type: "application/pdf" }));
    const upload = await app.request(`/nests/${nestId}/nodes/pdf`, {
      method: "POST",
      headers: authed(owner.apiKey),
      body: form,
    });
    const pdfId = (await upload.json()).node.id;

    const moved = await post(`${pdfId}/move`, { folder: "reports" });

    expect(moved.status).toBe(200);
    const newId = moved.data.node.id;
    expect(newId).toMatch(/^nodes\/reports\//);
    const res = await app.request(`/nests/${nestId}/nodes/${newId}/pdf`, { headers: authed(owner.apiKey) });
    expect(res.status).toBe(200);
  });
});
