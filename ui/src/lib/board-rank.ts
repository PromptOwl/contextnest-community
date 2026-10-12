/**
 * Per-column card order for saved boards — pure (test/board-rank.test.ts).
 * A board stores, per column, the node ids top to bottom; cards it has never
 * seen (new, or moved in from elsewhere) sit below the ranked ones in their
 * existing order, so a fresh card never jumps to the top.
 */
import { layoutKey, type BoardSettings } from "./board-dimensions";

/** Storage key of one column's order on a board. Column keys repeat across
 *  dimensions ("draft" status vs a "draft" tag), so the layout key prefixes it. */
export function rankKey(s: Pick<BoardSettings, "dimension" | "tagNamespace">, column: string): string {
  return `${layoutKey(s)}::${column}`;
}

/** Cards in board order: ranked ids first, then the rest as given. */
export function orderByRank<T extends { id: string }>(cards: T[], rank: string[] | undefined): T[] {
  if (!rank || rank.length === 0) return cards;
  const pos = new Map(rank.map((id, i) => [id, i]));
  const ranked = cards.filter((c) => pos.has(c.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  const rest = cards.filter((c) => !pos.has(c.id));
  return [...ranked, ...rest];
}

/**
 * The column's new order after placing `id` before `beforeId` (null = at the
 * bottom). `current` is the column as displayed, so unranked cards get pinned
 * where they sit — the order you see is the order saved.
 */
export function placeCard(current: string[], id: string, beforeId: string | null): string[] {
  const without = current.filter((x) => x !== id);
  if (beforeId === null || beforeId === id) {
    return beforeId === id ? current : [...without, id];
  }
  const i = without.indexOf(beforeId);
  if (i === -1) return [...without, id];
  return [...without.slice(0, i), id, ...without.slice(i)];
}
