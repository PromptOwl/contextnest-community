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

  // ─── stewards (governance) — the trickiest table in the merge ───

  const insNest = (db: Database.Database, id: string, owner: string) =>
    db
      .prepare("INSERT INTO nests (id, user_id, name, slug) VALUES (?,?,?,?)")
      .run(id, owner, id, id);

  const insSteward = (
    db: Database.Database,
    id: string,
    nestId: string,
    email: string,
    userId: string,
    isActive = 1,
    scope = "nest",
  ) =>
    db
      .prepare(
        `INSERT INTO stewards
           (id, nest_id, scope, user_email, user_id, assigned_by, is_active)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, nestId, scope, email, userId, "admin@x.com", isActive);

  it("keeps the winner's solitary (non-duplicate) steward grant", () => {
    // Regression guard: the old self-satisfying EXISTS deleted EVERY active
    // steward row for the email, wiping a grant that had no duplicate at all.
    const db = seededDb();
    insUser(db, "winner", "bob@x.com", 0);
    insUser(db, "loser", "Bob@x.com", 1);
    insNest(db, "nestA", "winner");
    insSteward(db, "s1", "nestA", "bob@x.com", "winner"); // only grant, no dup

    mergeCaseCollidingUsers(db);

    const active = db
      .prepare(
        "SELECT id, user_id, user_email FROM stewards WHERE is_active = 1",
      )
      .all();
    expect(active).toEqual([
      { id: "s1", user_id: "winner", user_email: "bob@x.com" },
    ]);
  });

  it("dedups colliding steward rows on the same (nest, scope, target) to one", () => {
    const db = seededDb();
    insUser(db, "winner", "bob@x.com", 0);
    insUser(db, "loser", "Bob@x.com", 1);
    insNest(db, "nestB", "winner");
    // Both sides hold a nest-scope grant on the SAME nest — a genuine collision.
    insSteward(db, "s_w", "nestB", "bob@x.com", "winner");
    insSteward(db, "s_l", "nestB", "Bob@x.com", "loser");
    // Winner also has a grant on a DIFFERENT nest — must survive untouched.
    insNest(db, "nestC", "winner");
    insSteward(db, "s_c", "nestC", "bob@x.com", "winner");

    mergeCaseCollidingUsers(db);

    const active = db
      .prepare(
        "SELECT nest_id, user_id, user_email FROM stewards WHERE is_active = 1 ORDER BY nest_id",
      )
      .all();
    // Exactly one active grant per nest, all repointed to winner + canonical email.
    expect(active).toEqual([
      { nest_id: "nestB", user_id: "winner", user_email: "bob@x.com" },
      { nest_id: "nestC", user_id: "winner", user_email: "bob@x.com" },
    ]);
    // No active grant collides with the partial unique index (build proves it).
    expect(() =>
      db.exec(
        "CREATE UNIQUE INDEX tmp_uniq ON stewards(nest_id, user_email) WHERE scope='nest' AND is_active=1",
      ),
    ).not.toThrow();
  });

  it("merges a 3-way collision group (N losers), repointing steward grants", () => {
    const db = seededDb();
    insUser(db, "u_claimed", "dan@x.com", 0);
    insUser(db, "u_mid", "Dan@x.com", 1);
    insUser(db, "u_upper", "DAN@X.COM", 1);
    insNest(db, "n1", "u_claimed");
    insNest(db, "n2", "u_mid");
    insSteward(db, "sa", "n1", "dan@x.com", "u_claimed");
    insSteward(db, "sb", "n2", "Dan@x.com", "u_mid");

    const res = mergeCaseCollidingUsers(db);
    expect(res).toEqual({ groups: 1, merged: 2 });

    // One surviving user, everything owned/attributed to it.
    const users = db
      .prepare("SELECT id, email FROM users WHERE LOWER(email)='dan@x.com'")
      .all();
    expect(users).toEqual([{ id: "u_claimed", email: "dan@x.com" }]);
    const nestOwners = db
      .prepare("SELECT DISTINCT user_id FROM nests ORDER BY user_id")
      .all();
    expect(nestOwners).toEqual([{ user_id: "u_claimed" }]);
    const stewards = db
      .prepare(
        "SELECT DISTINCT user_id, user_email FROM stewards WHERE is_active=1",
      )
      .all();
    expect(stewards).toEqual([
      { user_id: "u_claimed", user_email: "dan@x.com" },
    ]);
  });

  it("dedups nest_collaborators and drops self-collaboration on owned nests", () => {
    const db = seededDb();
    insUser(db, "winner", "eve@x.com", 0);
    insUser(db, "loser", "Eve@x.com", 1);
    insUser(db, "owner3", "owner3@x.com", 0);
    // A nest owned by a third party where BOTH winner and loser collaborate.
    insNest(db, "shared", "owner3");
    const insCollab = (id: string, nestId: string, uid: string) =>
      db
        .prepare(
          `INSERT INTO nest_collaborators
             (id, nest_id, user_id, permission, granted_by)
           VALUES (?,?,?,?,?)`,
        )
        .run(id, nestId, uid, "write", "owner3");
    insCollab("cw", "shared", "winner");
    insCollab("cl", "shared", "loser");
    // Winner OWNS a nest that the loser collaborates on → self-collab, must drop.
    insNest(db, "wnest", "winner");
    insCollab("cself", "wnest", "loser");

    mergeCaseCollidingUsers(db);

    const collab = db
      .prepare(
        "SELECT nest_id, user_id FROM nest_collaborators ORDER BY nest_id",
      )
      .all();
    // Only one row on the shared nest (deduped), none on the winner-owned nest.
    expect(collab).toEqual([{ nest_id: "shared", user_id: "winner" }]);
  });
});
