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

import {
  fieldColumnKeys,
  fieldColumnOrder,
  fieldKeyLabel,
  fieldValueForMove,
  type FieldDefinition,
} from "./custom-fields";

/** The bucket for nodes that don't carry a value for the active dimension. */
export const UNCATEGORIZED = "__uncategorized__";

/** The slice of a node the board needs. Mirrors the /nodes list payload. */
export interface BoardNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  status: string;
  /** Board fields + timestamps, from the node listing (src/nodes/task-fields.ts). */
  assignee?: string;
  assigned_at?: string;
  due?: string;
  priority?: string;
  parent?: string;
  moved_at?: string;
  completed_at?: string;
  created_at?: string;
  updated_at?: string;
  /** Document-scope prime flag; undefined = inherit from tags. */
  prime?: boolean;
  /** Blocking relations from nodes not yet in a done column (server-counted,
   *  including blockers this viewer can't read). */
  open_blockers?: number;
  /** Custom field values (stored + computed), key → value. */
  fields?: Record<string, unknown>;
  /** When the node entered its current column — time-in-status counts from it. */
  status_since?: string;
}

export type DimensionKind = "folder" | "status" | "tag" | "assignee" | "priority" | "field";

/** Field-valued dimensions: a column is a value of a board field, and a drag
 *  between columns sets that field (Linear's group-by-assignee/priority). */
export function isFieldDimension(d: DimensionKind): d is "assignee" | "priority" {
  return d === "assignee" || d === "priority";
}

/** Linear's order, most urgent first. */
export const PRIORITY_ORDER = ["urgent", "high", "medium", "low"];
const PRIORITY_COLUMN_LABELS: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

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
  /** For the "field" dimension: the custom field whose values are columns. */
  field?: FieldDefinition;
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
  /** Heading text. For folder columns, the full folder path, shortened from
   *  the front (see `folderColumnLabel`) so a deep path still shows its leaf
   *  segment — a shortened leaf-only label loses hierarchy and can't tell
   *  "a/notes" from "b/notes" apart, but the CSS `truncate` the header uses
   *  elides from the END, which for an untouched long path hides the leaf —
   *  the one segment that actually names the folder. `title` carries the full,
   *  unshortened text. */
  label: string;
  /** Full, untrimmed name for the tooltip. Same as `label` for folder columns. */
  title: string;
}

/**
 * Shortens a folder path for display, dropping segments from the front (the
 * end closest to the root) until it fits within `maxChars`, so the leaf
 * segment — the folder's actual name, and the last thing a browser's
 * end-eliding `truncate` would clip — is always the part kept. The leaf is
 * kept even if it alone exceeds `maxChars`; the header's own `truncate`
 * handles that remaining overflow, clipping from a point that still shows the
 * leaf's start rather than the path's root.
 *
 * `maxChars` defaults to roughly what fits in the board's column header
 * (w-64, see MaturityBoard.tsx) before the browser starts eliding anyway.
 */
export function folderColumnLabel(path: string, maxChars = 28): string {
  if (path.length <= maxChars) return path;
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    const candidate = `…/${segments.slice(i).join("/")}`;
    if (candidate.length <= maxChars || i === segments.length - 1) {
      return candidate;
    }
  }
  return path;
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

/**
 * Pattern columns (CU-wdqcq05pad). On the tag board a column key with a "*"
 * — "status*", "*-review" — is a pattern, not a tag: it stands for one column
 * per matching tag on the board, sorted, at the pattern's place in the order,
 * so a status that appears later gets its column with no setup. A tag that
 * is also listed as its own column keeps that column instead. Matching is a
 * case-insensitive whole-value glob, "*" being any run of characters; it is
 * deliberately not a regex — the server evaluates saved boards too, and a
 * user's regex there is a catastrophic-backtracking risk.
 */
export function isColumnPattern(key: string): boolean {
  return key.includes("*");
}

