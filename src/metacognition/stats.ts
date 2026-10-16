/**
 * Per-agent activity: what a metacognition agent did over a window, and how
 * its proposals were judged. Read-only, built from the run log (runs +
 * run_steps) and the review queue, so it covers runs from before the
 * run_id back-links existed.
 *
 * Outcome of a run, as shown to people:
 *   running · succeeded · failed · timeout (stopped by its time cap) ·
 *   skipped (cancelled before it started: no key, agent off…) · cancelled.
 */
import { getDb } from "../db/client.js";

export type RunOutcome = "running" | "succeeded" | "failed" | "timeout" | "skipped" | "cancelled";

export interface AgentRunSummary {
  id: string;
  outcome: RunOutcome;
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  tokens: number;
  est_cost_usd: number | null;
  proposals: number;
  approved: number;
  rejected: number;
  comments: number;
  error: string | null;
}

export interface AgentStats {
  node_id: string;
  window_days: number;
  runs: { total: number } & Record<RunOutcome, number>;
  tokens: number;
  est_cost_usd: number;
  proposals: { made: number; approved: number; rejected: number; pending: number; withdrawn: number; approval_rate: number | null };
  comments: number;
  access_requests: number;
  blocked_by_scope: number;
  last_run_at: string | null;
  last_error: { run_id: string; at: string; message: string } | null;
  history: AgentRunSummary[];
}

interface RunRow {
  id: string;
  status: string;
  triggered_by: string;
  trace: string | null;
  started_at: string;
  finished_at: string | null;
}

