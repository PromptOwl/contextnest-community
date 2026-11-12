/**
 * A run's cost and token totals, read once from its trace when the trace is
 * written (po-1186 CR1) and stored on the run (`runs.est_cost_micros`,
 * `runs.tokens`), as the decision verdict is, so the ledger and its rollups
 * aggregate in SQL instead of parsing every run's trace.
 */
import { safeJson } from "../shared/json.js";

function usageTotal(u: unknown): number {
  if (typeof u === "number" && Number.isFinite(u)) return u;
  if (!u || typeof u !== "object") return 0;
  let n = 0;
  for (const v of Object.values(u as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) n += v;
  return n;
}

/** `est_cost_usd` in micro-dollars (0 when absent or not positive) and the `usage` sum. */
export function runTotals(trace: unknown): { costMicros: number; tokens: number } {
  const t = (typeof trace === "string" ? safeJson(trace) : trace) as { est_cost_usd?: unknown; usage?: unknown } | null;
  if (!t || typeof t !== "object") return { costMicros: 0, tokens: 0 };
  const usd = Number(t.est_cost_usd);
  return {
    costMicros: Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : 0,
    tokens: Math.round(usageTotal(t.usage)),
  };
}
