import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { vi } from "vitest";
import { resetDb } from "../src/db/client.js";
import { _reset as resetRateLimits } from "../src/shared/rate-limit.js";

/** Clear auth rate-limit buckets mid-suite — needed when a suite registers
 *  more than REGISTER_LIMIT (3) users from the same IP. Dynamic import grabs
 *  the post-resetModules instance the running app actually uses (the top-level
 *  import above is stale after createTestApp's vi.resetModules). */
export async function resetAuthRateLimit() {
  const rl = await import("../src/shared/rate-limit.js");
  rl._reset();
}

/** Set up an isolated data directory for each test suite.
 *
 * The actual DB connection is opened lazily by createTestApp (which calls
 * initDb after vi.resetModules so the post-reset module graph the app uses is
 * the one that gets initialised). Here we just point env at a fresh dir and
 * best-effort close any connection left over on this module graph. */
export function setupTestEnv() {
  // Reset the cached DB connection so each suite gets its own (best-effort —
  // adapter.close() is async; we don't block the sync setup on it).
  void resetDb();
  // Clear rate-limiter state so auth-endpoint tests don't trip each other
  resetRateLimits();

  // Under data/test/ so the whole test corpus wipes with one `rm -rf data/test`.
  const testDir = join(process.cwd(), "data", "test", randomUUID());
  mkdirSync(testDir, { recursive: true });

  process.env.DATA_ROOT = testDir;
  process.env.DATABASE_PATH = join(testDir, "test.db");
  process.env.PROMPTOWL_KEY = ""; // no license in tests
  process.env.TELEMETRY_ENABLED = "false";
  // Suites create nests as ordinary users; the admins-only gate has its own test.
  process.env.NEST_CREATION = "everyone";
  // Default tests to SQLite regardless of any DB_DRIVER/DATABASE_URL set in
  // the developer's shell (the gated Postgres suite sets these itself).
  process.env.DB_DRIVER = "sqlite";
  delete process.env.DATABASE_URL;
  delete process.env.CLOUD_SQL_CONNECTION_NAME;

  return {
    dataDir: testDir,
    async cleanup() {
      await resetDb();
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Create the Hono app (must be called AFTER setupTestEnv sets env vars).
 *
 * The license gate in app.ts blocks every non-GET (and every governance
 * route) until getCurrentLicense() returns a valid license. Tests don't
 * have a real PromptOwl key, so we mock the license module to report a
 * valid license without changing production code. The mock is scoped to
 * this file's module cache, so test files that import the real license
 * module (license.test.ts) are unaffected.
 */
export async function createTestApp(
  authMode: "open" | "key" = "open",
  opts: {
    superAdmins?: string[];
    ownerEmail?: string;
    tier?: string;
    /** Named licence features (entitlements.ts). */
    features?: string[];
    /** License limits the mocked license reports. Read on every call, so a
     *  test can mutate maxUsers after seeding users (seat-limit tests). */
    licenseLimits?: { maxUsers: number; maxNests: number };
    /** Fields merged over the mocked license on every call — mutate it to
     *  flip the server to lapsed/suspended mid-suite. */
    licenseOverrides?: Record<string, unknown>;
    /** Pricing entitlement (see license.getEntitlement). Read on every call.
     *  Defaults to unlimited so plan limits never touch unrelated tests. */
    entitlement?: Partial<import("../src/auth/license.js").Entitlement>;
    /** The PromptOwl model gateway the licence check hands out (default none). */
    gateway?: { baseUrl: string; key: string; defaultModel?: string | null } | null;
    /** The licence's own-provider gateway (byok; default none). */
    ownGateway?: import("../src/auth/license.js").OwnGateway | null;
  } = {},
) {
  process.env.AUTH_MODE = authMode;
  vi.resetModules();
  vi.doMock("../src/auth/license.js", async () => {
    const actual = await vi.importActual<
      typeof import("../src/auth/license.js")
    >("../src/auth/license.js");
    // Capture the post-resetModules db/client instance so the userId override
    // reads the same DB the running app does.
    const dbClient = await import("../src/db/client.js");
    return {
      ...actual,
      getCurrentLicense: () => ({
        valid: true,
        tier: opts.tier ?? "test",
        org: "Test Org",
        limits: opts.licenseLimits ?? null,
        suspended: false,
        suspendedReason: null,
        ownerEmail: opts.ownerEmail ?? null,
        ...(opts.features ? { features: opts.features } : {}),
        ...(opts.licenseOverrides ?? {}),
      }),
      getModelGateway: () => (opts.gateway ? { defaultModel: null, ...opts.gateway } : null),
      getOwnGateway: () => opts.ownGateway ?? null,
      getEntitlement: () => ({
        plan: "enterprise",
        maxUsers: null,
        maxAccountOwners: null,
        maxSubscribers: null,
        ...(opts.entitlement ?? {}),
      }),
      // isLicenseAdminEmail reads the module-internal currentLicense, which
      // is never populated in tests. Override it so the ownerEmail opt drives
      // admin detection (e.g. the PROMPTOWL_SIGN_IN_GATE=admin-only path).
      isLicenseAdminEmail: (email?: string | null) =>
        !!opts.ownerEmail &&
        !!email &&
        opts.ownerEmail.toLowerCase() === email.toLowerCase(),
      // isLicenseAdminUserId in production calls the same-module
      // isLicenseAdminEmail directly, so the mock above doesn't reach it.
      // Override here too so resolveNestPermission/listSharedNests see the
      // test user as license admin.
      isLicenseAdminUserId: async (userId?: string | null) => {
        if (!opts.ownerEmail || !userId) return false;
        try {
          const row = (await dbClient
            .getDb()
            .get("SELECT email FROM users WHERE id = ?", [userId])) as
            | { email?: string }
            | undefined;
          return (
            !!row?.email &&
            row.email.toLowerCase() === opts.ownerEmail.toLowerCase()
          );
        } catch {
          return false;
        }
      },
    };
  });
  // Open the DB on the freshly-reset module graph the app will use.
  {
    const dbClient = await import("../src/db/client.js");
    await dbClient.resetDb();
    await dbClient.initDb();
    // Mirror index.ts startup: load DB-granted superadmins into the sync
    // isSuperAdmin() cache (post-reset module instance = the one the app uses).
    const access = await import("../src/governance/access-service.js");
    await access.loadGrantedSuperAdmins();
    // Mirror index.ts startup: load active community sites into the sync
    // cache GET /auth/sso reads (post-reset module instance).
    const communitySites = await import("../src/auth/community-sites.js");
    await communitySites.loadActiveCommunitySites();
  }
  const { createApp } = await import("../src/app.js");

  // Managing the steward roster (sync/list/assign) is server-admin only.
  // The license mock has no ownerEmail, so grant super-admin via access.yaml
  // and load it into the freshly-imported access-service instance.
  if (opts.superAdmins?.length) {
    writeFileSync(
      join(process.env.DATA_ROOT!, "access.yaml"),
      "super_admins:\n" +
        opts.superAdmins.map((e) => `  - ${e}`).join("\n") +
        "\n",
    );
    const access = await import("../src/governance/access-service.js");
    access.loadAccessConfig();
  }

  return createApp();
}

/**
 * Insert `count` plain people straight into the users table — the head-count
 * the Free tier measures (auth/free-tier.ts). Call AFTER the app's DB is open
 * (createTestApp, or a hand-built app after initDb): the dynamic import picks
 * up the same post-resetModules db/client instance the app uses.
 */
export async function seedPeople(count: number, prefix = "person") {
  const { getDb } = await import("../src/db/client.js");
  for (let i = 0; i < count; i++) {
    await getDb().run(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
      [randomUUID(), `${prefix}-${randomUUID()}@example.com`, null, "x"],
    );
  }
}

/** Register a user and return their API key + user ID.
 *
 * Note: `/auth/register` only opens a browser session — it deliberately
 * doesn't mint an external Bearer API key anymore (see src/auth/routes.ts
 * around line 136). The test pipeline needs Bearer tokens for every
 * subsequent request, so we mint a key explicitly via `/auth/keys` right
 * after registration, using the session cookie that registration set.
 */
export async function registerUser(
  app: any,
  email: string,
  name: string = email.split("@")[0],
) {
  const registerRes = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass", name }),
  });
  const registerData = await registerRes.json();
  const sessionCookie = registerRes.headers.get("set-cookie") || "";

  const keyRes = await app.request("/auth/keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Replay the session cookie that registration just set, so the
      // /auth/keys route authenticates the request as this user.
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ label: "test" }),
  });
  const keyData = await keyRes.json();

  return {
    apiKey: keyData.api_key as string,
    userId: registerData.user.id as string,
    email,
  };
}

/** Shorthand for authenticated requests */
export function authed(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` };
}

/** Make a JSON request */
export async function jsonRequest(
  app: any,
  method: string,
  path: string,
  body?: any,
  apiKey?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await app.request(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
