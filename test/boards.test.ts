/**
 * Saved Board views (CU-wdqcq03xn2): several named boards per nest, shared
 * unless private, with per-column card rank that never touches node versions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: any, writer: any, reader: any, outsider: any;
let nestId: string;

const req = (u: any, method: string, path: string, body?: unknown) =>
  jsonRequest(app, method, `/nests/${nestId}/boards${path}`, body, u.apiKey);

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  writer = await registerUser(app, "writer@acme.com", "Writer");
  reader = await registerUser(app, "reader@acme.com", "Reader");
  await resetAuthRateLimit();
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Projects" }, owner.apiKey);
  nestId = data.nest.id;
  for (const [u, permission] of [
    [writer, "write"],
    [reader, "read"],
  ] as const) {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: u.email, permission },
      owner.apiKey,
    );
  }
});

afterAll(() => env.cleanup());

describe("boards", () => {
  let sprint: string;
  let mine: string;

  it("a writer creates shared and private boards, in order", async () => {
    const a = await req(writer, "POST", "", {
      name: "Sprint",
      config: { dimension: "tag", tasksOnly: true, layouts: { "tag:": { columnOrder: ["todo", "doing"] } } },
    });
    expect(a.status).toBe(201);
    expect(a.data.board.private).toBe(false);
    expect(a.data.board.config.tasksOnly).toBe(true);
    expect(a.data.board.created_by_email).toBe("writer@acme.com");
    sprint = a.data.board.id;
    const b = await req(writer, "POST", "", { name: "My triage", private: true });
    expect(b.status).toBe(201);
    mine = b.data.board.id;
    expect(b.data.board.position).toBeGreaterThan(a.data.board.position);
  });

  it("everyone on the nest sees shared boards; private ones only their creator", async () => {
    const w = await req(writer, "GET", "");
    expect(w.data.boards.map((b: any) => b.name)).toEqual(["Sprint", "My triage"]);
    const r = await req(reader, "GET", "");
    expect(r.data.boards.map((b: any) => b.name)).toEqual(["Sprint"]);
    const o = await req(owner, "GET", "");
    expect(o.data.boards.map((b: any) => b.name)).toEqual(["Sprint"]);
    // Someone else's private board is a 404, not a 403.
    expect((await req(owner, "PATCH", `/${mine}`, { name: "x" })).status).toBe(404);
  });

  it("creator emails go to writers only — read tier also serves public visitors", async () => {
    const w = await req(writer, "GET", "");
    expect(w.data.boards[0].created_by_email).toBe("writer@acme.com");
    const r = await req(reader, "GET", "");
    expect(r.data.boards[0].created_by_email).toBeNull();
  });

  it("readers can't create or change boards; outsiders can't see them", async () => {
    expect((await req(reader, "POST", "", { name: "Nope" })).status).toBe(403);
    expect((await req(reader, "PATCH", `/${sprint}`, { name: "Nope" })).status).toBe(403);
    expect((await req(outsider, "GET", "")).status).toBe(404);
  });

  it("any writer edits a shared board; only its creator flips private", async () => {
    const r = await req(owner, "PATCH", `/${sprint}`, { name: "Sprint 42" });
    expect(r.status).toBe(200);
    expect(r.data.board.name).toBe("Sprint 42");
    expect((await req(owner, "PATCH", `/${sprint}`, { private: true })).status).toBe(403);
  });

  it("rank merges per column and survives a config save that omits it", async () => {
    await req(writer, "POST", `/${sprint}/rank`, { key: "tag:::todo", order: ["nodes/b", "nodes/a"] });
    await req(owner, "POST", `/${sprint}/rank`, { key: "tag:::doing", order: ["nodes/c"] });
    let b = (await req(writer, "GET", "")).data.boards.find((x: any) => x.id === sprint);
    expect(b.config.ranks).toEqual({ "tag:::todo": ["nodes/b", "nodes/a"], "tag:::doing": ["nodes/c"] });

    await req(writer, "PATCH", `/${sprint}`, { config: { dimension: "tag", tasksOnly: false } });
    b = (await req(writer, "GET", "")).data.boards.find((x: any) => x.id === sprint);
    expect(b.config.tasksOnly).toBe(false);
    expect(b.config.ranks["tag:::todo"]).toEqual(["nodes/b", "nodes/a"]);
  });

  it("validates names and config", async () => {
    expect((await req(writer, "POST", "", { name: "  " })).status).toBe(400);
    expect((await req(writer, "POST", "", { name: "x".repeat(81) })).status).toBe(400);
    expect((await req(writer, "POST", "", { name: "Bad", config: { dimension: "people" } })).status).toBe(400);
    expect((await req(writer, "POST", `/${sprint}/rank`, { key: "k", order: [1, 2] })).status).toBe(400);
  });

  it("delete: creator or nest owner, nobody else", async () => {
    const extra = (await req(writer, "POST", "", { name: "Scratch" })).data.board.id;
    await resetAuthRateLimit();
    const other = await registerUser(app, "writer2@acme.com", "W2");
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: other.email, permission: "write" }, owner.apiKey);
    expect((await req(other, "DELETE", `/${extra}`)).status).toBe(403);
    expect((await req(owner, "DELETE", `/${extra}`)).status).toBe(200);
    expect((await req(writer, "DELETE", `/${mine}`)).status).toBe(200);
    const names = (await req(writer, "GET", "")).data.boards.map((b: any) => b.name);
    expect(names).toEqual(["Sprint 42"]);
  });

  it("boards go with their nest", async () => {
    await jsonRequest(app, "DELETE", `/nests/${nestId}`, undefined, owner.apiKey);
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get("SELECT COUNT(*) AS n FROM boards WHERE nest_id = ?", [nestId])) as any;
    expect(Number(row.n)).toBe(0);
  });
});
