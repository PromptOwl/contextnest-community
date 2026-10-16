/**
 * Dead-simple in-memory rate limiter for auth endpoints.
 *
 * Strategy: sliding window counter per key (e.g. per-IP or per-email),
 * kept in a Map. Bucket entries expire lazily on access. Intentionally
 * not distributed — a single community server instance is the design
 * point, and rate-limit bypass via multi-instance would be a deployment
 * concern (put it behind a reverse proxy with fail2ban for production).
 *
 * Usage:
 *   if (!rateLimiter.tryConsume(`login:${ip}`, { max: 5, windowMs: 60_000 })) {
 *     return c.json({ error: "Too many attempts" }, 429);
 *   }
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimitConfig {
  /** Max hits allowed in the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

/** Drop expired hits in place (lazy GC). Returns the live bucket. */
function liveBucket(key: string, cutoff: number): Bucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  while (bucket.hits.length && bucket.hits[0] < cutoff) {
    bucket.hits.shift();
  }
  return bucket;
}

/**
 * Returns true if the caller is under the limit (consumes one token).
 * Returns false if rate-limited (does NOT consume).
 */
export function tryConsume(key: string, cfg: RateLimitConfig): boolean {
  const now = Date.now();
  const bucket = liveBucket(key, now - cfg.windowMs);
  if (bucket.hits.length >= cfg.max) {
    return false;
  }
  bucket.hits.push(now);
  return true;
}

/**
 * Peek the limit WITHOUT consuming. True if already at/over max.
 * Use when only failures should count (record them via recordFailure).
 */
export function isLimited(key: string, cfg: RateLimitConfig): boolean {
  return liveBucket(key, Date.now() - cfg.windowMs).hits.length >= cfg.max;
}

/**
 * Seconds until the caller may try again — for a Retry-After header after
 * tryConsume returned false. 0 when not limited. Rounded up, at least 1 while
 * limited, so a client honouring it never retries early.
 */
export function retryAfterSeconds(key: string, cfg: RateLimitConfig): number {
  const now = Date.now();
  const bucket = liveBucket(key, now - cfg.windowMs);
  if (bucket.hits.length < cfg.max) return 0;
  // The slot frees when the oldest hit that keeps us at max ages out.
  const oldest = bucket.hits[bucket.hits.length - cfg.max];
  return Math.max(1, Math.ceil((oldest + cfg.windowMs - now) / 1000));
}

/** Record one failed attempt against the key. */
export function recordFailure(key: string, cfg: RateLimitConfig): void {
  liveBucket(key, Date.now() - cfg.windowMs).hits.push(Date.now());
}

/** Clear a key's failure history (e.g. on successful auth). */
export function clear(key: string): void {
  buckets.delete(key);
}

/** Test-only helper — clear all state. */
export function _reset(): void {
  buckets.clear();
}

/** Called periodically to prevent the map from growing unbounded. */
export function sweepStale(maxAgeMs = 10 * 60_000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, bucket] of buckets.entries()) {
    if (!bucket.hits.length || bucket.hits[bucket.hits.length - 1] < cutoff) {
      buckets.delete(key);
    }
  }
}
