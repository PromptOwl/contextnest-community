/**
 * Tag board setup (CU-wdqcq05pad): pattern columns ("status*" → one column per
 * matching tag, new tags included) and the add-column tag suggestions. The
 * server's board list must section a pattern board exactly as the board does.
 */
import { describe, it, expect } from "vitest";
import {
  buildColumns,
  globMatch,
  groupByColumn,
  isColumnPattern,
  keepPatterns,
  withoutPattern,
  planMove,
  resolveConfig,
  tagSuggestions,
  UNCATEGORIZED,
  type BoardNode,
  type BoardSettings,
} from "../ui/src/lib/board-dimensions";
import {
  globMatch as serverGlobMatch,
  groupForBoard,
  type BoardConfig as ServerBoardConfig,
} from "../src/nests/board-items";
import { columnInputRows } from "../ui/src/lib/tag-column-input";
import type { NodeResponse } from "../src/nodes/service";

const node = (id: string, tags: string[]): BoardNode => ({
  id,
  title: id,
  type: "task",
  tags,
  status: "draft",
});

const docs = [
  node("a", ["#status:todo", "#launch"]),
  node("b", ["#status:doing"]),
  node("c", ["#Status-Done"]),
  node("d", ["#launch"]),
];

const tagBoard = (columnOrder: string[], hiddenColumns?: string[]): BoardSettings => ({
  dimension: "tag",
  layouts: { "tag:": { columnOrder, hiddenColumns } },
});

describe("isColumnPattern", () => {
  it("treats a key with * as a pattern and anything else as a tag", () => {
    expect(isColumnPattern("status*")).toBe(true);
    expect(isColumnPattern("*-review")).toBe(true);
    expect(isColumnPattern("status:todo")).toBe(false);
    expect(isColumnPattern("*")).toBe(true);
  });
});

describe("pattern columns", () => {
  it("expands status* into one column per matching tag, case-insensitively, sorted", () => {
    const cols = buildColumns(docs, resolveConfig(tagBoard(["status*"])));
    expect(cols.map((c) => c.key)).toEqual(["Status-Done", "status:doing", "status:todo"].sort());
  });

  it("puts the expansion where the pattern sits, after explicit columns before it", () => {
    const cols = buildColumns(docs, resolveConfig(tagBoard(["launch", "status*"])));
    expect(cols.map((c) => c.key)).toEqual(["launch", "Status-Done", "status:doing", "status:todo"]);
  });

  it("doesn't repeat a tag that is listed as its own column", () => {
    const cols = buildColumns(docs, resolveConfig(tagBoard(["status:todo", "status*"])));
    expect(cols.map((c) => c.key)).toEqual(["status:todo", "Status-Done", "status:doing"]);
  });

  it("picks up a tag added later with no setup", () => {
    const cfg = resolveConfig(tagBoard(["status*"]));
    const more = [...docs, node("e", ["#status:blocked"])];
    expect(buildColumns(more, cfg).map((c) => c.key)).toContain("status:blocked");
  });

  it("leaves a hidden match out but keeps the rest", () => {
    const cfg = resolveConfig(tagBoard(["status*"], ["status:doing"]));
    const { columns, byColumn } = groupByColumn(docs, cfg);
    expect(columns.map((c) => c.key)).toEqual(["Status-Done", "status:todo"]);
    expect(byColumn["status:todo"].map((n) => n.id)).toEqual(["a"]);
    // No catch-all on an explicit board: unmatched cards just aren't shown.
    expect(byColumn[UNCATEGORIZED]).toBeUndefined();
    expect(Object.values(byColumn).flat().map((n) => n.id)).not.toContain("b");
  });

  it("files each card under its matching tags", () => {
    const { byColumn } = groupByColumn(docs, resolveConfig(tagBoard(["status*", "launch"])));
    expect(byColumn["status:doing"].map((n) => n.id)).toEqual(["b"]);
    expect(byColumn["launch"].map((n) => n.id)).toEqual(["a", "d"]);
  });

  it("drags between expanded columns as an ordinary retag", () => {
    const cfg = resolveConfig(tagBoard(["status*"]));
    expect(planMove(docs[0], "status:doing", cfg, "status:todo")).toEqual({
      kind: "retag",
      tags: ["#launch", "#status:doing"],
    });
  });

  it("matches the value after the namespace on a namespaced board", () => {
    const s: BoardSettings = {
      dimension: "tag",
      tagNamespace: "status",
      layouts: { "tag:status": { columnOrder: ["d*"] } },
    };
    expect(buildColumns(docs, resolveConfig(s)).map((c) => c.key)).toEqual(["doing"]);
  });
});

describe("keepPatterns", () => {
  it("carries the saved patterns into a rewritten order, so reordering doesn't drop them", () => {
    expect(keepPatterns(["status:todo", "launch"], ["launch", "status*"])).toEqual([
      "status:todo",
      "launch",
      "status*",
    ]);
    expect(keepPatterns(["a", "status*"], ["status*"])).toEqual(["a", "status*"]);
    expect(keepPatterns(["a"], undefined)).toEqual(["a"]);
  });
});

