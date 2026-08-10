import { describe, it, expect } from "vitest";
import {
  folderOf,
  tagValueInNamespace,
  cardColumnKey,
  buildColumns,
  groupByColumn,
  planMove,
  resolveConfig,
  STATUS_ORDER,
  UNCATEGORIZED,
  type BoardNode,
  type BoardConfig,
  type BoardSettings,
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
  it("strips the 'nodes/' storage prefix real ids carry", () => {
    // Server-generated ids always start with "nodes/". Without stripping it,
    // a root doc lands in a bogus "nodes" column and "(root)" is unreachable.
    expect(folderOf("nodes/foo")).toBe("");
    expect(folderOf("nodes/gtm/deals/bar")).toBe("gtm/deals");
  });
  it("leaves an explicit id that lacks the prefix alone", () => {
    // Imported vaults can supply their own id at creation.
    expect(folderOf("b006e456-15de/nodes/architecture/a")).toBe(
      "b006e456-15de/nodes/architecture",
    );
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
  it("labels a folder column with its own name, full path in the title", () => {
    const cfg: BoardConfig = { dimension: "folder" };
    const cols = buildColumns(
      [
        node({ id: "b006e456-15de/nodes/architecture/a" }),
        node({ id: "b006e456-15de/nodes/gtm/deals/b" }),
      ],
      cfg,
    );
    expect(cols.map((c) => c.label)).toEqual(["architecture", "deals"]);
    expect(cols.map((c) => c.title)).toEqual([
      "b006e456-15de/nodes/architecture",
      "b006e456-15de/nodes/gtm/deals",
    ]);
  });
  it("grows colliding folder labels until they are distinct", () => {
    const cfg: BoardConfig = { dimension: "folder" };
    const cols = buildColumns(
      [
        node({ id: "v1/nodes/content/social/a" }),
        node({ id: "v1/nodes/content/published/social/b" }),
        node({ id: "v1/nodes/content/blog/c" }),
      ],
      cfg,
    );
    // Only the two "social" columns deepen; "blog" was already unique.
    expect(cols.map((c) => c.label).sort()).toEqual([
      "blog",
      "content/social",
      "published/social",
    ]);
  });
  it("labels a doc at the vault root '(root)'", () => {
    const cfg: BoardConfig = { dimension: "folder" };
    const cols = buildColumns(
      [node({ id: "loose-doc" }), node({ id: "gtm/deals/b" })],
      cfg,
    );
    expect(cols.map((c) => c.label)).toEqual(["(root)", "deals"]);
  });
  it("shows the folder's own name even when it is the only column", () => {
    const cfg: BoardConfig = { dimension: "folder" };
    const cols = buildColumns([node({ id: "gtm/deals/a" })], cfg);
    expect(cols.map((c) => c.label)).toEqual(["deals"]);
    expect(cols.map((c) => c.title)).toEqual(["gtm/deals"]);
  });
});

describe("status columns", () => {
  it("orders the real lifecycle states and labels them readably", () => {
    const cfg: BoardConfig = { dimension: "status", columnOrder: STATUS_ORDER };
    const cols = buildColumns(
      [
        node({ id: "a", status: "published" }),
        node({ id: "b", status: "pending_review" }),
      ],
      cfg,
    );
    expect(cols.map((c) => c.key)).toEqual([
      "draft",
      "pending_review",
      "approved",
      "published",
      "rejected",
    ]);
    expect(cols.map((c) => c.label)).toEqual([
      "Draft",
      "Pending Review",
      "Approved",
      "Published",
      "Rejected",
    ]);
  });
  it("carries no status the server cannot produce", () => {
    // These three were columns that could never fill; pending_review and
    // rejected were real states missing from the order.
    for (const invented of ["in_review", "superseded", "deprecated"]) {
      expect(STATUS_ORDER).not.toContain(invented);
    }
    expect(STATUS_ORDER).toContain("pending_review");
    expect(STATUS_ORDER).toContain("rejected");
  });
});

describe("tag dimension grouping", () => {
  it("groups by every tag when no namespace is given", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "" };
    const { columns, byColumn } = groupByColumn(
      [
        node({ id: "a", tags: ["blog", "marketing"] }),
        node({ id: "b", tags: ["blog"] }),
        node({ id: "c", tags: [] }),
      ],
      cfg,
    );
    expect(columns.map((c) => c.key)).toEqual([
      "blog",
      "marketing",
      UNCATEGORIZED,
    ]);
    // A multi-tagged doc appears under each of its tags.
    expect(byColumn["blog"].map((n) => n.id)).toEqual(["a", "b"]);
    expect(byColumn["marketing"].map((n) => n.id)).toEqual(["a"]);
    expect(byColumn[UNCATEGORIZED].map((n) => n.id)).toEqual(["c"]);
  });
  it("treats a typed 'ns:value' as just the namespace", () => {
    // The field wants a namespace; typing a whole tag is the obvious slip and
    // used to match nothing at all (it searched for "status:draft:").
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "status:draft" };
    const { byColumn } = groupByColumn(
      [node({ id: "a", tags: ["status:draft"] })],
      cfg,
    );
    expect(byColumn["draft"].map((n) => n.id)).toEqual(["a"]);
  });
  it("keeps flat tags out of a namespaced grouping", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "stage" };
    const { byColumn } = groupByColumn(
      [node({ id: "a", tags: ["blog", "sales"] })],
      cfg,
    );
    expect(byColumn[UNCATEGORIZED].map((n) => n.id)).toEqual(["a"]);
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

  it("tag → unsupported (columns are read-only; PATCH unions tags)", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "stage" };
    const plan = planMove(
      node({ id: "a", tags: ["keep", "stage:draft"] }),
      "review",
      cfg,
    );
    expect(plan.kind).toBe("unsupported");
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

