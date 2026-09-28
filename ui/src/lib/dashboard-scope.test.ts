/**
 * Dashboard grid scoping: which access scopes an unsynced folder can survive.
 */
import { describe, it, expect } from "vitest";
import {
  scopeShowsNests,
  visibleUnsynced,
  nestInScope,
  DEFAULT_NEST_SCOPE,
  restoredNestScope,
  type NestScope,
} from "./dashboard-scope";

const folders = [
  { name: "test/architecture", label: "architecture", mdCount: 5, sizeBytes: 10 },
  { name: "test/billing", label: "billing", mdCount: 2, sizeBytes: 20 },
];

describe("visibleUnsynced", () => {
  it("shows every folder in the unscoped, mine and unsynced-only views", () => {
    expect(visibleUnsynced(folders, "all", "")).toHaveLength(2);
    expect(visibleUnsynced(folders, "mine", "")).toHaveLength(2);
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

describe("nestInScope — which registered nests a scope keeps", () => {
  const rows = {
    mine: { is_owner: true, permission: "owner", visibility: "private" },
    sharedWithMe: { is_owner: false, permission: "write", visibility: "private" },
    // Discovered: reachable through visibility alone, no membership.
    orgDiscovered: { is_owner: false, permission: "read", visibility: "org", discovered: true },
    publicDiscovered: { is_owner: false, permission: "read", visibility: "public", discovered: true },
    // A nest I'm IN that also happens to be public — still mine.
    myPublic: { is_owner: true, permission: "owner", visibility: "public" },
  };
  const keeps = (scope: NestScope) =>
    Object.entries(rows).filter(([, n]) => nestInScope(n, scope)).map(([k]) => k);

  it("'mine' = owned + shared with me; discovered org/public nests stay out", () => {
    expect(keeps("mine")).toEqual(["mine", "sharedWithMe", "myPublic"]);
  });

  it("'mine' is the default scope", () => {
    expect(DEFAULT_NEST_SCOPE).toBe("mine");
  });

  it("'shared' = granted to me only; a discovered nest was never shared with me", () => {
    expect(keeps("shared")).toEqual(["sharedWithMe"]);
  });

  it("regression: the existing scopes are unchanged", () => {
    expect(keeps("all")).toEqual(Object.keys(rows));
    expect(keeps("owned")).toEqual(["mine", "myPublic"]);
    expect(keeps("org")).toEqual(["orgDiscovered"]);
    expect(keeps("public")).toEqual(["publicDiscovered", "myPublic"]);
  });

  it("unsynced folders stay visible under 'mine' — they are the operator's own disk, not a discovered nest", () => {
    // Regression guard: 'mine' is the new DEFAULT, so hiding them here would
    // hide every pending folder from every fresh dashboard, self-hosted
    // included (review finding on PR #315).
    expect(visibleUnsynced(folders, "mine", "")).toHaveLength(2);
    expect(visibleUnsynced(folders, "mine", "bill").map((f) => f.label)).toEqual(["billing"]);
    expect(scopeShowsNests("mine")).toBe(true);
  });
});

describe("restoredNestScope", () => {
  it("keeps a remembered narrow scope", () => {
    for (const s of ["mine", "owned", "shared", "synced", "unsynced"]) {
      expect(restoredNestScope(s)).toBe(s);
    }
  });

  it("opens broad scopes back on My nests", () => {
    for (const s of ["all", "org", "public"]) {
      expect(restoredNestScope(s)).toBe(DEFAULT_NEST_SCOPE);
    }
  });

  it("falls back to the default when nothing or junk is stored", () => {
    expect(restoredNestScope(null)).toBe(DEFAULT_NEST_SCOPE);
    expect(restoredNestScope("bogus")).toBe(DEFAULT_NEST_SCOPE);
  });
});
