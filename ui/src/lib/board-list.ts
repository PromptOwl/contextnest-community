/**
 * Board List view — pure, so it runs in the node test env
 * (test/board-list.test.ts). BoardListView renders; this decides.
 *
 * The list is the board's own slice (same filtered nodes, same columns in
 * the same order) laid out as rows, so switching Board ⇄ List never changes
 * what you're looking at — only how. Sections are the board's columns; within
 * one, rows follow the board's card order until a column header is clicked.
 *
 * Columns are a registry rather than hard-wired JSX so more can join without
 * touching the table: a custom field becomes a column with `fieldColumn`.
 */
import { PRIORITY_ORDER, type BoardNode } from "./board-dimensions";

// ── Columns ─────────────────────────────────────────────────────────────────

export type ListSortKey =
  | "rank"
  | "title"
  | "column"
  | "assignee"
  | "priority"
  | "due"
  | "parent"
  | "tags"
  | "updated"
  | `field:${string}`;

export interface ListColumn {
  /** Stable id; also the sort key for sortable columns. */
  id: string;
  /** Header text. "column" takes the board dimension's name at render time. */
  label: string;
  /** CSS grid track, e.g. "minmax(220px,1fr)" or "120px". */
  width: string;
  sortable: boolean;
  /** Hidden below this breakpoint ("md" | "lg"), so the list stays readable narrow. */
  hideBelow?: "md" | "lg";
  align?: "start" | "end";
  /** The cell's raw value, for sorting and the default text renderer. */
  value?: (n: BoardNode, ctx: ListContext) => string | number | null | undefined;
}

export interface ListContext {
  titleOf: (id: string) => string | undefined;
  /** Column keys the node sits in on this board (board-dimensions cardColumnKeys). */
  columnsOf: (n: BoardNode) => string[];
  columnLabel: (key: string) => string;
}

export const LIST_COLUMNS: ListColumn[] = [
  {
    id: "title",
    label: "Title",
    width: "minmax(240px, 1fr)",
    sortable: true,
    value: (n) => n.title.toLowerCase(),
  },
  {
    id: "column",
    label: "Column",
    width: "140px",
    sortable: true,
    value: (n, c) => c.columnsOf(n).map(c.columnLabel).join(", ").toLowerCase() || null,
  },
  {
    id: "assignee",
    label: "Assignee",
    width: "150px",
    sortable: true,
    value: (n) => n.assignee?.toLowerCase() || null,
  },
  {
    id: "priority",
    label: "Priority",
    width: "104px",
    sortable: true,
    value: (n) => {
      const i = PRIORITY_ORDER.indexOf(n.priority ?? "");
      return i === -1 ? null : i;
    },
  },
  { id: "due", label: "Due", width: "92px", sortable: true, value: (n) => n.due || null },
  {
    id: "parent",
    label: "Parent",
    width: "140px",
    sortable: true,
    hideBelow: "lg",
    value: (n, c) => (n.parent ? (c.titleOf(n.parent) ?? n.parent).toLowerCase() : null),
  },
  {
    id: "tags",
    label: "Tags",
    width: "160px",
    sortable: true,
    hideBelow: "lg",
    value: (n) =>
      n.tags.length ? n.tags.map((t) => t.replace(/^#/, "")).sort().join(" ") : null,
  },
  {
    id: "updated",
    label: "Updated",
    width: "84px",
    sortable: true,
    hideBelow: "md",
    align: "end",
    value: (n) => n.updated_at || n.created_at || null,
  },
];

/**
 * A column for a value the registry doesn't know — a nest custom field, say.
 * Renders as text and sorts like the others; `read` pulls the value off the
 * node however that field is carried.
 */
export function fieldColumn(
  key: string,
  label: string,
  read: (n: BoardNode) => string | number | null | undefined,
  width = "140px",
): ListColumn {
  return { id: `field:${key}`, label, width, sortable: true, hideBelow: "lg", value: read };
}

// ── Sorting ─────────────────────────────────────────────────────────────────

export interface ListSort {
  key: ListSortKey;
  dir: "asc" | "desc";
}

/** Clicking a header: first click sorts ascending (dates newest first),
 *  second flips, third returns to the board's own order. */
export function nextSort(current: ListSort, key: ListSortKey): ListSort {
  const firstDir = key === "updated" ? "desc" : "asc";
  if (current.key !== key) return { key, dir: firstDir };
  if (current.dir === firstDir) return { key, dir: firstDir === "asc" ? "desc" : "asc" };
  return { key: "rank", dir: "asc" };
}

/**
 * Rows in one section, sorted. "rank" keeps the given (board) order. Empty
 * values sink to the bottom whichever way you sort — a missing due date is
 * not "earliest". Ties keep board order, so a sort is stable.
 */
export function sortRows(
  rows: BoardNode[],
  sort: ListSort,
  ctx: ListContext,
  columns: ListColumn[] = LIST_COLUMNS,
): BoardNode[] {
  if (sort.key === "rank") return rows;
  const col = columns.find((c) => c.id === sort.key);
  if (!col?.value) return rows;
  const sign = sort.dir === "desc" ? -1 : 1;
  return rows
    .map((r, i) => {
      const v = col.value!(r, ctx);
      return { r, i, v: v === undefined || v === "" ? null : v };
    })
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      const c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      return c === 0 ? a.i - b.i : sign * c;
    })
    .map((x) => x.r);
}

