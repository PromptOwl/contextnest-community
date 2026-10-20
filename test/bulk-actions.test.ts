/**
 * Bulk move / delete over a selection of documents:
 * POST /nests/:id/nodes/bulk-move and /bulk-delete. Per-document results,
 * no all-or-nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Bulk" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

const create = (title: string, folder = "") =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `# ${title}`, folder }, alice.apiKey);
const post = (path: string, body: unknown, key = alice.apiKey) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes/${path}`, body, key);
const get = (id: string) => jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, alice.apiKey);

describe("bulk move", () => {
  it("moves several documents and reports each one", async () => {
    await create("Alpha");
    await create("Beta");
    const res = await post("bulk-move", {
      ids: ["nodes/alpha", "nodes/beta", "nodes/ghost"],
      folder: "archive",
    });
    expect(res.status).toBe(200);
    expect(res.data.requested).toBe(3);
    expect(res.data.done).toBe(2);
    expect(res.data.skipped).toBe(1);
    const byId = Object.fromEntries(res.data.results.map((r: any) => [r.id, r]));
    expect(byId["nodes/alpha"].new_id).toBe("nodes/archive/alpha");
    expect(byId["nodes/ghost"].code).toBe("not_found");
    expect((await get("nodes/archive/beta")).status).toBe(200);
    expect((await get("nodes/beta")).status).toBe(404);
  });

  it("reports a document already in the folder as unchanged", async () => {
    const res = await post("bulk-move", { ids: ["nodes/archive/alpha"], folder: "archive" });
    expect(res.status).toBe(200);
    expect(res.data.unchanged).toBe(1);
  });

  it("validates the body", async () => {
    expect((await post("bulk-move", { ids: [], folder: "x" })).status).toBe(400);
    expect((await post("bulk-move", { ids: ["nodes/a"] })).status).toBe(400);
  });
});

describe("bulk tag (bulk-update)", () => {
  it("tags documents that are not tasks", async () => {
    const res = await post("bulk-update", {
      ids: ["nodes/archive/alpha", "nodes/archive/beta"],
      patch: { add_tags: ["q4"] },
    });
    expect(res.status).toBe(200);
    expect(res.data.updated).toBe(2);
  });
});

describe("bulk delete", () => {
  it("deletes the selection and keeps going past a missing one", async () => {
    await create("Gamma");
    await create("Delta");
    const res = await post("bulk-delete", { ids: ["nodes/gamma", "nodes/delta", "nodes/nope"] });
    expect(res.status).toBe(200);
    expect(res.data.done).toBe(2);
    expect(res.data.results.find((r: any) => r.id === "nodes/nope").code).toBe("not_found");
    expect((await get("nodes/gamma")).status).toBe(404);
    expect((await get("nodes/delta")).status).toBe(404);
  });

  it("refuses a caller without access to the nest", async () => {
    await create("Epsilon");
    const bob = await registerUser(app, "bob@acme.com", "Bob");
    const res = await post("bulk-delete", { ids: ["nodes/epsilon"] }, bob.apiKey);
    expect([403, 404]).toContain(res.status);
    expect((await get("nodes/epsilon")).status).toBe(200);
  });
});
