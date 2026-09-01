/**
 * Dashboard grid scoping: which access scopes an unsynced folder can survive.
 */
import { describe, it, expect } from "vitest";
import { scopeShowsNests, visibleUnsynced, type NestScope } from "./dashboard-scope";

const folders = [
  { name: "test/architecture", label: "architecture", mdCount: 5, sizeBytes: 10 },
  { name: "test/billing", label: "billing", mdCount: 2, sizeBytes: 20 },
];

describe("visibleUnsynced", () => {
  it("shows every folder in the unscoped and unsynced-only views", () => {
    expect(visibleUnsynced(folders, "all", "")).toHaveLength(2);
    expect(visibleUnsynced(folders, "unsynced", "")).toHaveLength(2);
  });

  it("hides folders under every access scope — they have no owner or visibility", () => {
    for (const scope of ["owned", "shared", "public", "synced"] as NestScope[]) {
      expect(visibleUnsynced(folders, scope, "")).toEqual([]);
    }
  });

  it("matches the query against both the label and the path", () => {
    expect(visibleUnsynced(folders, "all", "BILL").map((f) => f.label)).toEqual([
      "billing",
    ]);
    expect(visibleUnsynced(folders, "all", "test/arch")).toHaveLength(1);
    expect(visibleUnsynced(folders, "all", "zzznomatch")).toEqual([]);
  });
});

describe("scopeShowsNests", () => {
  it("hides registered nests only in the unsynced-only view", () => {
    expect(scopeShowsNests("unsynced")).toBe(false);
    for (const scope of ["all", "owned", "shared", "public", "synced"] as NestScope[]) {
      expect(scopeShowsNests(scope)).toBe(true);
    }
  });
});
