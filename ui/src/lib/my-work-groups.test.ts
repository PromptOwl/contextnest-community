import { describe, it, expect } from "vitest";
import { splitWorkItems, workItemKey, waitingOnMeCount, nothingWaitingOnMe } from "./my-work-groups";
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
