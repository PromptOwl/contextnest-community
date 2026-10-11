/**
 * Custom fields on the client — formatting, and grouping / filtering a board
 * by a select, person or checkbox field (ui/src/lib/custom-fields.ts and the
 * "field" dimension in ui/src/lib/board-dimensions.ts).
 */
import { describe, it, expect } from "vitest";
import {
  NO_VALUE,
  fieldColumnKeys,
  fieldValueForMove,
  formatFieldValue,
  matchesFieldFilters,
  timeInStatus,
  type FieldDefinition,
} from "../ui/src/lib/custom-fields";
import {
  UNCATEGORIZED,
  buildLanes,
  groupByColumn,
  laneFields,
  layoutKey,
  newCardPlacement,
  planMove,
  resolveConfig,
  type BoardNode,
} from "../ui/src/lib/board-dimensions";

const def = (over: Partial<FieldDefinition>): FieldDefinition => ({
  id: over.key ?? "x",
  nest_id: "n",
  key: "x",
  label: "X",
  type: "text",
  options: [],
  required: false,
  default_value: null,
  applies_to: ["task"],
  unit: null,
  preset: null,
  position: 0,
  created_by: null,
  created_at: "",
  updated_at: "",
  ...over,
});

const severity = def({ key: "severity", label: "Severity", type: "select", options: ["low", "high"] });
const area = def({ key: "area", label: "Area", type: "multi_select", options: ["ui", "api"] });
const owner = def({ key: "owner", label: "Owner", type: "user" });
const blocked = def({ key: "blocked", label: "Blocked", type: "checkbox" });
const estimate = def({ key: "estimate", label: "Estimate", type: "number", unit: "points" });
const tis = def({ key: "tis", label: "Time in status", type: "time_in_status" });

const node = (id: string, fields: Record<string, unknown> = {}): BoardNode => ({
  id: `nodes/${id}`,
  title: id,
  type: "task",
  tags: [],
  status: "published",
  fields,
});

describe("formatting", () => {
  it("formats every type", () => {
    expect(formatFieldValue(estimate, 3)).toBe("3 pts");
    expect(formatFieldValue({ ...estimate, unit: "hours" }, 1.5)).toBe("1.5h");
    expect(formatFieldValue(area, ["ui", "api"])).toBe("ui, api");
    expect(formatFieldValue(blocked, true)).toBe("Blocked");
    expect(formatFieldValue(blocked, false)).toBe("");
    expect(formatFieldValue(owner, "a@x.com", { personLabel: () => "Ana" })).toBe("Ana");
    expect(formatFieldValue(def({ type: "url" }), "https://example.com/spec")).toBe("example.com/spec");
    expect(formatFieldValue(severity, null)).toBe("");
  });

  it("time in status ticks from status_since", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const n = { status_since: "2026-10-07T08:00:00Z", fields: { tis: 1 } };
    expect(timeInStatus(n, tis, now)).toBe(2 * 86400 + 4 * 3600);
    expect(formatFieldValue(tis, 1, { node: n, now })).toBe("2d 4h");
    expect(timeInStatus({ fields: { tis: 90 } }, tis, now)).toBe(90);
  });
});

