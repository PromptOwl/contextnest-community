import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { resetDb } from "../src/db/client.js";
import { _reset as resetRateLimits } from "../src/shared/rate-limit.js";

/** Set up an isolated data directory for each test suite */
export function setupTestEnv() {
  // Reset the cached DB connection so each suite gets its own
  resetDb();
  // Clear rate-limiter state so auth-endpoint tests don't trip each other
  resetRateLimits();

  const testDir = join(process.cwd(), "data", `test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });

  process.env.DATA_ROOT = testDir;
  process.env.DATABASE_PATH = join(testDir, "test.db");
  process.env.PROMPTOWL_KEY = ""; // no license in tests
  // Tests don't have a real PromptOwl license, so the license gate in
  // app.ts would 503 every non-GET. The bypass env var short-circuits
  // that gate. See src/app.ts for the safety notes — production must
  // not set this.
  process.env.PROMPTOWL_DEV_LICENSE_BYPASS = "1";
  process.env.TELEMETRY_ENABLED = "false";

  return {
    dataDir: testDir,
    cleanup() {
      resetDb();
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Create the Hono app (must be called AFTER setupTestEnv sets env vars) */
export async function createTestApp(authMode: "open" | "key" = "open") {
  process.env.AUTH_MODE = authMode;
  const { createApp } = await import("../src/app.js");
  return createApp();
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
