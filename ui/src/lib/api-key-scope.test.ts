import { describe, it, expect } from "vitest";
import {
  keyScope,
  nestOnlyKeyLabel,
  createKeyRequest,
  ALL_NESTS,
  filterSortKeys,
} from "./api-key-scope";

const nests = [
  { id: "n1", name: "Sales" },
  { id: "n2", name: "Legal" },
];

describe("keyScope", () => {
  it("a user-level key reads 'All your nests'", () => {
    expect(keyScope({ nest_id: null }, nests)).toEqual({
      kind: "all",
      label: "All your nests",
    });
  });

  it("a nest key names its nest", () => {
    expect(keyScope({ nest_id: "n2" }, nests)).toEqual({
      kind: "nest",
      label: "Nest: Legal",
      nestId: "n2",
    });
  });

  it("a nest key whose nest isn't in the list still says it's nest-only", () => {
    const s = keyScope({ nest_id: "gone" }, nests);
    expect(s.kind).toBe("nest");
    expect(s.label).toMatch(/^Nest: /);
    expect(s.label).toMatch(/gone/);
  });

  it("tolerates the nest list not having loaded yet", () => {
    expect(keyScope({ nest_id: "n1" }, undefined).kind).toBe("nest");
  });
});

describe("createKeyRequest", () => {
  it("All nests → no nest_id (a user-level key)", () => {
    expect(createKeyRequest(" Laptop ", ALL_NESTS)).toEqual({ label: "Laptop" });
  });
  it("a picked nest → nest_id", () => {
    expect(createKeyRequest("Agent", "n1")).toEqual({ label: "Agent", nest_id: "n1" });
  });
});

describe("nestOnlyKeyLabel", () => {
  it("defaults to '<nest> only'", () => {
    expect(nestOnlyKeyLabel("Sales", [])).toBe("Sales only");
  });
  it("steps past names already taken, case-insensitively", () => {
    expect(nestOnlyKeyLabel("Sales", ["sales ONLY", "Sales only 2"])).toBe("Sales only 3");
  });
  it("stays within the 60-character label cap", () => {
    const long = "x".repeat(100);
    expect(nestOnlyKeyLabel(long, []).length).toBeLessThanOrEqual(60);
    expect(nestOnlyKeyLabel(long, [nestOnlyKeyLabel(long, [])]).length).toBeLessThanOrEqual(60);
  });
});

describe("filterSortKeys", () => {
  const keys = [
    { id: "a", label: "Laptop CLI", key_prefix: "cnst_aaa", nest_id: null, created_at: "2026-01-01T00:00:00Z", last_used_at: null },
    { id: "b", label: "Zed agent", key_prefix: "cnst_bbb", nest_id: "n1", created_at: "2026-03-01T06:00:00Z", last_used_at: "2026-05-01T00:00:00Z" },
    { id: "c", label: "Claude Desktop", key_prefix: "cnst_ccc", nest_id: null, created_at: "2026-03-01 12:00:00", last_used_at: "2026-04-01T00:00:00Z" }, // SQL-style stamp, same day as b,
  ];
  const ids = (opts: Parameters<typeof filterSortKeys>[2]) => filterSortKeys(keys, nests, opts).map((k) => k.id);

  it("sorts newest first by default, by name, or by last used (never-used last)", () => {
    expect(ids({ query: "", scope: "any", sort: "newest" })).toEqual(["c", "b", "a"]);
    expect(ids({ query: "", scope: "any", sort: "name" })).toEqual(["c", "a", "b"]);
    expect(ids({ query: "", scope: "any", sort: "last_used" })).toEqual(["b", "c", "a"]);
  });

  it("searches name, prefix and nest name; filters by scope", () => {
    expect(ids({ query: "desk", scope: "any", sort: "newest" })).toEqual(["c"]);
    expect(ids({ query: "CNST_AAA", scope: "any", sort: "newest" })).toEqual(["a"]);
    expect(ids({ query: "sales", scope: "any", sort: "newest" })).toEqual(["b"]);
    expect(ids({ query: "", scope: "nest", sort: "newest" })).toEqual(["b"]);
    expect(ids({ query: "", scope: "all", sort: "newest" })).toEqual(["c", "a"]);
  });
});
