/**
 * Marketplace Pricing Math
 * ========================
 *
 * Three pure helpers governing the marketplace economics. Integer
 * microcent math only — no floating point.
 *
 * Units:
 *   - 1 cent = 10_000 microcents (μ¢)
 *   - Rates are expressed as "μ¢ per 1000 tokens" so we can represent
 *     fractional per-token prices without losing precision.
 *   - Percentages are expressed in basis points (bps): 1% = 100 bps.
 *
 * These functions are the source of truth for:
 *   - The publisher-side floor (publishers can't set rates below it)
 *   - The consumer-side charge for each query
 *   - The platform/publisher revenue split
 *
 * Invariants pinned by tests:
 *   - Floor is rounded UP (never undershoot the margin target)
 *   - Charge is rounded UP (consumers never get free fractional tokens)
 *   - Split: publisher rounded DOWN, platform gets any remainder
 *     (so publisher + platform === charge exactly)
 *
 * Lives in `core` so the same math powers community + TheOwl. Pure —
 * no DB, no I/O, safe to import anywhere.
 */

/**
 * Compute the minimum allowed publisher rate so every query covers
 * compute cost plus the platform's margin.
 *
 * @param avgComputeCostPer1kMicrocents Our average compute cost per
 *        1000 tokens, in microcents.
 * @param marginBps Desired margin above cost, in basis points.
 *        e.g. 6000 = 60%.
 * @returns The floor in microcents per 1000 tokens, rounded up so it
 *          never falls below the target margin.
 */
export function computeRateFloor(
  avgComputeCostPer1kMicrocents: number,
  marginBps: number,
): number {
  if (avgComputeCostPer1kMicrocents < 0) {
    throw new Error("computeRateFloor: cost must be positive");
  }
  if (marginBps < 0) {
    throw new Error("computeRateFloor: margin must be positive");
  }
  if (avgComputeCostPer1kMicrocents === 0) return 0;
  const numerator = avgComputeCostPer1kMicrocents * (10_000 + marginBps);
  return Math.ceil(numerator / 10_000);
}

/**
 * Calculate the charge for a single query in microcents.
 *
 * @param tokens Output tokens in the response (what the consumer
 *        actually received).
 * @param ratePer1kMicrocents Publisher's rate in μ¢ per 1000 tokens.
 * @returns Total charge in microcents, rounded up. Zero when either
 *          input is zero.
 */
export function calculateQueryCharge(
  tokens: number,
  ratePer1kMicrocents: number,
): number {
  if (tokens < 0) throw new Error("calculateQueryCharge: tokens cannot be negative");
  if (ratePer1kMicrocents < 0)
    throw new Error("calculateQueryCharge: rate cannot be negative");
  if (tokens === 0 || ratePer1kMicrocents === 0) return 0;
  return Math.ceil((tokens * ratePer1kMicrocents) / 1000);
}

/**
 * Split a charge between the publisher and the platform.
 *
 * Publisher is rounded DOWN so we never "owe" a fraction we haven't
 * actually collected; platform absorbs any 1-μ¢ remainder.
 *
 * @param chargeMicrocents Total charge to the consumer in microcents.
 * @param platformFeeBps Platform take in basis points. e.g. 3000 = 30%.
 * @returns { publisher, platform } in microcents. Always satisfies
 *          publisher + platform === chargeMicrocents.
 */
export function splitRevenue(
  chargeMicrocents: number,
  platformFeeBps: number,
): { publisher: number; platform: number } {
  if (chargeMicrocents < 0)
    throw new Error("splitRevenue: charge cannot be negative");
  if (platformFeeBps < 0 || platformFeeBps > 10_000)
    throw new Error("splitRevenue: fee must be in 0..10000 bps");
  const publisherBps = 10_000 - platformFeeBps;
  const publisher = Math.floor((chargeMicrocents * publisherBps) / 10_000);
  const platform = chargeMicrocents - publisher;
  return { publisher, platform };
}