describe("grouping a board by a field", () => {
  const nodes = [
    node("a", { severity: "high", area: ["ui", "api"], owner: "Ana@x.com", blocked: true }),
    node("b", { severity: "low" }),
    node("c"),
  ];

  it("select columns follow the option order, with a No-value column last", () => {
    const config = resolveConfig(
      { dimension: "field", fieldKey: "severity", layouts: {} },
      [severity],
    );
    const { columns, byColumn } = groupByColumn(nodes, config);
    expect(columns.map((c) => c.key)).toEqual(["low", "high", UNCATEGORIZED]);
    expect(columns.at(-1)!.label).toBe("No severity");
    expect(byColumn.high!.map((n) => n.title)).toEqual(["a"]);
    expect(byColumn[UNCATEGORIZED]!.map((n) => n.title)).toEqual(["c"]);
  });

  it("multi-select puts a card in each of its options; checkbox has no No-value column", () => {
    const multi = groupByColumn(nodes, resolveConfig({ dimension: "field", fieldKey: "area", layouts: {} }, [area]));
    expect(multi.byColumn.ui!.map((n) => n.title)).toEqual(["a"]);
    expect(multi.byColumn.api!.map((n) => n.title)).toEqual(["a"]);
    const check = groupByColumn(nodes, resolveConfig({ dimension: "field", fieldKey: "blocked", layouts: {} }, [blocked]));
    expect(check.columns.map((c) => c.key)).toEqual(["false", "true"]);
    expect(check.columns.map((c) => c.label)).toEqual(["Not blocked", "Blocked"]);
    expect(check.byColumn.false!.map((n) => n.title)).toEqual(["b", "c"]);
  });

  it("user columns key on the lower-cased email", () => {
    expect(fieldColumnKeys(owner, "Ana@x.com")).toEqual(["ana@x.com"]);
    expect(fieldColumnKeys(owner, undefined)).toEqual([NO_VALUE]);
  });

  it("each field keeps its own layout", () => {
    expect(layoutKey({ dimension: "field", fieldKey: "severity" })).toBe("field:severity");
  });

  it("a drag writes only that field; multi-select swaps one option", () => {
    const config = resolveConfig({ dimension: "field", fieldKey: "severity", layouts: {} }, [severity]);
    expect(planMove(nodes[1]!, "high", config, "low")).toEqual({ kind: "set-custom", fields: { severity: "high" } });
    expect(planMove(nodes[1]!, UNCATEGORIZED, config, "low")).toEqual({ kind: "set-custom", fields: { severity: null } });
    expect(planMove(nodes[1]!, "low", config, "low").kind).toBe("unsupported");
    expect(fieldValueForMove(area, ["ui", "api"], "api", "ui")).toEqual(["api"]);
    expect(fieldValueForMove(area, ["ui"], "api", "ui")).toEqual(["api"]);
    expect(fieldValueForMove(blocked, false, "true")).toBe(true);
    const computed = resolveConfig({ dimension: "field", fieldKey: "tis", layouts: {} }, [tis]);
    expect(planMove(nodes[0]!, "x", computed).kind).toBe("unsupported");
  });

  it("a card added in a column carries the column's value", () => {
    const config = resolveConfig({ dimension: "field", fieldKey: "blocked", layouts: {} }, [blocked]);
    expect(newCardPlacement("true", config)).toEqual({ fields: { blocked: true } });
    const sel = resolveConfig({ dimension: "field", fieldKey: "severity", layouts: {} }, [severity]);
    expect(newCardPlacement(UNCATEGORIZED, sel)).toEqual({});
  });

  it("lanes by a field, in option order", () => {
    const lanes = buildLanes(nodes, "field", (k) => k, severity);
    expect(lanes.map((l) => l.key)).toEqual(["low", "high", UNCATEGORIZED]);
    expect(laneFields("field", "high", severity)).toEqual({ fields: { severity: "high" } });
  });
});

describe("board field filters", () => {
  const defs = [severity, area, owner, blocked];
  const a = node("a", { severity: "high", area: ["ui"], owner: "ana@x.com", blocked: true });
  const b = node("b", { severity: "low" });

  it("narrow by select, multi-select, person, checkbox and no-value", () => {
    expect(matchesFieldFilters(a, { severity: "high" }, defs)).toBe(true);
    expect(matchesFieldFilters(b, { severity: "high" }, defs)).toBe(false);
    expect(matchesFieldFilters(a, { area: "ui" }, defs)).toBe(true);
    expect(matchesFieldFilters(a, { owner: "ANA@x.com" }, defs)).toBe(true);
    expect(matchesFieldFilters(b, { blocked: "false" }, defs)).toBe(true);
    expect(matchesFieldFilters(b, { owner: "none" }, defs)).toBe(true);
    // A filter on a deleted field no longer narrows anything.
    expect(matchesFieldFilters(b, { gone: "x" }, defs)).toBe(true);
    // A field that doesn't apply to the card's type can't match.
    expect(matchesFieldFilters({ ...b, type: "document" }, { severity: "low" }, defs)).toBe(false);
  });
});
