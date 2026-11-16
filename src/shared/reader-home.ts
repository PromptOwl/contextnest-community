/**
 * Reader-mode home node resolution (CU-wdqcq05ran).
 *
 * `nests.reader_home_node` is a soft pointer typed by hand or sent over the
 * API (PATCH /nests/:nestId/reader-mode), so it may be the full node id
 * (`nodes/docs/welcome`) or just its bare slug (`welcome`), in any case. The
 * SPA reader and the static docs site must land on the same page for the same
 * value, so both use this one rule — the UI mirrors it in
 * ui/src/lib/nest-caps.ts (`pickHomeNode`), and test/site-units.test.ts runs
 * the same cases through both.
 *
 * The rule:
 *  1. a node whose full id equals the value, case-insensitively, wins;
 *  2. otherwise a node whose last id segment equals the value's last segment,
 *     case-insensitively ("welcome" finds `nodes/docs/welcome`);
 *  3. when several nodes share that slug, the lowest id (plain string order)
 *     wins, so the pick never depends on how the list happens to be ordered;
 *  4. a blank value, or one matching nothing, resolves to nothing — callers
 *     then apply their own naming-convention fallback.
 */

/** Lowercased last segment of a node id — "nodes/guides/Welcome" → "welcome". */
export function homeLeaf(id: string): string {
  const i = id.lastIndexOf("/");
  return (i === -1 ? id : id.slice(i + 1)).toLowerCase();
}

/** The designated home among `items`, or undefined when `home` matches none. */
export function pickHomeNode<T>(items: readonly T[], home: string | null | undefined, idOf: (item: T) => string): T | undefined {
  const want = (home ?? "").trim().toLowerCase();
  if (!want) return undefined;
  const exact = items.find((item) => idOf(item).toLowerCase() === want);
  if (exact) return exact;
  const leaf = homeLeaf(want);
  let best: T | undefined;
  for (const item of items) {
    if (homeLeaf(idOf(item)) !== leaf) continue;
    if (best === undefined || idOf(item) < idOf(best)) best = item;
  }
  return best;
}
