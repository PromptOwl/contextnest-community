/**
 * Pure permission decision-tree tests.
 *
 * Every branch of `canEditPure`, `canApprovePure`, `canAccessPure` plus
 * the `mergeEffectiveRoles` and `sortResolvedStewards` helpers — all
 * exercised without touching SQLite, so the same suite proves the
 * Mongo adapter (TheOwl) and SQLite adapter (community) behave
 * identically when handed the same inputs.
 */

import { describe, it, expect } from "vitest";
import {
  canEditPure,
  canApprovePure,
  canAccessPure,
  mergeEffectiveRoles,
  sortResolvedStewards,
  type PermissionContext,
} from "./permissions.js";

function ctx(overrides: Partial<PermissionContext>): PermissionContext {
  return {
    roles: [],
    isSuperAdmin: false,
    isOwner: false,
    allowSelfApprove: false,
    isOwnSubmission: false,
    ...overrides,
  };
}

// ─── canEditPure ────────────────────────────────────────────────────────

describe("canEditPure", () => {
  it("owner role grants edit", () => {
    const r = canEditPure(ctx({ roles: ["owner"] }));
    expect(r).toEqual({ allowed: true, reason: "nest owner", role: "owner" });
  });

  it("super admin grants edit", () => {
    const r = canEditPure(ctx({ isSuperAdmin: true }));
    expect(r.allowed).toBe(true);
    expect(r.role).toBe("super_admin");
  });

  it("admin role grants edit", () => {
    const r = canEditPure(ctx({ roles: ["admin"] }));
    expect(r.allowed).toBe(true);
    expect(r.role).toBe("admin");
  });

  it("editor role grants edit", () => {
    const r = canEditPure(ctx({ roles: ["editor"] }));
    expect(r.allowed).toBe(true);
    expect(r.role).toBe("editor");
  });

  it("reviewer role alone does NOT grant edit", () => {
    const r = canEditPure(ctx({ roles: ["reviewer"] }));
    expect(r.allowed).toBe(false);
  });

  it("viewer role does NOT grant edit", () => {
    const r = canEditPure(ctx({ roles: ["viewer"] }));
    expect(r.allowed).toBe(false);
  });

  it("no roles → denied", () => {
    const r = canEditPure(ctx({}));
    expect(r.allowed).toBe(false);
    expect(r.role).toBeNull();
  });
});

// ─── canApprovePure ─────────────────────────────────────────────────────

describe("canApprovePure", () => {
  it("reviewer can approve teammate's work", () => {
    const r = canApprovePure(
      ctx({ roles: ["reviewer"], isOwnSubmission: false }),
    );
    expect(r.allowed).toBe(true);
    expect(r.role).toBe("reviewer");
  });

  it("admin steward can approve teammate's work", () => {
    const r = canApprovePure(ctx({ roles: ["admin"], isOwnSubmission: false }));
    expect(r.allowed).toBe(true);
    expect(r.role).toBe("admin");
  });

  it("reviewer CANNOT approve own submission (separation of duties)", () => {
    const r = canApprovePure(
      ctx({ roles: ["reviewer"], isOwnSubmission: true }),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/separation of duties/);
    expect(r.role).toBe("reviewer");
  });

  it("owner + reviewer + own submission + self-approve ON → allowed", () => {
    const r = canApprovePure(
      ctx({
        roles: ["owner", "reviewer"],
        isOwner: true,
        isOwnSubmission: true,
        allowSelfApprove: true,
      }),
    );
    expect(r.allowed).toBe(true);
  });

  it("owner without steward role + self-approve OFF → denied", () => {
    const r = canApprovePure(
      ctx({ roles: ["owner"], isOwner: true, allowSelfApprove: false }),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/self-approve/);
    expect(r.role).toBe("owner");
  });

  it("owner without steward role + self-approve ON → allowed", () => {
    const r = canApprovePure(
      ctx({ roles: ["owner"], isOwner: true, allowSelfApprove: true }),
    );
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/self-approve enabled/);
  });

  it("super admin alone + self-approve OFF → denied (route to reviewers)", () => {
    const r = canApprovePure(
      ctx({ isSuperAdmin: true, allowSelfApprove: false }),
    );
    expect(r.allowed).toBe(false);
    expect(r.role).toBe("super_admin");
  });

  it("super admin + self-approve ON → allowed", () => {
    const r = canApprovePure(
      ctx({ isSuperAdmin: true, allowSelfApprove: true }),
    );
    expect(r.allowed).toBe(true);
    expect(r.role).toBe("super_admin");
  });

  it("editor cannot approve, reason mentions the held role", () => {
    const r = canApprovePure(ctx({ roles: ["editor"] }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/"editor"/);
    expect(r.role).toBe("editor");
  });

  it("no role at all → denied with stewarding hint", () => {
    const r = canApprovePure(ctx({}));
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not a steward/);
    expect(r.role).toBeNull();
  });
});

