/**
 * Dialect-aware SQL helpers.
 *
 * Almost every query in the codebase is portable as-is (plain
 * SELECT/INSERT/UPDATE/DELETE with `?` placeholders and `LIMIT`/`OFFSET`,
 * all of which Postgres accepts; the adapter handles `?`→`$n`). Only a
 * handful of statements differ between SQLite and Postgres — those go through
 * the helpers below so the branching lives in one reviewable place rather
 * than scattered `if (dialect)` checks.
 */
import type { DatabaseAdapter } from "./adapter.js";

/**
 * Current-timestamp expression yielding the same text format on both
 * backends. SQLite's `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` in UTC;
 * the Postgres form matches that format and timezone so stored values — and
 * any string comparisons/sorts performed on them — stay identical across
 * backends.
 */
export function nowExpr(db: DatabaseAdapter): string {
  return db.dialect === "sqlite"
    ? "datetime('now')"
    : "to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')";
}

/**
 * Turn a plain `INSERT INTO …` into insert-or-ignore for the dialect.
 *   SQLite:   `INSERT OR IGNORE INTO …`
 *   Postgres: `… ON CONFLICT DO NOTHING` (target-less — ignores any
 *             unique/PK violation, matching SQLite's `OR IGNORE`).
 */
export function insertOrIgnore(db: DatabaseAdapter, insertSql: string): string {
  return db.dialect === "sqlite"
    ? insertSql.replace(/^\s*INSERT\s+INTO/i, "INSERT OR IGNORE INTO")
    : `${insertSql} ON CONFLICT DO NOTHING`;
}

/**
 * Turn a plain `INSERT INTO …` into an upsert keyed on `conflictCols`.
 *   SQLite:   `INSERT OR REPLACE INTO …` — full-row replace; columns not in
 *             the insert list reset to their defaults.
 *   Postgres: `… ON CONFLICT (conflictCols) DO UPDATE SET <set>`.
 *
 * `set` is the Postgres `DO UPDATE SET` body (ignored on the SQLite path).
 * Supply it so the update mirrors SQLite's replace semantics — including any
 * columns the SQLite path would reset to a default (e.g. a `…_at` timestamp).
 */
export function insertOrReplace(
  db: DatabaseAdapter,
  insertSql: string,
  conflictCols: string[],
  set: string,
): string {
  return db.dialect === "sqlite"
    ? insertSql.replace(/^\s*INSERT\s+INTO/i, "INSERT OR REPLACE INTO")
    : `${insertSql} ON CONFLICT (${conflictCols.join(", ")}) DO UPDATE SET ${set}`;
}
