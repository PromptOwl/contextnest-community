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

  it("evaluates suffixOf the same way SQLite does", async () => {
    // The helper exists for cross-backend parity, and its SQLite half is
    // proven in db-adapter.test.ts. This is the other half: `right()` must
    // agree with `substr(x, -n)`, including being case-SENSITIVE (Postgres's
    // LIKE already is, SQLite's is not — which is the bug that motivated it)
    // and returning the whole string when it is shorter than the suffix.
    const { suffixOf } = await import("../src/db/sql.js");
    // `?::text`, not a bare `?`: in production the argument is a column with a
    // known type, but a bound parameter standing in for one leaves Postgres
    // unable to infer it ("could not determine data type of parameter $1").
    const expr = suffixOf(adapter, "?::text", 13);
    const check = async (id: string) =>
      (
        await adapter.get<{ m: boolean }>(
          `SELECT (${expr} = ?) AS m`,
          [id, "--annotations"],
        )
      )?.m;
    expect(await check("x--annotations")).toBe(true);
    expect(await check("x--Annotations")).toBe(false);
    expect(await check("short")).toBe(false);
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

  it("creates the docs-site tables (068/069) and allows one nest per verified domain", async () => {
    // Running the migrations again must be a no-op (CREATE / ADD COLUMN IF NOT EXISTS).
    const { runPostgresMigrations } = await import("../src/db/migrations.postgres.js");
    await runPostgresMigrations(adapter);
    const cols = await adapter.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'nest_sites'",
    );
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(["site_key", "domain", "domain_verified_at", "settings", "public_url_host"]),
    );
    await adapter.run("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)", ["site-u", "site@example.com", "h"]);
    for (const id of ["site-a", "site-b"]) {
      await adapter.run("INSERT INTO nests (id, user_id, name, slug) VALUES (?, ?, ?, ?)", [id, "site-u", id, id]);
      await adapter.run(
        "INSERT INTO nest_sites (nest_id, domain, domain_token, indexnow_key) VALUES (?, ?, ?, ?)",
        [id, "docs.example.com", `t-${id}`, `k-${id}`],
      );
    }
    // Both may claim the domain; the partial unique index lets only one verify it.
    await adapter.run("UPDATE nest_sites SET domain_verified_at = ? WHERE nest_id = ?", ["2026-01-01", "site-a"]);
    await expect(
      adapter.run("UPDATE nest_sites SET domain_verified_at = ? WHERE nest_id = ?", ["2026-01-01", "site-b"]),
    ).rejects.toThrow(/unique|duplicate/i);
    await adapter.run("UPDATE nest_sites SET public_url_host = ? WHERE nest_id = ?", ["example.com", "site-a"]);
    expect((await adapter.get<{ h: string }>("SELECT public_url_host AS h FROM nest_sites WHERE nest_id = ?", ["site-a"]))?.h).toBe("example.com");
  });

  it("adds the org-contribution columns (074) with fail-closed defaults, idempotently", async () => {
    const { runPostgresMigrations } = await import("../src/db/migrations.postgres.js");
    await runPostgresMigrations(adapter);
    await adapter.run("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)", ["oc-u", "oc@acme.com", "h"]);
    await adapter.run("INSERT INTO nests (id, user_id, name, slug) VALUES (?, ?, ?, ?)", ["oc-n", "oc-u", "oc", "oc"]);
    const row = await adapter.get<{ c: string; d: string | null; v: string | null }>(
      `SELECT n.org_contributions AS c, n.org_domains AS d, u.email_verified_at AS v
         FROM nests n LEFT JOIN users u ON u.id = ? WHERE n.id = ?`,
      ["oc-u", "oc-n"],
    );
    expect(row).toEqual({ c: "off", d: null, v: null });
    const { HISTORICAL_MIGRATIONS } = await import("../src/db/migrations.postgres.js");
    expect(HISTORICAL_MIGRATIONS).toContain("074_org_contributions");
    // The contributor's own-drafts query (governance/org-contribution.ts).
    await adapter.run(
      "INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status) VALUES (?, ?, ?, ?, ?, ?)",
      ["oc-n", "nodes/idea", 1, "h", "oc@acme.com", "pending_review"],
    );
    const mine = await adapter.all<{ node_id: string; review_id: string | null }>(
      `SELECT v.node_id, v.version, v.status, v.created_at,
              (SELECT r.id FROM review_requests r
                WHERE r.nest_id = v.nest_id AND r.node_id = v.node_id
                  AND r.status = 'pending' LIMIT 1) AS review_id
         FROM node_versions v
        WHERE v.nest_id = ? AND v.author = ?
          AND v.status IN ('draft', 'pending_review', 'rejected')
          AND v.version = (SELECT MAX(v2.version) FROM node_versions v2
                            WHERE v2.nest_id = v.nest_id AND v2.node_id = v.node_id)
        ORDER BY v.created_at DESC
        LIMIT 200`,
      ["oc-n", "oc@acme.com"],
    );
    expect(mine.map((m) => m.node_id)).toEqual(["nodes/idea"]);
  });

  it("adds the run claim columns to a runs table that predates them", async () => {
    // Prod's runs table was created before claimed_by existed; boot crashed
    // building the metacognition index on it (42703).
    await adapter.exec("ALTER TABLE runs DROP COLUMN claimed_by, DROP COLUMN claimed_at");
    const { runPostgresMigrations } = await import("../src/db/migrations.postgres.js");
    await runPostgresMigrations(adapter);
    const cols = await adapter.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'runs'",
    );
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(["claimed_by", "claimed_at"]),
    );
  });

  it("adds nests.always_include_tags (073) defaulting to always-include, also to a nests table that predates it", async () => {
    await adapter.exec("ALTER TABLE nests DROP COLUMN always_include_tags");
    const { runPostgresMigrations } = await import("../src/db/migrations.postgres.js");
    await runPostgresMigrations(adapter);
    const col = await adapter.get<{ column_default: string; is_nullable: string }>(
      "SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'nests' AND column_name = 'always_include_tags'",
    );
    expect(col?.is_nullable).toBe("NO");
    expect(col?.column_default).toContain("always-include");
    // The resolver's approved-tags join (always-include-service.ts) runs here.
    const rows = await adapter.all(
      `SELECT a.node_id, v.tags_json
         FROM approved_versions a
         JOIN node_versions v
           ON v.nest_id = a.nest_id AND v.node_id = a.node_id AND v.version = a.approved_version
        WHERE a.nest_id = ?`,
      ["no-such-nest"],
    );
    expect(rows).toEqual([]);
  });

  it("runs the doc stream's JSON id-list scope and facet SQL (CU-wdqcq02crv)", async () => {
    const { jsonTextValues } = await import("../src/db/sql.js");
    await adapter.run("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)", ["u-ds", "ds@example.com", "h"]);
    await adapter.run("INSERT INTO nests (id, user_id, name, slug) VALUES (?, ?, ?, ?)", ["n-ds", "u-ds", "DS", "ds"]);
    for (const [node, v, author] of [["nodes/a", 1, "Ds@Example.com"], ["nodes/a", 2, "ds@example.com"], ["nodes/b", 1, "ds@example.com"]] as const) {
      await adapter.run(
        `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status, created_at)
         VALUES (?, ?, ?, 'h', ?, 'published', ?)`,
        ["n-ds", node, v, author, `2026-10-0${v} 00:00:00`],
      );
    }
    const rows = await adapter.all<{ node_id: string }>(
      `SELECT v.node_id FROM node_versions v
        WHERE v.nest_id = ? AND v.node_id IN (${jsonTextValues(adapter)}) AND v.created_at >= ?
        ORDER BY v.created_at DESC, v.id DESC LIMIT ? OFFSET ?`,
      ["n-ds", JSON.stringify(["nodes/a"]), "2026-10-01 00:00:00", 10, 0],
    );
    expect(rows.map((r: { node_id: string }) => r.node_id)).toEqual(["nodes/a", "nodes/a"]);
    const authors = await adapter.all<{ value: string; n: number | string }>(
      `SELECT LOWER(v.author) AS value, COUNT(*) AS n FROM node_versions v
        WHERE v.nest_id = ? GROUP BY LOWER(v.author)`,
      ["n-ds"],
    );
    expect(authors.map((a: { value: string; n: number | string }) => [a.value, Number(a.n)])).toEqual([["ds@example.com", 3]]);
  });
});

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
