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

// ─── S2b: routing and the queue (§4.8) ─────────────────────────────────────

export const QUEUE_MAX = 10;
export const RELEASE_HOUR = 9;

export type RouteDecision =
  | { action: "post"; reviewer: string | null; countsAgainstBudget: boolean }
  | { action: "queue"; reviewer: string; reason: "budget" | "capped" }
  | { action: "hold"; reason: "no_approver" | "none_in_conversation" };

/**
 * Where a new proposal goes. `ranked` is the eligible reviewers in §4.8
 * order; each carries today's usage. Forced (explicit asks) post at once,
 * name the first-ranked reviewer if any, and never count. Organic: no
 * eligible reviewer → held; the conversation already posted its daily cards
 * → queued (`capped`); otherwise the first reviewer with budget left posts,
 * and if none has budget → queued for the first-ranked (`budget`).
 */
export function route(input: {
  forced: boolean;
  ranked: Array<{ userId: string; usedToday: number }>;
  hasAnyApprover: boolean;
  reviewerDailyCards: number;
  conversationPostedToday: number;
  conversationDailyCards: number;
}): RouteDecision {
  const first = input.ranked[0]?.userId ?? null;
  if (input.forced) return { action: "post", reviewer: first, countsAgainstBudget: false };
  if (!first) return { action: "hold", reason: input.hasAnyApprover ? "none_in_conversation" : "no_approver" };
  if (input.conversationPostedToday >= input.conversationDailyCards) return { action: "queue", reviewer: first, reason: "capped" };
  const withBudget = input.ranked.find((r) => r.usedToday < input.reviewerDailyCards);
  if (withBudget) return { action: "post", reviewer: withBudget.userId, countsAgainstBudget: true };
  return { action: "queue", reviewer: first, reason: "budget" };
}

/** When the queue is full, which proposal is dropped: the lowest confidence
 *  (ties: the newest), possibly the incoming one. */
export function pickOverflow<T extends { id: string; confidence: number; created_at: string }>(queued: T[], incoming: T, max = QUEUE_MAX): T | null {
  if (queued.length < max) return null;
  const all = [...queued, incoming];
  return all.reduce((lo, x) => (x.confidence < lo.confidence || (x.confidence === lo.confidence && x.created_at > lo.created_at) ? x : lo));
}

function partsIn(ms: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  } catch {
    f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** The org-timezone calendar day (YYYY-MM-DD) of an instant. */
export function orgDay(ms: number, tz: string): string {
  const p = partsIn(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** 09:00 on the next org-timezone day after `ms`, as a UTC instant. */
export function nextReleaseAt(ms: number, tz: string): number {
  const p = partsIn(ms, tz);
  // Local wall-clock 09:00 tomorrow, then correct for the zone's offset at that instant.
  const guess = Date.UTC(p.y, p.m - 1, p.d + 1, RELEASE_HOUR, 0, 0);
  const q = partsIn(guess, tz);
  const shown = Date.UTC(q.y, q.m - 1, q.d, q.h, q.mi, q.s);
  return guess - (shown - guess);
}
