/**
 * Nothing keyed to a node id may outlive (or lag behind) its document.
 *
 * Delete and move share one list of node-keyed tables, so both cover the same
 * reference set. Before that, move rewrote rows delete never purged — a
 * recreated id inherited the dead document's comments, watchers, readers and
 * version rows, and the stale version rows made the recreate fail outright on
 * node_versions' unique constraint (CU-wdqcpzxcg8).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, testDbDriver } from "./helpers.js";
import * as staticDb from "../src/db/client.js";
// The app's (post-resetModules) db client — on Postgres the static import is
// a different, never-initialised instance. Bound in beforeAll.
let getDb: typeof staticDb.getDb = staticDb.getDb;
import { NODE_KEYED_TABLES } from "../src/nodes/service.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

/** Node-keyed rows seeded around a document, one per table under test. */
async function seedRows(nodeId: string) {
  const db = getDb();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO comments (id, nest_id, node_id, author, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    [`c-${nodeId}`, nestId, nodeId, alice.email, "review note", now],
  );
  await db.run(
    `INSERT INTO watchers (id, nest_id, node_id, user_email, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [`w-${nodeId}`, nestId, nodeId, alice.email, alice.email, now],
  );
  await db.run(
    `INSERT INTO schedules (id, nest_id, agent_node, every_minutes, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 5, 1, ?, ?, ?)`,
    [`s-${nodeId}`, nestId, nodeId, alice.email, now, now],
  );
  await db.run(
    `INSERT INTO grants (id, nest_id, target_type, target, user_id, role, granted_by, created_at, updated_at)
     VALUES (?, ?, 'document', ?, ?, 'read', ?, ?, ?)`,
    [`g-${nodeId}`, nestId, nodeId, alice.userId, alice.email, now, now],
  );
}

/** How many rows each table still holds for `nodeId`. */
async function rowCounts(nodeId: string): Promise<Record<string, number>> {
  const db = getDb();
  const counts: Record<string, number> = {};
  for (const [table, column] of [
    ["node_versions", "node_id"],
    ["comments", "node_id"],
    ["watchers", "node_id"],
    ["schedules", "agent_node"],
  ] as const) {
    const row = (await db.get(
      `SELECT COUNT(*) AS n FROM ${table} WHERE nest_id = ? AND ${column} = ?`,
      [nestId, nodeId],
    )) as { n: number };
    counts[table] = Number(row.n);
  }
  const grant = (await db.get(
    "SELECT COUNT(*) AS n FROM grants WHERE nest_id = ? AND target_type = 'document' AND target = ?",
    [nestId, nodeId],
  )) as { n: number };
  counts.grants = Number(grant.n);
  return counts;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  getDb = (await import("../src/db/client.js")).getDb;
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Cleanup" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

describe("node row cleanup", () => {
  it("covers every column in the schema that holds a node id", async () => {
    // The drift guard. A new table keyed to a node id must join
    // NODE_KEYED_TABLES (delete purges it, move repoints it) or be listed
    // here with the reason it's exempt — otherwise its rows outlive the
    // document and the next node to take that id inherits them.
    const EXEMPT = new Map<string, string>([
      // Historical record of what ran, not of what exists. Move retargets
      // these inline; delete keeps them.
      ["runs.agent_node", "run trace"],
      ["run_steps.node_id", "run trace"],
      // What was sent about a document stays sent: the message log is a
      // record of the past, pruned by its own retention window.
      ["outbound_messages.node_id", "message log"],
      // The one row that must survive a delete — it IS the delete record.
      ["node_deletions.node_id", "deletion tombstone"],
      // Predicated: only rows whose scope/target_type names a document.
      // Handled beside the loop in both helpers.
      ["stewards.node_pattern", "document-scoped only"],
      ["grants.target", "document grants only; folder grants cover a prefix"],
      ["access_requests.target_id", "node-targeted requests only; folder/nest targets aren't node ids"],
      // Public docs-site URLs: move repoints them; delete keeps each path as a
      // detached 410 marker (node_id ''). Handled beside the loop.
      ["site_paths.node_id", "kept as a 410 marker on delete"],
      // Seal queue: a row lives only until its batch is sealed, and sealing an
      // id that was deleted or moved just refreshes its old folder's index.
      ["nest_write_jobs.node_id", "transient; sealed and dropped right after the write"],
      // Surfaces (S2a): the proposal record of what a listener proposed and
      // how it was decided (its review row is the live link), and the 7-day
      // hold fingerprint, which expires on its own.
      ["surface_proposal_items.node_id", "Surfaces proposal audit record"],
      ["surface_fingerprints.node_id", "7-day hold; expires on its own"],
      ["surface_commits.node_id", "Surfaces commit audit; survives the node (life of the nest)"],
    ]);
    const NODE_ID_COLUMNS = new Set([
      "node_id",
      "node_pattern",
      "agent_node",
      "from_node",
      "to_node",
      "target",
      "target_id",
    ]);

    const db = getDb();
    const covered = new Set(NODE_KEYED_TABLES.map(([t, c]) => `${t}.${c}`));
    const pg = testDbDriver() === "postgres";
    const tables = (await db.all(
      pg
        ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'"
        : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )) as Array<{ name: string }>;

    const uncovered: string[] = [];
    for (const { name } of tables) {
      const columns = (pg
        ? await db.all("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", [name])
        : await db.all(`PRAGMA table_info(${name})`)) as Array<{ name: string }>;
      for (const col of columns) {
        if (!NODE_ID_COLUMNS.has(col.name)) continue;
        const key = `${name}.${col.name}`;
        if (!covered.has(key) && !EXEMPT.has(key)) uncovered.push(key);
      }
    }

    expect(uncovered).toEqual([]);
  });

  it("carries every node-keyed row along on move", async () => {
    const create = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Moving Doc", content: "# Move" },
      alice.apiKey,
    );
    expect(create.status).toBe(201);
    await seedRows("nodes/moving-doc");

    const move = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/moving-doc/move`,
      { folder: "archive" },
      alice.apiKey,
    );
    expect(move.status).toBe(200);
    expect(move.data.node.id).toBe("nodes/archive/moving-doc");

    expect(await rowCounts("nodes/moving-doc")).toEqual({
      node_versions: 0,
      comments: 0,
      watchers: 0,
      schedules: 0,
      grants: 0,
    });
    const moved = await rowCounts("nodes/archive/moving-doc");
    expect(moved.comments).toBe(1);
    expect(moved.watchers).toBe(1);
    expect(moved.schedules).toBe(1);
    expect(moved.grants).toBe(1);
    expect(moved.node_versions).toBeGreaterThan(0);
  });

  it("moves onto an id whose document is gone but whose rows are not", async () => {
    const create = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Landing Doc", content: "# Land" },
      alice.apiKey,
    );
    expect(create.status).toBe(201);
    // Orphan rows at the destination, as a file removed outside the app leaves.
    await getDb().run(
      `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status)
       VALUES (?, ?, 1, 'stale', ?, 'published')`,
      [nestId, "nodes/archive/landing-doc", alice.email],
    );
    await seedRows("nodes/archive/landing-doc");

    const move = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/landing-doc/move`,
      { folder: "archive" },
      alice.apiKey,
    );
    expect(move.status).toBe(200);
    const landed = await rowCounts("nodes/archive/landing-doc");
    expect(landed.comments).toBe(0);
    expect(landed.watchers).toBe(0);
    const hashes = (await getDb().all(
      "SELECT content_hash FROM node_versions WHERE nest_id = ? AND node_id = ?",
      [nestId, "nodes/archive/landing-doc"],
    )) as Array<{ content_hash: string }>;
    expect(hashes.map((r) => r.content_hash)).not.toContain("stale");
  });

  it("leaves nothing behind on delete, so a recreated id inherits nothing", async () => {
    const create = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Doomed Doc", content: "# Doomed" },
      alice.apiKey,
    );
    expect(create.status).toBe(201);
    await seedRows("nodes/doomed-doc");

    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/nodes/doomed-doc`,
      undefined,
      alice.apiKey,
    );
    expect(del.status).toBe(200);

    expect(await rowCounts("nodes/doomed-doc")).toEqual({
      node_versions: 0,
      comments: 0,
      watchers: 0,
      schedules: 0,
      grants: 0,
    });

    // Same title again → same id. It must come back clean, not crash on the
    // old version rows and not inherit the old readers or comments.
    const again = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Doomed Doc", content: "# Reborn" },
      alice.apiKey,
    );
    expect(again.status).toBe(201);
    const reborn = await rowCounts("nodes/doomed-doc");
    expect(reborn.comments).toBe(0);
    expect(reborn.watchers).toBe(0);
    expect(reborn.grants).toBe(0);
    expect(reborn.schedules).toBe(0);
  });
});
