/**
 * Router regression guard: suffix action routes (/versions, /annotations,
 * /stewards, /move, …) must match for node ids nested ANY number of folders
 * deep.
 *
 * History: the app once ran on Hono's default SmartRouter. RegExpRouter (its
 * fast path) lets the greedy /:nodeId{.+} catch-all shadow every suffix
 * route; worse, one unsupported pattern anywhere silently dropped the whole
 * app onto TrieRouter, which can't match greedy-suffix routes for ids with
 * 3+ segments — so version history, annotations, and approvals 404'd on any
 * doc inside a nested folder. createApp now pins LinearRouter (matching
 * upstream bb96ca8). If someone swaps the router again, this suite is the
 * tripwire.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

// Three folders deep — the depth TrieRouter silently lost.
const DEEP_ID = "nodes/a/b/c/deep-doc";

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Deep" }, alice.apiKey);
  nestId = nest.data.nest.id;
  const created = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Deep Doc", content: "# Deep", folder: "a/b/c" },
    alice.apiKey,
  );
  expect(created.status).toBe(201);
  expect(created.data.node.id).toBe(DEEP_ID);
});

afterAll(() => env.cleanup());

describe("suffix routes on deeply nested node ids", () => {
  it("GET /versions matches", async () => {
    const res = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/${DEEP_ID}/versions`, undefined, alice.apiKey,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.versions)).toBe(true);
  });

  it("GET /stewards matches", async () => {
    const res = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/${DEEP_ID}/stewards`, undefined, alice.apiKey,
    );
    expect(res.status).toBe(200);
  });

  it("annotation thread create + reply match (and reply hits the annotation route, not governance comments)", async () => {
    const created = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/${DEEP_ID}/annotations`,
      { body: "note on a deep doc" }, alice.apiKey,
    );
    expect(created.status).toBe(201);
    const threadId = created.data.thread.id;

    const replied = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/${DEEP_ID}/annotations/${threadId}/comments`,
      { body: "reply" }, alice.apiKey,
    );
    // The annotation reply route returns 200 with the thread; the governance
    // POST /:nodeId/comments route (which greedy matching once hijacked)
    // returns 201 with a bare comment. Assert we got the right handler.
    expect(replied.status).toBe(200);
    expect(replied.data.thread.comments).toHaveLength(2);
  });

  it("POST /move matches", async () => {
    const res = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/${DEEP_ID}/move`,
      { folder: "a/b" }, alice.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe("nodes/a/b/deep-doc");
    // Move back so earlier assertions stay valid on re-runs within the suite.
    const back = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/nodes/a/b/deep-doc/move`,
      { folder: "a/b/c" }, alice.apiKey,
    );
    expect(back.status).toBe(200);
  });

  it("plain GET of the deep doc still matches the catch-all", async () => {
    const res = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/${DEEP_ID}`, undefined, alice.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.node.title).toBe("Deep Doc");
  });
});
