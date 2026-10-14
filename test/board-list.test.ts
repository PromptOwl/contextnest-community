/**
 * Board List view logic (ui/src/lib/board-list.ts): sorting, sections,
 * windowing, selection and the remembered/URL layout.
 */
import { describe, it, expect } from "vitest";
import {
  LIST_COLUMNS,
  ROW_HEIGHT,
  SECTION_HEIGHT,
  bulkResultLine,
  chunk,
  fieldColumn,
  flattenSections,
  nextSort,
  pruneSelection,
  resolveViewMode,
  selectionState,
  sortRows,
  toggleGroup,
  viewStorageKey,
  visibleWindow,
  withLayoutParam,
  type ListContext,
} from "../ui/src/lib/board-list";
import type { BoardNode } from "../ui/src/lib/board-dimensions";

const node = (id: string, extra: Partial<BoardNode> = {}): BoardNode => ({
  id,
  title: id,
  type: "task",
  tags: [],
  status: "published",
  ...extra,
});

const ctx: ListContext = {
  titleOf: (id) => ({ p1: "Zeta parent", p2: "Alpha parent" })[id as "p1" | "p2"],
  columnsOf: (n) => n.tags.map((t) => t.replace(/^#/, "")),
  columnLabel: (k) => k,
};

describe("sortRows", () => {
  const rows = [
    node("c", { priority: "low", due: "2026-11-03", parent: "p1", updated_at: "2026-10-01T00:00:00Z" }),
    node("a", { priority: "urgent", updated_at: "2026-10-05T00:00:00Z" }),
    node("b", { due: "2026-11-01", parent: "p2", updated_at: "2026-10-03T00:00:00Z" }),
  ];
  const ids = (xs: BoardNode[]) => xs.map((x) => x.id);

  it("keeps board order for rank", () => {
    expect(ids(sortRows(rows, { key: "rank", dir: "asc" }, ctx))).toEqual(["c", "a", "b"]);
  });
  it("sorts priority urgent-first and sinks empty values in both directions", () => {
    expect(ids(sortRows(rows, { key: "priority", dir: "asc" }, ctx))).toEqual(["a", "c", "b"]);
    expect(ids(sortRows(rows, { key: "priority", dir: "desc" }, ctx))).toEqual(["c", "a", "b"]);
    expect(ids(sortRows(rows, { key: "due", dir: "asc" }, ctx))).toEqual(["b", "c", "a"]);
    expect(ids(sortRows(rows, { key: "due", dir: "desc" }, ctx))).toEqual(["c", "b", "a"]);
  });
  it("sorts parents by title, not id, and updated newest-first", () => {
    expect(ids(sortRows(rows, { key: "parent", dir: "asc" }, ctx))).toEqual(["b", "c", "a"]);
    expect(ids(sortRows(rows, { key: "updated", dir: "desc" }, ctx))).toEqual(["a", "b", "c"]);
  });
  it("sorts a custom field column through the same path", () => {
    const est = fieldColumn("estimate", "Estimate", (n) => (n as any).estimate);
    const withEst = [node("x", { estimate: 5 } as any), node("y", { estimate: 2 } as any), node("z")];
    expect(ids(sortRows(withEst, { key: "field:estimate", dir: "asc" }, ctx, [...LIST_COLUMNS, est]))).toEqual([
      "y",
      "x",
      "z",
    ]);
  });
});

describe("nextSort", () => {
  it("cycles asc → desc → board order; dates start newest-first", () => {
    let s = nextSort({ key: "rank", dir: "asc" }, "title");
    expect(s).toEqual({ key: "title", dir: "asc" });
    s = nextSort(s, "title");
    expect(s).toEqual({ key: "title", dir: "desc" });
    expect(nextSort(s, "title")).toEqual({ key: "rank", dir: "asc" });
    expect(nextSort({ key: "rank", dir: "asc" }, "updated")).toEqual({ key: "updated", dir: "desc" });
  });
});

describe("sections and windowing", () => {
  const sections = [
    { key: "todo", label: "Todo", nodes: [node("a"), node("b")] },
    { key: "empty", label: "Empty", nodes: [] },
    { key: "done", label: "Done", nodes: [node("c")] },
  ];

  it("flattens sections, drops empty ones and hides collapsed rows", () => {
    const flat = flattenSections(sections, new Set(["done"]));
    expect(flat.map((r) => (r.kind === "section" ? `#${r.key}` : r.node.id))).toEqual(["#todo", "a", "b", "#done"]);
    expect(flat[3]).toMatchObject({ kind: "section", collapsed: true, count: 1 });
  });

  it("renders only the rows near the viewport of a large list", () => {
    const big = [{ key: "all", label: "All", nodes: Array.from({ length: 5000 }, (_, i) => node(`n${i}`)) }];
    const flat = flattenSections(big, new Set());
    const w = visibleWindow(flat, 100_000, 600, 200);
    expect(w.total).toBe(SECTION_HEIGHT + 5000 * ROW_HEIGHT);
    expect(w.end - w.start).toBeLessThan(40);
    expect(w.offsets[w.start]).toBeLessThanOrEqual(100_000 - 200);
    expect(w.offsets[w.end - 1]).toBeGreaterThanOrEqual(100_000 + 600);
  });
});

describe("selection", () => {
  it("reports all/some/none and toggles a group", () => {
    const sel = new Set(["a"]);
    expect(selectionState(["a", "b"], sel)).toBe("some");
    const all = toggleGroup(["a", "b"], sel);
    expect(selectionState(["a", "b"], all)).toBe("all");
    expect(selectionState(["a", "b"], toggleGroup(["a", "b"], all))).toBe("none");
  });
  it("prunes ids that left the list, keeping identity when nothing changed", () => {
    const sel = new Set(["a", "b"]);
    expect(pruneSelection(sel, ["a", "b", "c"])).toBe(sel);
    expect([...pruneSelection(sel, ["b"])]).toEqual(["b"]);
  });
  it("chunks to the bulk endpoint's cap", () => {
    expect(chunk(Array.from({ length: 250 }, (_, i) => i), 100).map((c) => c.length)).toEqual([100, 100, 50]);
  });
  it("words the result", () => {
    expect(bulkResultLine({ updated: 10, skipped: 2, failed: 0, unchanged: 1 })).toBe(
      "10 updated · 1 already set · 2 skipped",
    );
  });
});

describe("layout memory", () => {
  it("prefers ?layout= over the remembered choice, defaulting to the board", () => {
    expect(resolveViewMode("?layout=list", "board")).toBe("list");
    expect(resolveViewMode("?layout=board", "list")).toBe("board");
    expect(resolveViewMode("", "list")).toBe("list");
    expect(resolveViewMode("?view=list", null)).toBe("board");
  });
  it("keys the memory per person and board", () => {
    expect(viewStorageKey("ann@acme.com", "b1")).not.toBe(viewStorageKey("bob@acme.com", "b1"));
    expect(viewStorageKey("ann@acme.com", "b1")).not.toBe(viewStorageKey("ann@acme.com", "b2"));
  });
  it("writes the list layout into the query and keeps other params", () => {
    expect(withLayoutParam("?board=1", "list")).toBe("?board=1&layout=list");
    expect(withLayoutParam("?board=1&layout=list", "board")).toBe("?board=1");
    expect(withLayoutParam("?layout=list", "board")).toBe("");
  });
});
