/** Bulk-select helpers for the Documents list (CU-wdqcq05rbt). `selected` is
 *  the list's id → node map; `nodes` is the group a select-all box covers. */
type Node = { id: string };

/** Checkbox state for a group: all, some or none of it selected. */
export function selectionState(selected: Map<string, unknown>, nodes: Node[]): boolean | "indeterminate" {
  const hit = nodes.filter((n) => selected.has(n.id)).length;
  if (hit === 0) return false;
  return hit === nodes.length ? true : "indeterminate";
}

/** Select the whole group, or deselect it when it is already fully selected. */
export function toggleMany<T extends Node>(selected: Map<string, T>, nodes: T[]): Map<string, T> {
  const next = new Map(selected);
  const all = nodes.length > 0 && nodes.every((n) => next.has(n.id));
  for (const n of nodes) {
    if (all) next.delete(n.id);
    else next.set(n.id, n);
  }
  return next;
}
