import { describe, it, expect } from "vitest";
import {
  folderOf,
  tagValueInNamespace,
  cardColumnKey,
  buildColumns,
  groupByColumn,
  planMove,
  UNCATEGORIZED,
  type BoardNode,
  type BoardConfig,
} from "../ui/src/lib/board-dimensions";

const node = (over: Partial<BoardNode> & { id: string }): BoardNode => ({
  title: over.id,
  type: "document",
  tags: [],
  status: "draft",
  ...over,
});

describe("folderOf", () => {
  it("returns the parent path of a path-like id", () => {
    expect(folderOf("gtm/deals/foley")).toBe("gtm/deals");
    expect(folderOf("gtm/deals")).toBe("gtm");
  });
  it("returns '' for a root-level id", () => {
    expect(folderOf("foley")).toBe("");
  });
});

describe("tagValueInNamespace", () => {
  it("extracts the value after 'ns:'", () => {
    expect(tagValueInNamespace(["x", "stage:review", "y"], "stage")).toBe(
      "review",
    );
  });
  it("returns null when no namespaced tag is present", () => {
    expect(tagValueInNamespace(["x", "y"], "stage")).toBeNull();
  });
  it("returns the FIRST matching namespaced tag deterministically", () => {
    expect(
      tagValueInNamespace(["stage:review", "stage:draft"], "stage"),
    ).toBe("review");
  });
});

describe("cardColumnKey", () => {
  it("folder dimension → the node's folder ('' for root)", () => {
    const cfg: BoardConfig = { dimension: "folder" };
    expect(cardColumnKey(node({ id: "gtm/deals/foo" }), cfg)).toBe("gtm/deals");
    expect(cardColumnKey(node({ id: "root-doc" }), cfg)).toBe("");
  });
  it("status dimension → the node's status", () => {
    const cfg: BoardConfig = { dimension: "status" };
    expect(cardColumnKey(node({ id: "a", status: "approved" }), cfg)).toBe(
      "approved",
    );
  });
  it("tag dimension → the namespaced tag value, else UNCATEGORIZED", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "stage" };
    expect(
      cardColumnKey(node({ id: "a", tags: ["stage:shipped"] }), cfg),
    ).toBe("shipped");
    expect(cardColumnKey(node({ id: "b", tags: ["other"] }), cfg)).toBe(
      UNCATEGORIZED,
    );
  });
});

describe("buildColumns", () => {
  it("returns distinct column keys present in the data", () => {
    const cfg: BoardConfig = { dimension: "status" };
    const cols = buildColumns(
      [
        node({ id: "a", status: "draft" }),
        node({ id: "b", status: "approved" }),
        node({ id: "c", status: "draft" }),
      ],
      cfg,
    );
    expect(cols.map((c) => c.key).sort()).toEqual(["approved", "draft"]);
  });
  it("honors an explicit columnOrder, appending unknown keys after", () => {
    const cfg: BoardConfig = {
      dimension: "status",
      columnOrder: ["draft", "in_review", "approved", "published"],
    };
    const cols = buildColumns(
      [
        node({ id: "a", status: "approved" }),
        node({ id: "b", status: "draft" }),
        node({ id: "c", status: "weird" }),
      ],
      cfg,
    );
    // ordered ones first (only those present or explicitly listed), unknown last
    expect(cols.map((c) => c.key)).toEqual([
      "draft",
      "in_review",
      "approved",
      "published",
      "weird",
    ]);
  });
});

describe("groupByColumn", () => {
  it("buckets every node under exactly one column, incl. UNCATEGORIZED", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "stage" };
    const nodes = [
      node({ id: "a", tags: ["stage:draft"] }),
      node({ id: "b", tags: ["stage:draft"] }),
      node({ id: "c", tags: ["nope"] }),
    ];
    const { columns, byColumn } = groupByColumn(nodes, cfg);
    const total = columns.reduce(
      (n, col) => n + (byColumn[col.key]?.length ?? 0),
      0,
    );
    expect(total).toBe(3);
    expect(byColumn["draft"].map((n) => n.id)).toEqual(["a", "b"]);
    expect(byColumn[UNCATEGORIZED].map((n) => n.id)).toEqual(["c"]);
  });
});

describe("planMove", () => {
  it("folder → move-folder to the target folder", () => {
    const cfg: BoardConfig = { dimension: "folder" };
    expect(planMove(node({ id: "gtm/foo" }), "sales", cfg)).toEqual({
      kind: "move-folder",
      folder: "sales",
    });
  });

  it("tag → swaps the namespaced tag, preserving other tags", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "stage" };
    const plan = planMove(
      node({ id: "a", tags: ["keep", "stage:draft"] }),
      "review",
      cfg,
    );
    expect(plan).toEqual({ kind: "set-tag", tags: ["keep", "stage:review"] });
  });

  it("tag → dropping into UNCATEGORIZED removes the namespaced tag", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "stage" };
    const plan = planMove(
      node({ id: "a", tags: ["keep", "stage:draft"] }),
      UNCATEGORIZED,
      cfg,
    );
    expect(plan).toEqual({ kind: "set-tag", tags: ["keep"] });
  });

  it("status → unsupported (governance goes through the review workflow)", () => {
    const cfg: BoardConfig = { dimension: "status" };
    const plan = planMove(node({ id: "a" }), "approved", cfg);
    expect(plan.kind).toBe("unsupported");
  });

  it("no-op move (same column) → unsupported to avoid a needless write", () => {
    const cfg: BoardConfig = { dimension: "folder" };
    const plan = planMove(node({ id: "gtm/foo" }), "gtm", cfg);
    expect(plan.kind).toBe("unsupported");
  });
});
