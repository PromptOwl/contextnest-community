/**
 * Migration 012 — mergeCaseCollidingUsers. Verifies that two user rows whose
 * emails differ only in case are merged into one, with every reference
 * repointed to the surviving (winner) row. This is the "rotate the password
 * and they still can't log in" fix: pre-existing collisions that migration 009
 * deliberately left for manual reconciliation.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, mergeCaseCollidingUsers } from "../src/db/migrations";

/** Fresh in-memory DB with the full schema, minus the NOCASE unique index so
 *  we can seed the pre-migration collision state. */
function seededDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.exec("DROP INDEX IF EXISTS idx_users_email_nocase");
  return db;
}

const insUser = (
  db: Database.Database,
  id: string,
  email: string,
  isInvited: number,
  name: string | null = null,
) =>
  db
    .prepare(
      "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?,?,?,?,?)",
    )
    .run(id, email, name, `hash-${id}`, isInvited);

describe("mergeCaseCollidingUsers", () => {
  it("merges a case-colliding pair, keeps the claimed account, repoints refs", () => {
    const db = seededDb();
    // Winner = claimed (is_invited=0); loser = invited placeholder, mixed case.
    insUser(db, "winner", "bob@x.com", 0, "Bob");
    insUser(db, "loser", "Bob@x.com", 1);

    // Loser owns a nest, holds an api key + session, and authored a comment.
    db.prepare(
      "INSERT INTO nests (id, user_id, name, slug) VALUES (?,?,?,?)",
    ).run("nest1", "loser", "Loser Nest", "loser-nest");
    db.prepare(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label) VALUES (?,?,?,?,?)",
    ).run("key1", "loser", "kh1", "cnst_a", "l");
    db.prepare(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)",
    ).run("sess1", "loser", "2999-01-01");
    db.prepare(
      "INSERT INTO comments (id, nest_id, node_id, author, body) VALUES (?,?,?,?,?)",
    ).run("c1", "nest1", "nodes/x", "Bob@x.com", "hi");

    const res = mergeCaseCollidingUsers(db);
    expect(res.merged).toBe(1);

    // Only the winner survives, email canonicalized to lowercase.
    const users = db
      .prepare("SELECT id, email FROM users WHERE LOWER(email) = 'bob@x.com'")
      .all();
    expect(users).toEqual([{ id: "winner", email: "bob@x.com" }]);

    // id-keyed refs repointed to the winner.
    expect(
      db.prepare("SELECT user_id FROM nests WHERE id = 'nest1'").get(),
    ).toEqual({ user_id: "winner" });
    expect(
      db.prepare("SELECT user_id FROM api_keys WHERE id = 'key1'").get(),
    ).toEqual({ user_id: "winner" });
    expect(
      db.prepare("SELECT user_id FROM sessions WHERE id = 'sess1'").get(),
    ).toEqual({ user_id: "winner" });
    // email-keyed attribution rewritten to the canonical winner email.
    expect(
      db.prepare("SELECT author FROM comments WHERE id = 'c1'").get(),
    ).toEqual({ author: "bob@x.com" });

    // The NOCASE unique index can now be built (the whole point).
    expect(() =>
      db.exec(
        "CREATE UNIQUE INDEX idx_users_email_nocase ON users(email COLLATE NOCASE)",
      ),
    ).not.toThrow();
  });

  it("picks the claimed account as winner regardless of row order", () => {
    const db = seededDb();
    // Insert the placeholder FIRST, claimed second — winner must still be the
    // claimed one, not the earliest/lowest row.
    insUser(db, "placeholder", "amy@x.com", 1);
    insUser(db, "claimed", "AMY@x.com", 0, "Amy");

    mergeCaseCollidingUsers(db);
    const rows = db
      .prepare("SELECT id FROM users WHERE LOWER(email) = 'amy@x.com'")
      .all();
    expect(rows).toEqual([{ id: "claimed" }]);
  });

  it("keeps the winner's API key when both rows have one (UNIQUE(user_id))", () => {
    const db = seededDb();
    insUser(db, "w", "cara@x.com", 0);
    insUser(db, "l", "Cara@x.com", 1);
    db.prepare(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label) VALUES (?,?,?,?,?)",
    ).run("kw", "w", "khw", "cnst_w", "w");
    db.prepare(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label) VALUES (?,?,?,?,?)",
    ).run("kl", "l", "khl", "cnst_l", "l");

    expect(() => mergeCaseCollidingUsers(db)).not.toThrow();
    const keys = db
      .prepare("SELECT id, user_id FROM api_keys ORDER BY id")
      .all();
    expect(keys).toEqual([{ id: "kw", user_id: "w" }]); // winner's kept, loser's dropped
  });

  it("is a no-op when there are no collisions", () => {
    const db = seededDb();
    insUser(db, "solo", "solo@x.com", 0);
    const res = mergeCaseCollidingUsers(db);
    expect(res).toEqual({ groups: 0, merged: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM users").get(),
    ).toEqual({ c: 1 });
  });
});
