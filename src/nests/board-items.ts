/**
 * A saved board's rows as a list (the board's List view, REST
 * GET /nests/:id/boards/:boardId/items, MCP context_board_items).
 *
 * Same slice as the board: the board's own filters (tasks only, tag filter,
 * hide completed) plus an optional assignee quick-filter, grouped by the
 * board's columns in the board's column order. A node in several tag columns
 * is a row in each section, exactly as it is a card in each column.
 *
 * The column rules mirror ui/src/lib/board-dimensions.ts and, for custom-field
 * boards, ui/src/lib/custom-fields.ts, which own them for the board UI
 * (test/board-dimensions.test.ts). The UI's list view renders
 * from the same in-memory nodes the board does, so the two views can't
 * disagree; this module is the same slice for agents and scripts, and
 * test/board-list.test.ts pins the two to the same answers.
 */
import {
  listNodesForCaller,
  ACCEPTED_NODE_TYPES,
  type NodeResponse,
} from "../nodes/service.js";
import { ValidationError } from "../shared/errors.js";
import {
  appliesTo,
  listFieldDefinitions,
  matchesFieldFilter,
  type FieldDefinition,
} from "../nodes/custom-fields.js";
import { nestTaskRules } from "./service.js";
import { getBoard, type Board, type BoardConfig as SavedBoardConfig } from "./board-service.js";

/** A saved board's config plus the custom-field definitions it names: the
 *  field a "field" board groups by, and every definition for filterFields. */
export type BoardConfig = SavedBoardConfig & {
  field?: FieldDefinition;
  fieldDefs?: FieldDefinition[];
  /** The nest's priority levels (task_rules), for a priority board's columns,
   *  labels and sort. Absent: the built-in four. */
  priorities?: readonly PriorityLevel[];
  /** The nest's workflow order for its stage group (task_rules.stage_order). */
  stageOrder?: { namespace: string; order: string[] };
};
/** `stage_order` applies to the namespace of the default stage tag, else the
 *  first exclusive namespace. */
function stageOrderOf(r: { default_stage_tag: string | null; exclusive_namespaces: string[]; stage_order: string[] }) {
  const ns = (r.default_stage_tag?.split(":")[0] ?? r.exclusive_namespaces[0] ?? "").toLowerCase();
  return ns && r.stage_order.length ? { namespace: ns, order: r.stage_order } : undefined;
}
const levelsOf = (c: { priorities?: readonly PriorityLevel[] }): readonly PriorityLevel[] =>
  c.priorities ?? DEFAULT_PRIORITIES;

export const UNCATEGORIZED = "__uncategorized__";
const STATUS_ORDER = ["draft", "pending_review", "approved", "published", "rejected", "external_edit_pending"];
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_review: "Pending Review",
  approved: "Approved",
  published: "Published",
  rejected: "Rejected",
  external_edit_pending: "External Edit",
};
import { DEFAULT_PRIORITIES, effectivePriorities, ticketFromTag, ticketTagOf, type PriorityLevel } from "../nodes/task-rules.js";
export const PRIORITY_ORDER = DEFAULT_PRIORITIES.map((p) => p.key);

export const LIST_SORTS = [
  "rank",
  "title",
  "status",
  "assignee",
  "priority",
  "due",
  "parent",
  "updated",
  "created",
] as const;
export type ListSort = (typeof LIST_SORTS)[number];

export const LIST_DEFAULT_LIMIT = 100;
export const LIST_MAX_LIMIT = 500;

const stripHash = (t: string) => (t.startsWith("#") ? t.slice(1) : t);
const namespaceOf = (c: { tagNamespace?: string }) =>
  (c.tagNamespace ?? "").trim().split(":")[0]!.trim();

/** A tag-board column key with a "*" is a pattern: one column per matching
 *  tag (board-dimensions.ts isColumnPattern, CU-wdqcq05pad). */
const isPattern = (k: string) => k.includes("*");

/** Whole-value, case-insensitive glob. No regex — the pattern is user-saved
 *  board config evaluated here on the server: O(value × pattern) at worst,
 *  never exponential, with keys capped at 600 characters (strList). */
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

/** layouts[] key — "tag:<ns>" / "field:<key>", the dimension otherwise. */
export function layoutKeyOf(c: BoardConfig): string {
  if (c.dimension === "field") return `field:${c.fieldKey ?? ""}`;
  return c.dimension === "tag" ? `tag:${namespaceOf(c)}` : c.dimension;
}

/** A field board's default order: the options as defined; checkbox off first. */
function fieldColumnOrder(def: FieldDefinition | undefined): string[] | undefined {
  if (def?.type === "select" || def?.type === "multi_select") return [...def.options];
  if (def?.type === "checkbox") return ["false", "true"];
  return undefined;
}

