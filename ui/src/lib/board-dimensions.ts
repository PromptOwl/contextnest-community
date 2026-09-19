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
  "external_edit_pending",
];

/** Headings for STATUS_ORDER — the raw keys are snake_case. */
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_review: "Pending Review",
  approved: "Approved",
  published: "Published",
  rejected: "Rejected",
  // Same wording as LifecycleStatusBadge, so a card's pill and its column agree.
  external_edit_pending: "External Edit",
};

export interface BoardConfig {
  dimension: DimensionKind;
  /** For the "tag" dimension: the namespace, e.g. "stage" groups by stage:* . */
  tagNamespace?: string;
  /** Optional explicit column ordering; unknown-but-present keys append after. */
  columnOrder?: string[];
  /** When true, `columnOrder` is the EXHAUSTIVE column set: only listed
   *  columns show, tags never promoted to a column don't appear, and there is
   *  no Uncategorized catch-all. A fresh tag board (no saved `columnOrder`
   *  yet) leaves this off so every present tag auto-populates, same as
   *  folder/status — it flips on the first time the user curates the board
   *  (adds, removes, or reorders a column, all of which save `columnOrder`).
   *  Folder/status never set this: they always auto-populate. */
  explicitColumns?: boolean;
  /** Columns to hide. A card whose only column(s) are hidden falls into
   *  UNCATEGORIZED; a multi-tag card keeps any still-shown column. */
  hiddenColumns?: string[];
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
function namespaceOf(config: { tagNamespace?: string }): string {
  return (config.tagNamespace ?? "").trim().split(":")[0]!.trim();
}

/**
 * Tags are stored with a leading "#" (normalizeTag, src/nodes/service.ts), but
 * a tag column key is the bare value — that is what the user types into the
 * add-column box and what reads best as a heading. Every crossing of that line
 * goes through these two: strip when deriving a key from stored tags, add back
 * when writing tags. Without it a hand-typed "doing" column writes "#doing",
 * matches no key, and the card vanishes from an explicit-column board.
 */
const stripHash = (t: string) => (t.startsWith("#") ? t.slice(1) : t);
const withHash = (t: string) => (t.startsWith("#") ? t : `#${t}`);

/** A saved column layout for one dimension. */
export interface ColumnLayout {
  columnOrder?: string[];
  hiddenColumns?: string[];
}

/** What the board persists: the chosen dimension plus a layout per dimension. */
export interface BoardSettings {
  dimension: DimensionKind;
  tagNamespace?: string;
  layouts: Record<string, ColumnLayout>;
}

/**
 * Storage key for the active dimension's layout. Column keys are
 * dimension-specific ("draft" is a status, "gtm/deals" a folder), so one shared
 * order leaked status columns onto the folder board. The tag namespace is part
 * of the key too, since it changes which tag values are columns.
 */
export function layoutKey(s: {
  dimension: DimensionKind;
  tagNamespace?: string;
}): string {
  return s.dimension === "tag" ? `tag:${namespaceOf(s)}` : s.dimension;
}

/**
 * One saved layout, brought up to date with the current key spelling.
 *
 * Tag column keys used to be the tag exactly as stored, "#" and all. A layout
 * saved back then holds keys like "#GDPR"; card keys are the bare value now, so
 * every one of those columns renders — and matches nothing, leaving a board of
 * empty columns. Stripping on read repairs a curated board in place instead of
 * asking the user to rebuild it. Folder/status keys never carried a "#", so
 * they are returned untouched.
 */
export function migrateLayout(key: string, layout: ColumnLayout): ColumnLayout {
  if (!key.startsWith("tag:")) return layout;
  const keys = (a?: string[]) => a && [...new Set(a.map(stripHash))];
  return {
    columnOrder: keys(layout.columnOrder),
    hiddenColumns: keys(layout.hiddenColumns),
  };
}

/** The BoardConfig for the active dimension: its own layout, nothing else's. */
export function resolveConfig(s: BoardSettings): BoardConfig {
  const layout = s.layouts[layoutKey(s)] ?? {};
  return {
    dimension: s.dimension,
    tagNamespace: s.tagNamespace,
    // Status defaults to the lifecycle order until the user reorders it.
    columnOrder:
      layout.columnOrder ??
      (s.dimension === "status" ? STATUS_ORDER : undefined),
    hiddenColumns: layout.hiddenColumns,
    // The tag board is user-curatable, but starts auto-populated: every
    // present tag is a column, exactly like folder/status, until the user
    // touches the layout (add/remove/reorder) — that's the first time
    // `columnOrder` is saved, and from then on it's the EXHAUSTIVE set (see
    // the field doc above). A nest with many tags would otherwise render
    // zero columns until each one is typed in by hand.
    explicitColumns: s.dimension === "tag" && layout.columnOrder !== undefined,
  };
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
      const tags = node.tags.map(stripHash);
      // With a namespace, group by the value after the colon; without one,
      // every tag is its own column (which is what a vault of flat tags needs).
      const values = ns
        ? tags
            .filter((t) => t.startsWith(`${ns}:`))
            .map((t) => t.slice(ns.length + 1))
            .filter(Boolean)
        : tags.filter(Boolean);
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
 * The columns a node actually appears in once hidden columns are removed: its
 * column keys minus any hidden ones. If every one is hidden it collects in
 * UNCATEGORIZED, so removing a column never makes documents disappear.
 */
function shownKeys(
  node: BoardNode,
  config: BoardConfig,
  hidden: Set<string>,
): string[] {
  const keys = cardColumnKeys(node, config).filter((k) => !hidden.has(k));
  // Explicit-column boards (the tag board) show ONLY the columns the user has
  // added: a card whose tags match none of them simply doesn't appear, and
  // there is no Uncategorized catch-all.
  if (config.explicitColumns) {
    const allowed = new Set(
      (config.columnOrder ?? []).filter((k) => !hidden.has(k)),
    );
    return keys.filter((k) => allowed.has(k));
  }
  return keys.length > 0 ? keys : [UNCATEGORIZED];
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
  // A status the server grew but this map hasn't: spaces beat raw snake_case,
  // since the heading is rendered with CSS `capitalize`.
  if (config.dimension === "status")
    return STATUS_LABELS[key] ?? key.replace(/_/g, " ");
  return key;
}

/**
 * Whether the Board column header should get CSS `text-transform: capitalize`.
 * Tag column keys/labels are the raw tag value (see `labelFor` above), the
 * same value the card's tag chip renders uncapitalized — capitalizing only
 * the header would make the two disagree on casing. Folder and status labels
 * have no such chip to match, so they keep the capitalize styling.
 */
export function capitalizeColumnHeader(dimension: DimensionKind): boolean {
  return dimension !== "tag";
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
  const hidden = new Set(config.hiddenColumns ?? []);
  // Explicit-column board: the columns ARE columnOrder (minus hidden), in that
  // order — nothing auto-appears, nothing trails. An empty order = empty board.
  if (config.explicitColumns) {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const key of config.columnOrder ?? []) {
      if (hidden.has(key) || key === UNCATEGORIZED || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys.map((key) => ({
      key,
      label: labelFor(key, config),
      title: titleFor(key, config),
    }));
  }
  const present = new Set<string>();
  for (const n of nodes) {
    for (const key of shownKeys(n, config, hidden)) present.add(key);
  }
  const needUncat = present.has(UNCATEGORIZED);
  present.delete(UNCATEGORIZED);

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of config.columnOrder ?? []) {
    if (hidden.has(key) || key === UNCATEGORIZED || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
    present.delete(key);
  }

  const rest = [...present].sort();
  const keys = [...ordered, ...rest];
  // UNCATEGORIZED always trails, regardless of columnOrder placement.
  if (needUncat) keys.push(UNCATEGORIZED);
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
  const hidden = new Set(config.hiddenColumns ?? []);
  const columns = buildColumns(nodes, config);
  const byColumn: Record<string, BoardNode[]> = {};
  for (const col of columns) byColumn[col.key] = [];
  for (const n of nodes) {
    for (const key of shownKeys(n, config, hidden)) {
      (byColumn[key] ??= []).push(n);
    }
  }
  return { columns, byColumn };
}

export type MovePlan =
  | { kind: "move-folder"; folder: string }
  | { kind: "retag"; tags: string[] }
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
  fromKey?: string,
): MovePlan {
  switch (config.dimension) {
    case "folder":
      if (cardColumnKey(node, config) === targetKey) {
        return { kind: "unsupported", reason: "Already in this column." };
      }
      return { kind: "move-folder", folder: targetKey };
    // Dragging between tag columns retags the node: drop the source column's
    // tag, add the target's. `updateNode` REPLACES the tag set on PATCH
    // (src/nodes/service.ts), so sending the full next set both adds and
    // removes in one write — the old "tag columns are read-only / PATCH
    // unions tags" limitation no longer holds. `fromKey` (the column the card
    // was dragged out of) disambiguates which tag to drop for a multi-tagged
    // card; without it we only add.
    case "tag": {
      if (targetKey === UNCATEGORIZED) {
        return {
          kind: "unsupported",
          reason: "Drop onto a tag column to add that tag.",
        };
      }
      if (fromKey && fromKey === targetKey) {
        return { kind: "unsupported", reason: "Already in this column." };
      }
      const ns = namespaceOf(config);
      // Column key → the tag as stored, "#" and all; the existing set is
      // normalized the same way so the drop actually removes the source tag.
      const asTag = (key: string) => withHash(ns ? `${ns}:${key}` : key);
      const removing =
        fromKey && fromKey !== UNCATEGORIZED ? asTag(fromKey) : null;
      const toTag = asTag(targetKey);
      const next = new Set(node.tags.map(withHash));
      if (removing) next.delete(removing);
      // Nothing to remove and the target tag is already there → pure no-op.
      if (!removing && next.has(toTag)) {
        return { kind: "unsupported", reason: "Already in this column." };
      }
      next.add(toTag);
      return { kind: "retag", tags: [...next] };
    }
    case "status":
      return {
        kind: "unsupported",
        reason:
          "Status changes go through the review workflow, not the board — open the doc and submit for review.",
      };
  }
}
