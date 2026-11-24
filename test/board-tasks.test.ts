import { describe, it, expect } from "vitest";
import {
  UNASSIGNED,
  assigneesOnBoard,
  dueState,
  formatDue,
  inDoneFolder,
  isPickedDue,
  matchesAssigneeFilter,
  matchesBlockedFilter,
  isTaskDone,
  matchesTitleFilter,
  moveNeedsReview,
  openBlockers,
  priorityRank,
  subItemsByParent,
  timestampsTooltip,
  type GovernanceContext,
} from "../ui/src/lib/board-tasks";
import { newCardPlacement, resolveConfig, type BoardNode } from "../ui/src/lib/board-dimensions";
import { filterForBoard } from "../src/nests/board-items";
import { saveOutcome } from "../ui/src/lib/save-outcome";

const node = (over: Partial<BoardNode> & { id: string }): BoardNode => ({
  title: over.id,
  type: "document",
  tags: [],
  status: "published",
  ...over,
});

const governed: GovernanceContext = {
  stewardshipEnabled: true,
  primeOnlyReview: false,
  allowSelfApprove: false,
  ownerOrAdmin: false,
  primeTags: ["prime-document"],
};

describe("moveNeedsReview — the governed-move modal", () => {
  it("warns for a document in a governed nest", () => {
    expect(moveNeedsReview(node({ id: "a" }), governed)).toBe(true);
  });
  it("never warns for a task", () => {
    expect(moveNeedsReview(node({ id: "a", type: "task" }), governed)).toBe(false);
  });
  it("warns for a prime task — prime beats the task bypass", () => {
    expect(moveNeedsReview(node({ id: "a", type: "task", prime: true }), governed)).toBe(true);
    expect(
      moveNeedsReview(node({ id: "a", type: "task", tags: ["#prime-document"] }), governed),
    ).toBe(true);
  });
  it("doesn't warn in an ungoverned nest, or for a self-approving owner", () => {
    expect(moveNeedsReview(node({ id: "a" }), { ...governed, stewardshipEnabled: false })).toBe(false);
    expect(
      moveNeedsReview(node({ id: "a" }), { ...governed, allowSelfApprove: true, ownerOrAdmin: true }),
    ).toBe(false);
  });
});

describe("saveOutcome isTask", () => {
  const base = {
    isNew: false,
    isOwnPendingReview: false,
    stewardshipEnabled: true,
    prime: false,
    primeOnlyReview: false,
    creatorIsReviewer: false,
    allowSelfApprove: false,
    ownerOrAdmin: false,
  };
  it("publishes a task, drafts a document, drafts a prime task", () => {
    expect(saveOutcome({ ...base, isTask: true })).toBe("publish");
    expect(saveOutcome(base)).toBe("draft");
    expect(saveOutcome({ ...base, isTask: true, prime: true })).toBe("draft");
  });
});

describe("assignee quick-filter", () => {
  const ns = [
    node({ id: "a", assignee: "Ann@x.com" }),
    node({ id: "b", assignee: "bob@x.com" }),
    node({ id: "c", assignee: "ann@x.com" }),
    node({ id: "d" }),
  ];
  it("empty selection shows everything", () => {
    expect(ns.filter((n) => matchesAssigneeFilter(n, new Set()))).toHaveLength(4);
  });
  it("selections OR together, case-insensitively, with an Unassigned bucket", () => {
    const sel = new Set(["ann@x.com", UNASSIGNED]);
    expect(ns.filter((n) => matchesAssigneeFilter(n, sel)).map((n) => n.id)).toEqual(["a", "c", "d"]);
  });
  it("lists people by card count", () => {
    expect(assigneesOnBoard(ns)).toEqual(["ann@x.com", "bob@x.com"]);
  });
});

describe("due, priority, sub-items, timestamps", () => {
  it("dueState is day-based", () => {
    expect(dueState("2026-10-05", "2026-10-06")).toBe("overdue");
    expect(dueState("2026-10-06", "2026-10-06")).toBe("today");
    expect(dueState("2026-10-08", "2026-10-06")).toBe("soon");
    expect(dueState("2026-10-20", "2026-10-06")).toBe("later");
  });
  it("a half-typed picker year isn't saved", () => {
    // What a date input fires while "2026" is typed into its year.
    expect(["0002-09-02", "0020-09-02", "0202-09-02"].some(isPickedDue)).toBe(false);
    expect(isPickedDue("2026-09-02")).toBe(true);
    expect(isPickedDue("")).toBe(false);
  });
  it("formatDue keeps a two-digit year instead of mapping it to 19xx", () => {
    expect(formatDue("0020-09-02", "2026-10-06")).not.toMatch(/1920/);
    expect(formatDue("2027-01-05", "2026-10-06")).toMatch(/2027/);
  });
  it("priorityRank puts urgent first and none last", () => {
    expect(["low", undefined, "urgent", "high"].sort((a, b) => priorityRank(a) - priorityRank(b)))
      .toEqual(["urgent", "high", "low", undefined]);
  });
  it("groups sub-items under their parent", () => {
    const m = subItemsByParent([
      node({ id: "e" }),
      node({ id: "c1", parent: "e" }),
      node({ id: "c2", parent: "e" }),
    ]);
    expect(m.get("e")?.map((n) => n.id)).toEqual(["c1", "c2"]);
  });
  it("timestamp tooltip lists every stamp present", () => {
    const t = timestampsTooltip(
      {
        created_at: "C",
        assigned_at: "A",
        assignee: "ann@x.com",
        moved_at: "M",
        updated_at: "U",
      },
      (s) => s,
    );
    expect(t.split("\n")).toEqual(["Created C", "Assigned to ann@x.com A", "Moved M", "Updated U"]);
  });
});

