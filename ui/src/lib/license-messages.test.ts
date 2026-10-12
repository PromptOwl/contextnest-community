import { describe, it, expect } from "vitest";
import type { AdminLicense } from "./api";
import {
  NEUTRAL_READ_ONLY,
  adminLicenseNotice,
  isDismissed,
  neutralReadOnlyNotice,
  safeContact,
} from "./license-messages";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function lic(over: Partial<AdminLicense> = {}): AdminLicense {
  return {
    valid: true,
    tier: "team",
    org: "Acme",
    owner_email: "owner@acme.com",
    suspended: false,
    suspended_reason: null,
    trial: false,
    expires_at: null,
    days_left: null,
    reason: null,
    grace_ends_at: null,
    contact: { url: "https://example.com/talk", email: "sales@example.com" },
    seats: { licensed: 30, used: 12, over_limit: false, at_limit: false },
    pending_rejections: 0,
    last_checked_at: null,
    ...over,
  };
}

describe("adminLicenseNotice", () => {
  it("says nothing when all is well", () => {
    expect(adminLicenseNotice(lic(), NOW)).toBeNull();
  });

  it("over the seat limit: friendly, dismissible, and nobody is blocked", () => {
    const n = adminLicenseNotice(
      lic({ seats: { licensed: 30, used: 34, over_limit: true, at_limit: true } }),
      NOW,
    )!;
    expect(n.level).toBe("info");
    expect(n.body).toContain("You have 34 people on a 30-seat license");
    expect(n.body).toContain("Everyone can keep working");
    expect(n.body).toContain("We'll reach out");
    expect(n.dismissible).toBe(true);
    expect(n.cta).toBeTruthy();
  });

  it("expiry grace: names both dates and says everything keeps working", () => {
    const n = adminLicenseNotice(
      lic({
        trial: true,
        reason: "expired_grace",
        expires_at: iso(NOW - 2 * day),
        grace_ends_at: iso(NOW + 10 * day),
      }),
      NOW,
    )!;
    expect(n.title).toMatch(/^Your trial ended on /);
    expect(n.body).toMatch(/^Everything keeps working until /);
    expect(n.dismissible).toBe(true);
  });

  it("can't be dismissed within 3 days of a change", () => {
    const n = adminLicenseNotice(
      lic({ reason: "expired_grace", expires_at: iso(NOW - 11 * day), grace_ends_at: iso(NOW + 2 * day) }),
      NOW,
    )!;
    expect(n.dismissible).toBe(false);
    expect(n.level).toBe("warning");

    const trial = adminLicenseNotice(lic({ trial: true, expires_at: iso(NOW + 2 * day) }), NOW)!;
    expect(trial.dismissible).toBe(false);
  });

  it("trial with time left is a calm, dismissible heads-up", () => {
    const n = adminLicenseNotice(lic({ trial: true, expires_at: iso(NOW + 20 * day) }), NOW)!;
    expect(n.level).toBe("info");
    expect(n.title).toBe("Your trial ends in 20 days");
    expect(n.dismissible).toBe(true);
  });

  it("paid license only mentions renewal inside 14 days", () => {
    expect(adminLicenseNotice(lic({ expires_at: iso(NOW + 40 * day) }), NOW)).toBeNull();
    const n = adminLicenseNotice(lic({ expires_at: iso(NOW + 10 * day) }), NOW)!;
    expect(n.title).toBe("Your license is up for renewal in 10 days");
  });

  it("a lapsed license tells the admin what still works and offers a new key when useful", () => {
    const expired = adminLicenseNotice(
      lic({ valid: false, reason: "expired", expires_at: iso(NOW - 20 * day) }),
      NOW,
    )!;
    expect(expired.body).toContain("Nothing has been deleted");
    expect(expired.dismissible).toBe(false);
    expect(expired.offerInstall).toBe(false); // renewal restores it by itself

    const deact = adminLicenseNotice(lic({ valid: false, reason: "deactivated" }), NOW)!;
    expect(deact.offerInstall).toBe(true);
  });

  it("never uses alarming (error) styling", () => {
    const cases: Partial<AdminLicense>[] = [
      { valid: false, reason: "expired" },
      { valid: false, reason: "deactivated" },
      { suspended: true },
      { pending_rejections: 2 },
      { seats: { licensed: 1, used: 9, over_limit: true, at_limit: true } },
    ];
    for (const c of cases) {
      const n = adminLicenseNotice(lic(c), NOW)!;
      expect(["info", "warning"]).toContain(n.level);
    }
  });
});

describe("neutral notice for everyone else", () => {
  it("is the one sentence, with no licensing vocabulary and no CTA", () => {
    const n = neutralReadOnlyNotice();
    expect(n.title).toBe(NEUTRAL_READ_ONLY);
    expect(`${n.title} ${n.body}`).not.toMatch(/licen|trial|expir|suspend|payment|seat/i);
    expect(n.cta).toBeNull();
    expect(n.dismissible).toBe(false);
  });
});

describe("dismissal", () => {
  it("lasts 7 days, and only for the same notice", () => {
    const n = adminLicenseNotice(lic({ trial: true, expires_at: iso(NOW + 20 * day) }), NOW)!;
    expect(isDismissed(n, { id: n.id, at: NOW - 6 * day }, NOW)).toBe(true);
    expect(isDismissed(n, { id: n.id, at: NOW - 8 * day }, NOW)).toBe(false);
    expect(isDismissed(n, { id: "other", at: NOW }, NOW)).toBe(false);
  });
});

describe("safeContact", () => {
  it("never passes a non-http link through", () => {
    expect(safeContact({ url: "javascript:alert(1)", email: "a@b.co" }).url).toMatch(/^https:\/\//);
  });
});
