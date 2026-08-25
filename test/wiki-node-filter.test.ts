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

  it("filters by author (case-insensitive, 'all' passes)", () => {
    const n = { ...node, author: "Me@X.com" };
    expect(matchesFilters(n, { author: "all" })).toBe(true);
    expect(matchesFilters(n, { author: "me@x.com" })).toBe(true);
    expect(matchesFilters(n, { author: "other@x.com" })).toBe(false);
    expect(matchesFilters(node, { author: "me@x.com" })).toBe(false);
  });

  it("filters by type ('all' passes, missing type = document)", () => {
    const agent = { ...node, type: "agent" };
    expect(matchesFilters(agent, { type: "all" })).toBe(true);
    expect(matchesFilters(agent, { type: "agent" })).toBe(true);
    expect(matchesFilters(agent, { type: "document" })).toBe(false);
    // A node with no explicit type is treated as a document.
    expect(matchesFilters(node, { type: "document" })).toBe(true);
    expect(matchesFilters(node, { type: "agent" })).toBe(false);
  });

  it("filters by updatedAfter threshold", () => {
    const n = { ...node, updated_at: "2026-06-01T00:00:00Z" };
    const may = Date.parse("2026-05-01T00:00:00Z");
    const july = Date.parse("2026-07-01T00:00:00Z");
    expect(matchesFilters(n, { updatedAfter: may })).toBe(true);
    expect(matchesFilters(n, { updatedAfter: july })).toBe(false);
    // Missing/invalid date fails a date filter but passes when none is set.
    expect(matchesFilters(node, { updatedAfter: may })).toBe(false);
    expect(matchesFilters(node, {})).toBe(true);
  });
});
