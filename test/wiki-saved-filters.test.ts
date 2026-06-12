import { describe, it, expect } from "vitest";
import {
  datePresetToEpoch,
  upsertFilter,
  removeFilter,
  parseSavedFilters,
  serializeSavedFilters,
  type SavedFilter,
} from "../ui/src/lib/saved-filters";

describe("datePresetToEpoch", () => {
  const now = 1_000_000_000_000;
  it("returns undefined for any / undefined", () => {
    expect(datePresetToEpoch("any", now)).toBeUndefined();
    expect(datePresetToEpoch(undefined, now)).toBeUndefined();
  });
  it("subtracts the preset window from now", () => {
    expect(datePresetToEpoch("7d", now)).toBe(now - 7 * 86_400_000);
    expect(datePresetToEpoch("1y", now)).toBe(now - 365 * 86_400_000);
  });
});

describe("upsert/remove", () => {
  const a: SavedFilter = { name: "Drafts", status: "draft" };
  it("replaces by case-insensitive name and keeps order stable", () => {
    const list = upsertFilter([a], { name: "drafts", status: "approved" });
    expect(list).toEqual([{ name: "drafts", status: "approved" }]);
  });
  it("appends a new name", () => {
    const list = upsertFilter([a], { name: "Mine", author: "me@x.com" });
    expect(list.map((f) => f.name)).toEqual(["Drafts", "Mine"]);
  });
  it("removes by case-insensitive name", () => {
    expect(removeFilter([a], "DRAFTS")).toEqual([]);
  });
});

describe("parse/serialize", () => {
  it("round-trips a filter list", () => {
    const list: SavedFilter[] = [
      { name: "X", search: "q", tags: ["#a"], author: "me", datePreset: "30d" },
    ];
    expect(parseSavedFilters(serializeSavedFilters(list))).toEqual(list);
  });
  it("drops malformed entries and bad JSON", () => {
    expect(parseSavedFilters(null)).toEqual([]);
    expect(parseSavedFilters("not json")).toEqual([]);
    expect(parseSavedFilters('{"not":"array"}')).toEqual([]);
    expect(parseSavedFilters('[{"name":""},{"name":"ok"}]')).toEqual([
      { name: "ok" },
    ]);
  });
});
