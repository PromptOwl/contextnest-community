import { describe, it, expect } from "vitest";
import { splitWorkItems } from "./my-work-groups";
import type { WorkItem } from "./api";

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
