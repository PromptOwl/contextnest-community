/**
 * Board dimensions — pure, framework-free so it's unit-testable in the node
 * test env (see test/board-dimensions.test.ts). Owns the maturity board's data
 * model: how nodes bucket into columns for a chosen dimension, and what
 * mutation a drag between columns implies. MaturityBoard owns the React state,
 * the localStorage I/O, and executing the returned MovePlan against the API.
 *
 * Why a "plan" rather than a direct write: each dimension mutates through a
 * different primitive (folder → moveNode, tag → updateNode), and one dimension
 * (status/governance) has NO direct setter — it only moves through the review
 * workflow. Keeping the decision pure lets us test the rules without a network
 * and keeps the governance guardrail in one obvious place.
 */

/** The bucket for nodes that don't carry a value for the active dimension. */
export const UNCATEGORIZED = "__uncategorized__";

/** The slice of a node the board needs. Mirrors the /nodes list payload. */
export interface BoardNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  status: string;
}

export type DimensionKind = "folder" | "status" | "tag";

export interface BoardConfig {
  dimension: DimensionKind;
  /** For the "tag" dimension: the namespace, e.g. "stage" groups by stage:* . */
  tagNamespace?: string;
  /** Optional explicit column ordering; unknown-but-present keys append after. */
  columnOrder?: string[];
}

export interface BoardColumn {
  key: string;
  /** Human label — same as key except UNCATEGORIZED and the folder root. */
  label: string;
}

/** Parent path of a path-like node id: "gtm/deals/foo" → "gtm/deals"; root → "". */
export function folderOf(id: string): string {
  const i = id.lastIndexOf("/");
  return i === -1 ? "" : id.slice(0, i);
}

/** Value carried by the first `ns:*` tag, or null. ["stage:review"] / "stage" → "review". */
export function tagValueInNamespace(
  tags: string[],
  ns: string,
): string | null {
  const prefix = `${ns}:`;
  for (const t of tags) {
    if (t.startsWith(prefix)) return t.slice(prefix.length);
  }
  return null;
}

/** Which column key a node sits in for the active dimension. */
export function cardColumnKey(node: BoardNode, config: BoardConfig): string {
  switch (config.dimension) {
    case "folder":
      return folderOf(node.id);
    case "status":
      return node.status || UNCATEGORIZED;
    case "tag": {
      const ns = config.tagNamespace?.trim();
      if (!ns) return UNCATEGORIZED;
      return tagValueInNamespace(node.tags, ns) ?? UNCATEGORIZED;
    }
  }
}

function labelFor(key: string, config: BoardConfig): string {
  if (key === UNCATEGORIZED) return "Uncategorized";
  if (key === "" && config.dimension === "folder") return "(root)";
  return key;
}

/**
 * The board's columns for the given nodes + config. Distinct keys actually
 * present in the data, ordered by `columnOrder` (those first, in that order),
 * then any remaining present keys sorted, with UNCATEGORIZED always last.
 */
export function buildColumns(
  nodes: BoardNode[],
  config: BoardConfig,
): BoardColumn[] {
  const present = new Set<string>();
  for (const n of nodes) present.add(cardColumnKey(n, config));

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of config.columnOrder ?? []) {
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
    present.delete(key);
  }

  const rest = [...present].filter((k) => k !== UNCATEGORIZED).sort();
  const keys = [...ordered, ...rest];
  if (present.has(UNCATEGORIZED) || [...seen].includes(UNCATEGORIZED)) {
    // UNCATEGORIZED always trails, regardless of columnOrder placement.
    const withoutUncat = keys.filter((k) => k !== UNCATEGORIZED);
    withoutUncat.push(UNCATEGORIZED);
    return withoutUncat.map((key) => ({ key, label: labelFor(key, config) }));
  }
  return keys.map((key) => ({ key, label: labelFor(key, config) }));
}

/** Columns + a key→nodes map. Every node lands in exactly one bucket. */
export function groupByColumn(
  nodes: BoardNode[],
  config: BoardConfig,
): { columns: BoardColumn[]; byColumn: Record<string, BoardNode[]> } {
  const columns = buildColumns(nodes, config);
  const byColumn: Record<string, BoardNode[]> = {};
  for (const col of columns) byColumn[col.key] = [];
  for (const n of nodes) {
    const key = cardColumnKey(n, config);
    (byColumn[key] ??= []).push(n);
  }
  return { columns, byColumn };
}

export type MovePlan =
  | { kind: "move-folder"; folder: string }
  | { kind: "set-tag"; tags: string[] }
  | { kind: "unsupported"; reason: string };

/**
 * What moving `node` into column `targetKey` requires. Pure — the caller runs
 * the actual write. A move into the node's current column is a no-op and
 * reported as unsupported so the UI skips a pointless request.
 */
export function planMove(
  node: BoardNode,
  targetKey: string,
  config: BoardConfig,
): MovePlan {
  if (cardColumnKey(node, config) === targetKey) {
    return { kind: "unsupported", reason: "Already in this column." };
  }
  switch (config.dimension) {
    case "folder":
      return { kind: "move-folder", folder: targetKey };
    case "tag": {
      const ns = config.tagNamespace?.trim();
      if (!ns) {
        return { kind: "unsupported", reason: "No tag namespace configured." };
      }
      const prefix = `${ns}:`;
      const kept = node.tags.filter((t) => !t.startsWith(prefix));
      const tags =
        targetKey === UNCATEGORIZED ? kept : [...kept, `${prefix}${targetKey}`];
      return { kind: "set-tag", tags };
    }
    case "status":
      return {
        kind: "unsupported",
        reason:
          "Status changes go through the review workflow, not the board — open the doc and submit for review.",
      };
  }
}
