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
  nestRelation,
  type NestScope,
} from "./dashboard-scope";

const folders = [
  { name: "test/architecture", label: "architecture", mdCount: 5, sizeBytes: 10 },
  { name: "test/billing", label: "billing", mdCount: 2, sizeBytes: 20 },
];

describe("visibleUnsynced", () => {
  it("shows folders only in the unsynced-only view", () => {
    expect(visibleUnsynced(folders, "unsynced", "")).toHaveLength(2);
  });

  it("hides folders in the nest list — every other scope, the default included", () => {
    for (const scope of ["all", "mine", "owned", "shared", "public", "synced"] as NestScope[]) {
      expect(visibleUnsynced(folders, scope, "")).toEqual([]);
    }
  });

  it("matches the query against both the label and the path", () => {
    expect(visibleUnsynced(folders, "unsynced", "BILL").map((f) => f.label)).toEqual([
      "billing",
    ]);
    expect(visibleUnsynced(folders, "unsynced", "test/arch")).toHaveLength(1);
    expect(visibleUnsynced(folders, "unsynced", "zzznomatch")).toEqual([]);
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

  it("'all' is the default scope — every card says whose it is instead (CU-wdqcq05m8z)", () => {
    expect(DEFAULT_NEST_SCOPE).toBe("all");
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

  it("unsynced folders stay out of the default 'mine' list — only the unsynced filter shows them", () => {
    // Reverses the PR #315 guard on purpose: folders aren't nests, so the nest
    // list neither shows nor counts them; "Unsynced folders only" does.
    expect(visibleUnsynced(folders, "mine", "")).toEqual([]);
    expect(visibleUnsynced(folders, "mine", "bill")).toEqual([]);
    expect(scopeShowsNests("mine")).toBe(true);
  });
});

describe("restoredNestScope", () => {
  it("remembers every scope, broad ones included (CU-wdqcq05m8z)", () => {
    for (const s of ["all", "mine", "owned", "shared", "org", "public", "synced", "unsynced"]) {
      expect(restoredNestScope(s)).toBe(s);
    }
  });

  it("falls back to All when nothing or junk is stored", () => {
    expect(restoredNestScope(null)).toBe("all");
    expect(restoredNestScope("bogus")).toBe("all");
  });
});

describe("nestRelation — what a card says about whose nest it is", () => {
  it("owned, shared with me, or only reachable through its visibility", () => {
    expect(nestRelation({ is_owner: true, permission: "owner", visibility: "public" })).toBe("owned");
    expect(nestRelation({ is_owner: false, permission: "write", visibility: "private" })).toBe("shared");
    expect(nestRelation({ is_owner: false, permission: "read", visibility: "org", discovered: true })).toBe(
      "discovered",
    );
    expect(
      nestRelation({ is_owner: false, permission: "read", visibility: "public", discovered: true }),
    ).toBe("discovered");
  });

  it("legacy rows without is_owner/permission read as owned, matching nestOwned", () => {
    expect(nestRelation({})).toBe("owned");
  });
});
