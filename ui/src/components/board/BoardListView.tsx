/**
 * BoardListView — a saved board as rows (Linear's list layout). Same nodes,
 * same filters and the same columns as the board, in the same order: the
 * board's columns become the list's sections. Clicking a row opens it;
 * checking rows opens a bulk bar (move to a column, tags, priority, assignee,
 * due) that applies through POST /nodes/bulk-update — each node its own
 * governed version, anything that needs review skipped and reported.
 *
 * Rows are windowed (lib/board-list visibleWindow), so a board of thousands
 * renders a screenful of DOM, not thousands of rows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Columns3,
  Loader2,
  Tag,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as api from "../../lib/api";
import { UNCATEGORIZED, namespaceKey, type BoardColumn, type BoardNode, type DimensionKind } from "../../lib/board-dimensions";
import {
  formatDue,
  isPickedDue,
  localToday,
  moveNeedsReview,
  type GovernanceContext,
} from "../../lib/board-tasks";
import {
  BULK_REASON_LABELS,
  LIST_COLUMNS,
  ROW_HEIGHT,
  SECTION_HEIGHT,
  bulkResultLine,
  chunk,
  flattenSections,
  nextSort,
  plural,
  pruneSelection,
  selectionState,
  sortRows,
  toggleGroup,
  visibleWindow,
  type ListColumn,
  type ListContext,
  type ListSection,
  type ListSort,
} from "../../lib/board-list";
import { timeAgo } from "../nest/node-display";
import { Avatar, DueChip, PriorityIcon, TicketChip, TypeIcon, type Person } from "./CardParts";
import { ticketOf, visibleTags } from "../../lib/ticket";
import { levelLabel, usePriorityLevels } from "../../lib/priorities";

const DIMENSION_NAMES: Record<DimensionKind, string> = {
  folder: "Folder",
  status: "Status",
  tag: "Column",
  assignee: "Assignee",
  priority: "Priority",
  field: "Field",
};

interface Props {
  nestId: string;
  /** The saved board — needed to move rows into one of its columns. */
  boardId?: string;
  dimension: DimensionKind;
  /** A field board's field label — the column header instead of "Field". */
  fieldLabel?: string;
  /** On a tag board, the grouped namespace — its tags are the sections, so the Tags column omits them. */
  tagNamespace?: string;
  /** The board's columns with their cards, in board order. */
  sections: ListSection[];
  /** The board's columns (move targets). */
  boardColumns: BoardColumn[];
  allNodes: BoardNode[];
  columnsOf: (n: BoardNode) => string[];
  columnLabel: (key: string) => string;
  people: Person[];
  me?: string;
  personLabel: (email: string) => string;
  canEdit: boolean;
  governance: GovernanceContext;
  doneTags: string[];
  tagSuggestions: string[];
  /** Extra columns (e.g. nest custom fields) appended after the built-ins. */
  extraColumns?: ListColumn[];
  onOpen: (id: string) => void;
  /** Re-read the nodes after a bulk run. */
  onChanged: () => Promise<void>;
}

interface PendingBulk {
  /** Headline, e.g. "Move to Done". */
  action: string;
  patch: api.BulkPatch;
  /** Extra line for the confirmation, e.g. done-column semantics. */
  note?: string;
}

/** A native checkbox that can show "some selected". */
function Check({
  state,
  onChange,
  label,
}: {
  state: "all" | "some" | "none";
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={state === "all"}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="h-3.5 w-3.5 cursor-pointer rounded-sm accent-primary"
    />
  );
}

