/**
 * Activity trace — one row per API request / MCP tool call, so the server
 * admin has a single place to see everything clients and agents did.
 * Deliberately simple: who, what, where, outcome, duration. This is an
 * operator audit surface, NOT product telemetry (tracker.ts) — it never
 * leaves the server and ignores TELEMETRY_ENABLED.
 *
 * Writes are best-effort fire-and-forget: a broken trace table must never
 * fail a real request. Retention is a rolling window pruned opportunistically
 * every PRUNE_EVERY inserts.
 */
import { getDb } from "../db/client.js";

const RETENTION_DAYS = 14;
const PRUNE_EVERY = 500;
let insertsSincePrune = 0;

export interface TraceEvent {
  kind: "api" | "mcp";
  method?: string;
  path?: string;
  tool?: string;
  nestId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  status?: number;
  durationMs?: number;
}

export async function logTraceEvent(e: TraceEvent): Promise<void> {
  try {
    const db = getDb();
    await db.run(
      `INSERT INTO api_events
         (ts, kind, method, path, tool, nest_id, user_id, user_email, status, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        e.kind,
        e.method ?? null,
        e.path ?? null,
        e.tool ?? null,
        e.nestId ?? null,
        e.userId ?? null,
        e.userEmail ?? null,
        e.status ?? null,
        e.durationMs ?? null,
      ],
    );
    if (++insertsSincePrune >= PRUNE_EVERY) {
      insertsSincePrune = 0;
      const cutoff = new Date(
        Date.now() - RETENTION_DAYS * 86_400_000,
      ).toISOString();
      await db.run("DELETE FROM api_events WHERE ts < ?", [cutoff]);
    }
  } catch {
    /* tracing must never break the request */
  }
}

export interface TraceFilters {
  limit?: number;
  kind?: "api" | "mcp";
  nestId?: string;
  user?: string;
}

export async function listTraceEvents(filters: TraceFilters = {}) {
  const db = getDb();
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  // Email is resolved at read time (join) so the hot write path stays one
  // insert; mcp rows carry user_email directly (their caller is email-keyed).
  let sql = `SELECT e.*, COALESCE(e.user_email, u.email) AS caller
               FROM api_events e LEFT JOIN users u ON u.id = e.user_id`;
  const where: string[] = [];
  const args: any[] = [];
  if (filters.kind) {
    where.push("e.kind = ?");
    args.push(filters.kind);
  }
  if (filters.nestId) {
    where.push("e.nest_id = ?");
    args.push(filters.nestId);
  }
  if (filters.user) {
    where.push("(COALESCE(e.user_email, u.email) LIKE ? OR e.user_id = ?)");
    args.push(`%${filters.user}%`, filters.user);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY e.id DESC LIMIT ?";
  args.push(limit);
  return db.all(sql, args);
}
