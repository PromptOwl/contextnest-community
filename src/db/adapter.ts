/**
 * Database adapter abstraction.
 *
 * All application code talks to a `DatabaseAdapter` instead of a concrete
 * driver, so the codebase can run on either SQLite (`better-sqlite3`, the
 * default) or PostgreSQL (`pg`, for Cloud SQL / Cloud Run). The driver types
 * never leak past this layer.
 *
 * Every method returns a Promise so one interface serves both a synchronous
 * driver (SQLite, which resolves immediately) and an asynchronous one
 * (Postgres). Application SQL keeps using positional `?` placeholders; the
 * Postgres adapter translates them to `$1, $2, …` internally.
 */

export type SqlParam = string | number | boolean | null | bigint | Buffer | Uint8Array;

export interface RunResult {
  /** Rows affected — better-sqlite3 `info.changes` / pg `result.rowCount`. */
  changes: number;
}

/**
 * Query surface available both on the top-level adapter and inside a
 * transaction callback. Inside a transaction the callback MUST use the
 * provided `tx` querier (not the outer adapter) so every statement runs on
 * the transaction's connection.
 */
export interface Querier {
  get<T = any>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  all<T = any>(sql: string, params?: SqlParam[]): Promise<T[]>;
  run(sql: string, params?: SqlParam[]): Promise<RunResult>;
  /** Execute one or more parameterless statements (DDL, pragmas). */
  exec(sql: string): Promise<void>;
}

export interface DatabaseAdapter extends Querier {
  /**
   * Run `fn` atomically. Commits if it resolves, rolls back if it rejects.
   * `fn` receives a transaction-scoped querier and must use it for all of
   * its statements.
   */
  transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T>;
  readonly dialect: "sqlite" | "postgres";
  close(): Promise<void>;
}