export function BoardListView({
  nestId,
  boardId,
  dimension,
  fieldLabel,
  tagNamespace,
  sections,
  boardColumns,
  allNodes,
  columnsOf,
  columnLabel,
  people,
  me,
  personLabel,
  canEdit,
  governance,
  doneTags,
  tagSuggestions,
  extraColumns = [],
  onOpen,
  onChanged,
}: Props) {
  const today = localToday();
  const levels = usePriorityLevels();
  const columnName = dimension === "field" && fieldLabel ? fieldLabel : DIMENSION_NAMES[dimension];
  const titles = useMemo(() => new Map(allNodes.map((n) => [n.id, n.title])), [allNodes]);
  const ctx: ListContext = useMemo(
    () => ({ titleOf: (id) => titles.get(id), columnsOf, columnLabel, priorityKeys: levels.map((l) => l.key) }),
    [titles, columnsOf, columnLabel, levels],
  );
  // The list's own width, not the window's: the nest sidebar takes a share.
  const [width, setWidth] = useState(1080);
  const columns = useMemo(
    () =>
      [...LIST_COLUMNS, ...extraColumns].filter(
        (c) => !(c.hideBelow === "lg" && width < 1080) && !(c.hideBelow === "md" && width < 760),
      ),
    [extraColumns, width],
  );
  const grid = `36px ${columns.map((c) => c.width).join(" ")}`;

  // ── Sort, sections, selection ──
  const [sort, setSort] = useState<ListSort>({ key: "rank", dir: "asc" });
  const sorted = useMemo(
    () => sections.map((s) => ({ ...s, nodes: sortRows(s.nodes, sort, ctx, columns) })),
    [sections, sort, ctx, columns],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const flat = useMemo(() => flattenSections(sorted, collapsed), [sorted, collapsed]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const listedIds = useMemo(() => [...new Set(sections.flatMap((s) => s.nodes.map((n) => n.id)))], [sections]);
  useEffect(() => setSelected((prev) => pruneSelection(prev, listedIds)), [listedIds]);
  const byId = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);
  const selectedNodes = useMemo(
    () => [...selected].map((id) => byId.get(id)).filter((n): n is BoardNode => !!n),
    [selected, byId],
  );
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Windowing ──
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(640);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      setViewport(el.clientHeight);
      setWidth(el.clientWidth);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
    // Re-attach when the table first appears (an empty list renders none).
  }, [flat.length === 0]);
  const win = useMemo(() => visibleWindow(flat, scrollTop, viewport), [flat, scrollTop, viewport]);

  // ── Bulk ──
  const [pending, setPending] = useState<PendingBulk | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<api.BulkUpdateResult | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const noun = selectedNodes.every((n) => n.type === "task") ? "task" : "item";
  const needReview = useMemo(
    () => (pending ? selectedNodes.filter((n) => moveNeedsReview(n, governance)) : []),
    [pending, selectedNodes, governance],
  );

  const run = useCallback(
    async (p: PendingBulk) => {
      const ids = selectedNodes.map((n) => n.id);
      setRunning(true);
      const total: api.BulkUpdateResult = { requested: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, results: [] };
      // Ids of the chunks that did not complete (the one that threw and every
      // one after it). They stay selected, so nothing drops out unreported.
      const notDone = new Set(ids);
      let failed = false;
      try {
        // The endpoint takes 100 per call; a bigger selection is several calls.
        for (const part of chunk(ids, api.BULK_UPDATE_MAX)) {
          const r = await api.bulkUpdateNodes(nestId, part, p.patch);
          for (const id of part) notDone.delete(id);
          total.requested += r.requested;
          total.updated += r.updated;
          total.unchanged += r.unchanged;
          total.skipped += r.skipped;
          total.failed += r.failed;
          total.results.push(...r.results);
        }
      } catch (e: any) {
        failed = true;
        toast.error(
          total.requested > 0
            ? `${e?.message || "Bulk edit failed"} — ${notDone.size} not attempted, still selected`
            : e?.message || "Bulk edit failed",
        );
      } finally {
        setRunning(false);
      }
      if (total.requested === 0) return;
      await onChanged();
      // What landed leaves the selection; what didn't stays, so it can be
      // looked at (or retried) without hunting for it again.
      const leftover = new Set([
        ...total.results.filter((r) => r.outcome === "skipped" || r.outcome === "failed").map((r) => r.id),
        ...notDone,
      ]);
      setSelected(leftover);
      if (total.skipped + total.failed > 0) setReport(total);
      else if (failed) return;
      else toast.success(`${p.action} — ${bulkResultLine(total)}`);
    },
    [selectedNodes, nestId, onChanged],
  );

  // Move targets: only where a column is a value you can set.
  const canMove = !!boardId && (dimension === "tag" || dimension === "assignee" || dimension === "priority");
  const moveTargets = boardColumns.filter((c) => dimension !== "tag" || c.key !== UNCATEGORIZED);
  const tagsOnSelection = useMemo(() => {
    const set = new Set<string>();
    for (const n of selectedNodes) for (const t of n.tags) set.add(t.replace(/^#/, ""));
    return [...set].sort();
  }, [selectedNodes]);
  const ask = (p: PendingBulk) => setPending(p);

  // A name when the roster has one; otherwise the address's local part —
  // the full address is on hover.
  const shortPerson = (email: string) => {
    const label = personLabel(email);
    return label.toLowerCase() === email.toLowerCase() ? email.split("@")[0]! : label;
  };
  const headerFor = (c: ListColumn) => (c.id === "column" ? columnName : c.label);

  const renderCell = (c: ListColumn, n: BoardNode) => {
    switch (c.id) {
      case "title": {
        const done = !!n.completed_at;
        return (
          <span className="flex min-w-0 items-center gap-2">
            {done ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="Completed" />
            ) : (
              <TypeIcon type={n.type} />
            )}
            <TicketChip ticket={ticketOf(n.tags)} />
            <span className={`truncate ${done ? "text-muted-foreground" : "text-foreground"}`}>{n.title}</span>
          </span>
        );
      }
      case "column": {
        const keys = columnsOf(n);
        const label = keys.map(columnLabel).join(", ");
        const isDone = dimension === "tag" && keys.some((k) => doneTags.includes(k.toLowerCase()));
        return (
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={label}>
            {dimension === "priority" ? (
              <PriorityIcon priority={keys[0] === UNCATEGORIZED ? undefined : keys[0]} />
            ) : dimension === "assignee" ? null : (
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${isDone ? "bg-emerald-500" : keys[0] === UNCATEGORIZED ? "border border-muted-foreground/50" : "bg-muted-foreground/40"}`}
              />
            )}
            <span className="truncate">{dimension === "assignee" && keys[0] !== UNCATEGORIZED ? personLabel(keys[0]!) : label}</span>
          </span>
        );
      }
      case "assignee":
        return n.assignee ? (
          <span className="flex min-w-0 items-center gap-1.5" title={n.assignee}>
            <Avatar email={n.assignee} size="sm" />
            <span className="truncate text-muted-foreground">{shortPerson(n.assignee)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        );
      case "priority":
        return n.priority ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <PriorityIcon priority={n.priority} />
            {levelLabel(levels, n.priority)}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        );
      case "due":
        return n.due && !n.completed_at ? (
          <DueChip due={n.due} today={today} editable={false} onChange={() => {}} />
        ) : n.due ? (
          <span className="text-xs text-muted-foreground/70 tabular-nums" title={`Due ${n.due}`}>
            {formatDue(n.due, today)}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        );
      case "parent":
        return n.parent ? (
          <span className="truncate text-muted-foreground" title={titles.get(n.parent) ?? n.parent}>
            {titles.get(n.parent) ?? n.parent}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        );
      case "tags": {
        // The ticket number is the ID, and the grouped tag group is the section
        // header — neither belongs in the chips.
        const ns = dimension === "tag" ? namespaceKey(tagNamespace) : "";
        const shown = visibleTags(n.tags).filter((t) => !ns || namespaceKey(t.includes(":") ? t : "") !== ns);
        return shown.length ? (
          <span className="flex min-w-0 items-center gap-1 overflow-hidden" title={shown.join(" ")}>
            {shown.slice(0, 2).map((t) => (
              <span key={t} className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                {t.replace(/^#/, "")}
              </span>
            ))}
            {shown.length > 2 && (
              <span className="text-[10px] text-muted-foreground">+{shown.length - 2}</span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        );
      }
      case "updated": {
        const at = n.updated_at || n.created_at;
        return at ? (
          <span className="text-xs text-muted-foreground tabular-nums" title={new Date(at).toLocaleString()}>
            {timeAgo(at)}
          </span>
        ) : null;
      }
      default: {
        // Registry columns without a bespoke renderer (custom fields) show their value.
        const v = c.value?.(n, ctx);
        return v === null || v === undefined || v === "" ? (
          <span className="text-muted-foreground/50">—</span>
        ) : (
          <span className="truncate text-muted-foreground">{String(v)}</span>
        );
      }
    }
  };

  const allState = selectionState(listedIds, selected);

  if (flat.length === 0) {
    return <div className="py-8 text-sm text-muted-foreground">Nothing on this board matches its filters.</div>;
  }

  return (
    <div className="relative">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="max-h-[calc(100vh-300px)] min-h-[240px] overflow-auto">
          {/* Header */}
          <div
            role="row"
            className="sticky top-0 z-10 grid h-9 items-center border-b border-border bg-muted text-xs font-medium text-muted-foreground"
            style={{ gridTemplateColumns: grid, minWidth: "fit-content" }}
          >
            <span className="flex justify-center">
              {canEdit && <Check state={allState} label="Select all" onChange={() => setSelected(toggleGroup(listedIds, selected))} />}
            </span>
            {columns.map((c) => {
              const active = sort.key === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={!c.sortable}
                  onClick={() => setSort((s) => nextSort(s, c.id as ListSort["key"]))}
                  className={`flex h-full items-center gap-1 px-3 text-left hover:text-foreground ${active ? "text-foreground" : ""} ${c.align === "end" ? "justify-end" : ""}`}
                  title={c.sortable ? `Sort by ${headerFor(c).toLowerCase()}` : undefined}
                >
                  {headerFor(c)}
                  {active && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                </button>
              );
            })}
          </div>

          {/* Windowed body */}
          <div className="relative" style={{ height: win.total, minWidth: "fit-content" }}>
            {flat.slice(win.start, win.end).map((r, i) => {
              const top = win.offsets[win.start + i]!;
              if (r.kind === "section") {
                const ids = sorted.find((s) => s.key === r.key)?.nodes.map((n) => n.id) ?? [];
                return (
                  <div
                    key={`s:${r.key}`}
                    className="absolute inset-x-0 grid items-center border-b border-border bg-muted/30"
                    style={{ top, height: SECTION_HEIGHT, gridTemplateColumns: `36px 1fr` }}
                  >
                    <span className="flex justify-center">
                      {canEdit && (
                        <Check
                          state={selectionState(ids, selected)}
                          label={`Select all in ${r.label}`}
                          onChange={() => setSelected(toggleGroup(ids, selected))}
                        />
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(r.key)) next.delete(r.key);
                          else next.add(r.key);
                          return next;
                        })
                      }
                      className="flex h-full items-center gap-2 px-3 text-left text-sm font-medium"
                    >
                      <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${r.collapsed ? "-rotate-90" : ""}`} />
                      {dimension === "assignee" && r.key !== UNCATEGORIZED && <Avatar email={r.key} size="sm" />}
                      {dimension === "priority" && <PriorityIcon priority={r.key === UNCATEGORIZED ? undefined : r.key} />}
                      {dimension === "tag" && doneTags.includes(r.key.toLowerCase()) && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      )}
                      <span className={r.key === UNCATEGORIZED ? "text-muted-foreground" : ""}>
                        {dimension === "assignee" && r.key !== UNCATEGORIZED ? personLabel(r.key) : r.label}
                      </span>
                      <span className="text-xs font-normal text-muted-foreground tabular-nums">{r.count}</span>
                    </button>
                  </div>
                );
              }
              const n = r.node;
              const isSel = selected.has(n.id);
              return (
                <div
                  key={`r:${r.section}:${n.id}`}
                  role="row"
                  onClick={() => onOpen(n.id)}
                  className={`group absolute inset-x-0 grid cursor-pointer items-center border-b border-border/60 text-sm transition-colors ${isSel ? "bg-primary/[0.06]" : "hover:bg-muted/40"}`}
                  style={{ top, height: ROW_HEIGHT, gridTemplateColumns: grid }}
                >
                  <span className="flex justify-center">
                    {canEdit && (
                      <span className={isSel ? "" : "opacity-40 group-hover:opacity-100"}>
                        <Check state={isSel ? "all" : "none"} label={`Select ${n.title}`} onChange={() => toggleOne(n.id)} />
                      </span>
                    )}
                  </span>
                  {columns.map((c) => (
                    <span key={c.id} className={`flex min-w-0 items-center px-3 ${c.align === "end" ? "justify-end" : ""}`}>
                      {renderCell(c, n)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bulk bar — Linear's floating selection bar. */}
      {canEdit && selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4 pointer-events-none">
          <div
            role="toolbar"
            aria-label="Bulk actions"
            className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-popover px-2 py-1.5 text-sm shadow-lg"
          >
            <span className="px-2 font-medium tabular-nums">{selected.size} selected</span>
            <span className="mx-1 h-4 w-px bg-border" />
            {canMove && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" disabled={running}>
                    <Columns3 className="h-3.5 w-3.5" /> Move to
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-52">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    {columnName}
                  </DropdownMenuLabel>
                  {moveTargets.map((c) => {
                    const done = dimension === "tag" && doneTags.includes(c.key.toLowerCase());
                    const label = dimension === "assignee" && c.key !== UNCATEGORIZED ? personLabel(c.key) : c.label;
                    return (
                      <DropdownMenuItem
                        key={c.key}
                        className="gap-2"
                        onSelect={() =>
                          ask({
                            action: `Move to ${label}`,
                            patch: { board_id: boardId, column: c.key },
                            note: done ? "Tasks moved here are marked completed." : undefined,
                          })
                        }
                      >
                        {dimension === "priority" ? (
                          <PriorityIcon priority={c.key === UNCATEGORIZED ? undefined : c.key} />
                        ) : dimension === "assignee" && c.key !== UNCATEGORIZED ? (
                          <Avatar email={c.key} size="sm" />
                        ) : done ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                        ) : (
                          <span className="ml-0.5 mr-0.5 h-2 w-2 rounded-full bg-muted-foreground/40" />
                        )}
                        <span className="truncate">{label}</span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Popover onOpenChange={(o) => !o && setTagDraft("")}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" disabled={running}>
                  <Tag className="h-3.5 w-3.5" /> Tags
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-64 p-2">
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = tagDraft.trim().replace(/^#/, "");
                    if (t) ask({ action: `Add #${t}`, patch: { add_tags: [t] } });
                  }}
                >
                  <Input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    placeholder="Add a tag…"
                    list="board-list-tags"
                    className="h-8 text-sm [&::-webkit-calendar-picker-indicator]:!hidden"
                    autoFocus
                  />
                  <datalist id="board-list-tags">
                    {tagSuggestions.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                  <Button type="submit" size="sm" className="h-8" disabled={!tagDraft.trim()}>
                    Add
                  </Button>
                </form>
                {tagsOnSelection.length > 0 && (
                  <div className="mt-2 border-t border-border pt-2">
                    <div className="mb-1 px-1 text-xs text-muted-foreground">Remove from selection</div>
                    <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                      {tagsOnSelection.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => ask({ action: `Remove #${t}`, patch: { remove_tags: [t] } })}
                          className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          title={`Remove #${t} from the selected items`}
                        >
                          {t}
                          <X className="h-3 w-3" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" disabled={running}>
                  <PriorityIcon priority="high" /> Priority
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-40">
                {levels.map((p) => (
                  <DropdownMenuItem
                    key={p.key}
                    className="gap-2"
                    onSelect={() => ask({ action: `Set priority to ${p.label}`, patch: { priority: p.key } })}
                  >
                    <PriorityIcon priority={p.key} /> {p.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2" onSelect={() => ask({ action: "Clear priority", patch: { priority: null } })}>
                  <PriorityIcon /> No priority
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" disabled={running}>
                  <UserRound className="h-3.5 w-3.5" /> Assignee
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-60">
                <div className="max-h-64 overflow-y-auto">
                  {people
                    .filter((p) => p.member !== false)
                    .sort((a, b) =>
                      me && a.email.toLowerCase() === me ? -1 : me && b.email.toLowerCase() === me ? 1 : (a.name ?? a.email).localeCompare(b.name ?? b.email),
                    )
                    .map((p) => (
                      <DropdownMenuItem
                        key={p.email}
                        className="gap-2"
                        onSelect={() =>
                          ask({ action: `Assign to ${p.name || p.email}`, patch: { assignee: p.email.toLowerCase() } })
                        }
                      >
                        <Avatar email={p.email} size="sm" />
                        <span className="truncate">
                          {p.name || p.email}
                          {me && p.email.toLowerCase() === me && <span className="text-muted-foreground"> (me)</span>}
                        </span>
                      </DropdownMenuItem>
                    ))}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2" onSelect={() => ask({ action: "Unassign", patch: { assignee: null } })}>
                  <UserRound className="h-4 w-4" /> Unassign
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" disabled={running}>
                  <CalendarDays className="h-3.5 w-3.5" /> Due
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-auto p-2">
                <div className="flex items-center gap-1">
                  <Input
                    type="date"
                    className="h-8"
                    autoFocus
                    onChange={(e) => {
                      const d = e.target.value;
                      if (isPickedDue(d)) ask({ action: `Set due date to ${d}`, patch: { due: d } });
                    }}
                  />
                  <Button variant="ghost" size="sm" className="h-8" onClick={() => ask({ action: "Clear due date", patch: { due: null } })}>
                    Clear
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <span className="mx-1 h-4 w-px bg-border" />
            {running ? (
              <Loader2 className="mx-2 h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground"
                onClick={() => setSelected(new Set())}
                title="Clear selection"
                aria-label="Clear selection"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}

      {/* One confirmation, summarising the change. */}
      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.action} — {plural(selectedNodes.length, noun)}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>Each one is saved as its own new version, as if it had been changed by hand.</p>
                {pending?.note && <p>{pending.note}</p>}
                {needReview.length > 0 && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200">
                    <p className="font-medium">
                      {plural(needReview.length, "document")} {needReview.length === 1 ? "goes" : "go"} through review and will be skipped
                    </p>
                    <p className="mt-0.5 text-xs">
                      A bulk edit never creates drafts. Change {needReview.length === 1 ? "it" : "them"} one at a time
                      from the document to send the change for review.
                    </p>
                    <ul className="mt-1.5 space-y-0.5 text-xs">
                      {needReview.slice(0, 5).map((n) => (
                        <li key={n.id} className="truncate">· {n.title}</li>
                      ))}
                      {needReview.length > 5 && <li>· and {needReview.length - 5} more</li>}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={selectedNodes.length - needReview.length <= 0}
              onClick={() => {
                const p = pending;
                setPending(null);
                if (p) void run(p);
              }}
            >
              Apply to {plural(Math.max(0, selectedNodes.length - needReview.length), noun)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Result summary when anything didn't land. */}
      <AlertDialog open={!!report} onOpenChange={(o) => !o && setReport(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{report ? bulkResultLine(report) : ""}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>The ones below weren't changed and are still selected.</p>
                <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {report?.results
                    .filter((r) => r.outcome === "skipped" || r.outcome === "failed")
                    .map((r) => (
                      <li key={r.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0">
                          <span className="block truncate text-foreground">{r.title ?? r.id}</span>
                          <span className="block text-xs text-muted-foreground">{r.reason}</span>
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {BULK_REASON_LABELS[r.code ?? "error"] ?? r.code}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setReport(null)}>Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
