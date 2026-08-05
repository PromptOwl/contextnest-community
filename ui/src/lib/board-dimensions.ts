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

/**
 * The lifecycle states the server actually produces, in left→right order.
 * Mirrors DocumentLifecycleStatus in src/governance/types.ts.
 *
 * buildColumns renders every columnOrder key whether or not a node carries it,
 * so anything invented here becomes a permanently empty column. An earlier
 * list did exactly that with in_review / superseded / deprecated — none of
 * which the system emits — while omitting the real pending_review and
 * rejected, which then fell through to the auto-sorted tail.
 */
export const STATUS_ORDER = [
  "draft",
  "pending_review",
  "approved",
  "published",
  "rejected",
];

/** Headings for STATUS_ORDER — the raw keys are snake_case. */
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_review: "Pending Review",
  approved: "Approved",
  published: "Published",
  rejected: "Rejected",
};

export interface BoardConfig {
  dimension: DimensionKind;
  /** For the "tag" dimension: the namespace, e.g. "stage" groups by stage:* . */
  tagNamespace?: string;
  /** Optional explicit column ordering; unknown-but-present keys append after. */
  columnOrder?: string[];
}

export interface BoardColumn {
  key: string;
  /** Heading text. For folder columns, just the folder's own name. */
  label: string;
  /** Full, untrimmed name for the tooltip, since `label` may be shortened. */
  title: string;
}

/**
 * Folder path of a node id, with the storage prefix removed:
 * "nodes/gtm/deals/foo" → "gtm/deals"; "nodes/foo" → "" (the root).
 *
 * Server-generated ids always start with "nodes/" (see folderToSegments in
 * src/nodes/service.ts), so without stripping it EVERY document looks nested
 * one level deep: root docs bucket into a bogus "nodes" column, the "(root)"
 * column becomes unreachable, and every column key leaks the storage prefix
 * into its tooltip. Matches folderOfNode in NestView.
 *
 * An explicit id supplied at creation (an imported vault, say) can skip that
 * prefix; such ids are left alone.
 */
