import type { Pool, PoolClient } from "pg";
import type {
  DatabaseAdapter,
  Querier,
  RunResult,
  SqlParam,
} from "./adapter.js";

/**
 * Translate positional `?` placeholders (the convention used throughout the
 * codebase, inherited from better-sqlite3) into Postgres `$1, $2, …`.
 *
 * The scan is string-literal aware: a `?` inside a single-quoted SQL literal
 * is left untouched. `''` (an escaped quote inside a literal) is handled by
 * the toggle naturally — the pair flips `inStr` off then on again, leaving us
 * still "inside" the literal, which is correct.
 *
 * Comments are skipped whole, so an apostrophe in prose (`there's`) cannot be
 * mistaken for the start of a literal and swallow every later placeholder.
 */
export function translatePlaceholders(sql: string): string {
  let out = "";
  let inStr = false;
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inStr && ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (!inStr && ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (ch === "'") {
      inStr = !inStr;
      out += ch;
    } else if (ch === "?" && !inStr) {
      out += "$" + ++n;
    } else {
      out += ch;
    }
  }
  return out;
}

class PgQuerier implements Querier {
  constructor(protected readonly q: Pool | PoolClient) {}

  async get<T = any>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const res = await this.q.query(translatePlaceholders(sql), params as any[]);
    return res.rows[0] as T | undefined;
  }

  async all<T = any>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const res = await this.q.query(translatePlaceholders(sql), params as any[]);
    return res.rows as T[];
  }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    const res = await this.q.query(translatePlaceholders(sql), params as any[]);
    return { changes: res.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    // DDL / multi-statement: no placeholder translation (no params).
    await this.q.query(sql);
  }
}

/**
 * PostgreSQL adapter backed by a `pg` connection pool. Used for Cloud SQL /
 * Cloud Run deployments where SQLite's local file is not durable.
 */
export class PostgresAdapter extends PgQuerier implements DatabaseAdapter {
  readonly dialect = "postgres" as const;

  constructor(private readonly pool: Pool) {
    super(pool);
  }

  async transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgQuerier(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Surface the original error.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
