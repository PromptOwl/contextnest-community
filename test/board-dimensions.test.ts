import { describe, it, expect } from "vitest";
import {
  folderOf,
  tagValueInNamespace,
  cardColumnKey,
  buildColumns,
  capitalizeColumnHeader,
  groupByColumn,
  migrateLayout,
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
      cardColumnKey(node({ id: "a", tags: ["#stage:shipped"] }), cfg),
    ).toBe("shipped");
    expect(cardColumnKey(node({ id: "b", tags: ["#other"] }), cfg)).toBe(
      UNCATEGORIZED,
    );
  });
});

describe("capitalizeColumnHeader", () => {
  it("does not capitalize tag column headers — they must match the card's tag chip casing", () => {
    expect(capitalizeColumnHeader("tag")).toBe(false);
  });
  it("keeps capitalizing folder and status headers", () => {
    expect(capitalizeColumnHeader("folder")).toBe(true);
    expect(capitalizeColumnHeader("status")).toBe(true);
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
  it("labels a folder column with its full path, matching the title", () => {
    const cfg: BoardConfig = { dimension: "folder" };
    const cols = buildColumns(
      [
        node({ id: "b006e456-15de/nodes/architecture/a" }),
        node({ id: "b006e456-15de/nodes/gtm/deals/b" }),
      ],
      cfg,
    );
    expect(cols.map((c) => c.label)).toEqual([
      "b006e456-15de/nodes/architecture",
      "b006e456-15de/nodes/gtm/deals",
    ]);
    expect(cols.map((c) => c.title)).toEqual([
      "b006e456-15de/nodes/architecture",
      "b006e456-15de/nodes/gtm/deals",
    ]);
  });
  it("shows a folder column added to columnOrder before any card is in it", () => {
    // What the board's "new folder" action leans on: a nest whose documents
    // all sit in Root needs somewhere to drag them, and the folder itself is
    // written by the first move.
    const cols = buildColumns(
      [node({ id: "nodes/a" }), node({ id: "nodes/b" })],
      { dimension: "folder", columnOrder: ["gtm"] },
    );
    expect(cols.map((c) => c.key)).toEqual(["gtm", ""]);
    expect(cols[0]!.label).toBe("gtm");
  });

  it("keeps nested folders with the same leaf name distinct", () => {
    // The report's own example: "a/notes" and "b/notes" must not both
    // collapse to an ambiguous "notes" column.
    const cfg: BoardConfig = { dimension: "folder" };
    const cols = buildColumns(
      [node({ id: "a/notes/x" }), node({ id: "b/notes/y" })],
      cfg,
    );
    expect(cols.map((c) => c.label).sort()).toEqual(["a/notes", "b/notes"]);
  });
  it("labels a doc at the vault root '(root)'", () => {
    const cfg: BoardConfig = { dimension: "folder" };
    const cols = buildColumns(
      [node({ id: "loose-doc" }), node({ id: "gtm/deals/b" })],
      cfg,
    );
    expect(cols.map((c) => c.label)).toEqual(["(root)", "gtm/deals"]);
  });
  it("shows the folder's full path even when it is the only column", () => {
    // A leaf-only label ("folder") loses the nesting entirely and can't be
    // told apart from another folder with the same name elsewhere in the
    // vault — the label always carries the full path instead.
    const cfg: BoardConfig = { dimension: "folder" };
    const cols = buildColumns([node({ id: "no/such/folder/a" })], cfg);
    expect(cols.map((c) => c.label)).toEqual(["no/such/folder"]);
    expect(cols.map((c) => c.title)).toEqual(["no/such/folder"]);
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
      "external_edit_pending",
    ]);
    expect(cols.map((c) => c.label)).toEqual([
      "Draft",
      "Pending Review",
      "Approved",
      "Published",
      "Rejected",
      "External Edit",
    ]);
  });
  it("spaces out a status heading it has no label for", () => {
    const cfg: BoardConfig = { dimension: "status" };
    const cols = buildColumns([node({ id: "a", status: "awaiting_sync" })], cfg);
    expect(cols.map((c) => c.label)).toEqual(["awaiting sync"]);
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
        node({ id: "a", tags: ["#blog", "#marketing"] }),
        node({ id: "b", tags: ["#blog"] }),
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
      [node({ id: "a", tags: ["#status:draft"] })],
      cfg,
    );
    expect(byColumn["draft"].map((n) => n.id)).toEqual(["a"]);
  });
  it("keeps flat tags out of a namespaced grouping", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "stage" };
    const { byColumn } = groupByColumn(
      [node({ id: "a", tags: ["#blog", "#sales"] })],
      cfg,
    );
    expect(byColumn[UNCATEGORIZED].map((n) => n.id)).toEqual(["a"]);
  });
});

