import { describe, it, expect } from "vitest";
import type { AssignedItem } from "./api";
import {
  DEFAULT_TASK_FILTERS,
  isDefaultTaskFilters,
  isUrgentTask,
  matchesTaskFilters,
  openTasks,
  sortTasks,
  stagesOf,
  taskStage,
} from "./my-work-tasks";
import { urgentOnMeCount, waitingOnMeCount, nothingWaitingOnMe } from "./my-work-groups";

const TODAY = "2026-11-18";
const task = (over: Partial<AssignedItem> & { node_id: string }): AssignedItem => ({
  nest_id: "n1",
  nest_name: "Ops",
  title: over.node_id,
  type: "task",
  due: null,
  priority: null,
  assigned_at: null,
  tags: [],
  ...over,
});

describe("taskStage", () => {
  it("reads the stage: tag", () => {
    expect(taskStage(["task", "stage:doing", "owner-stacey"])).toBe("doing");
    expect(taskStage(["task"])).toBeNull();
    expect(taskStage(undefined)).toBeNull();
  });
  it("lists stages in flow order", () => {
    const items = [
      task({ node_id: "a", tags: ["stage:review"] }),
      task({ node_id: "b", tags: ["stage:backlog"] }),
      task({ node_id: "c", tags: ["stage:zeta"] }),
      task({ node_id: "d", tags: ["stage:doing"] }),
    ];
    expect(stagesOf(items)).toEqual(["backlog", "doing", "review", "zeta"]);
  });
});

describe("filters", () => {
  const open = task({ node_id: "open", tags: ["stage:doing"], priority: "high", due: "2026-11-20" });
  const done = task({ node_id: "done", done: true, completed_at: "2026-11-10T00:00:00Z" });
  const late = task({ node_id: "late", due: "2026-11-01" });

  it("shows open tasks only by default", () => {
    expect(isDefaultTaskFilters(DEFAULT_TASK_FILTERS)).toBe(true);
    const got = [open, done, late].filter((t) => matchesTaskFilters(t, DEFAULT_TASK_FILTERS, TODAY));
    expect(got.map((t) => t.node_id)).toEqual(["open", "late"]);
  });
  it("Done and All widen it", () => {
    expect([open, done].filter((t) => matchesTaskFilters(t, { ...DEFAULT_TASK_FILTERS, status: "done" }, TODAY)).map((t) => t.node_id)).toEqual(["done"]);
    expect([open, done].filter((t) => matchesTaskFilters(t, { ...DEFAULT_TASK_FILTERS, status: "all" }, TODAY))).toHaveLength(2);
  });
  it("narrows by stage, priority, due and text", () => {
    const f = DEFAULT_TASK_FILTERS;
    expect(matchesTaskFilters(open, { ...f, stage: "doing" }, TODAY)).toBe(true);
    expect(matchesTaskFilters(late, { ...f, stage: "doing" }, TODAY)).toBe(false);
    expect(matchesTaskFilters(open, { ...f, priority: "high" }, TODAY)).toBe(true);
    expect(matchesTaskFilters(late, { ...f, priority: "none" }, TODAY)).toBe(true);
    expect(matchesTaskFilters(open, { ...f, priority: "none" }, TODAY)).toBe(false);
    expect(matchesTaskFilters(late, { ...f, due: "overdue" }, TODAY)).toBe(true);
    expect(matchesTaskFilters(open, { ...f, due: "overdue" }, TODAY)).toBe(false);
    expect(matchesTaskFilters(open, { ...f, due: "week" }, TODAY)).toBe(true);
    expect(matchesTaskFilters(late, { ...f, due: "week" }, TODAY)).toBe(false);
    expect(matchesTaskFilters(task({ node_id: "x" }), { ...f, due: "none" }, TODAY)).toBe(true);
    expect(matchesTaskFilters(open, { ...f, search: "OPE" }, TODAY)).toBe(true);
    expect(matchesTaskFilters(open, { ...f, search: "nothing" }, TODAY)).toBe(false);
  });
});

describe("sortTasks", () => {
  it("puts urgent and overdue first, then soonest due, finished last", () => {
    const items = [
      task({ node_id: "later", due: "2026-12-30" }),
      task({ node_id: "finished", done: true, completed_at: "2026-11-01T00:00:00Z" }),
      task({ node_id: "nodate" }),
      task({ node_id: "overdue", due: "2026-11-01" }),
      task({ node_id: "urgent", priority: "urgent", due: "2027-01-01" }),
      task({ node_id: "soon", due: "2026-11-19" }),
    ];
    expect(sortTasks(items, TODAY).map((t) => t.node_id)).toEqual([
      "overdue",
      "urgent",
      "soon",
      "later",
      "nodate",
      "finished",
    ]);
  });
  it("a finished task is never urgent", () => {
    expect(isUrgentTask(task({ node_id: "x", priority: "urgent", done: true }), TODAY)).toBe(false);
  });
});

describe("counts ignore finished tasks", () => {
  const assigned = [
    task({ node_id: "a", priority: "urgent" }),
    task({ node_id: "b", due: "2020-01-01", done: true }),
  ];
  it("keeps them out of the badge, the urgent count and the empty state", () => {
    expect(openTasks(assigned)).toHaveLength(1);
    expect(waitingOnMeCount({ waiting_on_me_total: 0, assigned })).toBe(1);
    expect(urgentOnMeCount({ assigned }, TODAY)).toBe(1);
    expect(nothingWaitingOnMe({ items: [], assigned: [assigned[1]] })).toBe(true);
  });
});

describe("the urgent filter behind the red count", () => {
  it("keeps exactly the tasks the red count counts, and is not the default", async () => {
    const { matchesTaskFilters: matches, DEFAULT_TASK_FILTERS: base, isDefaultTaskFilters: isDefault } = await import("./my-work-tasks");
    const items = [
      task({ node_id: "a", priority: "urgent" }),
      task({ node_id: "b", due: "2020-01-01" }),
      task({ node_id: "c", priority: "low" }),
      task({ node_id: "d", priority: "urgent", done: true }),
    ];
    const f = { ...base, urgent: true };
    expect(items.filter((i) => matches(i, f, TODAY)).map((i) => i.node_id)).toEqual(["a", "b"]);
    expect(items.filter((i) => isUrgentTask(i, TODAY)).length).toBe(2);
    expect(isDefault(f)).toBe(false);
  });
});
