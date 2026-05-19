import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../config.js";
import { runMigrations } from "./migrations.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
    db = new Database(config.DATABASE_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Wait up to 5s for a competing writer (external DB tool, parallel
    // request) to release the lock instead of throwing SQLITE_BUSY immediately.
    db.pragma("busy_timeout = 5000");
    runMigrations(db);
  }
  return db;
}

/** Reset the DB connection (for tests with different data dirs) */
export function resetDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
