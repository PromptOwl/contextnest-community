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
import { getAgent, SERVER_CLAIM } from "../metacognition/store.js";

interface ScheduleRow {
  id: string;
  nest_id: string;
  agent_node: string;
  every_minutes: number;
  enabled: number;
  last_run_at: string | null;
  created_by: string;
  max_runs: number | null;
  runs_created: number;
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
  // Archived nests are skipped, not disabled: the tick runs outside any request
  // (so the read-only permission cap never applies to it), and a schedule left
  // enabled on a nest someone put away would keep creating agent runs in it.
  // Restoring the nest brings its schedules back with everything else.
  const due = (
    (await db.all(
      `SELECT s.* FROM schedules s
         JOIN nests n ON n.id = s.nest_id
        WHERE s.enabled = 1 AND n.archived_at IS NULL`,
    )) as ScheduleRow[]
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

      // A metacognition agent is executed by this server: its run is created
      // already claimed (so no poll-mode runner takes it) and started below.
      // One at a time per agent — a run still going skips this firing.
      const serverRun =
        config.FEATURE_METACOGNITION && !!(await getAgent(s.nest_id, s.agent_node))?.enabled;
      if (serverRun) {
        const busy = await db.get(
          `SELECT id FROM runs WHERE nest_id = ? AND agent_node = ? AND status = 'running' AND claimed_by = ?`,
          [s.nest_id, s.agent_node, SERVER_CLAIM],
        );
        if (busy) continue;
      }

      const id = `run_${uuid()}`;
      const nowIso = new Date(now).toISOString();
      await db.run(
        `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, inputs, started_at, parent_run_id, depth, claimed_by, claimed_at)
         VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL, 0, ?, ?)`,
        // triggered_by names the schedule's creator with a schedule: prefix —
        // honest provenance ("this fired on X's schedule, not X clicking").
        [
          id,
          s.nest_id,
          s.agent_node,
          `schedule:${s.created_by}`,
          nowIso,
          serverRun ? SERVER_CLAIM : null,
          serverRun ? nowIso : null,
        ],
      );
      if (serverRun) {
        const { launch } = await import("../metacognition/service.js");
        launch(id);
      }
      // Stop-after bound: this firing may be the last — auto-pause the row
      // when it hits max_runs so "run 10 times" completes instead of looping
      // forever. Deterministic v1 of a goal condition.
      const fired = s.runs_created + 1;
      const done = s.max_runs !== null && fired >= s.max_runs;
      await db.run(
        `UPDATE schedules SET last_run_at = ?, runs_created = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
        [nowIso, fired, done ? 0 : s.enabled, nowIso, s.id],
      );
      created.push(id);
    } catch (err) {
      console.error(`[scheduler] failed to fire schedule ${s.id}`, err);
    }
  }
  return created;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

/** Loop state for the admin Network & status page. */
export function schedulerState(): { running: boolean; lastTickAt: string | null; lastTickError: string | null } {
  return { running: timer !== null, lastTickAt, lastTickError };
}

/** Start the background loop. No-op unless the workflow plane is enabled. */
export function startScheduler(): void {
  if (!config.FEATURE_WORKFLOW_PLANE || timer) return;
  timer = setInterval(() => {
    void schedulerTick().then(
      () => {
        lastTickAt = new Date().toISOString();
        lastTickError = null;
      },
      (err) => {
        lastTickAt = new Date().toISOString();
        lastTickError = err instanceof Error ? err.message : String(err);
        console.error("[scheduler] tick failed", err);
      },
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
