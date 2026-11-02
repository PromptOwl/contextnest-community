/**
 * Spend (PRD §4.8): before each model call the worst-case cost is reserved;
 * organic windows stop at 90% of the nest's monthly cap, explicit asks at
 * 100%. Amounts are integer micros.
 */
export const ORGANIC_STOP = 0.9;

export function spendAllowed(b: { cap: number; spent: number; reserved: number; estimate: number; forced: boolean }): boolean {
  if (!(b.cap > 0)) return false;
  const limit = b.forced ? b.cap : Math.floor(b.cap * ORGANIC_STOP);
  return b.spent + b.reserved + b.estimate <= limit;
}

/** Thresholds (90, 100) that `before → after` crossed. */
export function thresholdsCrossed(before: number, after: number, cap: number): Array<90 | 100> {
  const out: Array<90 | 100> = [];
  if (!(cap > 0)) return out;
  const t90 = cap * ORGANIC_STOP;
  if (before < t90 && after >= t90) out.push(90);
  if (before < cap && after >= cap) out.push(100);
  return out;
}
