/**
 * Reader-mode columns migrate onto BOTH a fresh and an upgraded SQLite DB.
 *
 * `nests.reader_mode` (INTEGER NOT NULL DEFAULT 0) and `nests.reader_home_node`
 * (nullable TEXT) are additive columns. A database created after they shipped
 * gets them from the CREATE TABLE / ALTER chain; an EXISTING database (one that
 * predates the columns) must get them from the idempotent, PRAGMA-guarded
 * `ALTER TABLE nests ADD COLUMN` — otherwise the first query naming them fails.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migrations";

function nestColumns(db: Database.Database): Map<string, { dflt: unknown; notnull: number }> {
  const rows = db
    .prepare("PRAGMA table_info(nests)")
    .all() as Array<{ name: string; dflt_value: unknown; notnull: number }>;
  return new Map(
    rows.map((r) => [r.name, { dflt: r.dflt_value, notnull: r.notnull }]),
  );
}

describe("reader-mode column migration", () => {
  it("a fresh DB exposes reader_mode + reader_home_node with correct defaults", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const cols = nestColumns(db);

    expect(cols.has("reader_mode")).toBe(true);
    expect(cols.has("reader_home_node")).toBe(true);

    // reader_mode is NOT NULL DEFAULT 0.
    expect(cols.get("reader_mode")!.notnull).toBe(1);
    expect(String(cols.get("reader_mode")!.dflt)).toBe("0");
    // reader_home_node is nullable (no NOT NULL).
    expect(cols.get("reader_home_node")!.notnull).toBe(0);

    db.close();
  });

  it("a fresh DB defaults reader_mode to 0 and reader_home_node to NULL on a real row", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare(
      "INSERT INTO users (id, email, password_hash) VALUES ('u1', 'u1@acme.com', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO nests (id, user_id, name, slug) VALUES ('n1', 'u1', 'N', 'n')",
    ).run();
    const row = db
      .prepare("SELECT reader_mode, reader_home_node FROM nests WHERE id = 'n1'")
      .get() as { reader_mode: number; reader_home_node: string | null };
    expect(row.reader_mode).toBe(0);
    expect(row.reader_home_node).toBe(null);
    db.close();
  });

  it("an UPGRADED DB (pre-reader-mode nests table) gains the columns idempotently", () => {
    const db = new Database(":memory:");
    // Simulate an old deployment: a nests table WITHOUT the reader-mode columns.
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE nests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      "INSERT INTO users (id, email, password_hash) VALUES ('u1', 'u1@acme.com', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO nests (id, user_id, name, slug) VALUES ('old', 'u1', 'Old', 'old')",
    ).run();

    // Before the migration the column does not exist.
    expect(nestColumns(db).has("reader_mode")).toBe(false);

    // Running (and re-running — idempotence) migrations adds the columns.
    runMigrations(db);
    runMigrations(db);

    const cols = nestColumns(db);
    expect(cols.has("reader_mode")).toBe(true);
    expect(cols.has("reader_home_node")).toBe(true);

    // The pre-existing row picks up the defaults.
    const row = db
      .prepare("SELECT reader_mode, reader_home_node FROM nests WHERE id = 'old'")
      .get() as { reader_mode: number; reader_home_node: string | null };
    expect(row.reader_mode).toBe(0);
    expect(row.reader_home_node).toBe(null);

    db.close();
  });
});
