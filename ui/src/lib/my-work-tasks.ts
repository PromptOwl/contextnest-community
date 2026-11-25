import type { AssignedItem } from "./api";
import { dueState, priorityRank } from "./board-tasks";

/**
 * Pure logic for the Tasks list on My Work: which task is open, which stage it
 * is in, and how the filter bar narrows and orders the list. The page renders;
 * this decides, so it runs in the node test env.
 */

export type TaskStatusFilter = "open" | "done" | "all";
export type PriorityFilter = "all" | "urgent" | "high" | "medium" | "low" | "none";
export type DueFilter = "all" | "overdue" | "week" | "none";

export interface TaskFilters {
  status: TaskStatusFilter;
  /** A stage name (`doing`), or "all". */
  stage: string;
  priority: PriorityFilter;
  due: DueFilter;
  /** Only the pressing ones: urgent by priority, or overdue. */
  urgent: boolean;
  search: string;
}

/** Open tasks only — the question My Work answers is "what do I owe". */
export const DEFAULT_TASK_FILTERS: TaskFilters = {
  status: "open",
  stage: "all",
  priority: "all",
  due: "all",
  urgent: false,
  search: "",
};

export function isDefaultTaskFilters(f: TaskFilters): boolean {
  return (
    f.status === DEFAULT_TASK_FILTERS.status &&
    f.stage === "all" &&
    f.priority === "all" &&
    f.due === "all" &&
    !f.urgent &&
    f.search.trim() === ""
  );
}

/** The stage a task is in: the tag `stage:<name>` (`stage:doing` → "doing"), or null. */
export function taskStage(tags: readonly string[] | undefined): string | null {
  const t = (tags ?? []).find((x) => x.startsWith("stage:"));
  return t ? t.slice("stage:".length) || null : null;
}

/** Stages that exist across the tasks, in the usual flow order, then the rest A–Z. */
const STAGE_ORDER = ["backlog", "todo", "doing", "blocked", "review", "done"];
export function stagesOf(items: readonly AssignedItem[]): string[] {
  const seen = new Set<string>();
  for (const a of items) {
    const s = taskStage(a.tags);
    if (s) seen.add(s);
  }
  return [...seen].sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a);
    const ib = STAGE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
}

/** Urgent by priority, or past its due day — the same rule as the red count. */
export function isUrgentTask(a: AssignedItem, today: string): boolean {
  if (a.done) return false;
  return a.priority === "urgent" || (!!a.due && dueState(a.due, today) === "overdue");
}

export function matchesTaskFilters(a: AssignedItem, f: TaskFilters, today: string): boolean {
  if (f.status === "open" && a.done) return false;
  if (f.status === "done" && !a.done) return false;
  if (f.stage !== "all" && taskStage(a.tags) !== f.stage) return false;
  if (f.urgent && !isUrgentTask(a, today)) return false;
  if (f.priority !== "all") {
    if (f.priority === "none" ? !!a.priority : a.priority !== f.priority) return false;
  }
  if (f.due !== "all") {
    if (f.due === "none") {
      if (a.due) return false;
    } else {
      if (!a.due) return false;
      if (f.due === "overdue" && dueState(a.due, today) !== "overdue") return false;
      if (f.due === "week") {
        const days = (Date.parse(a.due) - Date.parse(today)) / 86_400_000;
        if (days < 0 || days > 7) return false;
      }
    }
  }
  const q = f.search.trim().toLowerCase();
  if (q && !`${a.title} ${a.nest_name}`.toLowerCase().includes(q)) return false;
  return true;
}

/**
 * Open work first, most pressing on top: urgent or overdue, then soonest due
 * (no date last), then priority, then newest assignment. Finished tasks follow,
 * most recently finished first.
 */
export function sortTasks(items: readonly AssignedItem[], today: string): AssignedItem[] {
  return [...items].sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (a.done && b.done) return (b.completed_at ?? "").localeCompare(a.completed_at ?? "");
    const ua = isUrgentTask(a, today) ? 0 : 1;
    const ub = isUrgentTask(b, today) ? 0 : 1;
    return (
      ua - ub ||
      (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
      priorityRank(a.priority ?? undefined) - priorityRank(b.priority ?? undefined) ||
      (b.assigned_at ?? "").localeCompare(a.assigned_at ?? "")
    );
  });
}

/** Tasks that wait on you — finished ones never count. */
export function openTasks(items: readonly AssignedItem[] | undefined): AssignedItem[] {
  return (items ?? []).filter((a) => !a.done);
}
