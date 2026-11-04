/**
 * Every purge path records a counts-only row in surface_purge_runs (round 2,
 * L7): ttl | judged | pause | optout | delete | edit | uninstall. Never text,
 * never which message — only how many rows went and where.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../../db/client.js";

export type PurgeTrigger = "ttl" | "judged" | "pause" | "optout" | "delete" | "edit" | "uninstall";
type Runner = { run: (sql: string, p?: any[]) => Promise<{ changes: number }> };

export async function recordPurge(trigger: PurgeTrigger, rows: number, scope: { bindingId?: string | null; installId?: string | null } = {}, q: Runner = getDb()): Promise<void> {
  // Nothing purged, nothing to record (a delete event for an unbuffered
  // message would otherwise write a row per event for 90 days).
  if (rows <= 0) return;
  const now = new Date().toISOString();
  try {
    await q.run(
      `INSERT INTO surface_purge_runs (id, purge_trigger, binding_id, install_id, started_at, finished_at, rows_deleted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), trigger, scope.bindingId ?? null, scope.installId ?? null, now, now, rows, now],
    );
  } catch {
    /* the audit row never blocks a purge */
  }
}
