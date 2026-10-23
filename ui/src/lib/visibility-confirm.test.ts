import { describe, it, expect } from "vitest";
import {
  visibilityNeedsAcknowledgement,
  visibilityTierHint,
  visibilityConfirmCopy,
  visibilityBlockedReason,
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
