import { describe, it, expect } from "vitest";
import {
  visibilityNeedsAcknowledgement,
  visibilityTierHint,
  visibilityConfirmCopy,
  visibilityBlockedReason,
  visibilityMenuOptions,
  settleVisibilityChange,
  visibilityPickerOptions,
} from "./visibility-confirm";

// Who a tier reaches depends on what the server is. 'org' = every account on
// the deployment: one company when self-hosted, every customer on the
// PromptOwl-hosted server. The copy must say which (CU-wdqcq02mek).

describe("visibilityNeedsAcknowledgement", () => {
  it("public always confirms; private never does", () => {
    for (const shared of [false, true]) {
      expect(visibilityNeedsAcknowledgement("public", { sharedDeployment: shared })).toBe(true);
      expect(visibilityNeedsAcknowledgement("private", { sharedDeployment: shared })).toBe(false);
    }
  });

  it("org confirms only on a shared deployment", () => {
    expect(visibilityNeedsAcknowledgement("org", { sharedDeployment: false })).toBe(false);
    expect(visibilityNeedsAcknowledgement("org", { sharedDeployment: true })).toBe(true);
  });
});

describe("visibilityTierHint — the one-liner under each tier in the picker", () => {
  it("self-hosted: org reads as the organization", () => {
    expect(visibilityTierHint("org", { sharedDeployment: false })).toMatch(/signed in here/i);
    expect(visibilityTierHint("org", { sharedDeployment: false })).not.toMatch(/other organi/i);
  });

  it("shared: org says every account on the server, other organizations included", () => {
    const hint = visibilityTierHint("org", { sharedDeployment: true });
    expect(hint).toMatch(/every account on this server/i);
    expect(hint).toMatch(/other organi[sz]ations/i);
  });

  it("private is the same everywhere", () => {
    expect(visibilityTierHint("private", { sharedDeployment: true })).toBe(
      visibilityTierHint("private", { sharedDeployment: false }),
    );
  });
});

describe("visibilityConfirmCopy — the acknowledgement dialog", () => {
  it("public, self-hosted: anyone on the internet, outside your organization", () => {
    const c = visibilityConfirmCopy("public", { sharedDeployment: false });
    expect(c.title).toMatch(/public/i);
    expect(c.body).toMatch(/anyone on the internet/i);
    expect(c.confirm).toBe("Make public");
  });

  it("public, shared: also names other organizations on this server", () => {
    const c = visibilityConfirmCopy("public", { sharedDeployment: true });
    expect(c.body).toMatch(/anyone on the internet/i);
    expect(c.body).toMatch(/other organi[sz]ations/i);
  });

  it("org, self-hosted: never needs a dialog, so asking for its copy is a caller bug", () => {
    expect(() => visibilityConfirmCopy("org", { sharedDeployment: false })).toThrow(/shared deployment/);
  });

  it("org, shared: every account on this server — not just yours", () => {
    const c = visibilityConfirmCopy("org", { sharedDeployment: true });
    expect(c.title).toMatch(/organization|everyone on this server/i);
    expect(c.body).toMatch(/every account on this server/i);
    expect(c.body).toMatch(/other organi[sz]ations/i);
    expect(c.body).not.toMatch(/anyone on the internet/i);
    expect(c.confirm.length).toBeGreaterThan(0);
  });
});

// Server admins can stop owners widening a nest (NEST_PUBLIC_VISIBILITY /
// NEST_ORG_VISIBILITY = admins). The picker disables a blocked tier and says
// why; the server refuses it regardless.
describe("visibilityBlockedReason", () => {
  const open = { publicBy: "owners", orgBy: "owners", isServerAdmin: false } as const;
  const locked = { publicBy: "admins", orgBy: "admins", isServerAdmin: false } as const;

  it("defaults (owners) block nothing", () => {
    for (const t of ["private", "org", "public"] as const) {
      expect(visibilityBlockedReason(t, "private", open)).toBeNull();
    }
  });

  it("admins-only tiers are blocked for an owner, with a reason naming the server admin", () => {
    expect(visibilityBlockedReason("public", "private", locked)).toMatch(/server admin/i);
    expect(visibilityBlockedReason("org", "private", locked)).toMatch(/server admin/i);
    expect(visibilityBlockedReason("public", "org", { ...open, publicBy: "admins" })).toMatch(/public/i);
    expect(visibilityBlockedReason("org", "private", { ...open, orgBy: "admins" })).toMatch(/organization/i);
  });

  it("narrowing and staying put are never blocked", () => {
    expect(visibilityBlockedReason("private", "public", locked)).toBeNull();
    expect(visibilityBlockedReason("org", "public", locked)).toBeNull();
    expect(visibilityBlockedReason("public", "public", locked)).toBeNull();
  });

  it("a server admin is never blocked", () => {
    const admin = { ...locked, isServerAdmin: true };
    expect(visibilityBlockedReason("public", "private", admin)).toBeNull();
    expect(visibilityBlockedReason("org", "private", admin)).toBeNull();
  });
});

