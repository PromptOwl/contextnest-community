/**
 * po-1186 CR1 review: migration 086's surface_windows.run_id backfill runs
 * once (under the 086 id, on Postgres as on SQLite) and only links a run that
 * started within minutes of the window's verdict.
 *
 * The Postgres case runs when TEST_DATABASE_URL is set.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const T0 = "2026-11-01T00:00:00.000Z";

// ─── 1. The run_id backfill: once, and bounded ─────────────────────────────

/** A database at the previous release: 086's columns and indexes dropped. */
function sqliteBefore086(mem: any) {
  for (const i of ["idx_runs_idempotency", "idx_run_steps_client_key", "idx_runs_source", "idx_surface_windows_run", "idx_surface_windows_judged"]) mem.exec(`DROP INDEX IF EXISTS ${i}`);
  for (const [t, c] of [["runs", "idempotency_key"], ["runs", "source"], ["runs", "external_ref"], ["runs", "verdict"], ["runs", "reason_code"], ["run_steps", "client_key"], ["surface_windows", "run_id"]]) mem.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
  mem.prepare("DELETE FROM schema_migrations WHERE id = '086_control_room_ledger'").run();
}

const FIXTURE = [
  "INSERT INTO users (id, email, password_hash) VALUES ('u1', 'm@x.test', 'x')",
  "INSERT INTO nests (id, user_id, name, slug) VALUES ('n1', 'u1', 'N', 'n')",
  "INSERT INTO surface_installs (id, org_id, surface, mode, tenant_key) VALUES ('i1', 'o', 'slack', 'manifest', 'T')",
  "INSERT INTO surface_bindings (id, install_id, org_id, nest_id, conversation_id, conversation_kind, listener_agent_node_id) VALUES ('b1', 'i1', 'o', 'n1', 'C1', 'private_channel', 'nodes/l')",
  // w_old: judged, and legitimately run-less (no listener run near it).
  `INSERT INTO surface_windows (id, binding_id, nest_id, thread_key, opened_at, last_message_at, status, verdict, model, judged_at) VALUES ('w_old', 'b1', 'n1', 'channel', 'x', 'x', 'judged', 'no_op', 'm', '${T0}')`,
];
/** A listener run a day after w_old was judged: unrelated to it. */
const LATER_RUN = `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, started_at, claimed_by) VALUES ('run_later', 'n1', 'nodes/l', 'surfaces:window', 'succeeded', '${iso(Date.parse(T0) + DAY)}', 'server:surfaces')`;
/** A listener run 3 s after a window was judged: its own run. */
const NEAR_RUN = `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, started_at, claimed_by) VALUES ('run_near', 'n1', 'nodes/l', 'surfaces:window', 'succeeded', '${iso(Date.parse(T0) + 2 * DAY + 3000)}', 'server:surfaces')`;
const NEAR_WINDOW = `INSERT INTO surface_windows (id, binding_id, nest_id, thread_key, opened_at, last_message_at, status, verdict, model, judged_at) VALUES ('w_near', 'b1', 'n1', 'channel', 'x', 'x', 'judged', 'no_op', 'm', '${iso(Date.parse(T0) + 2 * DAY)}')`;

describe("086 backfill of surface_windows.run_id", () => {
  it("SQLite: a listener run long after a run-less window is not attached to it; a run just after its window is", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { runMigrations } = await import("../src/db/migrations.js");
    const mem = new Database(":memory:");
    runMigrations(mem);
    sqliteBefore086(mem);
    for (const s of FIXTURE) mem.prepare(s).run();
    mem.prepare(LATER_RUN).run();
    mem.prepare(NEAR_WINDOW).run();
    mem.prepare(NEAR_RUN).run();
    runMigrations(mem);
    expect(mem.prepare("SELECT run_id FROM surface_windows WHERE id = 'w_old'").get()).toEqual({ run_id: null });
    expect(mem.prepare("SELECT run_id FROM surface_windows WHERE id = 'w_near'").get()).toEqual({ run_id: "run_near" });
    mem.close();
  });

  const PG = process.env.TEST_DATABASE_URL;
  (PG ? it : it.skip)("Postgres: the backfill runs once (guarded by 086) and bounded — a later boot never attaches a newer run to an old run-less window", async () => {
    const { Pool } = await import("pg");
    const { PostgresAdapter } = await import("../src/db/adapter.postgres.js");
    const { runPostgresMigrations } = await import("../src/db/migrations.postgres.js");
    const schema = `cr1_backfill_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new Pool({ connectionString: PG });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    const pool = new Pool({ connectionString: PG, options: `-c search_path=${schema}` });
    const db = new PostgresAdapter(pool);
    try {
      await runPostgresMigrations(db);
      for (const s of FIXTURE) await db.run(s);
      // A later boot, after newer listener runs exist.
      await db.run(LATER_RUN);
      await runPostgresMigrations(db);
      expect(await db.get("SELECT run_id FROM surface_windows WHERE id = 'w_old'")).toEqual({ run_id: null });
      // An upgrade (086 not yet applied) links in a bounded window only.
      await db.run("UPDATE surface_windows SET run_id = NULL");
      await db.run(NEAR_WINDOW);
      await db.run(NEAR_RUN);
      await db.run("DELETE FROM schema_migrations WHERE id = '086_control_room_ledger'");
      await runPostgresMigrations(db);
      expect(await db.get("SELECT run_id FROM surface_windows WHERE id = 'w_old'")).toEqual({ run_id: null });
      expect(await db.get("SELECT run_id FROM surface_windows WHERE id = 'w_near'")).toEqual({ run_id: "run_near" });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.close();
    }
  }, 120_000);
});


// ─── 2. Run totals stay inside a BIGINT ────────────────────────────────────

describe("runTotals bounds a caller-written trace", () => {
  it("clamps huge values and drops negative ones", async () => {
    const { runTotals } = await import("../src/workflow/run-totals.js");
    const huge = runTotals({ est_cost_usd: 1e300, usage: { input_tokens: 1e300, output_tokens: 1e21 } });
    expect(huge.costMicros).toBe(Number.MAX_SAFE_INTEGER);
    expect(huge.tokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(runTotals({ est_cost_usd: -5, usage: { input_tokens: -100, output_tokens: 40 } })).toEqual({ costMicros: 0, tokens: 40 });
    expect(runTotals(JSON.stringify({ est_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 5 } }))).toEqual({ costMicros: 250_000, tokens: 15 });
  });
});
