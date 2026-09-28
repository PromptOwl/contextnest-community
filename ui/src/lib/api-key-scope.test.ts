import { describe, it, expect } from "vitest";
import {
  keyScope,
  nestOnlyKeyLabel,
  createKeyRequest,
  ALL_NESTS,
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
