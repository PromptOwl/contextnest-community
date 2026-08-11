/**
 * Postgres adapter conformance test.
 *
 * GATED: runs only when TEST_DATABASE_URL points at a reachable PostgreSQL
 * instance. Without it the whole suite is skipped, so the default `npm test`
 * stays SQLite-only and fast (no Docker/Postgres needed locally).
 *
 * Isolation: each run uses a unique schema (search_path) which is dropped on
 * teardown, so parallel runs / repeated runs don't collide.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

d("PostgresAdapter conformance", () => {
  let pool: any;
  let adapter: any;
  const schema = `cnst_test_${Math.abs(hashStr(URL || ""))}_${process.pid}`;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    const { PostgresAdapter } = await import("../src/db/adapter.postgres.js");
    // Create an isolated schema and pin search_path on every pooled connection.
    const admin = new Pool({ connectionString: URL });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await admin.end();
    pool = new Pool({
      connectionString: URL,
      options: `-c search_path=${schema}`,
    });
    adapter = new PostgresAdapter(pool);
    const { runPostgresMigrations } = await import(
      "../src/db/migrations.postgres.js"
    );
    await runPostgresMigrations(adapter);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adapter.close();
    }
  });

  it("translates ? placeholders and round-trips a row", async () => {
    await adapter.run(
      "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
      ["u1", "a@example.com", "h"],
    );
    const row = await adapter.get<{ email: string }>(
      "SELECT email FROM users WHERE id = ?",
      ["u1"],
    );
    expect(row?.email).toBe("a@example.com");
  });

  it("reports changes from run()", async () => {
    const res = await adapter.run(
      "UPDATE users SET name = ? WHERE id = ?",
      ["Alice", "u1"],
    );
    expect(res.changes).toBe(1);
  });

  it("enforces case-insensitive email uniqueness (lower(email) index)", async () => {
    await expect(
      adapter.run(
        "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
        ["u2", "A@EXAMPLE.COM", "h"],
      ),
    ).rejects.toThrow();
  });

  it("rejects an invalid CHECK enum value", async () => {
    await adapter.run(
      "INSERT INTO nests (id, user_id, name, slug) VALUES (?, ?, ?, ?)",
      ["n1", "u1", "N", "n"],
    );
    await expect(
      adapter.run("UPDATE nests SET visibility = ? WHERE id = ?", [
        "bogus",
        "n1",
      ]),
    ).rejects.toThrow();
  });

  it("rolls back a failed transaction", async () => {
    await expect(
      adapter.transaction(async (tx: any) => {
        await tx.run(
          "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
          ["u3", "c@example.com", "h"],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const row = await adapter.get("SELECT id FROM users WHERE id = ?", ["u3"]);
    expect(row).toBeUndefined();
  });

  it("commits a successful transaction", async () => {
    await adapter.transaction(async (tx: any) => {
      await tx.run(
        "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
        ["u4", "d@example.com", "h"],
      );
    });
    const row = await adapter.get("SELECT id FROM users WHERE id = ?", ["u4"]);
    expect((row as any)?.id).toBe("u4");
  });

  it("seeds historical SQLite migration ids through 012 (bookkeeping parity)", async () => {
    // The Postgres DDL is the consolidated end-state, but schema_migrations must
    // still record every SQLite migration id so future incremental Postgres
    // migrations gate correctly. 012 (case-collision merge) is a no-op on
    // greenfield Postgres — the lower(email) unique index prevents collisions —
    // but its id must be present.
    for (const id of [
      "002_steward_parity",
      "009_lowercase_emails",
      "011_comments",
      "012_merge_case_colliding_users",
      "013_node_deletion_tombstones",
    ]) {
      const row = await adapter.get(
        "SELECT id FROM schema_migrations WHERE id = ?",
        [id],
      );
      expect((row as any)?.id).toBe(id);
    }
  });

  it("node_deletions exists and upserts on (nest_id, node_id)", async () => {
    // Guards CU-wdqcpzv219 blocker: table was SQLite-only. Without it on
    // Postgres, DELETE /nodes and GET /changes throw. Also exercise the
    // ON CONFLICT DO UPDATE upsert (delete → recreate → delete refreshes).
    await adapter.run(
      "INSERT INTO nests (id, user_id, name, slug) VALUES (?, ?, ?, ?)",
      ["n-del", "u1", "N", "n-del"],
    );
    await adapter.run(
      `INSERT INTO node_deletions (nest_id, node_id, deleted_by, deleted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(nest_id, node_id) DO UPDATE
         SET deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at`,
      ["n-del", "doc-1", "a@example.com", "2026-01-01 00:00:00"],
    );
    await adapter.run(
      `INSERT INTO node_deletions (nest_id, node_id, deleted_by, deleted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(nest_id, node_id) DO UPDATE
         SET deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at`,
      ["n-del", "doc-1", "b@example.com", "2026-02-02 00:00:00"],
    );
    const rows = await adapter.all(
      "SELECT deleted_by, deleted_at FROM node_deletions WHERE nest_id = ?",
      ["n-del"],
    );
    expect(rows.length).toBe(1);
    expect((rows[0] as any).deleted_by).toBe("b@example.com");
    expect((rows[0] as any).deleted_at).toBe("2026-02-02 00:00:00");
  });
  it("runs the duplicate-edge check without a typed-parameter error", async () => {
    // Guards the 42P18 regression: the check used `(? IS NULL OR id != ?)` to
    // fold in the optional excludeId, and Postgres can't infer a bare param's
    // type inside IS NULL — so every edge create 500'd on Postgres while
    // passing on SQLite.
    const { assertNoDuplicateEdge } = await import(
      "../src/workflow/edge-routes.js"
    );
    const type = { id: "et-1", name: "flow" } as any;
    await adapter.run(
      "INSERT INTO nests (id, user_id, name, slug) VALUES (?, ?, ?, ?)",
      ["n-edge", "u1", "N", "n-edge"],
    );
    await adapter.run(
      `INSERT INTO edge_types
         (id, nest_id, name, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["et-1", "n-edge", "flow", "", "u1", "t", "t"],
    );

    // No excludeId, no existing row: this is the create path that threw 42P18.
    await expect(
      assertNoDuplicateEdge(adapter, "n-edge", "a", "b", type),
    ).resolves.toBeUndefined();

    await adapter.run(
      `INSERT INTO edges
         (id, nest_id, from_node, to_node, type_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["e-1", "n-edge", "a", "b", "et-1", "u1", "t", "t"],
    );
    await expect(
      assertNoDuplicateEdge(adapter, "n-edge", "a", "b", type),
    ).rejects.toThrow(/already exists/);
    // Retype path: the row being changed must not count as its own duplicate.
    await expect(
      assertNoDuplicateEdge(adapter, "n-edge", "a", "b", type, "e-1"),
    ).resolves.toBeUndefined();
  });
});

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
