/**
 * Nest-scoped API keys are a boundary, not a speed bump (CU-wdqcq02xqt).
 *
 * A key minted with `nest_id` is what you hand an agent that should see ONE
 * nest. Outside that nest it is deny-by-default: it may reach its own nest's
 * routes, the agent entry points that already filter to its nest (/mcp,
 * /index), and the read-only cross-nest views (/search, /stats, GET /nests),
 * which are narrowed to its nest. Everything else 403s with
 * `code: "nest_scoped_key"` — above all /auth/keys, or the key could be traded
 * for a whole-account key.
 *
 * The other side matters as much: a session or a user-level key keeps its full
 * behavior on every one of these routes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const OWNER_EMAIL = "owner@acme.com";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let stranger: { apiKey: string; userId: string; email: string };
let ownerCookie: string;
let nestA: string;
let nestB: string;
let strangerNest: string;
/** Owner's key scoped to nest A. */
let nestKey: string;
let nestKeyId: string;

async function loginCookie(email: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass" }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

async function keyCount(userId: string): Promise<number> {
  const { getDb } = await import("../src/db/client.js");
  const row = (await getDb().get(
    "SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?",
    [userId],
  )) as { c: number };
  return Number(row.c);
}

function expectScopedDenial(res: { status: number; data: any }) {
  expect(res.status).toBe(403);
  expect(res.data.code).toBe("nest_scoped_key");
  expect(res.data.error).toMatch(/scoped to one nest/i);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  owner = await registerUser(app, OWNER_EMAIL, "Owner");
  stranger = await registerUser(app, "stranger@acme.com", "Stranger");
  ownerCookie = await loginCookie(OWNER_EMAIL);

  const a = await jsonRequest(app, "POST", "/nests", { name: "Nest A" }, owner.apiKey);
  nestA = a.data.nest.id;
  const b = await jsonRequest(app, "POST", "/nests", { name: "Nest B" }, owner.apiKey);
  nestB = b.data.nest.id;
  const s = await jsonRequest(app, "POST", "/nests", { name: "Stranger Nest" }, stranger.apiKey);
  strangerNest = s.data.nest.id;

  await jsonRequest(app, "POST", `/nests/${nestA}/nodes`,
    { title: "Widget Runbook", content: "# how to onboard a widget" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestB}/nodes`,
    { title: "Widget Pricing", content: "# pricing for the widget" }, owner.apiKey);

  const minted = await jsonRequest(app, "POST", "/auth/keys",
    { label: "agent for A", nest_id: nestA }, owner.apiKey);
  expect(minted.status).toBe(201);
  nestKey = minted.data.api_key;
  nestKeyId = minted.data.id;
});

afterAll(() => env.cleanup());

describe("nest-scoped key — cannot touch API keys (the escalation)", () => {
  it("POST /auth/keys → 403 and no key is created", async () => {
    const before = await keyCount(owner.userId);
    const res = await jsonRequest(app, "POST", "/auth/keys", { label: "escalate" }, nestKey);
    expectScopedDenial(res);
    expect(res.data.api_key).toBeUndefined();
    expect(await keyCount(owner.userId)).toBe(before);
  });

  it("POST /auth/keys/rotate → 403 (can't un-scope itself)", async () => {
    // A throwaway nest key, so a failure here can't take the shared one down.
    const own = await jsonRequest(app, "POST", "/auth/keys",
      { label: "self-rotator", nest_id: nestA }, owner.apiKey);
    const res = await jsonRequest(app, "POST", "/auth/keys/rotate",
      { key_id: own.data.id, nest_id: null }, own.data.api_key);
    expectScopedDenial(res);
    expect(res.data.api_key).toBeUndefined();
    // The key still exists and is still scoped.
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get("SELECT nest_id FROM api_keys WHERE id = ?", [own.data.id])) as
      | { nest_id: string | null }
      | undefined;
    expect(row?.nest_id).toBe(nestA);
    await jsonRequest(app, "DELETE", `/auth/keys/${own.data.id}`, undefined, owner.apiKey);
  });

  it("GET /auth/keys → 403", async () => {
    expectScopedDenial(await jsonRequest(app, "GET", "/auth/keys", undefined, nestKey));
  });

  it("DELETE /auth/keys/:id → 403 and the target key survives", async () => {
    const other = await jsonRequest(app, "POST", "/auth/keys", { label: "victim" }, owner.apiKey);
    const res = await jsonRequest(app, "DELETE", `/auth/keys/${other.data.id}`, undefined, nestKey);
    expectScopedDenial(res);
    const still = await jsonRequest(app, "GET", "/auth/keys", undefined, other.data.api_key);
    expect(still.status).toBe(200);
  });

  it("account routes (/auth/profile, /auth/password) → 403", async () => {
    expectScopedDenial(await jsonRequest(app, "PATCH", "/auth/profile", { name: "pwned" }, nestKey));
    expectScopedDenial(await jsonRequest(app, "POST", "/auth/password",
      { current_password: "testpass", new_password: "newpass123" }, nestKey));
  });
});

describe("nest-scoped key — cross-nest reads are narrowed to its nest", () => {
  it("GET /search returns only hits from its nest", async () => {
    const res = await jsonRequest(app, "GET", "/search?q=widget", undefined, nestKey);
    expect(res.status).toBe(200);
    const nests = new Set(res.data.nodes.map((n: any) => n.nest_id));
    expect([...nests]).toEqual([nestA]);
    expect(res.data.count).toBe(1);
  });

  it("GET /stats counts only its nest", async () => {
    const res = await jsonRequest(app, "GET", "/stats", undefined, nestKey);
    expect(res.status).toBe(200);
    expect(res.data.nests).toBe(1);
    expect(res.data.documents).toBe(1);
  });

  it("GET /nests lists only its nest", async () => {
    const res = await jsonRequest(app, "GET", "/nests", undefined, nestKey);
    expect(res.status).toBe(200);
    expect(res.data.nests.map((n: any) => n.id)).toEqual([nestA]);
  });
});

describe("nest-scoped key — other nests stay closed", () => {
  it("/nests/B/nodes → 403 (existing behavior preserved)", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestB}/nodes`, undefined, nestKey);
    expect(res.status).toBe(403);
  });

  it("GET /nests/B (bare) → 403", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestB}`, undefined, nestKey);
    expect(res.status).toBe(403);
    expect(res.data.nest).toBeUndefined();
  });

  it("POST /nests (create a new nest) → 403", async () => {
    expectScopedDenial(await jsonRequest(app, "POST", "/nests", { name: "Escape" }, nestKey));
  });

  it("/nests/unsynced (admin namespace) → 403", async () => {
    const res = await jsonRequest(app, "GET", "/nests/unsynced", undefined, nestKey);
    expect(res.status).toBe(403);
  });
});

describe("nest-scoped key — account- and server-wide routes 403", () => {
  it("admin-owned nest key → /admin/settings 403 (GET and PATCH)", async () => {
    expectScopedDenial(await jsonRequest(app, "GET", "/admin/settings", undefined, nestKey));
    expectScopedDenial(await jsonRequest(app, "PATCH", "/admin/settings", { logo_url: "" }, nestKey));
  });

  it("/admin/trace and /admin/super-admins → 403", async () => {
    expectScopedDenial(await jsonRequest(app, "GET", "/admin/trace", undefined, nestKey));
    expectScopedDenial(await jsonRequest(app, "GET", "/admin/super-admins", undefined, nestKey));
  });

  it("admin routes that resolve the caller themselves (/auth/teammates, /auth/invite) → 403", async () => {
    expectScopedDenial(await jsonRequest(app, "GET", "/auth/teammates", undefined, nestKey));
    expectScopedDenial(await jsonRequest(app, "POST", "/auth/invite", { email: "x@acme.com" }, nestKey));
  });

  it("/teams, /people, /me/* → 403", async () => {
    expectScopedDenial(await jsonRequest(app, "GET", "/teams", undefined, nestKey));
    expectScopedDenial(await jsonRequest(app, "GET", "/people/suggest?q=s", undefined, nestKey));
    expectScopedDenial(await jsonRequest(app, "GET", "/me/work", undefined, nestKey));
    expectScopedDenial(await jsonRequest(app, "GET", "/me/drafts", undefined, nestKey));
    expectScopedDenial(await jsonRequest(app, "POST", `/me/nests/${nestB}/leave`, undefined, nestKey));
  });
});

describe("nest-scoped key — what it CAN reach", () => {
  it("its own nest's routes", async () => {
    const nest = await jsonRequest(app, "GET", `/nests/${nestA}`, undefined, nestKey);
    expect(nest.status).toBe(200);
    const nodes = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, nestKey);
    expect(nodes.status).toBe(200);
    const created = await jsonRequest(app, "POST", `/nests/${nestA}/nodes`,
      { title: "Agent Note", content: "written by the agent" }, nestKey);
    expect(created.status).toBe(201);
  });

  it("/index (filtered to its nest) and /health", async () => {
    const idx = await jsonRequest(app, "GET", "/index?format=json", undefined, nestKey);
    expect(idx.status).toBe(200);
    const health = await jsonRequest(app, "GET", "/health", undefined, nestKey);
    expect(health.status).toBe(200);
  });

  it("a session cookie sent alongside the nest key still wins (full access)", async () => {
    const res = await app.request("/auth/keys", {
      method: "GET",
      headers: { Cookie: ownerCookie, Authorization: `Bearer ${nestKey}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("minting a nest-scoped key — the caller must be able to reach that nest", () => {
  it("rejects a nest the caller can't access", async () => {
    // The stranger (not an admin) has no access to the owner's nest A.
    const res = await jsonRequest(app, "POST", "/auth/keys",
      { label: "sneaky", nest_id: nestA }, stranger.apiKey);
    expect([400, 403, 404]).toContain(res.status);
    expect(res.data.api_key).toBeUndefined();
  });

  it("rejects a nest that doesn't exist", async () => {
    const res = await jsonRequest(app, "POST", "/auth/keys",
      { label: "ghost", nest_id: "no-such-nest" }, owner.apiKey);
    expect([400, 404]).toContain(res.status);
    expect(res.data.api_key).toBeUndefined();
  });

  it("rejects rotating onto a nest the caller can't access", async () => {
    const k = await jsonRequest(app, "POST", "/auth/keys", { label: "to-rotate" }, stranger.apiKey);
    const res = await jsonRequest(app, "POST", "/auth/keys/rotate",
      { key_id: k.data.id, nest_id: nestA }, stranger.apiKey);
    expect([400, 403, 404]).toContain(res.status);
    // Rejected rotation leaves the original key alive and unscoped.
    const still = await jsonRequest(app, "GET", "/auth/keys", undefined, k.data.api_key);
    expect(still.status).toBe(200);
    expect(still.data.keys.find((r: any) => r.id === k.data.id)?.nest_id).toBeNull();
    await jsonRequest(app, "DELETE", `/auth/keys/${k.data.id}`, undefined, stranger.apiKey);
  });

  it("accepts a non-admin scoping a key to their own nest", async () => {
    const res = await jsonRequest(app, "POST", "/auth/keys",
      { label: "my agent", nest_id: strangerNest }, stranger.apiKey);
    expect(res.status).toBe(201);
    expect(res.data.nest_id).toBe(strangerNest);
    await jsonRequest(app, "DELETE", `/auth/keys/${res.data.id}`, undefined, stranger.apiKey);
  });

  it("accepts a nest the caller owns and reports the scope back", async () => {
    const res = await jsonRequest(app, "POST", "/auth/keys",
      { label: "agent for B", nest_id: nestB }, owner.apiKey);
    expect(res.status).toBe(201);
    expect(res.data.nest_id).toBe(nestB);
    await jsonRequest(app, "DELETE", `/auth/keys/${res.data.id}`, undefined, owner.apiKey);
  });
});

// Destructive calls last: on the pre-fix code these SUCCEED (they delete a nest
// and a user), so running them earlier would cascade into unrelated failures.
describe("nest-scoped key — destructive account-wide calls 403 (run last)", () => {
  it("admin-owned nest key can't reset another user's password or delete them", async () => {
    expectScopedDenial(await jsonRequest(app, "POST", `/auth/admin/reset-password/${stranger.userId}`,
      { password: "hijacked123" }, nestKey));
    expectScopedDenial(await jsonRequest(app, "DELETE", `/auth/users/${stranger.userId}`, undefined, nestKey));
  });

  it("DELETE /nests/B → 403 and nest B survives", async () => {
    const res = await jsonRequest(app, "DELETE", `/nests/${nestB}`, undefined, nestKey);
    expect(res.status).toBe(403);
    const still = await jsonRequest(app, "GET", `/nests/${nestB}`, undefined, owner.apiKey);
    expect(still.status).toBe(200);
  });

});

// Suites that register several users trip the auth rate limiter.
afterAll(() => resetAuthRateLimit());
