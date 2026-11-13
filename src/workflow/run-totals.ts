/**
 * A run's cost and token totals, read once from its trace when the trace is
 * written (po-1186 CR1) and stored on the run (`runs.est_cost_micros`,
 * `runs.tokens`), as the decision verdict is, so the ledger and its rollups
 * aggregate in SQL instead of parsing every run's trace.
 */
import { safeJson } from "../shared/json.js";

/** A trace is caller-written: keep each total a non-negative safe integer, so
 *  a huge or negative value can't overflow the Postgres BIGINT columns (a
 *  failed close, or a failed 090 backfill at boot) or skew the sums. */
const bounded = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), Number.MAX_SAFE_INTEGER) : 0);

function usageTotal(u: unknown): number {
  if (typeof u === "number") return bounded(u);
  if (!u || typeof u !== "object") return 0;
  let n = 0;
  for (const v of Object.values(u as Record<string, unknown>)) if (typeof v === "number") n += bounded(v);
  return n;
}

/** `est_cost_usd` in micro-dollars (0 when absent or not positive) and the `usage` sum. */
export function runTotals(trace: unknown): { costMicros: number; tokens: number } {
  const t = (typeof trace === "string" ? safeJson(trace) : trace) as { est_cost_usd?: unknown; usage?: unknown } | null;
  if (!t || typeof t !== "object") return { costMicros: 0, tokens: 0 };
  return {
    costMicros: bounded(Number(t.est_cost_usd) * 1_000_000),
    tokens: bounded(usageTotal(t.usage)),
  };
}
