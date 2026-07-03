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

  it("every recorded SQLite migration id (002+) is seeded in Postgres HISTORICAL_MIGRATIONS", () => {
    const recorded = recordedMigrationIds(sqliteSrc);
    const historical = historicalMigrationIds(pgSrc);
    // 002 onward are the versioned migrations; the base tables (pre-002) have no
    // recordMigration id. Every recorded id must be seeded on the Postgres side.
    const missing = [...recorded].filter((id) => !historical.has(id));
    expect(missing, `migration ids recorded in migrations.ts but not seeded in Postgres HISTORICAL_MIGRATIONS: ${missing.join(", ")}`).toEqual([]);
  });
});
