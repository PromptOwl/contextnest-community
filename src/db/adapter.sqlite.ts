import type Database from "better-sqlite3";
import type {
  DatabaseAdapter,
  Querier,
  RunResult,
  SqlParam,
} from "./adapter.js";

/**
 * SQLite adapter backed by a single synchronous `better-sqlite3` connection.
 *
 * The driver is synchronous, so every method resolves immediately — awaiting
 * it is behaviour-preserving relative to the pre-adapter direct calls. This
 * keeps existing SQLite deployments byte-for-byte unchanged.
 */
export class SqliteAdapter implements DatabaseAdapter {
  readonly dialect = "sqlite" as const;

  // better-sqlite3 is one synchronous connection. Once transaction bodies are
  // async (they may `await` between statements), two concurrent bodies could
  // interleave their BEGIN/COMMIT on the shared connection and corrupt
  // atomicity. This promise chain serialises transactions in-process,
  // restoring the run-to-completion guarantee better-sqlite3's own
  // `.transaction()` gave us synchronously.
  private txChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Database.Database) {}

  async get<T = any>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as any[])) as T | undefined;
  }

  async all<T = any>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as any[])) as T[];
  }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    const info = this.db.prepare(sql).run(...(params as any[]));
    return { changes: info.changes };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // `this` is a valid Querier; fn resolves synchronously for SQLite.
        const result = await fn(this);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors (e.g. no active transaction); surface the
          // original failure below.
        }
        throw err;
      }
    };
    const result = this.txChain.then(run, run);
    // Keep the chain alive even if this transaction rejects, so a failed
    // transaction doesn't permanently wedge subsequent ones.
    this.txChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
