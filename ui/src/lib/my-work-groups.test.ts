import { describe, it, expect } from "vitest";
import { splitWorkItems, workItemKey, waitingOnMeCount, nothingWaitingOnMe, urgentOnMeCount, withoutResolved } from "./my-work-groups";
import type { AssignedItem, WorkItem } from "./api";

const item = (node_id: string, type: WorkItem["type"], target_type?: string) =>
  ({ node_id, type, target_type, nest_id: "n", nest_name: "N", title: node_id, requested_by: "a", requested_at: "" }) as WorkItem;

describe("splitWorkItems", () => {
  it("puts archive and deletion requests in their own group, reviews first", () => {
    const { reviews, requests } = splitWorkItems([
      item("r1", "review"),
      item("arch", "deletion", "nest_archive"),
      item("r2", "review"),
      item("del", "deletion", "document"),
    ]);
    expect(reviews.map((w) => w.node_id)).toEqual(["r1", "r2"]);
    expect(requests.map((w) => w.node_id)).toEqual(["arch", "del"]);
  });

  it("returns empty groups for an empty inbox", () => {
    expect(splitWorkItems([])).toEqual({ reviews: [], requests: [] });
  });
});

describe("workItemKey", () => {
  const base = { nest_id: "n", nest_name: "N", node_id: "nodes/a", title: "A", requested_by: "x", requested_at: "t" };
  it("names reviews and flags by document, access requests by request", () => {
    expect(workItemKey({ ...base, type: "review" } as any)).toBe("n:nodes/a");
    expect(workItemKey({ ...base, type: "deletion" } as any)).toBe("n:nodes/a");
    expect(workItemKey({ ...base, type: "access", request_id: "r1" } as any)).toBe("access:r1");
  });
});

const task = (node_id: string) =>
  ({ node_id, nest_id: "n", nest_name: "N", title: node_id, type: "task", due: null, priority: null, assigned_at: null }) as AssignedItem;
const page = (total: number) => ({ total, limit: 50, offset: 0, has_more: false });

describe("waitingOnMeCount (the My Work badge)", () => {
  it("counts tasks assigned to you alongside reviews and requests", () => {
    expect(waitingOnMeCount({ pagination: page(2), assigned: [task("a"), task("b"), task("c")] })).toBe(5);
  });

  it("is the review total alone when nothing is assigned", () => {
    expect(waitingOnMeCount({ pagination: page(4) })).toBe(4);
    expect(waitingOnMeCount({ pagination: page(4), assigned: [] })).toBe(4);
  });

  it("counts unread notifications too", () => {
    expect(waitingOnMeCount({ pagination: page(1), assigned: [task("a")], notifications: [{}, {}] })).toBe(4);
  });

  it("leaves out what waits on others when the server says how much waits on you", () => {
    expect(waitingOnMeCount({ waiting_on_me_total: 0, pagination: page(6), assigned: [task("a")] })).toBe(1);
  });

  it("is zero before the read lands", () => {
    expect(waitingOnMeCount(undefined)).toBe(0);
  });
});

describe("nothingWaitingOnMe (the all-caught-up state)", () => {
  it("is false when the only thing waiting is an assigned task", () => {
    expect(nothingWaitingOnMe({ items: [], assigned: [task("a")] })).toBe(false);
  });

  it("is false when a review waits, true when nothing does", () => {
    expect(nothingWaitingOnMe({ items: [item("r1", "review")], assigned: [] })).toBe(false);
    expect(nothingWaitingOnMe({ items: [] })).toBe(true);
  });
});

describe("urgentOnMeCount (turns the My Work count red)", () => {
  const task = (over: Partial<AssignedItem>): AssignedItem => ({
    nest_id: "n",
    nest_name: "N",
    node_id: "t",
    title: "T",
    type: "task",
    due: null,
    priority: null,
    assigned_at: null,
    ...over,
  });
  const TODAY = "2026-11-09";

  it("is zero with nothing waiting", () => {
    expect(urgentOnMeCount(undefined, TODAY)).toBe(0);
    expect(urgentOnMeCount({ assigned: [] }, TODAY)).toBe(0);
  });

  it("counts urgent reviews the server totals", () => {
    expect(urgentOnMeCount({ urgent_reviews_total: 3 }, TODAY)).toBe(3);
  });

  it("counts an urgent task and an overdue task, not a high-priority or future one", () => {
    const assigned = [
      task({ node_id: "a", priority: "urgent" }),
      task({ node_id: "b", due: "2026-11-08" }),
      task({ node_id: "c", priority: "high", due: "2026-11-20" }),
      task({ node_id: "d", due: "2026-11-09" }),
    ];
    expect(urgentOnMeCount({ assigned }, TODAY)).toBe(2);
  });

  it("adds reviews and tasks together", () => {
    expect(
      urgentOnMeCount({ urgent_reviews_total: 2, assigned: [task({ priority: "urgent" })] }, TODAY),
    ).toBe(3);
  });
});

describe("AC-MW-04 the badge and the empty state with mentions", () => {
  const mention = { type: "mention", kind: "channel", nest_id: "n", thread_id: "t" } as any;
  it("an open mention means you are not caught up", () => {
    expect(nothingWaitingOnMe({ items: [], assigned: [], mentions: [mention] })).toBe(false);
    expect(nothingWaitingOnMe({ items: [], assigned: [], mentions: [] })).toBe(true);
  });
  it("counts mentions once, through waiting_on_me_total (not per row shown)", () => {
    expect(waitingOnMeCount({ waiting_on_me_total: 120, assigned: [], notifications: [] } as any)).toBe(120);
  });
});

describe("withoutResolved (PO-1404)", () => {
  // Quick decisions share one refetch (VERDICT_REFETCH_WINDOW_MS), so a page
  // read right after the second approval can still hold the row the reviewer
  // just decided. It must not come back.
  it("keeps a row decided on this page out of a stale read", () => {
    const resolved = new Set([workItemKey(item("done", "review"))]);
    const out = withoutResolved([item("done", "review"), item("open", "review")], resolved);
    expect(out.map((w) => w.node_id)).toEqual(["open"]);
    expect(resolved.size).toBe(1);
  });

  it("forgets a decided row once the server stops listing it, so a new request for it shows", () => {
    const resolved = new Set([workItemKey(item("done", "review"))]);
    expect(withoutResolved([item("open", "review")], resolved).map((w) => w.node_id)).toEqual(["open"]);
    expect(resolved.size).toBe(0);
    expect(withoutResolved([item("done", "review")], resolved).map((w) => w.node_id)).toEqual(["done"]);
  });
});
