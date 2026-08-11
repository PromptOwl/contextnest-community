/**
 * Bounded-parallel batching for per-item I/O.
 *
 * Nest storage may be a network-backed mount (Cloud Storage on Cloud Run), where
 * every read or write is a round trip. Walking a few hundred documents with an
 * `await` inside a `for` loop therefore costs one full latency per document, in
 * series — which is what made importing a large folder take minutes. Batching
 * overlaps those round trips instead.
 */

/** Items processed per parallel batch. Tuned for a network mount, not a disk. */
export const IO_CONCURRENCY = 32;

/**
 * Run `fn` over `items` in bounded-parallel batches, preserving input order.
 *
 * A batch is awaited as a whole before the next one starts, so at most
 * `concurrency` operations are ever in flight. `fn` is responsible for its own
 * per-item error handling: a rejection propagates and abandons the remaining
 * batches, exactly as an `await` in a loop would.
 */
export async function mapBatched<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = IO_CONCURRENCY,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...(await Promise.all(items.slice(i, i + concurrency).map(fn))));
  }
  return out;
}