describe("hidden columns (curated tag columns)", () => {
  const cfg = (over: Partial<BoardConfig> = {}): BoardConfig => ({
    dimension: "tag",
    tagNamespace: "",
    ...over,
  });
  const nodes = [
    node({ id: "a", tags: ["draft"] }),
    node({ id: "b", tags: ["review"] }),
    node({ id: "c", tags: ["draft", "review"] }),
  ];

  it("omits a hidden column from the board", () => {
    const cols = buildColumns(nodes, cfg({ hiddenColumns: ["review"] }));
    expect(cols.map((c) => c.key)).toContain("draft");
    expect(cols.map((c) => c.key)).not.toContain("review");
  });

  it("routes a card whose only column is hidden to Uncategorized, but keeps a card that still has a shown column", () => {
    const { byColumn } = groupByColumn(nodes, cfg({ hiddenColumns: ["review"] }));
    expect(byColumn[UNCATEGORIZED].map((n) => n.id)).toEqual(["b"]);
    expect(byColumn["draft"].map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("shows an added, empty column via columnOrder (add a tag with no cards yet)", () => {
    const cols = buildColumns(
      nodes,
      cfg({ columnOrder: ["draft", "shipped", "review"] }),
    );
    expect(cols.map((c) => c.key)).toEqual(["draft", "shipped", "review"]);
  });

  it("drops a hidden key from columnOrder; its orphaned cards go to Uncategorized", () => {
    const cols = buildColumns(
      nodes,
      cfg({ columnOrder: ["draft", "review"], hiddenColumns: ["review"] }),
    );
    // review column gone; doc `b` (only tagged review) surfaces in Uncategorized.
    expect(cols.map((c) => c.key)).toEqual(["draft", UNCATEGORIZED]);
  });
});

describe("resolveConfig", () => {
  const settings = (over: Partial<BoardSettings> = {}): BoardSettings => ({
    dimension: "folder",
    tagNamespace: "",
    layouts: {
      status: { columnOrder: ["approved", "draft"] },
      folder: { columnOrder: ["gtm"] },
      "tag:stage": { columnOrder: ["ship"], hiddenColumns: ["old"] },
    },
    ...over,
  });

  it("uses only the active dimension's layout", () => {
    // The bug: a status reorder leaked onto the folder board, which then
    // rendered phantom "Draft"/"Approved" columns.
    expect(resolveConfig(settings()).columnOrder).toEqual(["gtm"]);
    expect(resolveConfig(settings({ dimension: "status" })).columnOrder).toEqual(
      ["approved", "draft"],
    );
  });

  it("keys tag layouts by namespace", () => {
    const s = settings({ dimension: "tag", tagNamespace: "stage" });
    expect(resolveConfig(s).columnOrder).toEqual(["ship"]);
    expect(resolveConfig(s).hiddenColumns).toEqual(["old"]);
    // A different namespace is a different column vocabulary — no layout yet.
    const other = settings({ dimension: "tag", tagNamespace: "team" });
    expect(resolveConfig(other).columnOrder).toBeUndefined();
    expect(resolveConfig(other).hiddenColumns).toBeUndefined();
  });

  it("falls back to the lifecycle order for an un-reordered status board", () => {
    expect(
      resolveConfig({ dimension: "status", layouts: {} }).columnOrder,
    ).toEqual(STATUS_ORDER);
  });
});
