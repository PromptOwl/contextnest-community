/**
 * Seats + license status + who hears what (license contract v2, amendment 1).
 *
 * Joining is never refused: over the limit, new people still sign up, and only
 * the admin sees a private notice (role grants are capped — plan-limits.test.ts).
 * When the license lapses on a server past the
 * Free tier (more than 10 people), it goes read-only; the admin/owner is told why, everyone else gets one neutral line
 * with no licensing vocabulary in it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
  seedPeople,
} from "./helpers";
import { FREE_TIER_MAX_USERS } from "../src/auth/free-tier.js";

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
// The pricing entitlement, also read on every call.
const entitlement: Record<string, any> = {};

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", {
    ownerEmail: "owner@co.com",
    licenseLimits: limits,
    licenseOverrides: overrides,
    entitlement,
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

  it("/admin/license counts billed users against the plan's cap", async () => {
    // Billed users: the license owner (Account Owner) and member (owns a nest).
    // late@ and invitee@ hold no role, so they're free viewers.
    entitlement.maxUsers = 1;
    const res = await jsonRequest(app, "GET", "/admin/license", undefined, owner.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.seats).toEqual({ licensed: 1, used: 2, over_limit: true, at_limit: true });
    expect(res.data.subscribers).toEqual({ licensed: null, used: 0 });
    expect(res.data.plan).toBe("enterprise");
    expect(res.data.contact.url).toMatch(/^https:\/\//);
    expect(res.data).toHaveProperty("grace_ends_at");
    expect(res.data.pending_rejections).toBe(0);
    // The License tab shows whether own model keys (byok) are on; this licence has no features.
    expect(res.data.byok).toBe(false);
  });

  it("links to PromptOwl's page for this key by its last 4 characters only", async () => {
    const before = process.env.PROMPTOWL_KEY;
    process.env.PROMPTOWL_KEY = "pk_0123456789abcdef";
    try {
      const res = await jsonRequest(app, "GET", "/admin/license", undefined, owner.apiKey);
      expect(res.data.manage_url).toMatch(/\/community-license\?key=cdef$/);
      expect(res.data.manage_url).not.toContain("0123456789");
    } finally {
      if (before === undefined) delete process.env.PROMPTOWL_KEY;
      else process.env.PROMPTOWL_KEY = before;
    }
  });

  it("no limit reports licensed:null and never over", async () => {
    entitlement.maxUsers = null;
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
    beforeAll(async () => {
      // Past the Free tier, so a lapsed license makes the server read-only.
      await seedPeople(FREE_TIER_MAX_USERS + 1);
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

    it("nest-level writes (create, rename, delete) are refused too; reads still work", async () => {
      const create = await jsonRequest(app, "POST", "/nests", { name: "Blocked" }, member.apiKey);
      expect(create.status).toBe(503);
      expect(create.data.error).toBe(NEUTRAL);
      const rename = await jsonRequest(app, "PATCH", `/nests/${nestId}`, { name: "Renamed" }, member.apiKey);
      expect(rename.status).toBe(503);
      const del = await jsonRequest(app, "DELETE", `/nests/${nestId}`, undefined, member.apiKey);
      expect(del.status).toBe(503);
      // The license owner hears why.
      const asOwner = await jsonRequest(app, "POST", "/nests", { name: "Blocked" }, owner.apiKey);
      expect(asOwner.status).toBe(503);
      expect(asOwner.data.error).toBe("License required");
      // Reading is untouched.
      expect((await jsonRequest(app, "GET", "/nests", undefined, member.apiKey)).status).toBe(200);
      expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, member.apiKey)).status).toBe(200);
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