// The nest header's visibility button used to flip private <-> public only,
// with Organization reachable from the ⋯ menu alone. Every visibility control
// now draws its choices from one list (task
// community-nest-header-visibility-button-skips-organization).
describe("visibilityMenuOptions — what every visibility control offers", () => {
  const ctx = { sharedDeployment: false };
  const open = { publicBy: "owners", orgBy: "owners", isServerAdmin: false } as const;

  it("offers Private, Organization and Public from every tier", () => {
    for (const current of ["private", "org", "public"] as const) {
      const opts = visibilityMenuOptions(current, ctx, open);
      expect(opts.map((o) => o.value)).toEqual(["private", "org", "public"]);
      expect(opts.map((o) => o.label)).toEqual(["Private", "Organization", "Public"]);
      expect(opts.filter((o) => o.current).map((o) => o.value)).toEqual([current]);
      expect(opts.every((o) => !o.disabled)).toBe(true);
    }
  });

  it("an org nest can go straight to private or public — no detour", () => {
    const opts = visibilityMenuOptions("org", ctx, open);
    expect(opts.find((o) => o.value === "private")!.disabled).toBe(false);
    expect(opts.find((o) => o.value === "public")!.disabled).toBe(false);
  });

  it("a tier the server caps is disabled with the reason in place of its hint", () => {
    const opts = visibilityMenuOptions("private", ctx, { ...open, publicBy: "admins" });
    const pub = opts.find((o) => o.value === "public")!;
    expect(pub.disabled).toBe(true);
    expect(pub.hint).toMatch(/server admin/i);
    expect(opts.find((o) => o.value === "org")!.disabled).toBe(false);
  });

  it("hints are worded for the deployment", () => {
    const shared = visibilityMenuOptions("private", { sharedDeployment: true }, open);
    expect(shared.find((o) => o.value === "org")!.hint).toMatch(/other organi/i);
  });
});

describe("settleVisibilityChange — what the control shows after a save", () => {
  it("takes the server's answer on success", async () => {
    const r = await settleVisibilityChange("private", "org", async () => ({ visibility: "org" }));
    expect(r).toEqual({ visibility: "org", error: null });
  });

  it("reverts to the PREVIOUS value on failure, never the inverse of the target", async () => {
    const r = await settleVisibilityChange("org", "public", async () => {
      throw new Error("Only a server admin can make nests public on this server.");
    });
    expect(r.visibility).toBe("org");
    expect(r.error).toMatch(/server admin/);
  });

  it("reports a server that answered with a different tier", async () => {
    const r = await settleVisibilityChange("private", "public", async () => ({ visibility: "private" }));
    expect(r.visibility).toBe("private");
    expect(r.error).toMatch(/did not accept/i);
  });
});

// On a shared deployment, 'org' reaches every organization on the server, so
// the picker offers team sharing in its place. On a single-organization
// server, 'org' is the company and stays.
describe("visibilityPickerOptions — tiers plus team sharing", () => {
  const owners = { publicBy: "owners", orgBy: "owners", isServerAdmin: false } as const;
  const values = (opts: { value: string }[]) => opts.map((o) => o.value);

  it("shared deployment: offers 'Share with a team…' and not Organization", () => {
    const opts = visibilityPickerOptions("private", { sharedDeployment: true }, owners, { canShareWithTeam: true });
    expect(values(opts)).toEqual(["private", "team", "public"]);
    expect(opts.find((o) => o.value === "team")?.label).toBe("Share with a team…");
  });

  it("shared deployment: a nest that is already org still shows org, so the value is not misreported", () => {
    const opts = visibilityPickerOptions("org", { sharedDeployment: true }, owners, { canShareWithTeam: true });
    expect(values(opts)).toEqual(["private", "org", "team", "public"]);
  });

  it("shared deployment without a team-share target: no team option, still no Organization", () => {
    const opts = visibilityPickerOptions("private", { sharedDeployment: true }, owners, { canShareWithTeam: false });
    expect(values(opts)).toEqual(["private", "public"]);
  });

  it("single-organization server: Organization stays and no team option is added", () => {
    const opts = visibilityPickerOptions("private", { sharedDeployment: false }, owners, { canShareWithTeam: true });
    expect(values(opts)).toEqual(["private", "org", "public"]);
  });
});
