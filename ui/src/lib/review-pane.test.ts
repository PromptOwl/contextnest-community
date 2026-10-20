import { describe, it, expect } from "vitest";
import {
  reviewIdFromSearch,
  withReviewParam,
  defaultReviewTab,
  nextReviewNodeId,
  showPriorityBadge,
  displayedChangeOrder,
  requestChangesError,
  readOnlyReason,
} from "./review-pane";

// The Review tab's side-by-side review pane (CU-wdqcq05mhk): a queue row
// opens the document beside the queue, the review is linkable, and a
// decision moves straight on to the next item.

describe("review deep link", () => {
  it("reads the open review from ?review=", () => {
    expect(reviewIdFromSearch("?tab=review&review=nodes/a")).toBe("nodes/a");
    expect(reviewIdFromSearch("?tab=review")).toBeNull();
    expect(reviewIdFromSearch("")).toBeNull();
  });

  it("sets and clears ?review= without touching the other params", () => {
    expect(withReviewParam("?tab=review", "nodes/a")).toBe("?tab=review&review=nodes%2Fa");
    expect(withReviewParam("?tab=review&review=nodes%2Fa", null)).toBe("?tab=review");
    expect(withReviewParam("?review=x", null)).toBe("");
  });

  it("round-trips a node id with slashes and spaces", () => {
    const id = "nodes/ontology/core/service line";
    expect(reviewIdFromSearch(withReviewParam("?tab=review", id))).toBe(id);
  });
});

describe("default tab", () => {
  it("opens on Changes when a different published version exists", () => {
    expect(defaultReviewTab({ approvedVersion: 7, pendingVersion: 8 })).toBe("changes");
  });

  it("opens on Preview for a first version (nothing published to compare)", () => {
    expect(defaultReviewTab({ approvedVersion: null, pendingVersion: 1 })).toBe("preview");
  });

  it("opens on Preview when the published version is the one under review", () => {
    expect(defaultReviewTab({ approvedVersion: 3, pendingVersion: 3 })).toBe("preview");
  });
});

describe("advance after a decision", () => {
  const q = [{ nodeId: "a" }, { nodeId: "b" }, { nodeId: "c" }];

  it("moves to the next item", () => {
    expect(nextReviewNodeId(q, "a")).toBe("b");
  });

  it("falls back to the previous item at the end of the queue", () => {
    expect(nextReviewNodeId(q, "c")).toBe("b");
  });

  it("returns null when the decided item was the last one", () => {
    expect(nextReviewNodeId([{ nodeId: "a" }], "a")).toBeNull();
  });

  it("opens the first item when the decided one is no longer in the queue", () => {
    expect(nextReviewNodeId(q, "zzz")).toBe("a");
    expect(nextReviewNodeId([], "zzz")).toBeNull();
  });
});

describe("advance follows the order on screen", () => {
  // Server order is by priority; the All/feed view shows newest first.
  const q = [
    { id: "1", nodeId: "glossary", requestedAt: "2026-10-20 10:00:00" },
    { id: "2", nodeId: "customer", requestedAt: "2026-10-20 10:02:00" },
    { id: "3", nodeId: "active-user", requestedAt: "2026-10-20 10:03:00" },
  ];

  it("feed view: newest first, so next after the top row is the row below it", () => {
    const shown = displayedChangeOrder(q, true);
    expect(shown.map((r) => r.nodeId)).toEqual(["active-user", "customer", "glossary"]);
    expect(nextReviewNodeId(shown, "active-user")).toBe("customer");
  });

  it("Changes chip: keeps the server's order", () => {
    expect(displayedChangeOrder(q, false).map((r) => r.nodeId)).toEqual([
      "glossary",
      "customer",
      "active-user",
    ]);
  });
});

describe("priority badge", () => {
  it("only high and urgent earn a badge — 40 'Normal' pills are noise", () => {
    expect(showPriorityBadge("low")).toBe(false);
    expect(showPriorityBadge("normal")).toBe(false);
    expect(showPriorityBadge("high")).toBe(true);
    expect(showPriorityBadge("urgent")).toBe(true);
  });
});

describe("request changes", () => {
  it("requires a reason", () => {
    expect(requestChangesError("")).toMatch(/reason/i);
    expect(requestChangesError("   ")).toMatch(/reason/i);
    expect(requestChangesError("Fix the definition")).toBeNull();
  });
});

describe("read-only reason", () => {
  it("explains your own submission (separation of duties)", () => {
    expect(readOnlyReason({ canReview: false, requestedBy: "a@x.com" }, "a@x.com")).toMatch(
      /you submitted/i,
    );
  });

  it("explains scope when someone else's change is outside your review rights", () => {
    expect(readOnlyReason({ canReview: false, requestedBy: "b@x.com" }, "a@x.com")).toMatch(
      /steward scope/i,
    );
  });

  it("is null when you can review", () => {
    expect(readOnlyReason({ canReview: true, requestedBy: "b@x.com" }, "a@x.com")).toBeNull();
    // Older servers omit canReview: the queue only lists what you can act on.
    expect(readOnlyReason({ requestedBy: "b@x.com" }, "a@x.com")).toBeNull();
  });
});
