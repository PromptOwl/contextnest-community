/**
 * License validation + kill-switch tests.
 *
 * The license module has top-level mutable state (suspension flags). We use
 * vi.resetModules() between tests to get a fresh module instance per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestEnv } from "./helpers";

type LicenseModule = typeof import("../src/auth/license.js");

async function loadLicense(): Promise<LicenseModule> {
  vi.resetModules();
  // Re-import after reset so suspensionFirstSeen / suspensionConfirmed start clean.
  return await import("../src/auth/license.js");
}

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  reject?: Error;
}) {
  const fn = vi.fn(async () => {
    if (response.reject) throw response.reject;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body ?? {},
    } as Response;
  });
  // @ts-expect-error — overriding the global for the test
  global.fetch = fn;
  return fn;
}

describe("validateLicense", () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it("returns unlicensed when no PROMPTOWL_KEY is set", async () => {
    process.env.PROMPTOWL_KEY = "";
    const { validateLicense } = await loadLicense();
    const result = await validateLicense();
    expect(result.valid).toBe(false);
    expect(result.tier).toBe("none");
    expect(result.org).toBeNull();
    expect(result.suspended).toBe(false);
  });

  it("hits PromptOwl, returns the license, and caches it", async () => {
    process.env.PROMPTOWL_KEY = "pk_test_1";
    const fetchMock = mockFetch({
      body: {
        valid: true,
        tier: "team",
        org: "Acme",
        limits: { maxNests: 100, maxUsers: 25 },
      },
    });
    const { validateLicense } = await loadLicense();
    const result = await validateLicense();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.valid).toBe(true);
    expect(result.tier).toBe("team");
    expect(result.org).toBe("Acme");
    expect(result.limits).toEqual({ maxNests: 100, maxUsers: 25 });

    // Second call should hit the cache, not the network.
    const result2 = await validateLicense();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result2.tier).toBe("team");
  });

  it("falls back to cached license on a network error (grace period)", async () => {
    process.env.PROMPTOWL_KEY = "pk_test_2";
    // First call: succeeds and caches.
    mockFetch({
      body: { valid: true, tier: "team", org: "Acme" },
    });
    const license = await loadLicense();
    await license.validateLicense();

    // Reload module so the cache TTL stays the same in DB but reset
    // suspension state; then make fetch reject.
    process.env.PROMPTOWL_KEY = "pk_test_2";
    const fetchMock = mockFetch({ reject: new Error("connection refused") });
    const license2 = await loadLicense();
    // Force cache miss by aging the cached row out — actually we want
    // network to be called even on cache hit, so age the row.
    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    db.prepare(
      "UPDATE license_cache SET validated_at = datetime('now', '-2 days') WHERE key = ?",
    ).run("pk_test_2");

    const result = await license2.validateLicense();
    expect(fetchMock).toHaveBeenCalled();
    // grace period: still valid
    expect(result.valid).toBe(true);
    expect(result.tier).toBe("team");
  });

  it("returns unlicensed on network error with no cache", async () => {
    process.env.PROMPTOWL_KEY = "pk_test_3";
    mockFetch({ reject: new Error("network down") });
    const { validateLicense } = await loadLicense();
    const result = await validateLicense();
    expect(result.valid).toBe(false);
    expect(result.tier).toBe("none");
  });

  it("returns unlicensed on a non-OK response with no cache", async () => {
    process.env.PROMPTOWL_KEY = "pk_test_4";
    mockFetch({ ok: false, status: 401 });
    const { validateLicense } = await loadLicense();
    const result = await validateLicense();
    expect(result.valid).toBe(false);
  });

  it("uses cache on non-OK response when cache exists (grace period)", async () => {
    process.env.PROMPTOWL_KEY = "pk_test_5";
    // Seed the cache via a successful first call
    mockFetch({ body: { valid: true, tier: "team", org: "Acme" } });
    const license = await loadLicense();
    await license.validateLicense();

    // Age the cache so the next call goes to network, then 500
    const { getDb } = await import("../src/db/client.js");
    getDb()
      .prepare(
        "UPDATE license_cache SET validated_at = datetime('now', '-2 days') WHERE key = ?",
      )
      .run("pk_test_5");

    process.env.PROMPTOWL_KEY = "pk_test_5";
    mockFetch({ ok: false, status: 500 });
    const license2 = await loadLicense();
    const result = await license2.validateLicense();
    expect(result.valid).toBe(true);
    expect(result.tier).toBe("team");
  });

  it("returns unlicensed (without crashing) when API says valid:false but not suspended", async () => {
    process.env.PROMPTOWL_KEY = "pk_invalid";
    mockFetch({ body: { valid: false } });
    const { validateLicense } = await loadLicense();
    const result = await validateLicense();
    expect(result.valid).toBe(false);
    expect(result.tier).toBe("none");
  });
});

describe("kill switch (isSuspended / two-strike confirmation)", () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it("first suspension flag does NOT confirm — confirmation requires the 1h window", async () => {
    process.env.PROMPTOWL_KEY = "pk_susp_1";
    mockFetch({
      body: { valid: true, tier: "team", suspended: true, suspended_reason: "abuse" },
    });
    const { validateLicense, isSuspended, getSuspensionReason } =
      await loadLicense();
    await validateLicense();
    expect(isSuspended()).toBe(false); // still in confirmation window
    expect(getSuspensionReason()).toBe("abuse"); // reason captured early
  });

  it("a second strike after the confirm window confirms suspension", async () => {
    process.env.PROMPTOWL_KEY = "pk_susp_2";
    mockFetch({
      body: { valid: true, tier: "team", suspended: true, suspended_reason: "tos" },
    });
    const license = await loadLicense();

    // First strike at t=0
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow);
    await license.validateLicense();
    expect(license.isSuspended()).toBe(false);

    // Force the cache to be stale so the second call hits network
    const { getDb } = await import("../src/db/client.js");
    getDb()
      .prepare(
        "UPDATE license_cache SET validated_at = datetime('now', '-2 days') WHERE key = ?",
      )
      .run("pk_susp_2");

    // Jump past the 1h confirmation window
    vi.spyOn(Date, "now").mockReturnValue(realNow + 61 * 60 * 1000);
    await license.validateLicense();
    expect(license.isSuspended()).toBe(true);
    expect(license.getSuspensionReason()).toBe("tos");
  });

  it("clears a pending suspension when PromptOwl reverses the flag", async () => {
    process.env.PROMPTOWL_KEY = "pk_susp_3";
    // First call: suspended (first strike, not confirmed)
    mockFetch({
      body: { valid: true, suspended: true, suspended_reason: "oops" },
    });
    const license = await loadLicense();
    await license.validateLicense();
    expect(license.getSuspensionReason()).toBe("oops");

    // Age cache so next call goes to network, then return suspended:false
    const { getDb } = await import("../src/db/client.js");
    getDb()
      .prepare(
        "UPDATE license_cache SET validated_at = datetime('now', '-2 days') WHERE key = ?",
      )
      .run("pk_susp_3");
    mockFetch({ body: { valid: true, tier: "team" } });
    await license.validateLicense();
    expect(license.isSuspended()).toBe(false);
    expect(license.getSuspensionReason()).toBeNull();
  });
});
