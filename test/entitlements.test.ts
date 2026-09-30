/**
 * Licence entitlements — named features from PromptOwl's validate answer
 * (`features`), with a fallback to tier defaults when an older PromptOwl
 * sends none. Enterprise features stack by name instead of by tier.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

type Lic = Record<string, unknown> | null;

async function withLicense(lic: Lic) {
  vi.resetModules();
  vi.doMock("../src/auth/license.js", async () => {
    const actual = await vi.importActual<typeof import("../src/auth/license.js")>("../src/auth/license.js");
    return { ...actual, getCurrentLicense: () => lic };
  });
  return await import("../src/auth/entitlements.js");
}

const valid = (over: Record<string, unknown> = {}) => ({
  valid: true,
  tier: "community",
  org: "Acme",
  limits: null,
  suspended: false,
  suspendedReason: null,
  ownerEmail: null,
  ...over,
});

describe("hasEntitlement", () => {
  afterEach(() => {
    vi.doUnmock("../src/auth/license.js");
    vi.resetModules();
  });

  it("a feature PromptOwl lists is on, whatever the tier", async () => {
    const e = await withLicense(valid({ features: ["hootie_branding"] }));
    expect(e.hasEntitlement("hootie_branding")).toBe(true);
    expect(e.licenseFeatures()).toEqual(["hootie_branding"]);
  });

  it("an explicit list wins over the tier: enterprise with the feature revoked is off", async () => {
    const e = await withLicense(valid({ tier: "enterprise", features: [] }));
    expect(e.hasEntitlement("hootie_branding")).toBe(false);
  });

  it("an older PromptOwl that sends no features falls back to tier defaults", async () => {
    expect((await withLicense(valid({ tier: "enterprise" }))).hasEntitlement("hootie_branding")).toBe(true);
    expect((await withLicense(valid({ tier: "enterprise", features: null }))).hasEntitlement("hootie_branding")).toBe(true);
    expect((await withLicense(valid({ tier: "community" }))).hasEntitlement("hootie_branding")).toBe(false);
  });

  it("an invalid, suspended or missing licence unlocks nothing", async () => {
    expect((await withLicense(valid({ valid: false, features: ["hootie_branding"] }))).hasEntitlement("hootie_branding")).toBe(false);
    expect((await withLicense(valid({ suspended: true, features: ["hootie_branding"] }))).hasEntitlement("hootie_branding")).toBe(false);
    expect((await withLicense(null)).hasEntitlement("hootie_branding")).toBe(false);
    expect((await withLicense(null)).licenseFeatures()).toEqual([]);
  });

  it("ignores non-string junk in the features list", async () => {
    const e = await withLicense(valid({ features: ["hootie_branding", 7, null, { x: 1 }] }));
    expect(e.licenseFeatures()).toEqual(["hootie_branding"]);
  });
});
