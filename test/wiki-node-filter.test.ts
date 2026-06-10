import { describe, it, expect } from "vitest";
import { matchesFilters } from "../ui/src/lib/node-filter";

const node = {
  title: "API Design Guide",
  status: "approved",
  tags: ["#api", "#design"],
};

describe("matchesFilters", () => {
  it("passes with no filters / status all", () => {
    expect(matchesFilters(node, {})).toBe(true);
    expect(matchesFilters(node, { status: "all" })).toBe(true);
  });

  it("filters by status", () => {
    expect(matchesFilters(node, { status: "draft" })).toBe(false);
    expect(matchesFilters(node, { status: "approved" })).toBe(true);
  });

  it("search hits title or tag substring", () => {
    expect(matchesFilters(node, { search: "design" })).toBe(true);
    expect(matchesFilters(node, { search: "api" })).toBe(true);
    expect(matchesFilters(node, { search: "zebra" })).toBe(false);
  });

  it("multi-tag is AND, case-insensitive, '#' optional", () => {
    expect(matchesFilters(node, { tags: ["api"] })).toBe(true);
    expect(matchesFilters(node, { tags: ["API", "#design"] })).toBe(true);
    expect(matchesFilters(node, { tags: ["api", "missing"] })).toBe(false);
  });

  it("combines search + status + tags", () => {
    expect(
      matchesFilters(node, { search: "guide", status: "approved", tags: ["api"] }),
    ).toBe(true);
    expect(
      matchesFilters(node, { search: "guide", status: "draft", tags: ["api"] }),
    ).toBe(false);
  });

  it("handles nodes without tags", () => {
    expect(matchesFilters({ title: "X" }, { tags: ["api"] })).toBe(false);
    expect(matchesFilters({ title: "X" }, {})).toBe(true);
  });
});
