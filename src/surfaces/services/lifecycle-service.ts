/**
 * Lifecycle for S2a (PRD §4.4 purge triggers, §4.16 uninstall order):
 *  - the pause hook: when S1 pauses, boots or removes a binding, its buffer
 *    rows are hard-deleted, its unjudged windows discarded (no model call)
 *    and its pending items withdrawn (no 7-day hold) — carry-forward 1;
 *  - uninstall / tokens revoked: bindings removed (via S1), buffer purged,
 *    pending withdrawn, drafts purged, secrets, links and the user cache
 *    deleted; approved nodes stay;
 *  - the TTL sweeper (every 5 min), recorded in surface_purge_runs (counts only);
 *  - the in-process loops (window tick 1 min, purge 5 min, fetch queue 15 s).
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../../db/client.js";
import { surfacesEnabled } from "../flags.js";
import { onBindingPaused } from "./pause-hooks.js";
import { discardBindingWindows, windowTick } from "./window-service.js";
import { withdrawForBinding, retryWithdrawals } from "./proposal-service.js";
import { removeListener } from "./listener-service.js";
import { deleteSecrets } from "./secret-store.js";
import { handleSurfaceSignal } from "./guard-runner.js";
import { runFetchQueue } from "./fetch-queue.js";
import { track } from "./work.js";
import { recordPurge } from "./purge-audit.js";
import { getSettings } from "./settings-service.js";
import { effectiveTtlHours } from "../core/settings.js";

let hooked = false;

/** Register the pause hook once (idempotent). */
export function registerSurfacesLifecycle(): void {
  if (hooked) return;
  hooked = true;
  onBindingPaused(async (b, reason) => {
    await discardBindingWindows(b.id);
    await withdrawForBinding(b.id);
    // A removed binding's listener has nothing left to do: remove it, so it
    // never lingers on the nest as an untied agent (which would block every
    // other binding's guard). Its persona stays for history. A paused binding
    // keeps its listener for a resume.
    if (reason === "removed") await removeListener(b.id);
  });
}

/** app_uninstalled / tokens_revoked / admin disconnect. */
export async function uninstall(installId: string, signal: "uninstalled" | "tokens_revoked"): Promise<void> {
  // S1: install → revoked, every binding → removed (the pause hook purges
  // and withdraws per binding).
  await handleSurfaceSignal(installId, { surface: "slack", workspace: "", kind: signal });
  const db = getDb();
  const purged = (await db.run("DELETE FROM surface_buffer WHERE install_id = ?", [installId])).changes;
  await recordPurge("uninstall", purged, { installId });
  await deleteSecrets(installId);
  await db.run("DELETE FROM surface_identity_links WHERE install_id = ?", [installId]);
  await db.run("DELETE FROM surface_users_cache WHERE install_id = ?", [installId]);
  await db.run("DELETE FROM surface_link_tokens WHERE install_id = ?", [installId]);
  await db.run("UPDATE surface_fetch_queue SET status = 'failed' WHERE install_id = ? AND status IN ('queued', 'running')", [installId]);
}

/**
 * The TTL sweeper: delete rows past expires_at; an open window whose rows
 * expired closes as `expired_unjudged`. One surface_purge_runs row per run.
 */
