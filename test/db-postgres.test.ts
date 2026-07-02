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
    ]) {
      const row = await adapter.get(
        "SELECT id FROM schema_migrations WHERE id = ?",
        [id],
      );
      expect((row as any)?.id).toBe(id);
    }
  });
});

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
