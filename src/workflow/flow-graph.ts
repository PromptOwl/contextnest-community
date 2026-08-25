/**
 * Flow-graph acyclicity — shared by the edge and edge-type routes without
 * either importing the other (avoids an ESM import cycle).
 */
import { getDb } from "../db/client.js";
import { ConflictError } from "../shared/errors.js";

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
        `cycle: ["${r.from_node}"] — a flow edge cannot be a self-loop`,
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
      "cycle: enabling flow on this edge type would create a cycle in the flow graph — flow edges must form a DAG",
    );
  }
}
