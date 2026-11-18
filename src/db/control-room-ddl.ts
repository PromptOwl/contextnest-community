/** Agent control room (po-1186 CR1): shared DDL for migration 086. */

/**
 * How long after a window is judged its listener run may start and still be
 * the window's run. judge-service records the run right after the verdict
 * write, so seconds apart; anything later is another window's run.
 */
export const RUN_LINK_WINDOW_MINUTES = 5;

/** `judged_at + RUN_LINK_WINDOW_MINUTES`, as the same ISO string the columns hold. */
function linkBound(dialect: "sqlite" | "postgres"): string {
  return dialect === "postgres"
    ? `CASE WHEN surface_windows.judged_at ~ '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?Z$'
         THEN to_char((surface_windows.judged_at::timestamptz + interval '${RUN_LINK_WINDOW_MINUTES} minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END`
    : `strftime('%Y-%m-%dT%H:%M:%fZ', surface_windows.judged_at, '+${RUN_LINK_WINDOW_MINUTES} minutes')`;
}

/**
 * Migration 086's indexes and one-time backfill. Plain SQL both drivers
 * accept, apart from the time bound, shared with migrations.postgres.ts so
 * the two can't drift. Both callers run it ONCE, under the 086 migration id:
 * a judged window that legitimately has no run stays `run_id IS NULL`, and a
 * re-run on every boot would attach it to whatever listener run came later.
 */
export function controlRoomLedgerIndexesAndBackfill(dialect: "sqlite" | "postgres" = "sqlite"): string {
  return `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
      ON runs(nest_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_steps_client_key
      ON run_steps(run_id, client_key) WHERE client_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(nest_id, source, started_at);
    CREATE INDEX IF NOT EXISTS idx_surface_windows_run ON surface_windows(run_id) WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_surface_windows_judged ON surface_windows(nest_id, judged_at);
    UPDATE runs SET source = 'server:metacognition'
      WHERE source = 'runner' AND claimed_by = 'server:metacognition';
    UPDATE runs SET source = 'server:surfaces'
      WHERE source = 'runner' AND (claimed_by = 'server:surfaces' OR triggered_by = 'surfaces:window');
    -- Best effort: the listener records its run just after it judges
    -- (judge-service recordRun), so a judged window's run is the first
    -- listener run of that nest and agent within ${RUN_LINK_WINDOW_MINUTES} minutes of judged_at.
    UPDATE surface_windows SET run_id = (
        SELECT r.id FROM runs r JOIN surface_bindings b ON b.id = surface_windows.binding_id
         WHERE r.nest_id = surface_windows.nest_id
           AND r.source = 'server:surfaces'
           AND r.agent_node = b.listener_agent_node_id
           AND r.started_at >= surface_windows.judged_at
           AND r.started_at < ${linkBound(dialect)}
           AND NOT EXISTS (SELECT 1 FROM surface_windows w2 WHERE w2.run_id = r.id)
         ORDER BY r.started_at LIMIT 1)
      WHERE run_id IS NULL AND status = 'judged' AND model IS NOT NULL AND judged_at IS NOT NULL;
  `;
}