describe("newCardPlacement — + Add task lands in its column", () => {
  const cfg = (s: Parameters<typeof resolveConfig>[0]) => resolveConfig(s);
  it("tag board: the column's tag, namespaced when the board is", () => {
    expect(newCardPlacement("doing", cfg({ dimension: "tag", tagNamespace: "", layouts: {} })))
      .toEqual({ tags: ["#doing"] });
    expect(newCardPlacement("review", cfg({ dimension: "tag", tagNamespace: "stage", layouts: {} })))
      .toEqual({ tags: ["#stage:review"] });
  });
  it("folder board: the column's folder; root is no folder", () => {
    expect(newCardPlacement("gtm/deals", cfg({ dimension: "folder", layouts: {} })))
      .toEqual({ folder: "gtm/deals" });
    expect(newCardPlacement("", cfg({ dimension: "folder", layouts: {} }))).toEqual({ folder: "" });
  });
  it("status board: no + (governance decides status)", () => {
    expect(newCardPlacement("draft", cfg({ dimension: "status", layouts: {} }))).toBeNull();
  });
});

describe("blocked badge (task relations)", () => {
  it("counts open blockers, and none once the card itself is done", () => {
    expect(openBlockers({})).toBe(0);
    expect(openBlockers({ open_blockers: 2 })).toBe(2);
    expect(openBlockers({ open_blockers: 2, completed_at: "2026-10-09T00:00:00Z" })).toBe(0);
    expect(openBlockers({ open_blockers: -1 })).toBe(0);
  });

  it("hide blocked keeps unblocked and done cards", () => {
    expect(matchesBlockedFilter({ open_blockers: 1 }, false)).toBe(true);
    expect(matchesBlockedFilter({ open_blockers: 1 }, true)).toBe(false);
    expect(matchesBlockedFilter({}, true)).toBe(true);
    expect(matchesBlockedFilter({ open_blockers: 1, completed_at: "2026-10-09T00:00:00Z" }, true)).toBe(true);
  });

  it("title filter matches part of a title, ignoring case; '#…' is a tag, not a title", () => {
    expect(matchesTitleFilter({ title: "Task Beta", tags: [] }, "beta")).toBe(true);
    expect(matchesTitleFilter({ title: "Task Beta", tags: [] }, " Task B ")).toBe(true);
    expect(matchesTitleFilter({ title: "Task Alpha", tags: [] }, "Beta")).toBe(false);
    expect(matchesTitleFilter({ title: "Task Alpha", tags: [] }, "")).toBe(true);
    expect(matchesTitleFilter({ title: "Task Alpha", tags: [] }, "#prime")).toBe(true);
  });
  it("po-1261: finds a card by its ticket number, any case", () => {
    const card = { title: "Migrate user table", tags: ["#stage:backlog", "#ticket:dpb-5"] };
    for (const q of ["DPB-5", "dpb-5", "dpb"]) expect(matchesTitleFilter(card, q)).toBe(true);
    expect(matchesTitleFilter(card, "DPB-6")).toBe(false);
    expect(matchesTitleFilter(card, "backlog")).toBe(false);
    // The board items agents read filter the same way.
    const rows = [{ id: "nodes/a", type: "task", ...card }] as any;
    const board = { dimension: "tag" } as any;
    expect(filterForBoard(rows, board, { q: "Dpb-5" })).toHaveLength(1);
    expect(filterForBoard(rows, board, { q: "DPB-6" })).toHaveLength(0);
  });
});

// PO-1241: a task in the folder board's "Done" column isn't overdue.
describe("inDoneFolder", () => {
  it("matches the folder's last segment against the nest's done tags", () => {
    expect(inDoneFolder("nodes/projects/done/fix-login", ["done"])).toBe(true);
    expect(inDoneFolder("nodes/Done/x", ["#stage:done"])).toBe(true);
    expect(inDoneFolder("nodes/shipped/x", ["done", "shipped"])).toBe(true);
  });
  it("leaves other folders and root documents alone", () => {
    expect(inDoneFolder("nodes/projects/doing/x", ["done"])).toBe(false);
    expect(inDoneFolder("nodes/done-later/x", ["done"])).toBe(false);
    expect(inDoneFolder("nodes/done", ["done"])).toBe(false);
  });
});

describe("po-1238: isTaskDone, so a finished task is not overdue on its page", () => {
  it("reads done tags and done folders, as the board does", () => {
    expect(isTaskDone("nodes/a", ["stage:done"], ["#Stage:Done"])).toBe(true);
    expect(isTaskDone("nodes/projects/done/a", [], ["done"])).toBe(true);
    expect(isTaskDone("nodes/a", ["#stage:backlog"], ["done"])).toBe(false);
    expect(isTaskDone(undefined, [], ["done"])).toBe(false);
  });
});
