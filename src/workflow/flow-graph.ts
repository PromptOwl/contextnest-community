/**
 * Flow-graph acyclicity — shared by the edge and edge-type routes without
 * either importing the other (avoids an ESM import cycle).
 */
import { getDb } from "../db/client.js";
import type { Querier } from "../db/adapter.js";
import { ConflictError } from "../shared/errors.js";

/**
 * A node trail written the way the canvas reads: `"Intake" → "Review"`. Raw
 * ids ("nodes/3") named nothing the user could see (CU-wdqcq018r1). Titles come
 * from the node index; an id the index doesn't carry stands in for itself, so a
 * stale index costs clarity, never the error.
 *
 * Two cards may carry the same title, and then the titles alone name no card in
 * particular ("Draft" → "Draft"). A repeated title is written with its node id
 * — `"Draft" (nodes/draft-2)` — so every step in the trail addresses one card
 * (CU-wdqcq01k29).
 */
export async function nodeTrail(
  db: Querier,
  nestId: string,
  ids: string[],
): Promise<string> {
  const unique = [...new Set(ids)];
  const titles = new Map<string, string>();
  try {
    const rows = (await db.all(
      `SELECT node_id, title FROM node_index
        WHERE nest_id = ? AND node_id IN (${unique.map(() => "?").join(",")})`,
      [nestId, ...unique],
    )) as Array<{ node_id: string; title: string }>;
    for (const r of rows) if (r.title) titles.set(r.node_id, r.title);
  } catch {
    // No index yet (or it is mid-rebuild) — ids still describe the cycle.
  }
  const label = (id: string) => titles.get(id) ?? id;
  // A label shared by two ids in this trail can't identify either one.
  const idsPerLabel = new Map<string, Set<string>>();
  for (const id of unique) {
    const l = label(id);
    (idsPerLabel.get(l) ?? idsPerLabel.set(l, new Set()).get(l)!).add(id);
  }
  return ids
    .map((id) => {
      const l = label(id);
      const ambiguous = (idsPerLabel.get(l)?.size ?? 0) > 1;
      return ambiguous && l !== id ? `"${l}" (${id})` : `"${l}"`;
    })
    .join(" → ");
}

/**
 * Assert the WOULD-BE flow graph of a nest is acyclic. Considers edges under
 * already-flow types PLUS edges under `extraFlowTypeId` (a type about to be
 * flipped to `is_flow`), so the check can run before the flip is committed.
 *
 * Per-edge cycle guards only fire on edge *creation* while the type is already
 * flow; they can't catch a cycle assembled under a non-flow type that is later
 * flipped to flow. This is the backstop for that path. Kahn's algorithm: if any
 * node never reaches in-degree 0, the remaining subgraph contains a cycle.
 */
export async function assertFlowGraphAcyclic(
  nestId: string,
  extraFlowTypeId?: string,
): Promise<void> {
  const db = getDb();
  const rows = (await db.all(
    `SELECT e.from_node, e.to_node FROM edges e
       JOIN edge_types t ON t.id = e.type_id
      WHERE e.nest_id = ? AND (t.is_flow = 1 OR t.id = ?)`,
    [nestId, extraFlowTypeId ?? ""],
  )) as Array<{ from_node: string; to_node: string }>;

  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  const nodes = new Set<string>();
  for (const r of rows) {
    if (r.from_node === r.to_node) {
      throw new ConflictError(
        `This step loops back on itself: ${await nodeTrail(db, nestId, [r.from_node])}.\nA flow can't return to a step it already ran.`,
      );
    }
    nodes.add(r.from_node);
    nodes.add(r.to_node);
    (adj.get(r.from_node) ?? adj.set(r.from_node, []).get(r.from_node)!).push(
      r.to_node,
    );
    indeg.set(r.to_node, (indeg.get(r.to_node) ?? 0) + 1);
    if (!indeg.has(r.from_node)) indeg.set(r.from_node, 0);
  }

  const queue = [...nodes].filter((n) => (indeg.get(n) ?? 0) === 0);
  let removed = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    removed++;
    for (const nb of adj.get(cur) ?? []) {
      indeg.set(nb, (indeg.get(nb) ?? 0) - 1);
      if ((indeg.get(nb) ?? 0) === 0) queue.push(nb);
    }
  }
  if (removed < nodes.size) {
    throw new ConflictError(
      "Making this connection type a flow would loop these steps back on each other. A flow can't return to a step it already ran.",
    );
  }
}