export function folderOf(id: string): string {
  const rel = id.startsWith("nodes/") ? id.slice("nodes/".length) : id;
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
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

/**
 * The namespace to group by, from whatever the user typed. Everything from the
 * first colon on is dropped: the field wants a namespace ("stage"), but typing
 * a whole tag ("stage:draft") is the obvious mistake, and looking for
 * `stage:draft:` would silently match nothing. Empty means "group by every tag".
 */
function namespaceOf(config: BoardConfig): string {
  return (config.tagNamespace ?? "").trim().split(":")[0]!.trim();
}

/**
 * Every column a node belongs to. Folder and status put a node in exactly one;
 * tag can put it in several, because a document carries several tags and there
 * is no basis for picking one. Nodes with nothing to group on get UNCATEGORIZED.
 */
export function cardColumnKeys(node: BoardNode, config: BoardConfig): string[] {
  switch (config.dimension) {
    case "folder":
      return [folderOf(node.id)];
    case "status":
      return [node.status || UNCATEGORIZED];
    case "tag": {
      const ns = namespaceOf(config);
      // With a namespace, group by the value after the colon; without one,
      // every tag is its own column (which is what a vault of flat tags needs).
      const values = ns
        ? node.tags
            .filter((t) => t.startsWith(`${ns}:`))
            .map((t) => t.slice(ns.length + 1))
            .filter(Boolean)
        : node.tags.filter(Boolean);
      return values.length > 0 ? [...new Set(values)] : [UNCATEGORIZED];
    }
  }
}

/**
 * The single column a node sits in. Kept for the move-planning check; on the
 * tag dimension a node can be in several columns, so prefer cardColumnKeys.
 */
export function cardColumnKey(node: BoardNode, config: BoardConfig): string {
  return cardColumnKeys(node, config)[0]!;
}

/**
 * Folder headings: the folder's own name, and only as much of its parent path
 * as it takes to be unique.
 *
 * The full path is useless as a heading — an imported vault puts every folder
 * under one long root, so the headings all truncate to the same elided prefix.
 * The last segment alone is readable but collides (`content/social` and
 * `content/published/social` both read "social"), so colliding labels grow one
 * parent segment at a time until they separate: "content/social" vs
 * "published/social". Columns that were already unique keep their short name.
 */
function disambiguateFolderLabels(keys: string[]): Map<string, string> {
  const segments = new Map(keys.map((k) => [k, k.split("/")]));
  const depth = new Map(keys.map((k) => [k, 1]));
  const labelOf = (k: string) => segments.get(k)!.slice(-depth.get(k)!).join("/");

  for (;;) {
    const byLabel = new Map<string, string[]>();
    for (const k of keys) {
      const label = labelOf(k);
      const group = byLabel.get(label);
      if (group) group.push(k);
      else byLabel.set(label, [k]);
    }
    // Deepen only the colliding ones. Terminates: each pass either deepens a
    // key (bounded by its segment count) or changes nothing and stops.
    let deepened = false;
    for (const group of byLabel.values()) {
      if (group.length < 2) continue;
      for (const k of group) {
        if (depth.get(k)! < segments.get(k)!.length) {
          depth.set(k, depth.get(k)! + 1);
          deepened = true;
        }
      }
    }
    if (!deepened) break;
  }
  return new Map(keys.map((k) => [k, labelOf(k)]));
}

function labelFor(key: string, config: BoardConfig): string {
  if (key === UNCATEGORIZED) return "Uncategorized";
  if (key === "" && config.dimension === "folder") return "(root)";
  if (config.dimension === "status") return STATUS_LABELS[key] ?? key;
  return key;
}

function titleFor(key: string, config: BoardConfig): string {
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
  for (const n of nodes) {
    for (const key of cardColumnKeys(n, config)) present.add(key);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of config.columnOrder ?? []) {
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
    present.delete(key);
  }

  const rest = [...present].filter((k) => k !== UNCATEGORIZED).sort();
  let keys = [...ordered, ...rest];
  if (present.has(UNCATEGORIZED) || [...seen].includes(UNCATEGORIZED)) {
    // UNCATEGORIZED always trails, regardless of columnOrder placement.
    keys = keys.filter((k) => k !== UNCATEGORIZED);
    keys.push(UNCATEGORIZED);
  }
  const folderLabels =
    config.dimension === "folder"
      ? disambiguateFolderLabels(
          keys.filter((k) => k !== UNCATEGORIZED && k !== ""),
        )
      : null;
  return keys.map((key) => ({
    key,
    label: folderLabels?.get(key) ?? labelFor(key, config),
    title: titleFor(key, config),
  }));
}

/**
 * Columns + a key→nodes map. Every node lands in at least one bucket — exactly
 * one for folder/status, but a multi-tagged node appears under each of its tags,
 * so on the tag dimension the column counts sum to more than the node count.
 */
export function groupByColumn(
  nodes: BoardNode[],
  config: BoardConfig,
): { columns: BoardColumn[]; byColumn: Record<string, BoardNode[]> } {
  const columns = buildColumns(nodes, config);
  const byColumn: Record<string, BoardNode[]> = {};
  for (const col of columns) byColumn[col.key] = [];
  for (const n of nodes) {
    for (const key of cardColumnKeys(n, config)) {
      (byColumn[key] ??= []).push(n);
    }
  }
  return { columns, byColumn };
}

export type MovePlan =
  | { kind: "move-folder"; folder: string }
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
    // Tag columns are read-only. Beyond the multi-tag ambiguity (a document
    // sits in one column per tag, so "moved out of this one" means nothing),
    // a tag swap is not expressible today: PATCH /nodes/:id UNIONS the tags it
    // is given with the existing set (src/nodes/service.ts), so it can add a
    // tag but never drop the old one. Retagging needs a real replace there
    // first — the same gap DocumentEditor's removeTag runs into.
    case "tag":
      return {
        kind: "unsupported",
        reason:
          "Tag columns are read-only — a document carries several tags, so edit them in the document view.",
      };
    case "status":
      return {
        kind: "unsupported",
        reason:
          "Status changes go through the review workflow, not the board — open the doc and submit for review.",
      };
  }
}
