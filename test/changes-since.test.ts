/**
 * GET /nests/:id/changes?since=<ISO> — the sync primitive for external
 * mirrors (GitHub/GitBook): created/updated/deleted since a point in time.
 * Deletions come from node_deletions tombstones, the one record the DELETE
 * purge leaves behind.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;
let t0: string;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Mirror" }, alice.apiKey);
  nestId = nest.data.nest.id;

  // Pre-t0 baseline doc.
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Old Doc", content: "# Old" },
    alice.apiKey,
  );
  await wait(20);
  t0 = new Date().toISOString();
  await wait(20);

  // Post-t0 activity: update the old doc, create a new one, create + delete one.
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/nodes/nodes/old-doc`,
    { append: "\nMore." },
    alice.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "New Doc", content: "# New content here" },
    alice.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Doomed Doc", content: "# Doomed" },
    alice.apiKey,
  );
  await jsonRequest(
    app,
    "DELETE",
    `/nests/${nestId}/nodes/nodes/doomed-doc`,
    undefined,
    alice.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("GET /nests/:id/changes", () => {
  it("rejects a missing or malformed since", async () => {
    const missing = await jsonRequest(app, "GET", `/nests/${nestId}/changes`, undefined, alice.apiKey);
    expect(missing.status).toBe(400);
    const bad = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=yesterday-ish`,
      undefined,
      alice.apiKey,
    );
    expect(bad.status).toBe(400);
  });

  it("buckets created, updated, and deleted since the given time", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=${encodeURIComponent(t0)}`,
      undefined,
      alice.apiKey,
    );
    expect(res.status).toBe(200);

    const createdIds = res.data.created.map((n: any) => n.id);
    expect(createdIds).toContain("nodes/new-doc");
    // Deleted docs never appear as created, even though they were made post-t0.
    expect(createdIds).not.toContain("nodes/doomed-doc");

    const updatedIds = res.data.updated.map((n: any) => n.id);
    expect(updatedIds).toContain("nodes/old-doc");

    expect(res.data.deleted.map((d: any) => d.id)).toContain("nodes/doomed-doc");
    expect(res.data.deleted[0].deleted_by).toBe(alice.email);
    // Content is omitted unless asked for.
    expect(res.data.created[0].content).toBeUndefined();
  });

  it("a since after all activity returns empty buckets", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=${encodeURIComponent(future)}`,
      undefined,
      alice.apiKey,
    );
    expect(res.data.created).toEqual([]);
    expect(res.data.updated).toEqual([]);
    expect(res.data.deleted).toEqual([]);
  });

  it("include_content=1 ships the bodies", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=${encodeURIComponent(t0)}&include_content=1`,
      undefined,
      alice.apiKey,
    );
    const doc = res.data.created.find((n: any) => n.id === "nodes/new-doc");
    expect(doc.content).toContain("New content here");
  });
});
