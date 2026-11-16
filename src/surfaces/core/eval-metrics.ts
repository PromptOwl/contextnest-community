/**
 * Judgement-eval metrics (PRD §8.3), computed at window level on the held-out
 * split. Pure: the harness hands in one row per judged window.
 */
export interface EvalWindowResult {
  id: string;
  label: "keep" | "not_keep";
  clear_keep?: boolean;
  must_never?: boolean;
  /** Explicit-ask (forced) window: scored only by explicit-ask recall. */
  forced?: boolean;
  /** Conflict slice: "true" = a real conflict with a seeded node, "paraphrase" = on-record restatement. */
  conflict?: "true" | "paraphrase" | null;
  predicted: "propose" | "no_op";
  proposed_items?: number;
  /** Labeller-judged supported items (faithfulness); undefined = not labelled. */
  supported_items?: number;
  /** The judge proposed a correction/conflict card on this window. */
  conflict_proposed?: boolean;
  cost_micros?: number;
}

export interface EvalTargets {
  recall: number;
  precision_pi: number;
  precision_lb: number;
  explicit_recall: number;
  faithfulness: number;
  must_never: number;
  conflict_precision: number;
  cpd: number;
}

export const TARGETS: EvalTargets = {
  recall: 0.6,
  precision_pi: 0.8,
  precision_lb: 0.7,
  explicit_recall: 1,
  faithfulness: 0.95,
  must_never: 0,
  conflict_precision: 0.9,
  cpd: 1,
};

/** Default windows per active channel per day until measured (§8.3). */
export const DEFAULT_W = 8;

/** Wilson score interval for k successes in n trials (95% by default). */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

function precisionAt(pi: number, r: number | null, fpr: number | null): number | null {
  if (r === null || fpr === null) return null;
  const d = pi * r + (1 - pi) * fpr;
  return d > 0 ? (pi * r) / d : null;
}

export interface EvalMetrics {
  windows: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  recall: number | null;
  recall_all: number | null;
  fpr: number | null;
  precision_at: { pi_02: number | null; pi_04: number | null; pi_06: number | null };
  precision_raw: number | null;
  precision_raw_wilson: { lo: number; hi: number };
  explicit_recall: number | null;
  faithfulness: number | null;
  must_never_proposals: number;
  conflict_precision: number | null;
  cards_per_channel_per_day: number | null;
  cost_per_1000_windows: number | null;
}

export function computeMetrics(rows: EvalWindowResult[], opts: { windowsPerDay?: number } = {}): EvalMetrics {
  const W = opts.windowsPerDay ?? DEFAULT_W;
  const scored = rows.filter((r) => !r.forced);
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0,
    clearKeep = 0,
    clearTp = 0;
  for (const r of scored) {
    const p = r.predicted === "propose";
    if (r.label === "keep") {
      if (p) tp++;
      else fn++;
      if (r.clear_keep) {
        clearKeep++;
        if (p) clearTp++;
      }
    } else if (p) fp++;
    else tn++;
  }
  const recall = ratio(clearTp, clearKeep);
  const recallAll = ratio(tp, tp + fn);
  const fpr = ratio(fp, fp + tn);
  const forced = rows.filter((r) => r.forced && !r.must_never);
  const tpRows = scored.filter((r) => r.label === "keep" && r.predicted === "propose");
  const proposedItems = tpRows.reduce((s, r) => s + (r.proposed_items ?? 0), 0);
  const labelled = tpRows.every((r) => typeof r.supported_items === "number");
  const supported = tpRows.reduce((s, r) => s + (r.supported_items ?? 0), 0);
  const conflictRows = rows.filter((r) => r.conflict && r.conflict_proposed);
  const cost = rows.reduce((s, r) => s + (r.cost_micros ?? 0), 0);
  const pi04 = precisionAt(0.04, recallAll, fpr);
  return {
    windows: rows.length,
    tp,
    fp,
    fn,
    tn,
    recall,
    recall_all: recallAll,
    fpr,
    precision_at: { pi_02: precisionAt(0.02, recallAll, fpr), pi_04: pi04, pi_06: precisionAt(0.06, recallAll, fpr) },
    precision_raw: ratio(tp, tp + fp),
    precision_raw_wilson: wilson(tp, tp + fp),
    explicit_recall: ratio(forced.filter((r) => r.predicted === "propose").length, forced.length),
    faithfulness: !labelled ? null : proposedItems > 0 ? supported / proposedItems : null,
    must_never_proposals: rows.filter((r) => r.must_never && r.predicted === "propose").length,
    conflict_precision: ratio(conflictRows.filter((r) => r.conflict === "true").length, conflictRows.length),
    cards_per_channel_per_day: recallAll === null || fpr === null ? null : W * (0.04 * recallAll + 0.96 * fpr),
    cost_per_1000_windows: rows.length ? (cost / rows.length) * 1000 : null,
  };
}

/** Which targets a report misses (null = unmeasured counts as missed, so
 *  silence or a missing label can never pass the gate). */
export function missedTargets(m: EvalMetrics, t: EvalTargets = TARGETS): string[] {
  const miss: string[] = [];
  const lt = (v: number | null, min: number) => v === null || v < min;
  if (lt(m.recall, t.recall)) miss.push("recall");
  if (lt(m.precision_at.pi_04, t.precision_pi)) miss.push("precision_pi");
  if (m.precision_raw_wilson.lo < t.precision_lb || m.precision_raw === null) miss.push("precision_lb");
  if (lt(m.explicit_recall, t.explicit_recall)) miss.push("explicit_recall");
  if (lt(m.faithfulness, t.faithfulness)) miss.push("faithfulness");
  if (m.must_never_proposals > t.must_never) miss.push("must_never");
  if (m.conflict_precision !== null && m.conflict_precision < t.conflict_precision) miss.push("conflict_precision");
  if (m.cards_per_channel_per_day === null || m.cards_per_channel_per_day > t.cpd) miss.push("cpd");
  return miss;
}
