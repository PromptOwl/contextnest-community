/**
 * Tag board setup (CU-wdqcq05pad): pattern columns ("status*" → one column per
 * matching tag, new tags included) and the add-column tag suggestions. The
 * server's board list must section a pattern board exactly as the board does.
 */
import { describe, it, expect } from "vitest";
import {
  buildColumns,
  groupByColumn,
  isColumnPattern,
  keepPatterns,
  planMove,
  resolveConfig,
  tagSuggestions,
  UNCATEGORIZED,
  type BoardNode,
  type BoardSettings,
} from "../ui/src/lib/board-dimensions";
import { groupForBoard, type BoardConfig as ServerBoardConfig } from "../src/nests/board-items";
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