// ─── canAccessPure ──────────────────────────────────────────────────────

describe("canAccessPure", () => {
  it("owner role grants access", () => {
    const r = canAccessPure(ctx({ roles: ["owner"] }));
    expect(r.allowed).toBe(true);
    expect(r.role).toBe("owner");
  });

  it("super admin grants access", () => {
    const r = canAccessPure(ctx({ isSuperAdmin: true }));
    expect(r.allowed).toBe(true);
    expect(r.role).toBe("super_admin");
  });

  it("any non-empty role set grants view", () => {
    expect(canAccessPure(ctx({ roles: ["viewer"] })).allowed).toBe(true);
    expect(canAccessPure(ctx({ roles: ["editor"] })).allowed).toBe(true);
    expect(canAccessPure(ctx({ roles: ["reviewer"] })).allowed).toBe(true);
  });

  it("no roles → denied", () => {
    const r = canAccessPure(ctx({}));
    expect(r.allowed).toBe(false);
    expect(r.role).toBeNull();
  });
});

// ─── mergeEffectiveRoles ────────────────────────────────────────────────

describe("mergeEffectiveRoles", () => {
  it("super admin maps to admin role", () => {
    const roles = mergeEffectiveRoles({
      collabRole: null,
      stewardRoles: [],
      isSuperAdmin: true,
      isOwner: false,
    });
    expect(roles).toEqual(["admin"]);
  });

  it("owner is included when isOwner", () => {
    const roles = mergeEffectiveRoles({
      collabRole: null,
      stewardRoles: [],
      isSuperAdmin: false,
      isOwner: true,
    });
    expect(roles).toContain("owner");
  });

  it("collaborator role added", () => {
    const roles = mergeEffectiveRoles({
      collabRole: "editor",
      stewardRoles: [],
      isSuperAdmin: false,
      isOwner: false,
    });
    expect(roles).toEqual(["editor"]);
  });

  it("steward roles added, deduped against collaborator", () => {
    const roles = mergeEffectiveRoles({
      collabRole: "editor",
      stewardRoles: ["editor", "reviewer"],
      isSuperAdmin: false,
      isOwner: false,
    });
    expect(roles.sort()).toEqual(["editor", "reviewer"].sort());
  });

  it("all sources merge", () => {
    const roles = mergeEffectiveRoles({
      collabRole: "editor",
      stewardRoles: ["reviewer"],
      isSuperAdmin: true,
      isOwner: true,
    });
    expect(roles.sort()).toEqual(["admin", "editor", "owner", "reviewer"].sort());
  });
});

// ─── sortResolvedStewards ───────────────────────────────────────────────

describe("sortResolvedStewards", () => {
  it("orders by priority asc then email asc", () => {
    const input = [
      { priority: 3, steward: { userEmail: "zeta@x.com" } },
      { priority: 1, steward: { userEmail: "beta@x.com" } },
      { priority: 1, steward: { userEmail: "alpha@x.com" } },
      { priority: 2, steward: { userEmail: "gamma@x.com" } },
    ];
    const sorted = sortResolvedStewards(input);
    expect(sorted.map((r) => r.steward.userEmail)).toEqual([
      "alpha@x.com",
      "beta@x.com",
      "gamma@x.com",
      "zeta@x.com",
    ]);
  });

  it("returns a new array (does not mutate input)", () => {
    const input = [
      { priority: 2, steward: { userEmail: "a@x.com" } },
      { priority: 1, steward: { userEmail: "b@x.com" } },
    ];
    const before = input.slice();
    sortResolvedStewards(input);
    expect(input).toEqual(before);
  });
});
