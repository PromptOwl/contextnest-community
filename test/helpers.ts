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

/** Register a user and return their API key + user ID */
export async function registerUser(
  app: any,
  email: string,
  name: string = email.split("@")[0],
) {
  const res = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass", name }),
  });
  const data = await res.json();
  return {
    apiKey: data.api_key as string,
    userId: data.user.id as string,
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
