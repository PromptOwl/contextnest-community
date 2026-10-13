/**
 * Run retention — prunes finished agent runs older than RUN_RETENTION_DAYS.
 *
 * 0 (the default) keeps every run. The window is read on every pass, so a
 * change from admin Settings takes effect without a restart. A run still
 * `running` is never pruned, whatever its age. Steps go with their run.
 *
 * A proposal, comment or access request keeps its run_id after its run is
 * pruned; the UI treats a run it can't load as "trace no longer kept".
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";

const PRUNE_EVERY_MS = 60 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** One pass. Returns how many runs were removed. Exported for tests. */
export async function pruneOldRuns(now: number = Date.now()): Promise<number> {
  const days = config.RUN_RETENTION_DAYS;
  if (days <= 0) return 0;
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  const db = getDb();
  let removed = 0;
  await db.transaction(async (tx) => {
    // Steps first: don't lean on ON DELETE CASCADE, which SQLite only honours
    // with foreign_keys on.
    await tx.run(
      `DELETE FROM run_steps WHERE run_id IN (
         SELECT id FROM runs WHERE status <> 'running' AND finished_at IS NOT NULL AND finished_at < ?)`,
      [cutoff],
    );
    const res = await tx.run(
      "DELETE FROM runs WHERE status <> 'running' AND finished_at IS NOT NULL AND finished_at < ?",
      [cutoff],
    );
    removed = res.changes ?? 0;
  });
  return removed;
}

/** Start the hourly prune. No-op unless the workflow plane is enabled. */
export function startRunRetention(): void {
  if (!config.FEATURE_WORKFLOW_PLANE || timer) return;
  const pass = () =>
    void pruneOldRuns()
      .then((n) => {
        if (n > 0) console.log(`[runs] pruned ${n} run(s) older than ${config.RUN_RETENTION_DAYS} days`);
      })
      .catch((err) => console.error("[runs] retention prune failed", err));
  timer = setInterval(pass, PRUNE_EVERY_MS);
  timer.unref?.();
  pass();
}
