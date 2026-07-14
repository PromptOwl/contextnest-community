/**
 * Activity-trace retention: TRACE_RETENTION_DAYS drives the opportunistic
 * prune inside logTraceEvent (every PRUNE_EVERY inserts). 0 = keep forever
 * (prune skipped entirely); a custom value prunes rows older than the window.
 * Also covers the /admin/settings surface for the runtime override.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let admin: { apiKey: string; userId: string; email: string };
// Post-vi.resetModules() instances — the same module graph the app uses, so
// the module-level insert counter we drive is the one the prune check reads.
let trace: typeof import("../src/telemetry/trace-log.js");
let db: any;

// Mirrors PRUNE_EVERY in src/telemetry/trace-log.ts.
const PRUNE_EVERY = 500;

beforeAll(async () => {
  env = setupTestEnv();
  // ownerEmail makes admin@acme.com the license admin (adminSettingsAllowed),
  // so the /admin/settings tests below can GET/PATCH.
  app = await createTestApp("key", { ownerEmail: "admin@acme.com" });
  admin = await registerUser(app, "admin@acme.com", "Admin");
  trace = await import("../src/telemetry/trace-log.js");
  db = (await import("../src/db/client.js")).getDb();
});

afterAll(async () => {
  delete process.env.TRACE_RETENTION_DAYS;
  await env.cleanup();
});

async function insertRowAged(path: string, daysAgo: number) {
  await db.run(
    "INSERT INTO api_events (ts, kind, method, path, status) VALUES (?, 'api', 'GET', ?, 200)",
    [new Date(Date.now() - daysAgo * 86_400_000).toISOString(), path],
  );
}

async function countPath(path: string): Promise<number> {
  const row = (await db.get(
    "SELECT COUNT(*) AS n FROM api_events WHERE path = ?",
    [path],
  )) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Awaiting PRUNE_EVERY fresh inserts guarantees the prune check fires at
 *  least once, wherever the module-level counter currently stands. */
async function crossPruneThreshold() {
  for (let i = 0; i < PRUNE_EVERY; i++) {
    await trace.logTraceEvent({
      kind: "api",
      method: "GET",
      path: "/filler",
      status: 200,
    });
  }
}

describe("trace retention (TRACE_RETENTION_DAYS)", () => {
  it("0 keeps rows forever — pruning is skipped entirely", async () => {
    process.env.TRACE_RETENTION_DAYS = "0";
    await insertRowAged("/ancient-keep-forever", 400);
    await crossPruneThreshold();
    expect(await countPath("/ancient-keep-forever")).toBe(1);
  });

  it("a custom window prunes older rows and keeps newer ones", async () => {
    process.env.TRACE_RETENTION_DAYS = "2";
    await insertRowAged("/older-than-window", 3);
    await insertRowAged("/inside-window", 1);
    await crossPruneThreshold();
    expect(await countPath("/older-than-window")).toBe(0);
    expect(await countPath("/inside-window")).toBe(1);
  });
});

describe("trace retention via /admin/settings", () => {
  it("is exposed in GET /admin/settings", async () => {
    process.env.TRACE_RETENTION_DAYS = "2";
    const res = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.trace_retention_days).toBe(2);
  });

  it("PATCH persists a valid value and applies it live", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { trace_retention_days: 30 },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.settings.trace_retention_days).toBe(30);
    expect(process.env.TRACE_RETENTION_DAYS).toBe("30");
  });

  it("PATCH rejects an invalid value with a field error and applies nothing", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { trace_retention_days: -1 },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.fieldErrors.trace_retention_days).toBeTruthy();
    // Untouched — still the value the previous test set.
    expect(process.env.TRACE_RETENTION_DAYS).toBe("30");
  });

  it("PATCH null clears the override back to the default", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { trace_retention_days: null },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.settings.trace_retention_days).toBe(14);
    expect(process.env.TRACE_RETENTION_DAYS).toBeUndefined();
  });
});