describe("groupByColumn", () => {
  it("buckets every node under exactly one column, incl. UNCATEGORIZED", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "stage" };
    const nodes = [
      node({ id: "a", tags: ["#stage:draft"] }),
      node({ id: "b", tags: ["#stage:draft"] }),
      node({ id: "c", tags: ["#nope"] }),
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

  it("tag → retag: drops the source column's tag, adds the target's", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "stage" };
    const plan = planMove(
      node({ id: "a", tags: ["#keep", "#stage:draft"] }),
      "review",
      cfg,
      "draft",
    );
    expect(plan).toEqual({ kind: "retag", tags: ["#keep", "#stage:review"] });
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
    node({ id: "a", tags: ["#draft"] }),
    node({ id: "b", tags: ["#review"] }),
    node({ id: "c", tags: ["#draft", "#review"] }),
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

describe("explicit tag columns (user-curated board)", () => {
  const nodes = [
    node({ id: "a", tags: ["#todo"] }),
    node({ id: "b", tags: ["#doing"] }),
    node({ id: "c", tags: ["#todo", "#someday"] }),
  ];
  const cfg = (over: Partial<BoardConfig> = {}): BoardConfig => ({
    dimension: "tag",
    tagNamespace: "",
    explicitColumns: true,
    ...over,
  });

  it("starts empty: no columns until the user adds some", () => {
    expect(buildColumns(nodes, cfg({ columnOrder: [] }))).toEqual([]);
  });

  it("shows ONLY the added columns, in order — unlisted tags never appear", () => {
    const cols = buildColumns(nodes, cfg({ columnOrder: ["doing", "todo"] }));
    expect(cols.map((c) => c.key)).toEqual(["doing", "todo"]);
    // "someday" is a real tag on c but was never promoted to a column.
    expect(cols.map((c) => c.key)).not.toContain("someday");
  });

  it("has no Uncategorized catch-all; unmatched cards simply don't appear", () => {
    const { columns, byColumn } = groupByColumn(
      nodes,
      cfg({ columnOrder: ["doing"] }),
    );
    expect(columns.map((c) => c.key)).toEqual(["doing"]);
    expect(byColumn[UNCATEGORIZED]).toBeUndefined();
    expect(byColumn["doing"].map((n) => n.id)).toEqual(["b"]);
  });

  it("still honors hidden columns", () => {
    const cols = buildColumns(
      nodes,
      cfg({ columnOrder: ["todo", "doing"], hiddenColumns: ["doing"] }),
    );
    expect(cols.map((c) => c.key)).toEqual(["todo"]);
  });
});

describe("planMove — tag retag", () => {
  it("flat tags: swaps the source tag for the target tag", () => {
    const cfg: BoardConfig = {
      dimension: "tag",
      tagNamespace: "",
      explicitColumns: true,
    };
    const plan = planMove(
      node({ id: "a", tags: ["#todo", "#keep"] }),
      "doing",
      cfg,
      "todo",
    );
    expect(plan).toEqual({ kind: "retag", tags: ["#keep", "#doing"] });
  });

  it("no source column (dropped from outside): just adds the target tag", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "" };
    const plan = planMove(node({ id: "a", tags: ["#keep"] }), "doing", cfg);
    expect(plan).toEqual({ kind: "retag", tags: ["#keep", "#doing"] });
  });

  it("same source and target column → no-op", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "" };
    expect(
      planMove(node({ id: "a", tags: ["#doing"] }), "doing", cfg, "doing").kind,
    ).toBe("unsupported");
  });

  it("target tag already present and nothing to remove → no-op", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "" };
    expect(
      planMove(node({ id: "a", tags: ["#doing"] }), "doing", cfg).kind,
    ).toBe("unsupported");
  });

  it("a hand-typed column round-trips: the written tag lands back in it", () => {
    // Column keys are the bare value ("doing") but the server stores "#doing".
    // Plan the drop, feed the resulting tags back through the grouping: the card
    // must reappear under the column it was dropped on. Nothing else in this
    // file catches a mismatch between the key we write and the key we read.
    const cfg = resolveConfig({
      dimension: "tag",
      tagNamespace: "",
      layouts: { "tag:": { columnOrder: ["todo", "doing"] } },
    });
    const card = node({ id: "a", tags: ["#todo"] });
    const plan = planMove(card, "doing", cfg, "todo");
    expect(plan).toEqual({ kind: "retag", tags: ["#doing"] });
    const { byColumn } = groupByColumn(
      [{ ...card, tags: (plan as { tags: string[] }).tags }],
      cfg,
    );
    expect(byColumn["doing"].map((n) => n.id)).toEqual(["a"]);
    expect(byColumn["todo"]).toEqual([]);
  });

  it("dropping onto Uncategorized is unsupported", () => {
    const cfg: BoardConfig = { dimension: "tag", tagNamespace: "" };
    expect(
      planMove(node({ id: "a", tags: ["#x"] }), UNCATEGORIZED, cfg, "x").kind,
    ).toBe("unsupported");
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

  it("a fresh tag board (no saved columnOrder) is NOT explicit — every present tag auto-shows, same as folder/status", () => {
    expect(
      resolveConfig({ dimension: "tag", tagNamespace: "", layouts: {} })
        .explicitColumns,
    ).toBe(false);
    expect(
      resolveConfig({ dimension: "folder", layouts: {} }).explicitColumns,
    ).toBeFalsy();
    expect(
      resolveConfig({ dimension: "status", layouts: {} }).explicitColumns,
    ).toBeFalsy();
  });

  it("becomes explicit the moment the tag board has a saved columnOrder (curated)", () => {
    const s = settings({ dimension: "tag", tagNamespace: "stage" });
    expect(resolveConfig(s).explicitColumns).toBe(true);
    // Even an empty saved order (user removed their only column) counts as
    // curated — it must stay explicit, not fall back to auto-populating.
    const emptied = settings({
      dimension: "tag",
      tagNamespace: "stage",
      layouts: { "tag:stage": { columnOrder: [] } },
    });
    expect(resolveConfig(emptied).explicitColumns).toBe(true);
  });
});

