/**
 * §1.12 view addresses are reserved at write time (PR #440 review, L-1).
 *
 * A view at X is served at …/X/view/hosted and …/X/view/blocks/<b>/hosted, so:
 *  (a) no node may be created / moved to X/view or under X/view/blocks/ while
 *      a view lives at X;
 *  (b) no view may be created / converted / moved to X while a node lives at
 *      X/view or under X/view/blocks/.
 * Ordinary ids like nodes/foo/view stay legal when nodes/foo is not a view.
 * Covered on REST create, PATCH re-type, move, folder move, MCP create, bulk
 * POST /publish (held-write replay goes through the same createNode) and
 * folder import.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed } from "./helpers.js";
import { viewOwnersOf, batchViewCollisions } from "../src/views/collision.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let nestId: string;

const VIEW = { blocks: [{ callout: { text: "hi" } }] };
const post = (body: Record<string, unknown>) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, owner.apiKey);

async function mcp(name: string, args: Record<string, unknown>) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authed(owner.apiKey),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const line = (await res.text()).split("\n").find((l: string) => l.startsWith("data: "));
    body = line ? JSON.parse(line.slice(6)) : null;
  }
  const text = (body?.result?.content ?? []).map((c: any) => c.text).join("");
  return { isError: body?.result?.isError === true || !!body?.error, text };
}

const exists = async (id: string) =>
  (await app.request(`/nests/${nestId}/nodes/${id}`, { headers: authed(owner.apiKey) })).status === 200;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@collide.test", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Collide" }, owner.apiKey);
  nestId = nest.data.nest.id;
  const v = await post({ title: "Board", type: "view", content: "intro", view: VIEW });
  expect(v.status, JSON.stringify(v.data)).toBe(201);
  expect(v.data.node.id).toBe("nodes/board");
});

afterAll(() => env.cleanup());

describe("pure helpers", () => {
  it("viewOwnersOf names every X a path would shadow", () => {
    expect(viewOwnersOf("nodes/board/view")).toEqual(["nodes/board"]);
    expect(viewOwnersOf("nodes/board/view/blocks/h")).toEqual(["nodes/board"]);
    expect(viewOwnersOf("nodes/board/view/blocks/h/deep")).toEqual(["nodes/board"]);
    expect(viewOwnersOf("nodes/board/view/other")).toEqual([]);
    expect(viewOwnersOf("nodes/view")).toEqual(["nodes"]);
    expect(viewOwnersOf("nodes/plain")).toEqual([]);
  });

  it("batchViewCollisions keeps the view and refuses the node under its address", () => {
    const refused = batchViewCollisions(
      [
        { id: "a", type: "view" },
        { id: "a/view", type: "document" },
        { id: "b", type: "view" },
      ],
      [{ id: "b/view/blocks/x", type: "artifact" }],
    );
    expect([...refused.keys()].sort()).toEqual(["a/view", "b"]);
  });
});

describe("(a) nothing may take a view's address", () => {
  it("REST create of X/view and of X/view/blocks/… is 409", async () => {
    const a = await post({ title: "View", folder: "board", content: "x" });
    expect(a.status, JSON.stringify(a.data)).toBe(409);
    expect(String(a.data.error)).toMatch(/nodes\/board is a view/);
    const b = await post({ title: "H", folder: "board/view/blocks", content: "x" });
    expect(b.status).toBe(409);
    expect(await exists("nodes/board/view")).toBe(false);
  });

  it("an ordinary nodes/foo/view is fine when nodes/foo is not a view", async () => {
    const r = await post({ title: "View", folder: "foo", content: "x" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.node.id).toBe("nodes/foo/view");
  });

  it("moving a node onto X/view is 409", async () => {
    const r = await post({ title: "View", folder: "elsewhere", content: "x" });
    expect(r.status).toBe(201);
    const mv = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/elsewhere/view/move`,
      { folder: "board" },
      owner.apiKey,
    );
    expect(mv.status, JSON.stringify(mv.data)).toBe(409);
    expect(String(mv.data.error)).toMatch(/is a view/);
    expect(await exists("nodes/elsewhere/view")).toBe(true);
  });

  it("MCP context_create onto X/view is refused", async () => {
    const r = await mcp("context_create", { title: "View", folder: "board", content: "x" });
    expect(r.isError).toBe(true);
    expect(await exists("nodes/board/view")).toBe(false);
  });

  it("bulk POST /publish (the held-write replay path) skips it", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      { documents: [{ title: "View", folder: "board", content: "x" }] },
      owner.apiKey,
    );
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    expect(r.data.node_ids ?? []).not.toContain("nodes/board/view");
    expect(await exists("nodes/board/view")).toBe(false);
  });
});

describe("(b) a view may not land on an occupied address", () => {
  it("REST create of a view at X when X/view exists is 409", async () => {
    // nodes/foo/view exists (created above).
    const r = await post({ title: "Foo", type: "view", content: "x", view: VIEW });
    expect(r.status, JSON.stringify(r.data)).toBe(409);
    expect(String(r.data.error)).toMatch(/nodes\/foo\/view already uses/);
  });

  it("…or when something lives under X/view/blocks/", async () => {
    expect((await post({ title: "B1", folder: "blk/view/blocks", content: "x" })).status).toBe(201);
    expect((await post({ title: "Blk", type: "view", content: "x", view: VIEW })).status).toBe(409);
  });

  it("converting a node at X to type: view is 409", async () => {
    expect((await post({ title: "Conv", content: "x" })).status).toBe(201);
    expect((await post({ title: "View", folder: "conv", content: "x" })).status).toBe(201);
    const r = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/conv`,
      { type: "view", view: VIEW },
      owner.apiKey,
    );
    expect(r.status, JSON.stringify(r.data)).toBe(409);
  });

  it("moving a view to X when X/view exists is 409", async () => {
    expect((await post({ title: "View", folder: "sub/mover", content: "x" })).status).toBe(201);
    expect((await post({ title: "Mover", type: "view", content: "x", view: VIEW })).status).toBe(201);
    const mv = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/mover/move`,
      { folder: "sub" },
      owner.apiKey,
    );
    expect(mv.status, JSON.stringify(mv.data)).toBe(409);
    expect(await exists("nodes/mover")).toBe(true);
  });

  it("a folder move that would put a node on a view's address is 409 before anything moves", async () => {
    expect((await post({ title: "View", folder: "carry", content: "x" })).status).toBe(201);
    expect((await post({ title: "Keep", folder: "carry", content: "x" })).status).toBe(201);
    // Moving folder "carry" to "board" would put nodes/carry/view at nodes/board/view.
    const mv = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/folders/move`,
      { folder: "carry", to: "board" },
      owner.apiKey,
    );
    expect(mv.status, JSON.stringify(mv.data)).toBe(409);
    expect(String(mv.data.error)).toMatch(/is a view/);
    expect(await exists("nodes/carry/view")).toBe(true);
    expect(await exists("nodes/carry/keep")).toBe(true);
  });
});

describe("folder import", () => {
  it("refuses a file under an imported view's address, and reports it", async () => {
    const md = (path: string, fm: string, body = "body") => ({ path, content: `---\n${fm}\n---\n${body}\n` });
    const r = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      {
        name: "Imported Views",
        files: [
          md("dash.md", "title: Dash\ntype: view\nstatus: published\nview:\n  blocks:\n    - callout:\n        text: hi"),
          md("dash/view.md", "title: Shadow\nstatus: published"),
          md("plain/view.md", "title: Fine\nstatus: published"),
        ],
      },
      owner.apiKey,
    );
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.rejected).toContain("dash/view.md");
    expect(r.data.problems.some((p: string) => p.startsWith("dash/view.md:"))).toBe(true);
    expect(r.data.rejected).not.toContain("plain/view.md");
    expect(r.data.rejected).not.toContain("dash.md");
  });
});
