/**
 * GET/PATCH /admin/settings — the server-wide settings the admin edits from
 * the Settings page. This endpoint mutates process.env live and writes to
 * ENV_FILE_PATH, so it is security-sensitive: only the admin may reach it,
 * validation must reject bad values, and a partially-invalid PATCH must apply
 * nothing (the response code and server state must agree).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

const OWNER_EMAIL = "owner@example.com";

let env: ReturnType<typeof setupTestEnv>;

// process.env settings touched by these tests — cleared between cases so one
// test's mutation can't leak into the next.
const SETTING_ENV = [
  "PROMPTOWL_SIGN_IN_GATE",
  "LOGO_URL",
  "PUBLIC_BASE_URL",
  "MAX_BODY_BYTES",
];

beforeEach(() => {
  env = setupTestEnv();
  for (const k of SETTING_ENV) delete process.env[k];
});

afterEach(() => {
  for (const k of SETTING_ENV) delete process.env[k];
  env.cleanup();
});

describe("/admin/settings — access control (key mode)", () => {
  it("403s a non-admin on GET and PATCH", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const stranger = await registerUser(app, "stranger@example.com");

    const get = await jsonRequest(app, "GET", "/admin/settings", undefined, stranger.apiKey);
    expect(get.status).toBe(403);

    const patch = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { logo_url: "https://evil.example/x.png" },
      stranger.apiKey,
    );
    expect(patch.status).toBe(403);
  });

  it("401s an unauthenticated caller in key mode", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const res = await app.request("/admin/settings", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("allows the anonymous admin in open mode", async () => {
    const app = await createTestApp("open");
    const get = await jsonRequest(app, "GET", "/admin/settings");
    expect(get.status).toBe(200);
    expect(get.data.promptowl_sign_in_gate).toBe("open");
  });
});

describe("/admin/settings — admin round-trip (key mode)", () => {
  it("GET returns current settings and PATCH applies them live + persists", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const before = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(before.status).toBe(200);
    expect(before.data.promptowl_sign_in_gate).toBe("open");

    const patch = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      {
        promptowl_sign_in_gate: "admin-only",
        logo_url: "https://cdn.example/logo.png",
        public_base_url: "https://nest.example/",
        max_body_bytes: 20 * 1024 * 1024,
      },
      admin.apiKey,
    );
    expect(patch.status).toBe(200);
    // Response reflects the new values; trailing slash stripped on base URL.
    expect(patch.data.settings.promptowl_sign_in_gate).toBe("admin-only");
    expect(patch.data.settings.logo_url).toBe("https://cdn.example/logo.png");
    expect(patch.data.settings.public_base_url).toBe("https://nest.example");
    expect(patch.data.settings.max_body_bytes).toBe(20 * 1024 * 1024);

    // Live: a fresh GET (config getters read process.env) shows the new values.
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.promptowl_sign_in_gate).toBe("admin-only");
    expect(after.data.max_body_bytes).toBe(20 * 1024 * 1024);

    // Persisted: the env file under DATA_ROOT carries the change across restart.
    const envFile = join(env.dataDir, ".env");
    expect(existsSync(envFile)).toBe(true);
    const contents = readFileSync(envFile, "utf8");
    expect(contents).toMatch(/PROMPTOWL_SIGN_IN_GATE=admin-only/);
    expect(contents).toMatch(/MAX_BODY_BYTES=20971520/);
  });
});

describe("/admin/settings — validation", () => {
  it("rejects a bad sign-in gate value", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { promptowl_sign_in_gate: "nonsense" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/promptowl_sign_in_gate/);
  });

  it("rejects an out-of-range max_body_bytes", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const tooSmall = await jsonRequest(
      app, "PATCH", "/admin/settings", { max_body_bytes: 1024 }, admin.apiKey,
    );
    expect(tooSmall.status).toBe(400);

    const tooBig = await jsonRequest(
      app, "PATCH", "/admin/settings", { max_body_bytes: 999 * 1024 * 1024 }, admin.apiKey,
    );
    expect(tooBig.status).toBe(400);
  });

  it("applies NOTHING when one field of a multi-field PATCH is invalid", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    // logo_url is valid; promptowl_sign_in_gate is not. The whole request must
    // fail (400) and the valid field must NOT be applied or persisted.
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { logo_url: "https://cdn.example/logo.png", promptowl_sign_in_gate: "bogus" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);

    // Live state unchanged: logo_url still at its default (null).
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.logo_url).toBeNull();

    // Nothing persisted: env file either absent or free of LOGO_URL.
    const envFile = join(env.dataDir, ".env");
    if (existsSync(envFile)) {
      expect(readFileSync(envFile, "utf8")).not.toMatch(/LOGO_URL=/);
    }
  });
});
