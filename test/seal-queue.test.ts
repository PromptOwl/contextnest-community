import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

// Writes return once the document and its version are on disk; the nest
// checkpoint and the index update run after, from nest_write_jobs.
describe("seal queue", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let apiKey: string;
  let nestId: string;
  // After createTestApp: it resets the module graph, and these must be the
  // instances the app runs on.
  let resolveNestPath: typeof import("../src/nests/service.js").resolveNestPath;
  let getDb: typeof import("../src/db/client.js").getDb;
  let engine: typeof import("../src/nodes/engine.js");
  let queue: typeof import("../src/nodes/seal-queue.js");

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    ({ resolveNestPath } = await import("../src/nests/service.js"));
    ({ getDb } = await import("../src/db/client.js"));
    engine = await import("../src/nodes/engine.js");
    queue = await import("../src/nodes/seal-queue.js");
    ({ apiKey } = await registerUser(app, "seal@test.com", "Seal"));
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Seal" }, apiKey);
    nestId = data.nest.id;
  });
  afterAll(() => env.cleanup());

  const create = async (title: string) => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title, content: title, tags: ["sealq"] },
      apiKey,
    );
    expect(res.status).toBe(201);
    return res.data.node.id as string;
  };
  const contextYaml = () => readFile(join(resolveNestPath(nestId), "context.yaml"), "utf-8");

  it("seals a published create into a checkpoint and the index after the response", async () => {
    const id = await create("Sealed one");
    await queue.sealsSettled(nestId);
    expect(await queue.hasPendingSeals(nestId)).toBe(false);
    const { storage } = await engine.engineCache.get(nestId);
    const head = await storage.readLatestCheckpoint();
    expect(Object.keys(head?.document_versions ?? {})).toContain(id);
    expect(await contextYaml()).toContain(id);
  });

  it("a query sees a write whose seal is still queued", async () => {
    const id = await create("Read your writes");
    const res = await engine.engineApi.run<{ documents: Array<{ id: string }> }>(
      "context_query",
      { query: "#sealq" },
      await engine.opContext(nestId, "seal@test.com"),
    );
    expect(res.documents.map((d) => d.id)).toContain(id);
  });

  it("boot seals what a previous process queued", async () => {
    const id = await create("Left behind");
    await queue.sealsSettled(nestId);
    // As if the process died after the write: the row is back, the index is not.
    const { storage } = await engine.engineCache.get(nestId);
    const before = (await storage.readLatestCheckpoint())?.checkpoint ?? 0;
    await getDb().run(
      "INSERT INTO nest_write_jobs (nest_id, node_id, published, created_at) VALUES (?, ?, 1, '2026-01-01 00:00:00')",
      [nestId, id],
    );
    expect(await queue.resumeSeals()).toBeGreaterThan(0);
    await queue.sealsSettled(nestId);
    expect(await queue.hasPendingSeals(nestId)).toBe(false);
    expect((await storage.readLatestCheckpoint())?.checkpoint).toBeGreaterThan(before);
  });
});