/** The columns a field value sits in (custom-fields.ts fieldColumnKeys). */
function fieldColumnKeys(def: FieldDefinition, value: unknown): string[] {
  if (def.type === "checkbox") return [value === true ? "true" : "false"];
  if (value === undefined || value === null || value === "") return [UNCATEGORIZED];
  if (def.type === "multi_select") {
    const list = Array.isArray(value) ? value.map(String) : [String(value)];
    return list.length > 0 ? list : [UNCATEGORIZED];
  }
  if (def.type === "user") return [String(value).toLowerCase()];
  return [String(value)];
}

/** The active dimension's column order / hidden set / explicitness. */
export function resolvedColumns(c: BoardConfig): {
  order?: string[];
  hidden: Set<string>;
  explicit: boolean;
} {
  const layout = c.layouts?.[layoutKeyOf(c)] ?? {};
  const keys = (a?: string[]) =>
    a && (c.dimension === "tag" ? [...new Set(a.map(stripHash))] : a);
  const order =
    keys(layout.columnOrder) ??
    (c.dimension === "tag" && c.stageOrder && (c.tagNamespace ?? "").trim().replace(/^#/, "").split(":")[0]!.toLowerCase() === c.stageOrder.namespace
      ? c.stageOrder.order
      : c.dimension === "status"
      ? STATUS_ORDER
      : c.dimension === "priority"
        ? levelsOf(c).map((p) => p.key)
        : c.dimension === "field"
          ? fieldColumnOrder(c.field)
          : undefined);
  return {
    order,
    hidden: new Set(keys(layout.hiddenColumns) ?? []),
    explicit: c.dimension === "tag" && layout.columnOrder !== undefined,
  };
}

function folderOf(id: string): string {
  const rel = id.startsWith("nodes/") ? id.slice("nodes/".length) : id;
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

/** Every column a node belongs to on this board (before hiding). */
export function columnKeysOf(n: NodeResponse, c: BoardConfig): string[] {
  switch (c.dimension) {
    case "folder":
      return [folderOf(n.id)];
    case "status":
      return [n.status || UNCATEGORIZED];
    case "assignee":
      return [n.assignee ? n.assignee.toLowerCase() : UNCATEGORIZED];
    case "priority":
      return [n.priority || UNCATEGORIZED];
    case "field":
      // A board on a deleted field keeps loading, as one "no value" column.
      return c.field ? fieldColumnKeys(c.field, n.fields?.[c.field.key]) : [UNCATEGORIZED];
    case "tag": {
      const ns = namespaceOf(c);
      const tags = (n.tags ?? []).map(stripHash);
      const values = ns
        ? tags.filter((t) => t.startsWith(`${ns}:`)).map((t) => t.slice(ns.length + 1)).filter(Boolean)
        : tags.filter(Boolean);
      return values.length > 0 ? [...new Set(values)] : [UNCATEGORIZED];
    }
  }
}

/** The columns a node shows in once hidden ones are removed. */
function shownKeys(n: NodeResponse, c: BoardConfig, cols: ReturnType<typeof resolvedColumns>): string[] {
  const keys = columnKeysOf(n, c).filter((k) => !cols.hidden.has(k));
  if (cols.explicit) {
    const order = (cols.order ?? []).filter((k) => !cols.hidden.has(k));
    const allowed = new Set(order);
    const patterns = order.filter(isPattern);
    return keys.filter((k) => allowed.has(k) || patterns.some((p) => globMatch(p, k)));
  }
  return keys.length > 0 ? keys : [UNCATEGORIZED];
}

export function columnLabel(key: string, c: BoardConfig): string {
  const f = c.dimension === "field" ? c.field : undefined;
  if (f) {
    if (key === UNCATEGORIZED) return f.type === "user" ? "Unassigned" : `No ${f.label.toLowerCase()}`;
    if (f.type === "checkbox") return key === "true" ? f.label : `Not ${f.label.toLowerCase()}`;
    return key;
  }
  if (key === UNCATEGORIZED) {
    return c.dimension === "assignee" ? "Unassigned" : c.dimension === "priority" ? "No priority" : "Uncategorized";
  }
  if (c.dimension === "priority") return levelsOf(c).find((p) => p.key === key)?.label ?? key;
  if (c.dimension === "status") return STATUS_LABELS[key] ?? key.replace(/_/g, " ");
  if (c.dimension === "folder" && key === "") return "(root)";
  return key;
}

export interface BoardListFilters {
  /** Lower-cased emails, plus "unassigned"; empty = everyone. */
  assignees?: string[];
  /** Case-insensitive title substring. */
  q?: string;
  now?: number;
}

/** The board's own filters, then the request's. Same rules as the board UI. */
export function filterForBoard(
  nodes: NodeResponse[],
  c: BoardConfig,
  f: BoardListFilters = {},
  tasksEnabled = ACCEPTED_NODE_TYPES.has("task"),
): NodeResponse[] {
  const now = f.now ?? Date.now();
  const people = new Set((f.assignees ?? []).map((a) => a.toLowerCase()));
  const q = (f.q ?? "").trim().toLowerCase();
  return nodes.filter((n) => {
    if (c.tasksOnly && tasksEnabled && n.type !== "task") return false;
    if (people.size > 0 && !people.has(n.assignee ? n.assignee.toLowerCase() : "unassigned")) return false;
    if (
      c.hideDoneAfterDays !== undefined &&
      n.completed_at &&
      now - Date.parse(n.completed_at) > c.hideDoneAfterDays * 86_400_000
    ) {
      return false;
    }
    const tags = (n.tags ?? []).map((t) => stripHash(t).toLowerCase());
    if (!(c.filterTags ?? []).every((t) => tags.includes(t.toLowerCase()))) return false;
    // Same rule as the board's matchesFieldFilters: a deleted field's filter
    // no longer narrows; a field the node's type can't carry fails it.
    for (const [key, wanted] of Object.entries(c.filterFields ?? {})) {
      const def = c.fieldDefs?.find((d) => d.key === key);
      if (!def) continue;
      if (!appliesTo(def, n.type) || !matchesFieldFilter(def, n.fields?.[key], wanted)) return false;
    }
    if (q && !String(n.title ?? "").toLowerCase().includes(q)) return false;
    return true;
  });
}

export interface ListGroup {
  key: string;
  label: string;
  count: number;
}

/** Sections in board column order; Uncategorized last. Empty sections dropped. */
export function groupForBoard(
  nodes: NodeResponse[],
  c: BoardConfig,
): { groups: ListGroup[]; byGroup: Map<string, NodeResponse[]> } {
  const cols = resolvedColumns(c);
  const byGroup = new Map<string, NodeResponse[]>();
  for (const n of nodes) {
    for (const k of shownKeys(n, c, cols)) {
      const list = byGroup.get(k) ?? [];
      list.push(n);
      byGroup.set(k, list);
    }
  }
  const present = new Set(byGroup.keys());
  const keys: string[] = [];
  const order = cols.order ?? [];
  const listed = new Set(order.filter((k) => !isPattern(k)));
  for (const k of order) {
    if (cols.explicit && isPattern(k)) {
      // A pattern's matches sit at its place, sorted; a tag listed on its
      // own keeps its own place.
      for (const t of [...present].sort()) {
        if (t !== UNCATEGORIZED && !listed.has(t) && globMatch(k, t)) {
          present.delete(t);
          keys.push(t);
        }
      }
    } else if (present.delete(k) && k !== UNCATEGORIZED) keys.push(k);
  }
  const hadUncat = present.delete(UNCATEGORIZED);
  keys.push(...[...present].sort());
  if (hadUncat) keys.push(UNCATEGORIZED);
  return {
    groups: keys.map((k) => ({ key: k, label: columnLabel(k, c), count: byGroup.get(k)!.length })),
    byGroup,
  };
}

/** A comparable value per sort key. Empty values sort last in either direction. */
function sortValue(
  n: NodeResponse,
  sort: ListSort,
  titles: Map<string, string>,
  priorityKeys: readonly string[],
): string | number | null {
  switch (sort) {
    case "title":
      return String(n.title ?? "").toLowerCase();
    case "status":
      return n.status || null;
    case "assignee":
      return n.assignee?.toLowerCase() || null;
    case "priority": {
      const i = priorityKeys.indexOf(n.priority ?? "");
      return i === -1 ? null : i;
    }
    case "due":
      return n.due || null;
    case "parent":
      return n.parent ? (titles.get(n.parent) ?? n.parent).toLowerCase() : null;
    case "updated":
      return n.updated_at || n.created_at || null;
    case "created":
      return n.created_at || null;
    default:
      return null;
  }
}

export function sortRows(
  rows: NodeResponse[],
  sort: ListSort,
  dir: "asc" | "desc",
  titles: Map<string, string>,
  rank?: string[],
  priorityKeys: readonly string[] = PRIORITY_ORDER,
): NodeResponse[] {
  if (sort === "rank") {
    // Board order: ranked cards first, the rest as listed (orderByRank).
    if (!rank || rank.length === 0) return rows;
    const pos = new Map(rank.map((id, i) => [id, i]));
    const ranked = rows.filter((r) => pos.has(r.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
    return [...ranked, ...rows.filter((r) => !pos.has(r.id))];
  }
  const sign = dir === "desc" ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i, v: sortValue(r, sort, titles, priorityKeys) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      const c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      return c === 0 ? a.i - b.i : sign * c;
    })
    .map((x) => x.r);
}

export interface BoardListRow {
  id: string;
  title: string;
  type: string;
  status: string;
  tags: string[];
  /** The section this row is listed under (a board column key). */
  group: string;
  /** Every board column the node sits in. */
  columns: string[];
  /** The task's permanent number (`CMN-12`), when the nest numbers tasks. */
  ticket?: string;
  assignee?: string;
  priority?: string;
  due?: string;
  parent?: string;
  parent_title?: string;
  completed_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface BoardListResult {
  board: { id: string; name: string; dimension: BoardConfig["dimension"]; tag_namespace?: string; field_key?: string };
  sort: ListSort;
  dir: "asc" | "desc";
  total: number;
  offset: number;
  limit: number;
  groups: ListGroup[];
  items: BoardListRow[];
}

export function parseListQuery(q: Record<string, unknown>): {
  sort: ListSort;
  dir: "asc" | "desc";
  limit: number;
  offset: number;
  filters: BoardListFilters;
} {
  const sort = (q.sort ?? "rank") as ListSort;
  if (!(LIST_SORTS as readonly string[]).includes(sort)) {
    throw new ValidationError(`sort must be one of ${LIST_SORTS.join(", ")}`);
  }
  const dir = q.dir === "desc" ? "desc" : "asc";
  const num = (v: unknown, d: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const limit = Math.min(Math.max(num(q.limit, LIST_DEFAULT_LIMIT), 1), LIST_MAX_LIMIT);
  const offset = num(q.offset, 0);
  const raw = q.assignee;
  const assignees = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  return { sort, dir, limit, offset, filters: { assignees, q: typeof q.q === "string" ? q.q : undefined } };
}

/** One page of a board's list view, as the caller is allowed to see it. */
export async function listBoardItems(
  nestId: string,
  boardId: string,
  userId: string,
  query: Record<string, unknown>,
): Promise<BoardListResult> {
  const { sort, dir, limit, offset, filters } = parseListQuery(query);
  const board: Board = await getBoard(nestId, boardId, userId);
  const usesFields = board.config.dimension === "field" || !!board.config.filterFields;
  const fieldDefs = usesFields ? await listFieldDefinitions(nestId) : undefined;
  const c: BoardConfig = {
    ...board.config,
    fieldDefs,
    field: board.config.dimension === "field" ? fieldDefs?.find((d) => d.key === board.config.fieldKey) : undefined,
    priorities: effectivePriorities(await nestTaskRules(nestId)),
    stageOrder: stageOrderOf(await nestTaskRules(nestId)),
  };
  // The caller-gated listing the board UI reads (metadata only, no bodies).
  const all = await listNodesForCaller(nestId, userId);
  const titles = new Map(all.map((n) => [n.id, n.title]));
  const visible = filterForBoard(all, c, filters);
  const { groups, byGroup } = groupForBoard(visible, c);
  const lk = layoutKeyOf(c);
  const rows: BoardListRow[] = [];
  for (const g of groups) {
    const sorted = sortRows(byGroup.get(g.key)!, sort, dir, titles, c.ranks?.[`${lk}::${g.key}`], levelsOf(c).map((p) => p.key));
    for (const n of sorted) {
      rows.push({
        id: n.id,
        title: n.title,
        type: n.type,
        status: n.status,
        tags: n.tags,
        group: g.key,
        columns: columnKeysOf(n, c),
        ...(ticketTagOf(n.tags) && ticketFromTag(ticketTagOf(n.tags)!) ? { ticket: ticketFromTag(ticketTagOf(n.tags)!)! } : {}),
        ...(n.assignee ? { assignee: n.assignee } : {}),
        ...(n.priority ? { priority: n.priority } : {}),
        ...(n.due ? { due: n.due } : {}),
        ...(n.parent ? { parent: n.parent, parent_title: titles.get(n.parent) } : {}),
        ...(n.completed_at ? { completed_at: n.completed_at } : {}),
        ...(n.created_at ? { created_at: n.created_at } : {}),
        ...(n.updated_at ? { updated_at: n.updated_at } : {}),
      });
    }
  }
  return {
    board: {
      id: board.id,
      name: board.name,
      dimension: c.dimension,
      ...(c.tagNamespace ? { tag_namespace: c.tagNamespace } : {}),
      ...(c.fieldKey ? { field_key: c.fieldKey } : {}),
    },
    sort,
    dir,
    total: rows.length,
    offset,
    limit,
    groups,
    items: rows.slice(offset, offset + limit),
  };
}
