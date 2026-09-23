/**
 * License validation + kill-switch tests.
 *
 * The license module has top-level mutable state (suspension flags). We use
 * vi.resetModules() between tests to get a fresh module instance per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
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
    await db.run(
      "UPDATE license_cache SET validated_at = datetime('now', '-2 days') WHERE key = ?",
      ["pk_test_2"],
    );

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
    await getDb().run(
      "UPDATE license_cache SET validated_at = datetime('now', '-2 days') WHERE key = ?",
      ["pk_test_5"],
    );

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
    await getDb().run(
      "UPDATE license_cache SET validated_at = datetime('now', '-2 days') WHERE key = ?",
      ["pk_susp_2"],
    );

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
    await getDb().run(
      "UPDATE license_cache SET validated_at = datetime('now', '-2 days') WHERE key = ?",
      ["pk_susp_3"],
    );
    mockFetch({ body: { valid: true, tier: "team" } });
    await license.validateLicense();
    expect(license.isSuspended()).toBe(false);
    expect(license.getSuspensionReason()).toBeNull();
  });
});

// PromptOwl answers a suspended key with valid:false + suspended:true. That
// used to flip the license invalid on the first strike, so the 60s safety poll
// treated it as a revocation (wiped sessions, deleted the key) and the 1h
// two-strike window never ran.
describe("suspension (valid:false + suspended:true) keeps the two-strike window", () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    env.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stays licensed through the window, then suspends without revoking", async () => {
    process.env.PROMPTOWL_KEY = "pk_susp_v2";
    mockFetch({ body: { valid: true, tier: "team", org: "Acme" } });
    const license = await loadLicense();
    await license.validateLicense();

    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow);
    mockFetch({
      body: { valid: false, suspended: true, suspended_reason: "unpaid", tier: "none" },
    });
    const first = await license.validateLicense({ forceFresh: true });
    expect(first.valid).toBe(true); // first strike: nothing changes
    expect(first.tier).toBe("team");
    expect(license.isSuspended()).toBe(false);

    vi.spyOn(Date, "now").mockReturnValue(realNow + 61 * 60 * 1000);
    const second = await license.validateLicense({ forceFresh: true });
    expect(second.valid).toBe(true); // license kept; writes blocked via isSuspended()
    expect(license.isSuspended()).toBe(true);
    expect(second.suspended).toBe(true);
    expect(second.suspendedReason).toBe("unpaid");

    // The cached license survives, so an outage can't turn this into unlicensed.
    const { getDb } = await import("../src/db/client.js");
    const row = await getDb().get("SELECT key FROM license_cache WHERE key = ?", [
      "pk_susp_v2",
    ]);
    expect(row).toBeTruthy();
  });

  it("the safety poll does not revoke (sessions and key survive) on a suspension", async () => {
    process.env.PROMPTOWL_KEY = "pk_susp_poll";
    mockFetch({ body: { valid: true, tier: "team", org: "Acme" } });
    const license = await loadLicense();
    await license.validateLicense();
    expect(license.getCurrentLicense()?.valid).toBe(true);

    vi.useFakeTimers();
    mockFetch({ body: { valid: false, suspended: true, suspended_reason: "unpaid" } });
    license.startLicenseSafetyPoll();
    await vi.advanceTimersByTimeAsync(61 * 1000);

    expect(license.getCurrentLicense()?.valid).toBe(true);
    expect(process.env.PROMPTOWL_KEY).toBe("pk_susp_poll");
  });

  it("a suspension on a key that was never licensed stays unlicensed", async () => {
    process.env.PROMPTOWL_KEY = "pk_susp_never";
    mockFetch({ body: { valid: false, suspended: true, suspended_reason: "abuse" } });
    const { validateLicense } = await loadLicense();
    const result = await validateLicense();
    expect(result.valid).toBe(false);
  });
});

describe("rejection grace (CU-wdqcq01kh5)", () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  async function licensed(key: string) {
    process.env.PROMPTOWL_KEY = key;
    mockFetch({ body: { valid: true, tier: "team", org: "Acme" } });
    const license = await loadLicense();
    await license.validateLicense();
    return license;
  }

  it("keeps a cached license through two rejections and drops it on the third", async () => {
    const license = await licensed("pk_rej_1");
    mockFetch({ body: { valid: false, reason: "deactivated" } });

    const r1 = await license.validateLicense({ forceFresh: true });
    expect(r1.valid).toBe(true);
    expect(license.getPendingRejections()).toBe(1);
    const r2 = await license.validateLicense({ forceFresh: true });
    expect(r2.valid).toBe(true);
    expect(license.getPendingRejections()).toBe(2);

    const r3 = await license.validateLicense({ forceFresh: true });
    expect(r3.valid).toBe(false);
    expect(license.getPendingRejections()).toBe(0);
    const { getDb } = await import("../src/db/client.js");
    const row = await getDb().get("SELECT key FROM license_cache WHERE key = ?", [
      "pk_rej_1",
    ]);
    expect(row).toBeUndefined();
  });

  it("a valid answer resets the streak", async () => {
    const license = await licensed("pk_rej_2");
    mockFetch({ body: { valid: false } });
    await license.validateLicense({ forceFresh: true });
    await license.validateLicense({ forceFresh: true });
    expect(license.getPendingRejections()).toBe(2);

    mockFetch({ body: { valid: true, tier: "team", org: "Acme" } });
    await license.validateLicense({ forceFresh: true });
    expect(license.getPendingRejections()).toBe(0);

    mockFetch({ body: { valid: false } });
    const again = await license.validateLicense({ forceFresh: true });
    expect(again.valid).toBe(true); // streak restarted at 1
  });

  it("the safety poll does not revoke on a single rejection", async () => {
    const license = await licensed("pk_rej_poll");
    vi.useFakeTimers();
    try {
      mockFetch({ body: { valid: false } });
      license.startLicenseSafetyPoll();
      await vi.advanceTimersByTimeAsync(61 * 1000);
      expect(license.getCurrentLicense()?.valid).toBe(true);
      expect(process.env.PROMPTOWL_KEY).toBe("pk_rej_poll");
    } finally {
      vi.useRealTimers();
    }
  });

  it("installing a key fails immediately on rejection, even with an old cache row", async () => {
    const license = await licensed("pk_rej_install");
    mockFetch({ body: { valid: false } });
    const result = await license.installLicenseKey("pk_rej_install");
    expect(result.valid).toBe(false);
    expect(result.persisted).toBe(false);
  });
});

// Regression for the Docker license-persist bug: the in-app License Setup
// flow wrote PROMPTOWL_KEY to $cwd/.env (= /app/.env in the image), which is
// not on the mounted volume and not writable as the node user — so the key
// was lost on restart, and the write failure was swallowed (UI showed
// success). Fix: default ENV_FILE_PATH under DATA_ROOT, and surface failures.
describe("installLicenseKey — durable persistence (Docker)", () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
    delete process.env.ENV_FILE_PATH;
  });

  it("defaults ENV_FILE_PATH to a persisted, writable path under DATA_ROOT", async () => {
    delete process.env.ENV_FILE_PATH;
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.ENV_FILE_PATH).toBe(join(env.dataDir, ".env"));
  });

  it("persists the validated key to the database and reports persisted:true", async () => {
    mockFetch({
      body: { valid: true, tier: "team", org: "Acme", limits: { maxNests: 100, maxUsers: 25 } },
    });
    const { installLicenseKey } = await loadLicense();
    const result = await installLicenseKey("pk_persist_1");
    expect(result.valid).toBe(true);
    expect(result.persisted).toBe(true);
    // The key is durably stored in server_settings (survives restart + reaches
    // every instance) rather than an ephemeral .env file.
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get(
      "SELECT value FROM server_settings WHERE key = ?",
      ["PROMPTOWL_KEY"],
    )) as { value: string | null } | undefined;
    expect(row?.value).toBe("pk_persist_1");
  });

  it("surfaces a persistence failure instead of silently keeping the key in memory", async () => {
    // Force the DB write to throw by mocking the settings module — the license
    // still validates in-memory, but the operator must be told it did NOT
    // persist (the failure used to be swallowed, so the UI showed success).
    vi.resetModules();
    vi.doMock("../src/db/settings.js", () => ({
      persistSetting: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
      loadServerSettings: vi.fn(async () => 0),
    }));
    mockFetch({ body: { valid: true, tier: "team", org: "Acme" } });
    const { installLicenseKey } = await import("../src/auth/license.js");
    const result = await installLicenseKey("pk_persist_2");
    // Validated, so it works in-memory for this process...
    expect(result.valid).toBe(true);
    // ...but the operator must be told it did NOT persist.
    expect(result.persisted).toBe(false);
    expect(result.persistError).toBeTruthy();
    vi.doUnmock("../src/db/settings.js");
  });
});

describe("license contract v2", () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    env.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports seat count and server version on every validate", async () => {
    process.env.PROMPTOWL_KEY = "pk_v2_report";
    const fetchMock = mockFetch({ body: { valid: true, tier: "team" } });
    const { validateLicense } = await loadLicense();
    await validateLicense({ forceFresh: true });
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const sent = JSON.parse(String(init.body));
    expect(sent.key).toBe("pk_v2_report");
    expect(typeof sent.stats.users).toBe("number");
    expect(typeof sent.stats.nests).toBe("number");
    expect(typeof sent.server.version).toBe("string");
  });

  it("parses trial, expiry, grace, seats and contact from PromptOwl", async () => {
    process.env.PROMPTOWL_KEY = "pk_v2_fields";
    mockFetch({
      body: {
        valid: true,
        tier: "team",
        limits: { maxUsers: 30, maxNests: 0 },
        reason: "expired_grace",
        trial: true,
        expires_at: "2026-10-23T00:00:00.000Z",
        grace_ends_at: "2026-11-06T00:00:00.000Z",
        seats: { licensed: 30, used: 34, over_limit: true },
        contact: { url: "https://example.com/talk", email: "sales@example.com" },
      },
    });
    const { validateLicense } = await loadLicense();
    const lic = await validateLicense({ forceFresh: true });
    expect(lic.valid).toBe(true);
    expect(lic.trial).toBe(true);
    expect(lic.reason).toBe("expired_grace");
    expect(lic.expiresAt).toBe("2026-10-23T00:00:00.000Z");
    expect(lic.graceEndsAt).toBe("2026-11-06T00:00:00.000Z");
    expect(lic.seats).toEqual({ licensed: 30, used: 34, overLimit: true });
    expect(lic.contact).toEqual({ url: "https://example.com/talk", email: "sales@example.com" });

    // Cached reads keep the same terms.
    const again = await validateLicense();
    expect(again.graceEndsAt).toBe("2026-11-06T00:00:00.000Z");
  });

  it("derives seats from limits when PromptOwl predates v2", async () => {
    process.env.PROMPTOWL_KEY = "pk_v2_legacy";
    mockFetch({ body: { valid: true, tier: "team", limits: { maxUsers: 5, maxNests: 0 } } });
    const { validateLicense } = await loadLicense();
    const lic = await validateLicense({ forceFresh: true });
    expect(lic.seats?.licensed).toBe(5);
    expect(lic.seats?.overLimit).toBe(false);
    expect(lic.contact?.url).toMatch(/^https:\/\//);
  });

  it("never renders a non-http contact link", async () => {
    process.env.PROMPTOWL_KEY = "pk_v2_js";
    mockFetch({
      body: { valid: true, contact: { url: "javascript:alert(1)", email: "<x>" } },
    });
    const { validateLicense, DEFAULT_LICENSE_CONTACT } = await loadLicense();
    const lic = await validateLicense({ forceFresh: true });
    expect(lic.contact).toEqual(DEFAULT_LICENSE_CONTACT);
  });

  it("a lapse keeps the key and the owner, so a renewal restores the server", async () => {
    process.env.PROMPTOWL_KEY = "pk_v2_lapse";
    mockFetch({ body: { valid: true, tier: "team", owner_email: "owner@acme.com" } });
    const license = await loadLicense();
    await license.validateLicense();

    const { getDb } = await import("../src/db/client.js");
    await getDb().run(
      "INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'm@acme.com', 'M', 'x')",
    );
    await getDb().run(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', 'u1', datetime('now', '+1 day'))",
    ).catch(() => {});
    const sessionsBefore = (await getDb().get("SELECT COUNT(*) as c FROM sessions")) as { c: number };

    vi.useFakeTimers();
    mockFetch({
      body: { valid: false, reason: "expired", owner_email: "owner@acme.com", expires_at: "2026-09-01T00:00:00.000Z" },
    });
    license.startLicenseSafetyPoll();
    await vi.advanceTimersByTimeAsync(3 * 61 * 1000);

    expect(license.getCurrentLicense()?.valid).toBe(false);
    expect(license.getCurrentLicense()?.reason).toBe("expired");
    expect(process.env.PROMPTOWL_KEY).toBe("pk_v2_lapse");
    expect(license.getLicenseOwnerEmail()).toBe("owner@acme.com");
    const sessionsAfter = (await getDb().get("SELECT COUNT(*) as c FROM sessions")) as { c: number };
    expect(sessionsAfter.c).toBe(sessionsBefore.c);

    // PromptOwl renews it: the next poll restores the server, no reinstall.
    mockFetch({ body: { valid: true, tier: "team", owner_email: "owner@acme.com" } });
    await vi.advanceTimersByTimeAsync(61 * 1000);
    expect(license.getCurrentLicense()?.valid).toBe(true);
  });
});