interface Trace {
  usage?: Record<string, number>;
  est_cost_usd?: number;
  stopped_by?: string;
  skipped?: string;
  error?: string;
  timeout?: boolean;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

/** Sum every numeric token field of a usage object (input, output, cache…). */
function usageTotal(u: unknown): number {
  if (typeof u === "number" && Number.isFinite(u)) return u;
  if (!u || typeof u !== "object") return 0;
  let n = 0;
  for (const v of Object.values(u as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) n += v;
  }
  return n;
}

export function outcomeOf(status: string, t: Trace | null): RunOutcome {
  if (status === "running") return "running";
  if (t?.timeout || t?.stopped_by === "max_seconds" || t?.stopped_by === "timeout") return "timeout";
  if (status === "cancelled") return t?.skipped ? "skipped" : "cancelled";
  if (status === "failed") return "failed";
  return "succeeded";
}

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 200;
/** Enough for an hourly schedule over a year; the window bounds it first. */
const RUN_SCAN_MAX = 10_000;

export async function agentStats(
  nestId: string,
  nodeId: string,
  opts: { days?: number; limit?: number; now?: number } = {},
): Promise<AgentStats> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 30), 1), 365);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? HISTORY_DEFAULT), 1), HISTORY_MAX);
  const since = new Date((opts.now ?? Date.now()) - days * 86_400_000).toISOString();
  const db = getDb();

  const runs = (await db.all(
    `SELECT id, status, triggered_by, trace, started_at, finished_at FROM runs
      WHERE nest_id = ? AND agent_node = ? AND started_at >= ?
      ORDER BY started_at DESC LIMIT ?`,
    [nestId, nodeId, since, RUN_SCAN_MAX],
  )) as RunRow[];

  // Only the steps that carry an outcome: proposals and access (write),
  // comments (notify), scope blocks (also on reads) and per-turn usage. Bounded
  // to the runs scanned above, so the read/external bulk is never loaded.
  const steps = runs.length
    ? ((await db.all(
        `SELECT s.run_id, s.action, s.detail FROM run_steps s
           JOIN runs r ON r.id = s.run_id
          WHERE r.nest_id = ? AND r.agent_node = ? AND r.started_at >= ?
            AND s.detail IS NOT NULL
            AND (s.action IN ('write', 'notify') OR s.detail LIKE '%access_needed%'
                 OR s.detail LIKE '%"usage"%' OR s.detail LIKE '%"tokens"%')`,
        [nestId, nodeId, runs[runs.length - 1].started_at],
      )) as Array<{ run_id: string; action: string; detail: string }>)
    : [];

  const perRun = new Map<string, { reviews: string[]; comments: number; stepTokens: number; access: number; blocked: number }>();
  const bucket = (id: string) => {
    let b = perRun.get(id);
    if (!b) perRun.set(id, (b = { reviews: [], comments: 0, stepTokens: 0, access: 0, blocked: 0 }));
    return b;
  };
  for (const s of steps) {
    const d = parse<Record<string, unknown>>(s.detail);
    if (!d) continue;
    const b = bucket(s.run_id);
    if (d.kind === "proposal" && typeof d.review_id === "string") b.reviews.push(d.review_id);
    if (d.tool === "comment") b.comments++;
    if (d.kind === "access_request" || typeof d.access_request_id === "string") b.access++;
    if (d.kind === "access_needed") b.blocked++;
    if (d.usage !== undefined) b.stepTokens += usageTotal(d.usage);
    else if (d.tokens !== undefined) b.stepTokens += usageTotal(d.tokens);
  }

  // Verdicts for every proposal in the window, one query per chunk.
  const reviewIds = [...new Set([...perRun.values()].flatMap((b) => b.reviews))];
  const verdict = new Map<string, string>();
  for (let i = 0; i < reviewIds.length; i += 500) {
    const chunk = reviewIds.slice(i, i + 500);
    const rows = (await db.all(
      `SELECT id, status FROM review_requests WHERE nest_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
      [nestId, ...chunk],
    )) as Array<{ id: string; status: string }>;
    for (const r of rows) verdict.set(r.id, r.status);
  }

  const stats: AgentStats = {
    node_id: nodeId,
    window_days: days,
    runs: { total: runs.length, running: 0, succeeded: 0, failed: 0, timeout: 0, skipped: 0, cancelled: 0 },
    tokens: 0,
    est_cost_usd: 0,
    proposals: { made: 0, approved: 0, rejected: 0, pending: 0, withdrawn: 0, approval_rate: null },
    comments: 0,
    access_requests: 0,
    blocked_by_scope: 0,
    last_run_at: runs[0]?.started_at ?? null,
    last_error: null,
    history: [],
  };

  for (const r of runs) {
    const t = parse<Trace>(r.trace);
    const outcome = outcomeOf(r.status, t);
    stats.runs[outcome]++;
    const b = perRun.get(r.id);
    // The run's own total when it got to write one; otherwise (a crash before
    // finish) whatever its steps recorded per turn.
    const tokens = t?.usage ? usageTotal(t.usage) : b?.stepTokens ?? 0;
    const cost = typeof t?.est_cost_usd === "number" && Number.isFinite(t.est_cost_usd) ? t.est_cost_usd : null;
    stats.tokens += tokens;
    stats.est_cost_usd += cost ?? 0;

    let approved = 0;
    let rejected = 0;
    for (const id of b?.reviews ?? []) {
      const v = verdict.get(id);
      stats.proposals.made++;
      if (v === "approved") {
        approved++;
        stats.proposals.approved++;
      } else if (v === "rejected") {
        rejected++;
        stats.proposals.rejected++;
      } else if (v === "pending") stats.proposals.pending++;
      else stats.proposals.withdrawn++;
    }
    stats.comments += b?.comments ?? 0;
    stats.access_requests += b?.access ?? 0;
    stats.blocked_by_scope += b?.blocked ?? 0;

    const error = typeof t?.error === "string" ? t.error.slice(0, 500) : null;
    if (error && !stats.last_error) stats.last_error = { run_id: r.id, at: r.finished_at ?? r.started_at, message: error };

    if (stats.history.length < limit) {
      const start = Date.parse(r.started_at);
      const end = r.finished_at ? Date.parse(r.finished_at) : NaN;
      stats.history.push({
        id: r.id,
        outcome,
        triggered_by: r.triggered_by,
        started_at: r.started_at,
        finished_at: r.finished_at,
        duration_ms: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
        tokens,
        est_cost_usd: cost,
        proposals: b?.reviews.length ?? 0,
        approved,
        rejected,
        comments: b?.comments ?? 0,
        error,
      });
    }
  }

  const decided = stats.proposals.approved + stats.proposals.rejected;
  stats.proposals.approval_rate = decided ? stats.proposals.approved / decided : null;
  stats.est_cost_usd = Math.round(stats.est_cost_usd * 10_000) / 10_000;
  return stats;
}
