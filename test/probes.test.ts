/**
 * /livez and /readyz — public probes. Readiness needs the database and nest
 * storage; liveness only needs the process, so a database outage takes the
 * pod out of rotation without restarting it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers.js";

beforeEach(() => setupTestEnv());

describe("probes", () => {
  it("answers both without auth when everything is up", async () => {
    const app = await createTestApp("key");
    expect((await jsonRequest(app, "GET", "/livez")).status).toBe(200);
    const ready = await jsonRequest(app, "GET", "/readyz");
    expect(ready.status).toBe(200);
    expect(ready.data).toEqual({ status: "ok", checks: { db: true, storage: true } });
  });

  it("is not ready while the database is down, but stays live", async () => {
    const app = await createTestApp("key");
    // After createTestApp: it resets modules, so this is the app's own client.
    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    const down = vi.spyOn(db, "get").mockRejectedValue(new Error("connection refused"));
    try {
      const ready = await jsonRequest(app, "GET", "/readyz");
      expect(ready.status).toBe(503);
      expect(ready.data.checks).toEqual({ db: false, storage: true });
      expect((await jsonRequest(app, "GET", "/livez")).status).toBe(200);
    } finally {
      down.mockRestore();
    }
  });
});