describe("tagSuggestions", () => {
  it("lists tags with document counts, most used first, filtered by the typed text", () => {
    const cfg = resolveConfig(tagBoard([]));
    expect(tagSuggestions(docs, cfg, "")).toEqual([
      { value: "launch", count: 2 },
      { value: "Status-Done", count: 1 },
      { value: "status:doing", count: 1 },
      { value: "status:todo", count: 1 },
    ]);
    expect(tagSuggestions(docs, cfg, "STA").map((s) => s.value)).toEqual([
      "Status-Done",
      "status:doing",
      "status:todo",
    ]);
  });

  it("leaves out tags that are already columns, directly or through a pattern", () => {
    const cfg = resolveConfig(tagBoard(["launch", "status:t*"]));
    expect(tagSuggestions(docs, cfg, "").map((s) => s.value)).toEqual(["Status-Done", "status:doing"]);
  });

  it("suggests from every card, not only the ones on the board", () => {
    // On an explicit board a card matching no column isn't shown — its tags
    // are exactly the ones worth offering.
    const cfg = resolveConfig(tagBoard(["launch"]));
    expect(tagSuggestions(docs, cfg, "doing").map((s) => s.value)).toEqual(["status:doing"]);
  });
});

describe("server board list (MCP/REST) sections a pattern board like the board", () => {
  it("expands the pattern in place", () => {
    const c: ServerBoardConfig = {
      dimension: "tag",
      layouts: { "tag:": { columnOrder: ["launch", "status*"], hiddenColumns: ["status:doing"] } },
    } as ServerBoardConfig;
    const { groups, byGroup } = groupForBoard(docs as unknown as NodeResponse[], c);
    const ui = buildColumns(docs, resolveConfig(tagBoard(["launch", "status*"], ["status:doing"])));
    expect(groups.map((g) => g.key)).toEqual(ui.map((col) => col.key));
    expect(byGroup.get("launch")!.map((n) => n.id)).toEqual(["a", "d"]);
  });
});

describe("globMatch (UI and server copies agree)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["status*", "status:todo", true],
    ["status*", "Status-Done", true],
    ["status*", "status", true],
    ["status*", "my-status", false],
    ["*", "", true],
    ["*", "anything", true],
    ["*review", "status-review", true],
    ["a**b", "ab", true],
    ["a**b", "axxb", true],
    ["a*b*c", "abbbc", true],
    ["a*b*c", "acb", false],
    ["status", "status", true],
    ["status", "status:todo", false],
    ["s*", "", false],
    ["", "", true],
    ["*a*a*a*a*a*b", "a".repeat(500), false],
  ];
  it.each(cases)("%s ~ %s → %s", (pattern, value, want) => {
    expect(globMatch(pattern, value)).toBe(want);
    expect(serverGlobMatch(pattern, value)).toBe(want);
  });
});

describe("server parity: a listed tag plus a pattern", () => {
  it("keeps the listed tag's own place and doesn't repeat it in the expansion", () => {
    const order = ["status:todo", "launch", "status*"];
    const c = { dimension: "tag", layouts: { "tag:": { columnOrder: order } } } as unknown as ServerBoardConfig;
    const { groups } = groupForBoard(docs as unknown as NodeResponse[], c);
    expect(groups.map((g) => g.key)).toEqual(
      buildColumns(docs, resolveConfig(tagBoard(order))).map((col) => col.key),
    );
    expect(groups.map((g) => g.key)).toEqual(["status:todo", "launch", "Status-Done", "status:doing"]);
  });
});

describe("withoutPattern", () => {
  it("drops the pattern and every column it brought in, pinned ones included", () => {
    expect(withoutPattern(["launch", "status:todo", "status*", "x"], "status*")).toEqual(["launch", "x"]);
    expect(withoutPattern(undefined, "status*")).toEqual([]);
  });
});

describe("hiding or adding next to a pattern pins nothing", () => {
  // MaturityBoard writes hide/add against the saved order, not the visible
  // one, so the pattern's other columns stay pattern-driven.
  it("hide: saved order minus the key, plus hidden", () => {
    const saved = ["launch", "status*"];
    const order = saved.filter((k) => k !== "Status-Done");
    const cfg = resolveConfig(tagBoard(order, ["Status-Done"]));
    expect(cfg.columnOrder).toEqual(["launch", "status*"]);
    expect(buildColumns(docs, cfg).map((c) => c.key)).toEqual(["launch", "status:doing", "status:todo"]);
    expect(withoutPattern(cfg.columnOrder, "status*")).toEqual(["launch"]);
  });
});

describe("columnInputRows (the add-column box)", () => {
  const sugg = [
    { value: "Status-Done", count: 3 },
    { value: "status:todo", count: 2 },
    { value: "launch", count: 1 },
  ];
  it("Enter adds what was typed: a non-tag is offered first as a new tag", () => {
    const { rows, active } = columnInputRows("status", sugg);
    expect(rows[active]).toMatchObject({ kind: "new", value: "status" });
    expect(rows.slice(1).map((r) => r.value)).toEqual(["Status-Done", "status:todo"]);
  });
  it("an exact match is the Enter target, with no new-tag row", () => {
    const { rows, active } = columnInputRows("#Launch", sugg);
    expect(rows.map((r) => r.kind)).toEqual(["tag"]);
    expect(rows[active].value).toBe("launch");
  });
  it("an empty box lists everything and pre-selects nothing", () => {
    const { rows, active } = columnInputRows("  ", sugg);
    expect(rows.map((r) => r.value)).toEqual(["Status-Done", "status:todo", "launch"]);
    expect(active).toBe(-1);
  });
  it("a pattern is one row that previews its matches", () => {
    const { rows, active } = columnInputRows("status*", sugg);
    expect(rows).toHaveLength(1);
    expect(rows[active]).toMatchObject({ kind: "pattern", value: "status*" });
    expect(rows[0].hint).toContain("2 now: Status-Done, status:todo");
  });
});
