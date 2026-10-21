/**
 * Board List view + bulk edit (REST and MCP).
 *
 *  - GET /boards/:id/items is the board as rows: the board's own filters,
 *    grouped by its columns in board order, sortable, paged.
 *  - POST /nodes/bulk-update and MCP context_bulk_update apply one patch per
 *    node through the governed update: each node its own version, done
 *    columns stamp completed_at, nodes that need review are skipped (never
 *    drafted), read-only callers are refused, and the batch is capped.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: any, ann: any, rita: any, ed: any, ed2: any;
let nestId: string;
let boardId: string;

const create = (u: any, body: Record<string, unknown>, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/nodes`, { content: "x", ...body }, u.apiKey);
const get = async (slug: string, nest = nestId) =>
  (await jsonRequest(app, "GET", `/nests/${nest}/nodes/nodes/${slug}`, undefined, owner.apiKey)).data.node;
const items = (qs = "", u = owner, board = boardId) =>
  jsonRequest(app, "GET", `/nests/${nestId}/boards/${board}/items${qs}`, undefined, u.apiKey);
const bulk = (u: any, body: Record<string, unknown>, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/nodes/bulk-update`, body, u.apiKey);

async function mcp(apiKey: string, name: string, args: Record<string, unknown>, nest: string | null = nestId) {
  const res = await app.request(nest ? `/nests/${nest}/mcp` : "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  return body.result as { content: { text: string }[]; structuredContent?: any; isError?: boolean };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  ann = await registerUser(app, "ann@acme.com", "Ann");
  rita = await registerUser(app, "rita@acme.com", "Rita");
  await resetAuthRateLimit();
  ed = await registerUser(app, "ed@acme.com", "Ed");
  await resetAuthRateLimit();
  ed2 = await registerUser(app, "ed2@acme.com", "Ed2");
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Sprint" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: ann.email, permission: "write" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: rita.email, permission: "read" }, owner.apiKey);

  await create(owner, { title: "alpha", type: "task", tags: ["todo", "sprint"], priority: "low", due: "2026-11-02" });
  await create(owner, { title: "bravo", type: "task", tags: ["todo", "sprint"], priority: "urgent", assignee: ann.email });
  await create(owner, { title: "charlie", type: "task", tags: ["doing", "sprint"], priority: "medium", parent: "nodes/alpha" });
  await create(owner, { title: "delta", type: "task", tags: ["done", "sprint"] });
  await create(owner, { title: "echo", type: "task", tags: ["todo"] }); // not #sprint
  await create(owner, { title: "notes", tags: ["todo", "sprint"] }); // a document, not a task

  const board = await jsonRequest(app, "POST", `/nests/${nestId}/boards`, {
    name: "Sprint board",
    config: {
      dimension: "tag",
      tasksOnly: true,
      filterTags: ["sprint"],
      layouts: { "tag:": { columnOrder: ["todo", "doing", "done"] } },
    },
  }, owner.apiKey);
  boardId = board.data.board.id;
}, 60_000);

afterAll(() => env.cleanup());

describe("GET /boards/:id/items — the board as a list", () => {
  it("applies the board's filters and groups by its columns in board order", async () => {
    const { status, data } = await items();
    expect(status).toBe(200);
    expect(data.board).toMatchObject({ id: boardId, dimension: "tag" });
    // tasksOnly drops "notes", filterTags drops "echo".
    expect(data.groups).toEqual([
      { key: "todo", label: "todo", count: 2 },
      { key: "doing", label: "doing", count: 1 },
      { key: "done", label: "done", count: 1 },
    ]);
    expect(data.total).toBe(4);
    const charlie = data.items.find((r: any) => r.title === "charlie");
    expect(charlie).toMatchObject({ group: "doing", priority: "medium", parent: "nodes/alpha", parent_title: "alpha" });
    expect(data.items.map((r: any) => r.title)).not.toContain("notes");
  });

  it("sorts within each section and pages across them", async () => {
    const byPriority = (await items("?sort=priority")).data;
    expect(byPriority.items.filter((r: any) => r.group === "todo").map((r: any) => r.title)).toEqual(["bravo", "alpha"]);
    const byTitleDesc = (await items("?sort=title&dir=desc")).data;
    expect(byTitleDesc.items.filter((r: any) => r.group === "todo").map((r: any) => r.title)).toEqual(["bravo", "alpha"]);
    const page = (await items("?sort=title&limit=2&offset=2")).data;
    expect(page.total).toBe(4);
    expect(page.items.map((r: any) => r.title)).toEqual(["charlie", "delta"]);
    expect((await items("?sort=mood")).status).toBe(400);
  });

  it("filters by assignee (including unassigned) and title", async () => {
    const mine = (await items(`?assignee=${encodeURIComponent(ann.email)}`)).data;
    expect(mine.items.map((r: any) => r.title)).toEqual(["bravo"]);
    const nobody = (await items("?assignee=unassigned")).data;
    expect(nobody.items.map((r: any) => r.title).sort()).toEqual(["alpha", "charlie", "delta"]);
    const q = (await items("?q=CHAR")).data;
    expect(q.items.map((r: any) => r.title)).toEqual(["charlie"]);
  });

  it("is a read: a read-only collaborator sees it; someone else's private board is a 404", async () => {
    expect((await items("", rita)).status).toBe(200);
    const priv = await jsonRequest(app, "POST", `/nests/${nestId}/boards`, { name: "Mine", private: true }, ann.apiKey);
    expect((await items("", owner, priv.data.board.id)).status).toBe(404);
    expect((await items("", ann, priv.data.board.id)).status).toBe(200);
  });
});

describe("POST /nodes/bulk-update", () => {
  it("moves rows into a done column: each node versioned, tasks stamped completed", async () => {
    const before = await get("alpha");
    const { status, data } = await bulk(owner, {
      ids: ["nodes/alpha", "nodes/bravo"],
      patch: { board_id: boardId, column: "done" },
    });
    expect(status).toBe(200);
    expect(data).toMatchObject({ requested: 2, updated: 2, skipped: 0, failed: 0 });
    for (const r of data.results) {
      expect(r.outcome).toBe("updated");
      expect(Date.parse(r.completed_at)).not.toBeNaN();
    }
    const alpha = await get("alpha");
    // The column swap drops the old column tag and keeps the rest.
    expect(alpha.tags.sort()).toEqual(["#done", "#sprint"]);
    expect(alpha.version).toBeGreaterThan(before.version);
    expect(Date.parse(alpha.completed_at)).not.toBeNaN();
    // Moving back out reopens it.
    await bulk(owner, { ids: ["nodes/alpha"], patch: { board_id: boardId, column: "todo" } });
    expect((await get("alpha")).completed_at).toBeUndefined();
  });

  it("adds/removes tags and sets priority, assignee and due; a re-run is unchanged", async () => {
    const patch = { add_tags: ["#q4"], remove_tags: ["sprint"], priority: "high", assignee: ann.email, due: "2026-12-01" };
    const { data } = await bulk(ann, { ids: ["nodes/charlie", "nodes/delta"], patch });
    expect(data.updated).toBe(2);
    const charlie = await get("charlie");
    expect(charlie.tags.sort()).toEqual(["#doing", "#q4"]);
    expect(charlie).toMatchObject({ priority: "high", assignee: ann.email, due: "2026-12-01" });
    const again = (await bulk(ann, { ids: ["nodes/charlie", "nodes/delta"], patch })).data;
    expect(again).toMatchObject({ updated: 0, unchanged: 2 });
    // Clearing fields with null.
    await bulk(ann, { ids: ["nodes/charlie"], patch: { priority: null, due: null, assignee: null, add_tags: ["sprint"] } });
    const cleared = await get("charlie");
    expect(cleared.priority).toBeUndefined();
    expect(cleared.due).toBeUndefined();
    expect(cleared.assignee).toBeUndefined();
  });

  it("takes a selector instead of ids", async () => {
    const { data } = await bulk(owner, { selector: "#q4", patch: { priority: "low" } });
    expect(data.results.map((r: any) => r.id).sort()).toEqual(["nodes/charlie", "nodes/delta"]);
    expect(data.results.every((r: any) => r.outcome === "updated")).toBe(true);
  });

  it("validates the request: empty patch, unknown fields, bad values, unknown people", async () => {
    expect((await bulk(owner, { ids: ["nodes/alpha"], patch: {} })).status).toBe(400);
    expect((await bulk(owner, { ids: ["nodes/alpha"], patch: { colour: "red" } })).status).toBe(400);
    expect((await bulk(owner, { ids: ["nodes/alpha"], patch: { priority: "asap" } })).status).toBe(400);
    expect((await bulk(owner, { ids: ["nodes/alpha"], patch: { due: "tomorrow" } })).status).toBe(400);
    // A day that doesn't exist, which Date.parse would roll into March.
    expect((await bulk(owner, { ids: ["nodes/alpha"], patch: { due: "2026-02-31" } })).status).toBe(400);
    expect((await bulk(owner, { ids: ["nodes/alpha"], patch: { due: "0020-09-02" } })).status).toBe(400);
    expect((await bulk(owner, { ids: ["nodes/alpha"], patch: { assignee: "stranger@else.com" } })).status).toBe(400);
    expect((await bulk(owner, { ids: ["nodes/alpha"], patch: { column: "done" } })).status).toBe(400);
  });

  it("reports missing ids per node and keeps going", async () => {
    const { data } = await bulk(owner, { ids: ["nodes/nope", "nodes/echo"], patch: { priority: "high" } });
    expect(data.results.find((r: any) => r.id === "nodes/nope")).toMatchObject({ outcome: "skipped", code: "not_found" });
    expect(data.results.find((r: any) => r.id === "nodes/echo")).toMatchObject({ outcome: "updated" });
  });

  it("caps the batch", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `nodes/n-${i}`);
    const { status, data } = await bulk(owner, { ids, patch: { priority: "low" } });
    expect(status).toBe(400);
    expect(data.error).toMatch(/at most 100/);
  });

  it("caps a selector at the first match past the limit", async () => {
    const { data: n } = await jsonRequest(app, "POST", "/nests", { name: "Many" }, owner.apiKey);
    for (let i = 0; i < 101; i++) await create(owner, { title: `many ${i}`, tags: ["many"] }, n.nest.id);
    const { status, data } = await bulk(owner, { selector: "#many", patch: { priority: "low" } }, n.nest.id);
    expect(status).toBe(400);
    expect(data.error).toMatch(/at most 100.*selector matches more/);
  }, 60_000);

  it("refuses a read-only collaborator's key", async () => {
    const { status } = await bulk(rita, { ids: ["nodes/alpha"], patch: { priority: "high" } });
    expect(status).toBe(403);
    expect((await get("alpha")).priority).toBe("low");
  });
});

describe("governance: nodes that need review are skipped, never drafted", () => {
  let gid: string;
  beforeAll(async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Governed" }, owner.apiKey);
    gid = data.nest.id;
    await jsonRequest(app, "POST", `/nests/${gid}/collaborators`, { email: ed.email, permission: "write" }, owner.apiKey);
    await create(owner, { title: "policy", tags: ["todo"] }, gid);
    await create(owner, { title: "chore", type: "task", tags: ["todo"] }, gid);
    await create(owner, { title: "launch", type: "task", tags: ["todo"], prime: true }, gid);
    await jsonRequest(app, "PATCH", `/nests/${gid}/settings`, { stewardship_enabled: true, allow_self_approve: false }, owner.apiKey);
    mkdirSync(join(env.dataDir, "nests", gid), { recursive: true });
    writeFileSync(join(env.dataDir, "nests", gid, "stewards.yaml"), `version: 1\nnest:\n  - email: ${ed.email}, role: editor\n`);
    await jsonRequest(app, "POST", `/nests/${gid}/stewards/sync`, {}, owner.apiKey);
  }, 30_000);

  it("updates the plain task, skips the governed document and the prime task with reasons", async () => {
    const before = await get("policy", gid);
    const { status, data } = await bulk(ed, {
      ids: ["nodes/policy", "nodes/chore", "nodes/launch"],
      patch: { add_tags: ["q4"] },
    }, gid);
    expect(status).toBe(200);
    expect(data).toMatchObject({ updated: 1, skipped: 2 });
    const by = Object.fromEntries(data.results.map((r: any) => [r.id, r]));
    expect(by["nodes/chore"].outcome).toBe("updated");
    expect(by["nodes/policy"]).toMatchObject({ outcome: "skipped", code: "needs_review" });
    expect(by["nodes/launch"]).toMatchObject({ outcome: "skipped", code: "needs_review" });
    // Skipped means untouched: no draft, no new version.
    const after = await get("policy", gid);
    expect(after.version).toBe(before.version);
    expect(after.tags).not.toContain("#q4");
  });
});

describe("custom-field boards", () => {
  it("groups by the field, applies filterFields, and refuses a bulk move", async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Fields" }, owner.apiKey);
    const f = data.nest.id;
    const sev = await jsonRequest(app, "POST", `/nests/${f}/fields`, {
      key: "severity", label: "Severity", type: "select", options: ["low", "high"],
    }, owner.apiKey);
    expect(sev.status).toBe(201);
    await jsonRequest(app, "POST", `/nests/${f}/fields`, { key: "blocked", label: "Blocked", type: "checkbox" }, owner.apiKey);
    await create(owner, { title: "s1", type: "task", fields: { severity: "high" } }, f);
    await create(owner, { title: "s2", type: "task", fields: { severity: "low", blocked: true } }, f);
    await create(owner, { title: "s3", type: "task" }, f);

    const board = await jsonRequest(app, "POST", `/nests/${f}/boards`, {
      name: "By severity", config: { dimension: "field", fieldKey: "severity" },
    }, owner.apiKey);
    const bid = board.data.board.id;
    const list = await jsonRequest(app, "GET", `/nests/${f}/boards/${bid}/items`, undefined, owner.apiKey);
    expect(list.status).toBe(200);
    expect(list.data.board.field_key).toBe("severity");
    // Option order, then the no-value column, labelled like the board.
    expect(list.data.groups).toEqual([
      { key: "low", label: "low", count: 1 },
      { key: "high", label: "high", count: 1 },
      { key: "__uncategorized__", label: "No severity", count: 1 },
    ]);

    const filtered = await jsonRequest(app, "POST", `/nests/${f}/boards`, {
      name: "Blocked only", config: { dimension: "field", fieldKey: "blocked", filterFields: { blocked: "true" } },
    }, owner.apiKey);
    const only = await jsonRequest(app, "GET", `/nests/${f}/boards/${filtered.data.board.id}/items`, undefined, owner.apiKey);
    expect(only.data.items.map((r: any) => r.title)).toEqual(["s2"]);
    expect(only.data.groups).toEqual([{ key: "true", label: "Blocked", count: 1 }]);

    const move = await bulk(owner, { ids: ["nodes/s3"], patch: { board_id: bid, column: "high" } }, f);
    expect(move.status).toBe(400);
    expect(move.data.error).toMatch(/Custom-field boards/);
  }, 30_000);
});

describe("MCP — context_boards, context_board_items, context_bulk_update", () => {
  it("lists boards and a board's rows", async () => {
    const boards = await mcp(owner.apiKey, "context_boards", {});
    expect(boards.structuredContent.boards.some((b: any) => b.id === boardId && b.dimension === "tag")).toBe(true);
    const list = await mcp(owner.apiKey, "context_board_items", { board: "Sprint board", sort: "title" });
    expect(list.isError).toBeUndefined();
    expect(list.structuredContent.groups.map((g: any) => g.key)).toEqual(["todo", "doing", "done"]);
    expect(list.content[0].text).toContain("## todo");
    const missing = await mcp(owner.apiKey, "context_board_items", { board: "No such board" });
    expect(missing.isError).toBe(true);
  });

  it("refuses a board name that matches several boards, and takes the id", async () => {
    const twin = await jsonRequest(app, "POST", `/nests/${nestId}/boards`, { name: "Sprint board", private: true }, owner.apiKey);
    const twinId = twin.data.board.id;
    try {
      const byName = await mcp(owner.apiKey, "context_board_items", { board: "sprint board" });
      expect(byName.isError).toBe(true);
      expect(byName.content[0].text).toContain(boardId);
      expect(byName.content[0].text).toContain(twinId);
      const byId = await mcp(owner.apiKey, "context_board_items", { board: boardId });
      expect(byId.isError).toBeUndefined();
    } finally {
      await jsonRequest(app, "DELETE", `/nests/${nestId}/boards/${twinId}`, undefined, owner.apiKey);
    }
  });

  it("bulk-updates with per-node results and stamps done", async () => {
    const res = await mcp(ann.apiKey, "context_bulk_update", {
      ids: ["nodes/charlie"],
      patch: { board_id: boardId, column: "done" },
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ updated: 1 });
    expect(res.content[0].text).toMatch(/1 updated/);
    const charlie = await get("charlie");
    expect(Date.parse(charlie.completed_at)).not.toBeNaN();
    expect(charlie.tags).not.toContain("#doing");
  });

  it("refuses a read-only key, and caps the batch", async () => {
    const denied = await mcp(rita.apiKey, "context_bulk_update", { ids: ["nodes/alpha"], patch: { priority: "high" } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.code).toBe("UNAUTHORIZED_ACTION");
    expect((await get("alpha")).priority).toBe("low");
    const tooMany = await mcp(owner.apiKey, "context_bulk_update", {
      ids: Array.from({ length: 101 }, (_, i) => `nodes/x-${i}`),
      patch: { priority: "low" },
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content[0].text).toMatch(/at most 100/);
  });

  it("skips nodes that need review over MCP too", async () => {
    const ed = ed2;
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Gov2" }, owner.apiKey);
    const g = data.nest.id;
    await jsonRequest(app, "POST", `/nests/${g}/collaborators`, { email: ed.email, permission: "write" }, owner.apiKey);
    await create(owner, { title: "handbook", tags: ["todo"] }, g);
    await jsonRequest(app, "PATCH", `/nests/${g}/settings`, { stewardship_enabled: true, allow_self_approve: false }, owner.apiKey);
    mkdirSync(join(env.dataDir, "nests", g), { recursive: true });
    writeFileSync(join(env.dataDir, "nests", g, "stewards.yaml"), `version: 1\nnest:\n  - email: ${ed.email}, role: editor\n`);
    await jsonRequest(app, "POST", `/nests/${g}/stewards/sync`, {}, owner.apiKey);
    const res = await mcp(ed.apiKey, "context_bulk_update", { ids: ["nodes/handbook"], patch: { priority: "high" } }, g);
    expect(res.structuredContent).toMatchObject({ updated: 0, skipped: 1 });
    expect(res.structuredContent.results[0].code).toBe("needs_review");
  });

  it("is on the server-level /mcp endpoint too, nest-parameterised", async () => {
    const list = await mcp(owner.apiKey, "context_board_items", { nest: nestId, board: boardId }, null);
    expect(list.isError).toBeUndefined();
    expect(list.structuredContent.board.id).toBe(boardId);
    const res = await mcp(owner.apiKey, "context_bulk_update", { nest: nestId, ids: ["nodes/echo"], patch: { priority: "medium" } }, null);
    expect(res.structuredContent).toMatchObject({ updated: 1 });
    const denied = await mcp(rita.apiKey, "context_bulk_update", { nest: nestId, ids: ["nodes/echo"], patch: { priority: "low" } }, null);
    expect(denied.isError).toBe(true);
  });

  it("reports per row (not a blanket refusal) when only some targets are editable", async () => {
    // Rita reads the nest and holds a write share on one document only.
    const g = await mcp(owner.apiKey, "context_grant", {
      email: rita.email, target_type: "document", target: "nodes/echo", role: "write",
    });
    expect(g.content[0].text).toMatch(/Shared document/);
    const res = await mcp(rita.apiKey, "context_bulk_update", { ids: ["nodes/alpha", "nodes/echo"], patch: { priority: "medium" } });
    expect(res.isError).toBeUndefined();
    const by = Object.fromEntries(res.structuredContent.results.map((r: any) => [r.id, r]));
    expect(by["nodes/alpha"]).toMatchObject({ outcome: "skipped", code: "forbidden" });
    expect(by["nodes/echo"].outcome).toBe("unchanged");
  });
});