/** Whole-value glob match. No regex: the greedy last-star backtrack is
 *  O(value × pattern) at worst — never exponential — and saved column keys
 *  are capped at 600 characters server-side (board-service strList). */
export function globMatch(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  let pi = 0;
  let vi = 0;
  let star = -1;
  let mark = 0;
  while (vi < v.length) {
    if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = vi;
    } else if (pi < p.length && p[pi] === v[vi]) {
      pi++;
      vi++;
    } else if (star >= 0) {
      pi = star + 1;
      vi = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/**
 * A column order rebuilt from the visible columns (a reorder) with the saved
 * patterns carried over. The board only ever sees a pattern's expansion, so
 * the rebuilt order would otherwise lose the pattern and stop picking up new
 * tags. A reorder pins the expanded tags it writes out; add and remove edit
 * the saved order instead, so they pin nothing.
 */
export function withoutPattern(order: string[] | undefined, pattern: string): string[] {
  // Its columns go with it — including ones a reorder pinned in place.
  return (order ?? []).filter((k) => k !== pattern && !globMatch(pattern, k));
}

export function keepPatterns(order: string[], saved: string[] | undefined): string[] {
  return [...new Set([...order, ...(saved ?? []).filter(isColumnPattern)])];
}

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
  /** Show only `task` nodes — a project board rather than a nest map. */
  tasksOnly?: boolean;
  /** Show only cards carrying every one of these tags (bare, no "#"). */
  filterTags?: string[];
  /** Saved boards only: per-column card order, keyed by board-rank's rankKey. */
  ranks?: Record<string, string[]>;
  /** Sub-group columns into lanes. */
  swimlane?: SwimlaneKind;
  /** Hide cards completed more than this many days ago. */
  hideDoneAfterDays?: number;
  /** dimension "field": the custom field key whose values are the columns. */
  fieldKey?: string;
  /** swimlane "field": the custom field key whose values are the lanes. */
  swimlaneField?: string;
  /** Only cards whose custom fields match, key → value ("none" = unset). */
  filterFields?: Record<string, string>;
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
  fieldKey?: string;
}): string {
  if (s.dimension === "field") return `field:${s.fieldKey ?? ""}`;
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
export function resolveConfig(s: BoardSettings, fieldDefs: FieldDefinition[] = []): BoardConfig {
  const layout = s.layouts[layoutKey(s)] ?? {};
  const field =
    s.dimension === "field" ? fieldDefs.find((d) => d.key === s.fieldKey) : undefined;
  return {
    dimension: s.dimension,
    field,
    tagNamespace: s.tagNamespace,
    // Status defaults to the lifecycle order until the user reorders it.
    columnOrder:
      layout.columnOrder ??
      (s.dimension === "status"
        ? STATUS_ORDER
        : s.dimension === "priority"
          ? PRIORITY_ORDER
          : field
            ? fieldColumnOrder(field)
            : undefined),
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
    case "assignee":
      return [node.assignee ? node.assignee.toLowerCase() : UNCATEGORIZED];
    case "priority":
      return [node.priority || UNCATEGORIZED];
    case "field":
      return config.field
        ? fieldColumnKeys(config.field, node.fields?.[config.field.key])
        : [UNCATEGORIZED];
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
    const order = (config.columnOrder ?? []).filter((k) => !hidden.has(k));
    const allowed = new Set(order);
    const patterns = order.filter(isColumnPattern);
    return keys.filter((k) => allowed.has(k) || patterns.some((p) => globMatch(p, k)));
  }
  return keys.length > 0 ? keys : [UNCATEGORIZED];
}

/** The catch-all column's name, which on a field board is a real value. */
function uncategorizedLabel(d: DimensionKind, field?: FieldDefinition): string {
  if (d === "field" && field) return fieldKeyLabel(field, UNCATEGORIZED);
  if (d === "assignee") return "Unassigned";
  if (d === "priority") return "No priority";
  return "Uncategorized";
}

function labelFor(key: string, config: BoardConfig): string {
  if (key === UNCATEGORIZED) return uncategorizedLabel(config.dimension, config.field);
  if (config.dimension === "field" && config.field) return fieldKeyLabel(config.field, key);
  if (config.dimension === "priority") return PRIORITY_COLUMN_LABELS[key] ?? key;
  if (key === "" && config.dimension === "folder") return "(root)";
  // A status the server grew but this map hasn't: spaces beat raw snake_case,
  // since the heading is rendered with CSS `capitalize`.
  if (config.dimension === "status")
    return STATUS_LABELS[key] ?? key.replace(/_/g, " ");
  if (config.dimension === "folder") return folderColumnLabel(key);
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
  // Assignee columns are email addresses — capitalizing them misspells them.
  // Field values are what the admin typed — keep their casing.
  return dimension !== "tag" && dimension !== "assignee" && dimension !== "field";
}

function titleFor(key: string, config: BoardConfig): string {
  if (key === UNCATEGORIZED) return uncategorizedLabel(config.dimension, config.field);
  if (config.dimension === "field" && config.field) return fieldKeyLabel(config.field, key);
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
  /** Folders holding nothing yet — columns on the folder board, as in the
   *  sidebar tree, so an empty folder exists in both or neither (CU-wdqcq04wnz). */
  emptyFolders: string[] = [],
): BoardColumn[] {
  const hidden = new Set(config.hiddenColumns ?? []);
  // Explicit-column board: the columns ARE columnOrder (minus hidden), in that
  // order — nothing auto-appears, nothing trails. An empty order = empty board.
  if (config.explicitColumns) {
    const order = config.columnOrder ?? [];
    const listed = new Set(order.filter((k) => !isColumnPattern(k)));
    // Tag values on the board's cards, for patterns to expand against.
    const tagged = new Set<string>();
    if (order.some(isColumnPattern)) {
      for (const n of nodes) for (const k of cardColumnKeys(n, config)) tagged.add(k);
      tagged.delete(UNCATEGORIZED);
    }
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const key of order) {
      if (hidden.has(key) || key === UNCATEGORIZED || seen.has(key)) continue;
      seen.add(key);
      if (!isColumnPattern(key)) {
        keys.push(key);
        continue;
      }
      for (const t of [...tagged].sort()) {
        if (seen.has(t) || listed.has(t) || hidden.has(t) || !globMatch(key, t)) continue;
        seen.add(t);
        keys.push(t);
      }
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
  if (config.dimension === "folder") {
    for (const f of emptyFolders) if (f && !hidden.has(f)) present.add(f);
  }
  // On a field board "Unassigned"/"No priority" is a value you drag TO, so it
  // stays as a drop target even when nothing is in it.
  // A checkbox board has no "unset" column — unset reads as unchecked.
  const needUncat =
    present.has(UNCATEGORIZED) ||
    isFieldDimension(config.dimension) ||
    (config.dimension === "field" && !!config.field && config.field.type !== "checkbox");
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
  return keys.map((key) => ({
    key,
    label: labelFor(key, config),
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
  emptyFolders: string[] = [],
): { columns: BoardColumn[]; byColumn: Record<string, BoardNode[]> } {
  const hidden = new Set(config.hiddenColumns ?? []);
  const columns = buildColumns(nodes, config, emptyFolders);
  const byColumn: Record<string, BoardNode[]> = {};
  for (const col of columns) byColumn[col.key] = [];
  for (const n of nodes) {
    for (const key of shownKeys(n, config, hidden)) {
      (byColumn[key] ??= []).push(n);
    }
  }
  return { columns, byColumn };
}

/**
 * What the tag board's add-column box offers as you type: the tags on the
 * nest's cards — all of them, since on a curated board the cards not shown
 * are the ones whose tags are worth adding — with how many cards carry each,
 * most used first, minus the ones already a column (directly or through a
 * pattern). `query` is a case-insensitive substring.
 */
export function tagSuggestions(
  nodes: BoardNode[],
  config: BoardConfig,
  query: string,
): Array<{ value: string; count: number }> {
  if (config.dimension !== "tag") return [];
  const shown = new Set(buildColumns(nodes, config).map((c) => c.key));
  const counts = new Map<string, number>();
  for (const n of nodes) {
    for (const k of cardColumnKeys(n, config)) {
      if (k !== UNCATEGORIZED) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const q = query.trim().replace(/^#/, "").toLowerCase();
  return [...counts]
    .filter(([v]) => !shown.has(v) && (!q || v.toLowerCase().includes(q)))
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([value, count]) => ({ value, count }));
}

export type MovePlan =
  | { kind: "move-folder"; folder: string }
  | { kind: "retag"; tags: string[] }
  | { kind: "set-fields"; fields: { assignee?: string | null; priority?: string | null } }
  /** Custom field values — merged server-side, so only this key is sent. */
  | { kind: "set-custom"; fields: Record<string, unknown> }
  | { kind: "unsupported"; reason: string };

/**
 * The card as it will look once `plan` (plus a lane change's `extra` fields)
 * lands — shown right away on drop, so the card moves before the server
 * answers. A folder move guesses the new id; the background reload corrects it.
 */
export function optimisticMove(
  node: BoardNode,
  plan: MovePlan | null,
  extra: { fields?: Record<string, unknown>; [k: string]: unknown } = {},
): BoardNode {
  const next: BoardNode = { ...node };
  const custom: Record<string, unknown> = {};
  if (plan?.kind === "move-folder") {
    const slug = node.id.slice(node.id.lastIndexOf("/") + 1);
    next.id = plan.folder && plan.folder !== UNCATEGORIZED ? `nodes/${plan.folder}/${slug}` : `nodes/${slug}`;
  } else if (plan?.kind === "retag") {
    next.tags = plan.tags;
  } else if (plan?.kind === "set-fields") {
    Object.assign(next, plan.fields);
  } else if (plan?.kind === "set-custom") {
    Object.assign(custom, plan.fields);
  }
  const { fields: extraFields, ...extraTop } = extra;
  Object.assign(next, extraTop);
  Object.assign(custom, extraFields ?? {});
  for (const k of ["assignee", "priority", "due", "parent"] as const) {
    if ((next as any)[k] === null) delete (next as any)[k];
  }
  if (Object.keys(custom).length > 0) {
    const fields = { ...(node.fields ?? {}) };
    for (const [k, v] of Object.entries(custom)) {
      if (v === null) delete fields[k];
      else fields[k] = v;
    }
    next.fields = fields;
  }
  return next;
}

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
    case "field": {
      const def = config.field;
      if (!def) return { kind: "unsupported", reason: "This field no longer exists." };
      if (def.type === "time_in_status") {
        return { kind: "unsupported", reason: "Time in status is computed — it can't be set." };
      }
      if (fromKey ? fromKey === targetKey : cardColumnKey(node, config) === targetKey) {
        return { kind: "unsupported", reason: "Already in this column." };
      }
      const value = fieldValueForMove(def, node.fields?.[def.key], targetKey, fromKey);
      return { kind: "set-custom", fields: { [def.key]: value } };
    }
    case "assignee":
    case "priority": {
      if (cardColumnKey(node, config) === targetKey) {
        return { kind: "unsupported", reason: "Already in this column." };
      }
      const value = targetKey === UNCATEGORIZED ? null : targetKey;
      return { kind: "set-fields", fields: { [config.dimension]: value } };
    }
  }
}

/**
 * Where a card created from a column's "+ Add task" lands, so it shows up in
 * the column it was added from: the column's tag (tag board) or folder
 * (folder board). Null on the status board — a new node's status is decided
 * by governance, not by which column you clicked.
 */
export function newCardPlacement(
  columnKey: string,
  config: BoardConfig,
): {
  tags?: string[];
  folder?: string;
  assignee?: string;
  priority?: string;
  fields?: Record<string, unknown>;
} | null {
  switch (config.dimension) {
    case "field": {
      const def = config.field;
      if (!def || def.type === "time_in_status") return null;
      if (columnKey === UNCATEGORIZED) return {};
      return { fields: { [def.key]: fieldValueForMove(def, undefined, columnKey) } };
    }
    case "assignee":
      return columnKey === UNCATEGORIZED ? {} : { assignee: columnKey };
    case "priority":
      return columnKey === UNCATEGORIZED ? {} : { priority: columnKey };
    case "folder":
      return columnKey === UNCATEGORIZED ? {} : { folder: columnKey };
    case "tag": {
      if (columnKey === UNCATEGORIZED) return { tags: [] };
      const ns = namespaceOf(config);
      return { tags: [withHash(ns ? `${ns}:${columnKey}` : columnKey)] };
    }
    case "status":
      return null;
  }
}

// ── Swimlanes ───────────────────────────────────────────────────────────────

export type SwimlaneKind = "assignee" | "priority" | "parent" | "field";

/** The lane a card rides in. A multi-select card rides in its first option. */
export function laneKeyOf(node: BoardNode, lane: SwimlaneKind, field?: FieldDefinition): string {
  if (lane === "field") {
    return field ? fieldColumnKeys(field, node.fields?.[field.key])[0]! : UNCATEGORIZED;
  }
  if (lane === "assignee") return node.assignee ? node.assignee.toLowerCase() : UNCATEGORIZED;
  if (lane === "priority") return node.priority || UNCATEGORIZED;
  return node.parent || UNCATEGORIZED;
}

export interface Lane {
  key: string;
  label: string;
  nodes: BoardNode[];
}

/**
 * Cards split into lanes, in a stable order: priority lanes most urgent first;
 * assignee and parent lanes by label; the "none" lane always last. Empty lanes
 * are dropped — a lane exists because something is in it.
 */
export function buildLanes(
  nodes: BoardNode[],
  lane: SwimlaneKind,
  labelOf: (key: string) => string,
  field?: FieldDefinition,
): Lane[] {
  const groups = new Map<string, BoardNode[]>();
  for (const n of nodes) {
    const k = laneKeyOf(n, lane, field);
    const list = groups.get(k) ?? [];
    list.push(n);
    groups.set(k, list);
  }
  const keys = [...groups.keys()].filter((k) => k !== UNCATEGORIZED);
  const fieldOrder = lane === "field" && field ? fieldColumnOrder(field) : undefined;
  if (lane === "priority") {
    keys.sort((a, b) => PRIORITY_ORDER.indexOf(a) - PRIORITY_ORDER.indexOf(b));
  } else if (fieldOrder) {
    keys.sort((a, b) => fieldOrder.indexOf(a) - fieldOrder.indexOf(b));
  } else {
    keys.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  }
  if (groups.has(UNCATEGORIZED)) keys.push(UNCATEGORIZED);
  return keys.map((k) => ({ key: k, label: labelOf(k), nodes: groups.get(k)! }));
}

/** The field write that moves a card into a lane. */
export function laneFields(
  lane: SwimlaneKind,
  laneKey: string,
  field?: FieldDefinition,
): {
  assignee?: string | null;
  priority?: string | null;
  parent?: string | null;
  fields?: Record<string, unknown>;
} {
  if (lane === "field") {
    if (!field || field.type === "time_in_status") return {};
    return { fields: { [field.key]: fieldValueForMove(field, undefined, laneKey) } };
  }
  const v = laneKey === UNCATEGORIZED ? null : laneKey;
  return { [lane]: v };
}
