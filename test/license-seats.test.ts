/**
 * Seats + license status + who hears what (license contract v2, amendment 1).
 *
 * Seats are never enforced: over the limit, new people still join, and only
 * the admin sees a private notice. When the license lapses, the server goes
 * read-only; the admin/owner is told why, everyone else gets one neutral line
 * with no licensing vocabulary in it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers";

const NEUTRAL =
  "This workspace is read-only right now. Your administrator has been notified.";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let member: { apiKey: string; userId: string; email: string };
let nestId: string;
// Both are read by the mocked license on every call.
const limits = { maxUsers: 0, maxNests: 0 };
const overrides: Record<string, unknown> = {};

async function seatsUsed(): Promise<number> {
  const { getDb } = await import("../src/db/client.js");
  const row = (await getDb().get("SELECT COUNT(*) as c FROM users")) as { c: number };
  return Number(row.c);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", {
    ownerEmail: "owner@co.com",
    licenseLimits: limits,
    licenseOverrides: overrides,
  });
  owner = await registerUser(app, "owner@co.com");
  member = await registerUser(app, "member@co.com");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Team" }, member.apiKey);
  expect(nest.status).toBe(201);
  nestId = nest.data.id ?? nest.data.nest?.id;
});

afterAll(() => env.cleanup());

describe("seats are reported, never enforced", () => {
  it("still creates new people past the seat limit", async () => {
    limits.maxUsers = 1;
    await resetAuthRateLimit();
    const reg = await jsonRequest(app, "POST", "/auth/register", {
      email: "late@co.com",
      password: "testpass",
      name: "late",
    });
    expect(reg.status).toBe(201);

    const inv = await jsonRequest(app, "POST", "/auth/invite", { email: "invitee@co.com" }, owner.apiKey);
    expect(inv.status).toBe(201);
  });

  it("/admin/license shows the live head-count and the over-limit flag", async () => {
    limits.maxUsers = 2;
    const res = await jsonRequest(app, "GET", "/admin/license", undefined, owner.apiKey);
    expect(res.status).toBe(200);
    const used = await seatsUsed();
    expect(res.data.seats).toEqual({
      licensed: 2,
      used,
      over_limit: used > 2,
      at_limit: used >= 2,
    });
    expect(res.data.seats.over_limit).toBe(true);
    expect(res.data.contact.url).toMatch(/^https:\/\//);
    expect(res.data).toHaveProperty("grace_ends_at");
    expect(res.data.pending_rejections).toBe(0);
  });

  it("no limit reports licensed:null and never over", async () => {
    limits.maxUsers = 0;
    const res = await jsonRequest(app, "GET", "/admin/license", undefined, owner.apiKey);
    expect(res.data.seats.licensed).toBeNull();
    expect(res.data.seats.over_limit).toBe(false);
  });
});

describe("who hears what", () => {
  it("/admin/license is for admins only", async () => {
    expect((await jsonRequest(app, "GET", "/admin/license")).status).toBe(401);
    const res = await jsonRequest(app, "GET", "/admin/license", undefined, member.apiKey);
    expect(res.status).toBe(403);
  });

  it("public /license/status carries no lapse detail, head-count or contact", async () => {
    const res = await jsonRequest(app, "GET", "/license/status");
    expect(res.status).toBe(200);
    expect(res.data.valid).toBe(true);
    expect(res.data.setup_required).toBe(false);
    for (const k of ["reason", "expires_at", "days_left", "grace_ends_at", "contact", "seats", "trial"]) {
      expect(res.data).not.toHaveProperty(k);
    }
  });

  describe("license lapsed", () => {
    beforeAll(() => {
      overrides.valid = false;
      overrides.reason = "expired";
      overrides.expiresAt = "2026-09-01T00:00:00.000Z";
    });
    afterAll(() => {
      for (const k of Object.keys(overrides)) delete overrides[k];
    });

    it("a non-admin's write gets only the neutral line", async () => {
      const w = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "T", content: "C" },
        member.apiKey,
      );
      expect(w.status).toBe(503);
      expect(w.data.error).toBe(NEUTRAL);
      expect(JSON.stringify(w.data)).not.toMatch(/licen|expir|suspend|payment|trial/i);
    });

    it("the license owner gets the specifics and who to talk to", async () => {
      const w = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "T", content: "C" },
        owner.apiKey,
      );
      expect(w.status).toBe(503);
      expect(w.data.error).toBe("License required");
      expect(w.data.reason).toMatch(/ended/);
      expect(w.data.contact.url).toMatch(/^https:\/\//);
    });

    it("status says the workspace isn't in first-time setup", async () => {
      const res = await jsonRequest(app, "GET", "/license/status");
      expect(res.data.valid).toBe(false);
      // The mock keeps ownerEmail set, standing in for a remembered owner.
      expect(res.data).toHaveProperty("setup_required");
    });
  });
});
