/**
 * Migration parity — SQLite vs Postgres schema.
 *
 * UNGATED: pure source-file parse, no DB needed, so it runs in the default
 * `npm test`. Guards against the class of bug where a new table (or its
 * migration id) lands in the SQLite chain (`migrations.ts`) but is forgotten in
 * the consolidated Postgres DDL (`migrations.postgres.ts`) — which silently
 * breaks Postgres-backed deployments (DB_DRIVER=postgres) while every
 * SQLite-only test stays green. (Regression guard for CU-wdqcpzv219, where
 * `node_deletions` shipped SQLite-only.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src", "db");
const sqliteSrc = readFileSync(join(src, "migrations.ts"), "utf8");
const pgSrc = readFileSync(join(src, "migrations.postgres.ts"), "utf8");

/** Real (non-temporary) table names created by a migration source file. */
function tableNames(source: string): Set<string> {
  const names = new Set<string>();
  // Require the `(` column list so prose like "the CREATE TABLE above" in
  // comments isn't mistaken for a real table.
  const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const name = m[1];
    // `*_new` are transient rebuild tables that get renamed onto an existing
    // final name — not part of the end-state schema.
    if (name.endsWith("_new")) continue;
    names.add(name);
  }
  return names;
}

/** SQLite migration ids recorded via recordMigration("xxx"). */
function recordedMigrationIds(source: string): Set<string> {
  const ids = new Set<string>();
  const re = /recordMigration\("([^"]+)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) ids.add(m[1]);
  return ids;
}

/** Ids seeded into HISTORICAL_MIGRATIONS in the Postgres DDL. */
function historicalMigrationIds(source: string): Set<string> {
  const block = source.match(/HISTORICAL_MIGRATIONS\s*=\s*\[([\s\S]*?)\]/);
  const ids = new Set<string>();
  if (!block) return ids;
  const re = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1]))) ids.add(m[1]);
  return ids;
}

/** `table.column` pairs from every `ALTER TABLE … ADD COLUMN` in a source. */
function addedColumns(source: string): Set<string> {
  const cols = new Set<string>();
  const re = /ALTER TABLE (\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) cols.add(`${m[1]}.${m[2]}`);
  return cols;
}

/**
 * Columns that live ONLY inline in the Postgres CREATE TABLE, and may.
 *
 * Declaring a column inline is enough for a database the DDL creates from
 * scratch, and nothing else. On an EXISTING database `CREATE TABLE IF NOT
 * EXISTS` is a no-op, so the column never arrives — which is a hard failure the
 * moment any query names it, not a degraded feature.
 *
 * Every entry below predates the live Postgres deployments: their databases
 * were created by a consolidated DDL that already declared the column, so no
 * ALTER was ever needed. That is a fact about deployment history, not about the
 * source, so no static check can derive it — hence a frozen list.
 *
 * `stewards.can_approve/can_reject` are here for the opposite reason: migration
 * 007 drops them, and the Postgres DDL correctly never creates them at all.
 *
 * DO NOT ADD TO THIS LIST to make a failure go away. A newly added column has
 * by definition not shipped yet, so some live database lacks it — write the
 * `ALTER TABLE … ADD COLUMN IF NOT EXISTS` instead. (CU-wdqcq00ar3: an inline-only
 * `nests.index_synced_at` 500'd every document listing on Postgres.)
 */
const INLINE_ONLY_IN_POSTGRES = new Set([
  "nests.stewardship_enabled",
  "nests.is_imported",
  "nests.allow_self_approve",
  "users.is_admin",
  "users.is_invited",
  "stewards.can_approve",
  "stewards.can_reject",
  "license_cache.owner_email",
  "schedules.max_runs",
  "schedules.runs_created",
  "runs.claimed_by",
  "runs.claimed_at",
]);

describe("SQLite/Postgres migration parity", () => {
  it("every SQLite table exists in the consolidated Postgres DDL", () => {
    const sqlite = tableNames(sqliteSrc);
    const pg = tableNames(pgSrc);
    const missing = [...sqlite].filter((t) => !pg.has(t));
    expect(missing, `tables in migrations.ts but missing from migrations.postgres.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("node_deletions is present in both drivers", () => {
    expect(tableNames(sqliteSrc).has("node_deletions")).toBe(true);
    expect(tableNames(pgSrc).has("node_deletions")).toBe(true);
  });

  it("api_events (activity trace) is present in both drivers and seeded (CU-wdqcpzv21h)", () => {
    expect(tableNames(sqliteSrc).has("api_events")).toBe(true);
    expect(tableNames(pgSrc).has("api_events")).toBe(true);
    // The 014 migration id must be seeded in Postgres HISTORICAL_MIGRATIONS so
    // a PG deployment doesn't re-run it (and bookkeeping matches SQLite).
    expect(historicalMigrationIds(pgSrc).has("014_api_events")).toBe(true);
  });

  it("every SQLite-added column has an explicit Postgres ALTER", () => {
    const sqlite = addedColumns(sqliteSrc);
    const pg = addedColumns(pgSrc);
    const missing = [...sqlite].filter(
      (c) => !pg.has(c) && !INLINE_ONLY_IN_POSTGRES.has(c),
    );
    expect(
      missing,
      `columns added in migrations.ts with no "ALTER TABLE … ADD COLUMN IF NOT EXISTS" in ` +
        `migrations.postgres.ts: ${missing.join(", ")}. Declaring the column inline in the ` +
        `CREATE TABLE only reaches a database created after it shipped — an existing Postgres ` +
        `deployment never gets it, and the first query naming it fails.`,
    ).toEqual([]);
  });

  it("index_synced_at is altered in, not just declared inline (CU-wdqcq00ar3)", () => {
    // The node index reads this column on EVERY listing to decide whether to
    // rebuild, so inline-only made it a 500 on the document list rather than a
    // missing feature.
    expect(addedColumns(pgSrc).has("nests.index_synced_at")).toBe(true);
  });

  it("every recorded SQLite migration id (002+) is seeded in Postgres HISTORICAL_MIGRATIONS", () => {
    const recorded = recordedMigrationIds(sqliteSrc);
    const historical = historicalMigrationIds(pgSrc);
    // 002 onward are the versioned migrations; the base tables (pre-002) have no
    // recordMigration id. Every recorded id must be seeded on the Postgres side.
    const missing = [...recorded].filter((id) => !historical.has(id));
    expect(missing, `migration ids recorded in migrations.ts but not seeded in Postgres HISTORICAL_MIGRATIONS: ${missing.join(", ")}`).toEqual([]);
  });
});