export async function purgeSweep(nowMs: number = Date.now()): Promise<{ rows_deleted: number; windows_expired: number }> {
  const db = getDb();
  const id = uuid();
  const started = new Date(nowMs).toISOString();
  await db.run("INSERT INTO surface_purge_runs (id, purge_trigger, started_at, created_at) VALUES (?, 'ttl', ?, ?)", [id, started, started]);
  const cutoff = new Date(nowMs - effectiveTtlHours(await getSettings()) * 3600_000).toISOString();
  const expiredWindows = (await db.all(
    `SELECT DISTINCT w.id FROM surface_windows w JOIN surface_buffer b ON b.window_id = w.id
      WHERE (b.expires_at <= ? OR b.created_at <= ?) AND w.status IN ('open', 'closing', 'awaiting_fetch')`,
    [started, cutoff],
  )) as Array<{ id: string }>;
  let windows = 0;
  let deleted = 0;
  for (const w of expiredWindows) {
    const r = await db.run(
      `UPDATE surface_windows SET status = 'judged', close_reason = 'expired_unjudged', verdict = 'expired_unjudged', closed_at = COALESCE(closed_at, ?), judged_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('open', 'closing', 'awaiting_fetch')`,
      [started, started, started, w.id],
    );
    if (r.changes) {
      windows++;
      deleted += (await db.run("DELETE FROM surface_buffer WHERE window_id = ?", [w.id])).changes;
    }
  }
  deleted += (await db.run("DELETE FROM surface_buffer WHERE expires_at <= ?", [started])).changes;
  // The TTL is the CURRENT setting (round 2, L7): lowering it purges rows
  // already stored under the old one.
  const ttlCutoff = new Date(nowMs - effectiveTtlHours(await getSettings()) * 3600_000).toISOString();
  deleted += (await db.run("DELETE FROM surface_buffer WHERE created_at <= ?", [ttlCutoff])).changes;
  const oldest = (await db.get("SELECT MIN(created_at) AS at FROM surface_buffer")) as { at: string | null } | undefined;
  await db.run("UPDATE surface_purge_runs SET finished_at = ?, rows_deleted = ?, windows_expired = ?, oldest_buffered_at = ? WHERE id = ?", [
    new Date().toISOString(),
    deleted,
    windows,
    oldest?.at ?? null,
    id,
  ]);
  // OAuth housekeeping (round 2, INFO): spent or expired states, and
  // installs abandoned in `pending` for a day (their secrets with them).
  await db.run("DELETE FROM surface_oauth_states WHERE expires_at <= ? OR used_at IS NOT NULL", [started]);
  const abandoned = (await db.all(
    "SELECT id FROM surface_installs WHERE status = 'pending' AND created_at <= ? AND NOT EXISTS (SELECT 1 FROM surface_bindings b WHERE b.install_id = surface_installs.id)",
    [new Date(nowMs - 24 * 3600_000).toISOString()],
  )) as Array<{ id: string }>;
  for (const a of abandoned) {
    const r = await db.run("UPDATE surface_installs SET status = 'disconnected', updated_at = ? WHERE id = ? AND status = 'pending'", [started, a.id]);
    if (r.changes) await deleteSecrets(a.id);
  }
  // Withdrawals that couldn't finish earlier are retried here (round 2, M2).
  await retryWithdrawals();
  // Expired event ids (24 h) and old purge runs (90 days) go too.
  await db.run("DELETE FROM surface_events_seen WHERE received_at <= ?", [new Date(nowMs - 24 * 3600_000).toISOString()]);
  await db.run("DELETE FROM surface_purge_runs WHERE started_at <= ?", [new Date(nowMs - 90 * 86400_000).toISOString()]);
  return { rows_deleted: deleted, windows_expired: windows };
}

let timers: Array<ReturnType<typeof setInterval>> = [];

/** Always runs; each tick is a no-op while Surfaces is off (it can be turned on at runtime). */
export function startSurfacesIngestLoops(): void {
  if (timers.length) return;
  const every = (ms: number, fn: () => Promise<unknown>, label: string) => {
    let busy = false;
    const t = setInterval(() => {
      if (busy || !surfacesEnabled()) return;
      busy = true;
      track(
        fn().finally(() => {
          busy = false;
        }),
        label,
      );
    }, ms);
    t.unref?.();
    timers.push(t);
  };
  every(60_000, () => windowTick(), "window tick");
  every(5 * 60_000, () => purgeSweep(), "purge");
  every(15_000, () => runFetchQueue(), "fetch queue");
}

export function stopSurfacesIngestLoops(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}
