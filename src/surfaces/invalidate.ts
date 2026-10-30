/**
 * Guard invalidation (§4.17). Marks bindings `guard_dirty`; the guard loop
 * (services/guard-runner.ts) recomputes dirty bindings within one tick.
 *
 * Deliberately tiny and dependency-free beyond the DB, so permission code
 * anywhere in the server can call it after a mutation without an import
 * cycle. Best-effort: invalidation never fails the mutation that called it —
 * and the guard loop's reader fingerprint catches any change a missed call
 * would have flagged.
 */
import { getDb } from "../db/client.js";

const LIVE = "status IN ('active', 'paused_guard')";

async function mark(where: string, params: string[]): Promise<void> {
  try {
    await getDb().run(`UPDATE surface_bindings SET guard_dirty = 1, guard_dirty_epoch = guard_dirty_epoch + 1, guard_dirty_at = ? WHERE ${LIVE}${where}`, [
      new Date().toISOString(),
      ...params,
    ]);
  } catch {
    // table missing on a half-migrated DB, or a closed connection in teardown
  }
}

export function invalidateNestGuards(nestId: string): Promise<void> {
  return mark(" AND nest_id = ?", [nestId]);
}

export function invalidateInstallGuards(installId: string): Promise<void> {
  return mark(" AND install_id = ?", [installId]);
}

export function invalidateConversationGuards(installId: string, conversationId: string): Promise<void> {
  return mark(" AND install_id = ? AND conversation_id = ?", [installId, conversationId]);
}

/** Server-wide changes (server admin set, a user's email verification). */
export function invalidateAllGuards(): Promise<void> {
  return mark("", []);
}
