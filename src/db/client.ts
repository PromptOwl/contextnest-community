import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { config } from "../config.js";
import { runMigrations } from "./migrations.js";
import type { DatabaseAdapter } from "./adapter.js";
import { SqliteAdapter } from "./adapter.sqlite.js";

let adapter: DatabaseAdapter | null = null;

/**
 * Build a `pg` Pool config from env. Connection style precedence:
 *   1. CLOUD_SQL_CONNECTION_NAME → unix socket /cloudsql/<name> (Cloud Run +
 *      Cloud SQL Auth Proxy; the socket is already secure, so no TLS).
 *   2. DATABASE_URL → standard TCP connection string (pg parses it directly).
 *   3. discrete DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME.
 */
function buildPgConfig(): Record<string, unknown> {
  const base: Record<string, unknown> = {
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  };

  if (config.CLOUD_SQL_CONNECTION_NAME) {
    return {
      ...base,
      host: `/cloudsql/${config.CLOUD_SQL_CONNECTION_NAME}`,
      user: config.DB_USER || undefined,
      password: config.DB_PASSWORD || undefined,
      database: config.DB_NAME || undefined,
    };
  }

  if (config.DATABASE_URL) {
    return { ...base, connectionString: config.DATABASE_URL, ssl: pgSsl() };
  }

  return {
    ...base,
    host: config.DB_HOST || "localhost",
    port: config.DB_PORT,
    user: config.DB_USER || undefined,
    password: config.DB_PASSWORD || undefined,
    database: config.DB_NAME || undefined,
    ssl: pgSsl(),
  };
}

function pgSsl(): false | { rejectUnauthorized: boolean; ca?: string } {
  if (!config.DB_SSL) return false;
  const ssl: { rejectUnauthorized: boolean; ca?: string } = {
    rejectUnauthorized: true,
  };
  if (config.DB_SSL_CA) ssl.ca = readFileSync(config.DB_SSL_CA, "utf8");
  return ssl;
}

/** Open the SQLite adapter synchronously (default backend). */
function openSqlite(): SqliteAdapter {
  mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
  const raw = new Database(config.DATABASE_PATH);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  // Wait up to 5s for a competing writer (external DB tool, parallel
  // request) to release the lock instead of throwing SQLITE_BUSY immediately.
  raw.pragma("busy_timeout = 5000");
  runMigrations(raw);
  return new SqliteAdapter(raw);
}

/**
 * Initialise the database backend once and run migrations.
 *
 * For Postgres this MUST be awaited at startup (the driver is async) before any
 * `getDb()` call — `index.ts` does this. For SQLite it's optional: `getDb()`
 * opens it lazily (preserving the original behaviour), so direct service calls
 * in tests work without an explicit init step.
 */
export async function initDb(): Promise<DatabaseAdapter> {
  if (adapter) return adapter;

  if (config.DB_DRIVER === "postgres") {
    const { Pool } = await import("pg");
    const { PostgresAdapter } = await import("./adapter.postgres.js");
    const { runPostgresMigrations } = await import("./migrations.postgres.js");
    const pool = new Pool(buildPgConfig());
    adapter = new PostgresAdapter(pool);
    await runPostgresMigrations(adapter);
  } else {
    adapter = openSqlite();
  }

  return adapter;
}

/**
 * Return the active database adapter. For SQLite (the default) it lazily opens
 * the connection on first use. For Postgres it throws if `initDb()` hasn't run
 * yet — the async pool can't be opened from a synchronous accessor.
 */
export function getDb(): DatabaseAdapter {
  if (!adapter) {
    if (config.DB_DRIVER === "postgres") {
      throw new Error(
        "Postgres backend not initialised — call (and await) initDb() at startup before getDb().",
      );
    }
    adapter = openSqlite();
  }
  return adapter;
}

/** Reset the DB connection (for tests with different data dirs / schemas). */
export async function resetDb(): Promise<void> {
  if (adapter) {
    await adapter.close();
    adapter = null;
  }
}
