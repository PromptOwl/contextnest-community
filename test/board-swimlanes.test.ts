import { describe, it, expect } from "vitest";
import {
  UNCATEGORIZED,
  buildLanes,
  groupByColumn,
  laneFields,
  laneKeyOf,
  newCardPlacement,
  planMove,
  resolveConfig,
  type BoardNode,
} from "../ui/src/lib/board-dimensions";

const node = (over: Partial<BoardNode> & { id: string }): BoardNode => ({
  title: over.id,
  type: "task",
  tags: [],
  status: "published",
  ...over,
});
const nodes = [
  node({ id: "a", assignee: "ann@x.com", priority: "high" }),
  node({ id: "b", assignee: "Bob@x.com", priority: "urgent", parent: "a" }),
  node({ id: "c" }),
];

describe("assignee / priority columns", () => {
  it("assignee board: one column per person plus a pinned Unassigned", () => {
    const { columns, byColumn } = groupByColumn(nodes, resolveConfig({ dimension: "assignee", layouts: {} }));
    expect(columns.map((c) => c.key)).toEqual(["ann@x.com", "bob@x.com", UNCATEGORIZED]);
    expect(columns.at(-1)!.label).toBe("Unassigned");
    expect(byColumn[UNCATEGORIZED].map((n) => n.id)).toEqual(["c"]);
  });

  it("priority board: Linear order, every level shown, No priority last", () => {
    const { columns } = groupByColumn(nodes, resolveConfig({ dimension: "priority", layouts: {} }));
    expect(columns.map((c) => c.label)).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
  });

  it("Unassigned stays a drop target even when everyone has an owner", () => {
    const { columns } = groupByColumn([nodes[0]], resolveConfig({ dimension: "assignee", layouts: {} }));
    expect(columns.map((c) => c.key)).toContain(UNCATEGORIZED);
  });

  it("dragging across sets (or clears) the field", () => {
    const cfg = resolveConfig({ dimension: "assignee", layouts: {} });
    expect(planMove(nodes[2], "ann@x.com", cfg)).toEqual({ kind: "set-fields", fields: { assignee: "ann@x.com" } });
    expect(planMove(nodes[0], UNCATEGORIZED, cfg)).toEqual({ kind: "set-fields", fields: { assignee: null } });
    expect(planMove(nodes[0], "ann@x.com", cfg).kind).toBe("unsupported");
    const pcfg = resolveConfig({ dimension: "priority", layouts: {} });
    expect(planMove(nodes[0], "low", pcfg)).toEqual({ kind: "set-fields", fields: { priority: "low" } });
  });

  it("+ Add task in a person/priority column sets that field", () => {
    expect(newCardPlacement("ann@x.com", resolveConfig({ dimension: "assignee", layouts: {} }))).toEqual({ assignee: "ann@x.com" });
    expect(newCardPlacement("urgent", resolveConfig({ dimension: "priority", layouts: {} }))).toEqual({ priority: "urgent" });
    expect(newCardPlacement(UNCATEGORIZED, resolveConfig({ dimension: "priority", layouts: {} }))).toEqual({});
  });
});

describe("swimlanes", () => {
  it("lane keys per kind", () => {
    expect(laneKeyOf(nodes[1], "assignee")).toBe("bob@x.com");
    expect(laneKeyOf(nodes[2], "priority")).toBe(UNCATEGORIZED);
    expect(laneKeyOf(nodes[1], "parent")).toBe("a");
  });

  it("priority lanes run most urgent first, the none lane last, empty lanes dropped", () => {
    const lanes = buildLanes(nodes, "priority", (k) => k);
    expect(lanes.map((l) => l.key)).toEqual(["urgent", "high", UNCATEGORIZED]);
  });

  it("assignee lanes sort by label", () => {
    const lanes = buildLanes(nodes, "assignee", (k) => (k === "bob@x.com" ? "Aaron" : k === "ann@x.com" ? "Zed" : "None"));
    expect(lanes.map((l) => l.key)).toEqual(["bob@x.com", "ann@x.com", UNCATEGORIZED]);
  });

  it("moving into a lane writes that lane's field", () => {
    expect(laneFields("assignee", "ann@x.com")).toEqual({ assignee: "ann@x.com" });
    expect(laneFields("priority", UNCATEGORIZED)).toEqual({ priority: null });
    expect(laneFields("parent", "a")).toEqual({ parent: "a" });
  });
});
