/**
 * Interval scheduler for the workflow plane — the missing trigger side of
 * the runner loop. A schedule row says "create a run for this agent every N
 * minutes"; the tick below inserts the run rows exactly like a manual
 * trigger does, and an external runner in poll mode picks them up and walks
 * them. The server never executes anything itself, so governance stays
 * intact: scheduled output still lands as a review request like any other
 * agent write-back.
 *
 * Deliberately interval-based (every N minutes), not cron-expression-based:
 * no dependency, no timezone questions, covers the dogfood cases (nightly
 * digest, hourly poll). Cron syntax can layer on later without schema change
 * (swap every_minutes for a spec column).
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { config } from "../config.js";

interface ScheduleRow {
  id: string;
  nest_id: string;
  agent_node: string;
  every_minutes: number;
  enabled: number;
  last_run_at: string | null;
  created_by: string;
}

/** True when the schedule's interval has elapsed since its last firing. */
function isDue(s: ScheduleRow, now: number): boolean {
  if (!s.last_run_at) return true;
  const last = Date.parse(s.last_run_at);
  if (Number.isNaN(last)) return true;
  return now - last >= s.every_minutes * 60_000;
}

/**
 * One pass: fire every due schedule. Exported for tests (pass a fake `now`).
 * Returns the run ids created. Each schedule fails independently — one bad
 * row must not stall the rest.
 */
export async function schedulerTick(now: number = Date.now()): Promise<string[]> {
  const db = getDb();
  const due = (
    (await db.all("SELECT * FROM schedules WHERE enabled = 1")) as ScheduleRow[]
  ).filter((s) => isDue(s, now));

  const created: string[] = [];
  for (const s of due) {
    try {
      // Respect the same per-nest concurrency cap as manual triggers — a
      // stuck runner must not let schedules pile up unbounded run rows.
      const { n } = (await db.get(
        `SELECT COUNT(*) AS n FROM runs
          WHERE nest_id = ? AND parent_run_id IS NULL AND status = 'running'`,
        [s.nest_id],
      )) as { n: number };
      if (n >= config.RUN_MAX_CONCURRENT_ROOTS) {
        console.warn(
          `[scheduler] skip ${s.agent_node} in ${s.nest_id}: ${n} runs already running`,
        );
        continue;
      }

      const id = `run_${uuid()}`;
      const nowIso = new Date(now).toISOString();
      await db.run(
        `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, inputs, started_at, parent_run_id, depth)
         VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL, 0)`,
        // triggered_by names the schedule's creator with a schedule: prefix —
        // honest provenance ("this fired on X's schedule, not X clicking").
        [id, s.nest_id, s.agent_node, `schedule:${s.created_by}`, nowIso],
      );
      await db.run(
        "UPDATE schedules SET last_run_at = ?, updated_at = ? WHERE id = ?",
        [nowIso, nowIso, s.id],
      );
      created.push(id);
    } catch (err) {
      console.error(`[scheduler] failed to fire schedule ${s.id}`, err);
    }
  }
  return created;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the background loop. No-op unless the workflow plane is enabled. */
export function startScheduler(): void {
  if (!config.FEATURE_WORKFLOW_PLANE || timer) return;
  timer = setInterval(() => {
    void schedulerTick().catch((err) =>
      console.error("[scheduler] tick failed", err),
    );
  }, 60_000);
  // Never hold the process open just for the scheduler (tests, ctrl-c).
  timer.unref?.();
  console.log("[scheduler] workflow schedules active (60s tick)");
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
