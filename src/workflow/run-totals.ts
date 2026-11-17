/**
 * A run's cost and token totals, read once from its trace when the trace is
 * written (po-1186 CR1) and stored on the run (`runs.est_cost_micros`,
 * `runs.tokens`), as the decision verdict is, so the ledger and its rollups
 * aggregate in SQL instead of parsing every run's trace.
 */
import { safeJson } from "../shared/json.js";

/**
 * A trace is caller-written, so each run's totals are capped at a realistic
 * maximum. The caps keep a huge value from overflowing the Postgres BIGINT
 * columns (a failed close, or a failed 090 backfill at boot), and keep the
 * ledger's SQL SUM() under 2^63: SQLite raises "integer overflow" past it,
 * and that would fail the totals and rollups of a whole nest. At these caps
 * that takes ~9 million runs.
 */
export const MAX_RUN_TOKENS = 1_000_000_000_000; // 1e12 tokens
export const MAX_RUN_COST_MICROS = 100_000_000_000; // $100 000, AgentRunCloseBody's est_cost_usd max

const bounded = (n: number, max: number): number => (Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : 0);

function usageTotal(u: unknown): number {
  if (typeof u === "number") return bounded(u, MAX_RUN_TOKENS);
  if (!u || typeof u !== "object") return 0;
  let n = 0;
  for (const v of Object.values(u as Record<string, unknown>)) if (typeof v === "number") n += bounded(v, MAX_RUN_TOKENS);
  return n;
}

/** `est_cost_usd` in micro-dollars (0 when absent or not positive) and the `usage` sum, both capped. */
export function runTotals(trace: unknown): { costMicros: number; tokens: number } {
  const t = (typeof trace === "string" ? safeJson(trace) : trace) as { est_cost_usd?: unknown; usage?: unknown } | null;
  if (!t || typeof t !== "object") return { costMicros: 0, tokens: 0 };
  return {
    costMicros: bounded(Number(t.est_cost_usd) * 1_000_000, MAX_RUN_COST_MICROS),
    tokens: bounded(usageTotal(t.usage), MAX_RUN_TOKENS),
  };
}
