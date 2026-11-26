/**
 * The Tasks list on My Work: the tasks assigned to you, most pressing first,
 * with a filter bar. Open tasks only until you ask for more — Done and All
 * are a click away. The list is capped to a few rows so the approvals above
 * and the sections below stay in view; "Show all" opens the rest.
 */
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { AssignedItem } from "../../lib/api";
import { BlockedBadge, DueChip, PriorityIcon } from "../board/CardParts";
import {
  DEFAULT_TASK_FILTERS,
  isDefaultTaskFilters,
  isUrgentTask,
  matchesTaskFilters,
  sortTasks,
  stagesOf,
  taskStage,
  type DueFilter,
  type PriorityFilter,
  type TaskFilters,
  type TaskStatusFilter,
} from "../../lib/my-work-tasks";

/** Rows shown before "Show all". */
export const TASKS_PREVIEW_COUNT = 6;

const SELECT =
  "h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

const STATUS: { key: TaskStatusFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
];

interface Props {
  /** Already narrowed to the chosen nest. */
  items: AssignedItem[];
  today: string;
  /** Done tasks are being fetched (the Done / All filter was just chosen). */
  loadingDone?: boolean;
  /** Called when the status filter changes, so the page can fetch done tasks. */
  onStatusChange?: (status: TaskStatusFilter) => void;
  onOpen: (a: AssignedItem) => void;
}

export function AssignedTasks({ items, today, loadingDone, onStatusChange, onOpen }: Props) {
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [showAll, setShowAll] = useState(false);

  const stages = useMemo(() => stagesOf(items), [items]);
  const shown = useMemo(
    () => sortTasks(items.filter((a) => matchesTaskFilters(a, filters, today)), today),
    [items, filters, today],
  );
  const openTotal = items.filter((a) => !a.done).length;
  const urgent = items.filter((a) => isUrgentTask(a, today)).length;
  const rows = showAll ? shown : shown.slice(0, TASKS_PREVIEW_COUNT);
  const hidden = shown.length - rows.length;

  const set = (patch: Partial<TaskFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setShowAll(false);
  };
  const setStatus = (status: TaskStatusFilter) => {
    set({ status });
    onStatusChange?.(status);
  };
  const clear = () => {
    setFilters(DEFAULT_TASK_FILTERS);
    setShowAll(false);
    onStatusChange?.("open");
  };

  return (
    <section className="rounded-lg border" data-testid="my-work-tasks" aria-labelledby="my-work-tasks-heading">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <h3 id="my-work-tasks-heading" className="text-sm font-medium">
          Tasks
        </h3>
        <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="my-work-tasks-count">
          <button
            type="button"
            onClick={() => {
              setFilters({ ...DEFAULT_TASK_FILTERS });
              setShowAll(false);
              onStatusChange?.("open");
            }}
            aria-pressed={filters.status === "open" && !filters.urgent}
            data-testid="my-work-count-open"
            title="Show all open tasks"
            className={`rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground ${
              filters.status === "open" && !filters.urgent ? "bg-muted font-medium text-foreground" : ""
            }`}
          >
            {openTotal} open
          </button>
          {urgent > 0 && (
            <button
              type="button"
              onClick={() => {
                setFilters({ ...DEFAULT_TASK_FILTERS, urgent: true });
                setShowAll(false);
                onStatusChange?.("open");
              }}
              aria-pressed={filters.urgent}
              data-testid="my-work-count-urgent"
              title="Show only urgent or overdue tasks"
              className={`rounded px-1.5 py-0.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 ${
                filters.urgent ? "bg-red-50 font-medium dark:bg-red-950/30" : ""
              }`}
            >
              {urgent} urgent
            </button>
          )}
        </span>
        <div className="ml-auto flex items-center rounded-md border p-0.5" role="group" aria-label="Task status">
          {STATUS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStatus(s.key)}
              aria-pressed={filters.status === s.key}
              data-testid={`my-work-task-status-${s.key}`}
              className={`rounded px-2.5 py-0.5 text-xs font-medium transition-colors ${
                filters.status === s.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t px-4 py-2" data-testid="my-work-task-filters">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={filters.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder="Search tasks"
            aria-label="Search tasks"
            className="h-7 w-40 rounded-md border border-input bg-background pl-7 pr-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
        </div>
        {stages.length > 0 && (
          <select
            value={filters.stage}
            onChange={(e) => set({ stage: e.target.value })}
            aria-label="Filter by stage"
            className={SELECT}
            data-testid="my-work-task-stage"
          >
            <option value="all">Any stage</option>
            {stages.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        )}
        <select
          value={filters.priority}
          onChange={(e) => set({ priority: e.target.value as PriorityFilter })}
          aria-label="Filter by priority"
          className={SELECT}
          data-testid="my-work-task-priority"
        >
          <option value="all">Any priority</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="none">No priority</option>
        </select>
        <select
          value={filters.due}
          onChange={(e) => set({ due: e.target.value as DueFilter })}
          aria-label="Filter by due date"
          className={SELECT}
          data-testid="my-work-task-due"
        >
          <option value="all">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="week">Due in 7 days</option>
          <option value="none">No due date</option>
        </select>
        {!isDefaultTaskFilters(filters) && (
          <button
            type="button"
            onClick={clear}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="my-work-task-clear"
          >
            <X className="h-3 w-3" aria-hidden /> Reset
          </button>
        )}
      </div>

      {rows.length > 0 ? (
        <div className="divide-y border-t">
          {rows.map((a) => {
            const stage = taskStage(a.tags);
            return (
              <button
                key={`${a.nest_id}:${a.node_id}`}
                type="button"
                onClick={() => onOpen(a)}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted/50"
                data-testid="my-work-task-row"
              >
                <PriorityIcon priority={a.priority ?? undefined} />
                <span className={`min-w-0 flex-1 truncate ${a.done ? "text-muted-foreground line-through" : ""}`}>{a.title}</span>
                {stage && (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {stage}
                  </span>
                )}
                {!a.done && <BlockedBadge count={a.open_blockers ?? 0} />}
                {!a.done && a.due && <DueChip due={a.due} today={today} editable={false} onChange={() => {}} />}
                <span className="shrink-0 text-xs text-muted-foreground">{a.nest_name}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="border-t px-4 py-5 text-center text-sm text-muted-foreground" data-testid="my-work-tasks-empty">
          {loadingDone
            ? "Loading…"
            : items.length === 0 || (filters.status === "open" && openTotal === 0)
              ? "No open tasks assigned to you."
              : "No tasks match these filters."}
        </div>
      )}

      {(hidden > 0 || showAll) && shown.length > TASKS_PREVIEW_COUNT && (
        <div className="border-t px-4 py-1.5 text-center">
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setShowAll((v) => !v)}
            data-testid="my-work-tasks-toggle"
          >
            {showAll ? "Show fewer" : `Show all ${shown.length}`}
          </button>
        </div>
      )}
    </section>
  );
}
