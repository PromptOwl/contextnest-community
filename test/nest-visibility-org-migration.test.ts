/**
 * Migration 038 — widening the nests.visibility CHECK.
 *
 * Tested against a raw SQLite database rather than the app: SQLite cannot
 * alter a CHECK constraint in place, so widening `visibility` means rebuilding
 * `nests` — the most-referenced table in the schema (27 foreign keys, every one
 * ON DELETE CASCADE). With `foreign_keys = ON` (db/client.ts) a naive
 * `DROP TABLE nests` cascades every node, version, steward and run row out of
 * the database. That is the failure this file exists to catch, and it is why
 * the child-row assertions matter more than the constraint ones.
 *
 * Behaviour of the resulting 'org' tier lives in nest-visibility-org.test.ts,
 * which needs the whole app booted; this one needs nothing but the schema.
 */
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { widenNestVisibilityCheck } from "../src/db/migrations.js";

/** A pre-migration database: the old two-value CHECK, one child table with the
 *  same ON DELETE CASCADE every real child of `nests` carries, and a column
 *  added by a later ALTER (marketplace adds three of these) so the rebuild is
 *  proven to derive its column list from the live schema, not a stale literal. */
function oldSchemaDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE nests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
        CHECK(visibility IN ('private', 'public')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, slug)
    );
    CREATE INDEX idx_nests_user ON nests(user_id);
    CREATE TABLE node_index (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL
    );
  `);
  db.exec("ALTER TABLE nests ADD COLUMN is_pack INTEGER NOT NULL DEFAULT 0");
  db.prepare("INSERT INTO users (id) VALUES ('u1')").run();
  db.prepare(
    "INSERT INTO nests (id, user_id, name, slug, visibility, is_pack) VALUES (?,?,?,?,?,?)",
  ).run("n1", "u1", "Kept", "kept", "public", 1);
  db.prepare(
    "INSERT INTO nests (id, user_id, name, slug, visibility) VALUES (?,?,?,?,?)",
  ).run("n2", "u1", "Private", "private", "private");
  db.prepare("INSERT INTO node_index (nest_id, node_id) VALUES ('n1','nodes/a')").run();
  db.prepare("INSERT INTO node_index (nest_id, node_id) VALUES ('n2','nodes/b')").run();
  return db;
}

/** Run the rebuild the way the migration must: the foreign_keys pragma is a
 *  no-op inside a transaction, so it has to be toggled outside one. */
function runWiden(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => widenNestVisibilityCheck(db))();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

describe("migration 038 — widening the nests.visibility CHECK", () => {
  it("does not cascade-delete child rows when the table is rebuilt", () => {
    const db = oldSchemaDb();
    runWiden(db);
    const kids = db.prepare("SELECT nest_id, node_id FROM node_index ORDER BY node_id").all();
    expect(kids).toEqual([
      { nest_id: "n1", node_id: "nodes/a" },
      { nest_id: "n2", node_id: "nodes/b" },
    ]);
    db.close();
  });

  it("leaves no dangling foreign keys", () => {
    const db = oldSchemaDb();
    runWiden(db);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("preserves every row and every column, including ALTER-added ones", () => {
    const db = oldSchemaDb();
    runWiden(db);
    const rows = db
      .prepare("SELECT id, name, slug, visibility, is_pack FROM nests ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "n1", name: "Kept", slug: "kept", visibility: "public", is_pack: 1 },
      { id: "n2", name: "Private", slug: "private", visibility: "private", is_pack: 0 },
    ]);
    db.close();
  });

  it("accepts 'org' afterwards and still rejects an unknown value", () => {
    const db = oldSchemaDb();
    runWiden(db);
    db.prepare(
      "INSERT INTO nests (id, user_id, name, slug, visibility) VALUES ('n3','u1','Org','org','org')",
    ).run();
    expect(
      db.prepare("SELECT visibility FROM nests WHERE id='n3'").get(),
    ).toEqual({ visibility: "org" });
    expect(() =>
      db
        .prepare(
          "INSERT INTO nests (id, user_id, name, slug, visibility) VALUES ('n4','u1','Bad','bad','world')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("keeps the user index so listings do not silently table-scan", () => {
    const db = oldSchemaDb();
    runWiden(db);
    const idx = db.pragma("index_list(nests)") as Array<{ name: string }>;
    expect(idx.some((i) => i.name === "idx_nests_user")).toBe(true);
    db.close();
  });

  it("is idempotent — a second run is a no-op", () => {
    const db = oldSchemaDb();
    runWiden(db);
    runWiden(db);
    expect(db.prepare("SELECT COUNT(*) AS c FROM node_index").get()).toEqual({ c: 2 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM nests").get()).toEqual({ c: 2 });
    db.close();
  });
});