// ── Sections + windowing ────────────────────────────────────────────────────

export interface ListSection {
  key: string;
  label: string;
  nodes: BoardNode[];
}

export type FlatRow =
  | { kind: "section"; key: string; label: string; count: number; collapsed: boolean }
  | { kind: "row"; section: string; node: BoardNode };

/** Sections and their rows as one flat list, for windowed rendering. Empty
 *  sections are kept out: a list section exists because something is in it. */
export function flattenSections(sections: ListSection[], collapsed: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  for (const s of sections) {
    if (s.nodes.length === 0) continue;
    const isCollapsed = collapsed.has(s.key);
    out.push({ kind: "section", key: s.key, label: s.label, count: s.nodes.length, collapsed: isCollapsed });
    if (isCollapsed) continue;
    for (const n of s.nodes) out.push({ kind: "row", section: s.key, node: n });
  }
  return out;
}

export const ROW_HEIGHT = 40;
export const SECTION_HEIGHT = 36;

/**
 * Which flat rows to render for a scroll position: everything in the
 * viewport plus `overscan` px either side. Heights are fixed per kind, so
 * the offsets are exact and no row is measured.
 */
export function visibleWindow(
  rows: FlatRow[],
  scrollTop: number,
  viewport: number,
  overscan = 400,
): { start: number; end: number; offsets: number[]; total: number } {
  const offsets: number[] = new Array(rows.length);
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = y;
    y += rows[i]!.kind === "section" ? SECTION_HEIGHT : ROW_HEIGHT;
  }
  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + viewport + overscan;
  let start = 0;
  while (start < rows.length - 1 && offsets[start + 1]! <= top) start++;
  let end = start;
  while (end < rows.length && offsets[end]! < bottom) end++;
  return { start, end, offsets, total: y };
}

// ── Selection ───────────────────────────────────────────────────────────────

/** "all" / "some" / "none" of these ids are selected — a group checkbox's state. */
export function selectionState(ids: string[], selected: ReadonlySet<string>): "all" | "some" | "none" {
  let n = 0;
  for (const id of ids) if (selected.has(id)) n++;
  return n === 0 ? "none" : n === ids.length ? "all" : "some";
}

/** Toggle a whole group: select all of it, or — if it's all selected — clear it. */
export function toggleGroup(ids: string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (selectionState(ids, selected) === "all") for (const id of ids) next.delete(id);
  else for (const id of ids) next.add(id);
  return next;
}

/** Drop selected ids that are no longer on the list (filtered away, deleted). */
export function pruneSelection(selected: ReadonlySet<string>, present: Iterable<string>): Set<string> {
  const keep = new Set(present);
  const next = new Set<string>();
  for (const id of selected) if (keep.has(id)) next.add(id);
  return next.size === selected.size ? (selected as Set<string>) : next;
}

/** Ids in chunks the bulk endpoint accepts. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── View memory ─────────────────────────────────────────────────────────────

export type BoardViewMode = "board" | "list";

/** The URL's `?layout=` wins (a shared link), then this person's last choice
 *  for this board. Not `?view=`: that is the nest's legacy view query. */
export function resolveViewMode(search: string, remembered: string | null): BoardViewMode {
  const fromUrl = new URLSearchParams(search).get("layout");
  if (fromUrl === "list" || fromUrl === "board") return fromUrl;
  return remembered === "list" ? "list" : "board";
}

/** Per person AND per board: my List choice doesn't flip it for teammates. */
export function viewStorageKey(userKey: string | undefined, boardId: string | undefined): string {
  return `cn.board.layout.${userKey || "anon"}.${boardId || "local"}`;
}

/** The search string with `layout` set (list) or removed (board, the default). */
export function withLayoutParam(search: string, mode: BoardViewMode): string {
  const p = new URLSearchParams(search);
  if (mode === "list") p.set("layout", "list");
  else p.delete("layout");
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ── Bulk summary ────────────────────────────────────────────────────────────

export interface BulkSummaryInput {
  count: number;
  noun?: string;
  /** e.g. "Move to Done", "Set priority to High", "Add #q4". */
  action: string;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The confirmation's headline: "Move 12 tasks to Done". */
export function bulkHeadline({ count, noun = "item", action }: BulkSummaryInput): string {
  return `${action} — ${plural(count, noun)}`;
}

/** The result line after a run: "10 updated · 2 skipped · 1 unchanged". */
export function bulkResultLine(r: { updated: number; skipped: number; failed: number; unchanged: number }): string {
  const parts = [`${r.updated} updated`];
  if (r.unchanged) parts.push(`${r.unchanged} already set`);
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  if (r.failed) parts.push(`${r.failed} failed`);
  return parts.join(" · ");
}

/** Human words for a skip/fail code. */
export const BULK_REASON_LABELS: Record<string, string> = {
  needs_review: "Needs review",
  locked: "In review",
  forbidden: "No edit access",
  not_found: "Not found",
  invalid: "Invalid",
  error: "Error",
};