describe("tag board auto-populates until curated", () => {
  const nodes = [
    node({ id: "a", tags: ["#compliance"] }),
    node({ id: "b", tags: ["#microsoft", "#spec-review"] }),
    node({ id: "c", tags: [] }),
  ];

  it("a fresh tag board shows every present tag, plus Uncategorized for untagged docs", () => {
    const config = resolveConfig({
      dimension: "tag",
      tagNamespace: "",
      layouts: {},
    });
    const cols = buildColumns(nodes, config).map((c) => c.key);
    expect(new Set(cols)).toEqual(
      new Set(["compliance", "microsoft", "spec-review", UNCATEGORIZED]),
    );
  });

  it("once curated, only the saved columns show — matches the pre-existing explicit-board behavior", () => {
    const config = resolveConfig({
      dimension: "tag",
      tagNamespace: "",
      layouts: { "tag:": { columnOrder: ["compliance"] } },
    });
    expect(buildColumns(nodes, config).map((c) => c.key)).toEqual([
      "compliance",
    ]);
  });

  it("adding a column from an auto-populated board keeps every already-visible tag (mirrors MaturityBoard.addColumn, which seeds columnOrder from the currently-shown keys)", () => {
    const auto = resolveConfig({
      dimension: "tag",
      tagNamespace: "",
      layouts: {},
    });
    const autoKeys = buildColumns(nodes, auto)
      .map((c) => c.key)
      .filter((k) => k !== UNCATEGORIZED);
    const curated = resolveConfig({
      dimension: "tag",
      tagNamespace: "",
      layouts: { "tag:": { columnOrder: [...autoKeys, "new-tag"] } },
    });
    expect(buildColumns(nodes, curated).map((c) => c.key)).toEqual([
      ...autoKeys,
      "new-tag",
    ]);
  });
});

describe("migrateLayout — layouts saved before tag keys dropped the \"#\"", () => {
  it("strips the prefix from a tag layout so its columns match cards again", () => {
    const migrated = migrateLayout("tag:", {
      columnOrder: ["#GDPR", "#HIPAA"],
      hiddenColumns: ["#SOC2"],
    });
    expect(migrated).toEqual({
      columnOrder: ["GDPR", "HIPAA"],
      hiddenColumns: ["SOC2"],
    });
    // The whole point: cards land in those columns instead of a board of zeros.
    const { byColumn } = groupByColumn(
      [node({ id: "a", tags: ["#GDPR"] })],
      resolveConfig({
        dimension: "tag",
        tagNamespace: "",
        layouts: { "tag:": migrated },
      }),
    );
    expect(byColumn["GDPR"].map((n) => n.id)).toEqual(["a"]);
  });

  it("collapses keys that differ only by the prefix", () => {
    expect(
      migrateLayout("tag:", { columnOrder: ["#todo", "todo"] }).columnOrder,
    ).toEqual(["todo"]);
  });

  it("leaves folder and status layouts alone", () => {
    const l = { columnOrder: ["gtm/deals"], hiddenColumns: ["draft"] };
    expect(migrateLayout("folder", l)).toBe(l);
    expect(migrateLayout("status", l)).toBe(l);
  });
});
