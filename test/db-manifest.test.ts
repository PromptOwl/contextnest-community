import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NestStorage } from "@promptowl/contextnest-engine";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

// The engine takes the nest's documents from node_index (manifest_json)
// instead of crawling the storage mount. What it writes must match what a
// full crawl writes.
describe("index built from the database manifest", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let apiKey: string;
  let nestId: string;
  // After createTestApp, which resets the module graph the app runs on.
  let resolveNestPath: typeof import("../src/nests/service.js").resolveNestPath;
  let getDb: typeof import("../src/db/client.js").getDb;
  let sealsSettled: typeof import("../src/nodes/seal-queue.js").sealsSettled;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    ({ resolveNestPath } = await import("../src/nests/service.js"));
    ({ getDb } = await import("../src/db/client.js"));
    ({ sealsSettled } = await import("../src/nodes/seal-queue.js"));
    ({ apiKey } = await registerUser(app, "manifest@test.com", "Manifest"));
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Manifest" }, apiKey);
    nestId = data.nest.id;
    // A listing builds the mirror and stamps it fresh.
    await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, apiKey);
  });
  afterAll(() => env.cleanup());

  const create = async (title: string, folder: string, content: string) => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content, folder }, apiKey);
    expect(res.status).toBe(201);
    // The index update runs after the response (seal-queue.ts).
    await sealsSettled(nestId);
    return res.data.node.id as string;
  };

  /** context.yaml and every INDEX.md, minus timestamps. */
  const snapshot = async (root: string, folders: string[]) => {
    const strip = (s: string) => s.replace(/^.*(generated_at|_at:|Generated).*$/gm, "");
    const files = ["context.yaml", ...folders.map((f) => `${f}/INDEX.md`)];
    return Promise.all(files.map(async (f) => strip(await readFile(join(root, f), "utf-8").catch(() => ""))));
  };

  it("writes the same context.yaml and INDEX.md as a full crawl, without crawling", async () => {
    const log = vi.spyOn(console, "log");
    let moveLine = "";
    try {
      const a = await create("Alpha", "nodes/one", "links to [[Beta]]");
      const b = await create("Beta", "nodes/one", "plain");
      await create("Gamma", "nodes/two", "see contextnest://nodes/one/beta");
      const moved = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${b}/move`, { folder: "nodes/two" }, apiKey);
      expect(moved.status).toBe(200);
      const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/${a}`, undefined, apiKey);
      expect(del.status).toBeLessThan(300);
      await sealsSettled(nestId);
      moveLine = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[write] io move:")) ?? "";
    } finally {
      log.mockRestore();
    }
    // The move's index update read the database, not the folders.
    expect(moveLine).toContain("regenerateIndex");
    expect(moveLine).not.toContain("discoverDocuments");

    const rows = (await getDb().all(
      "SELECT node_id FROM node_index WHERE nest_id = ? AND manifest_json IS NULL",
      [nestId],
    )) as unknown[];
    expect(rows).toHaveLength(0);

    const root = resolveNestPath(nestId);
    const folders = ["nodes/one", "nodes/two"];
    const fromDb = await snapshot(root, folders);
    expect(fromDb[2]).toMatch(/beta/i);
    expect(fromDb[0]).toMatch(/gamma/i);
    await new NestStorage(root, { agentConfigs: false }).regenerateIndex();
    expect(fromDb).toEqual(await snapshot(root, folders));
  });

  it("a row from before manifest_json flags the nest for a rebuild that fills it in", async () => {
    await getDb().run("UPDATE node_index SET manifest_json = NULL WHERE nest_id = ?", [nestId]);
    await create("Delta", "nodes/one", "after the upgrade");
    const stamp = (await getDb().get("SELECT index_synced_at FROM nests WHERE id = ?", [nestId])) as {
      index_synced_at: string | null;
    };
    expect(stamp.index_synced_at).toBeNull();

    await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, apiKey);
    const empty = (await getDb().all(
      "SELECT node_id FROM node_index WHERE nest_id = ? AND manifest_json IS NULL",
      [nestId],
    )) as unknown[];
    expect(empty).toHaveLength(0);
  });
});
