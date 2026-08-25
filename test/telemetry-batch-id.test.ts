import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestEnv } from "./helpers.js";
import { computeBatchId, flushTelemetry } from "../src/telemetry/tracker.js";
import { getDb } from "../src/db/client.js";

describe("computeBatchId", () => {
  it("is deterministic for the same id set", () => {
    expect(computeBatchId([3, 1, 2])).toBe(computeBatchId([1, 2, 3]));
  });

  it("differs when ids differ", () => {
    expect(computeBatchId([1, 2])).not.toBe(computeBatchId([1, 2, 3]));
  });

  it("matches server validation regex (1-64 chars, A-Za-z0-9_-)", () => {
    expect(computeBatchId([1, 2, 3])).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("flushTelemetry batch_id", () => {
  let env: ReturnType<typeof setupTestEnv>;
  const fetchMock = vi.fn();

  beforeEach(() => {
    env = setupTestEnv();
    // Enable telemetry + supply a license key so flush actually POSTs.
    process.env.TELEMETRY_ENABLED = "true";
    process.env.PROMPTOWL_KEY = "pk_test";
    // First getDb() call inside the suite runs the schema migrations.
    getDb();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    env.cleanup();
  });

  async function insertEvent(name: string): Promise<number> {
    const db = getDb();
    await db.run(
      "INSERT INTO telemetry_events (event, data_json) VALUES (?, NULL)",
      [name],
    );
    const row = (await db.get(
      "SELECT id FROM telemetry_events ORDER BY id DESC LIMIT 1",
    )) as { id: number };
    return row.id;
  }

  function lastPayload(): { batch_id: string; events: unknown[] } {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return JSON.parse(call[1].body);
  }

  it("sends the same batch_id when the same pending set is flushed twice", async () => {
    await insertEvent("nest.create");
    await insertEvent("node.create");

    // First flush — server returns 500 so events stay pending (no sent=1).
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "x" });
    await flushTelemetry();
    const first = lastPayload().batch_id;

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "x" });
    await flushTelemetry();
    const second = lastPayload().batch_id;

    expect(first).toBe(second);
  });

  it("sends a different batch_id when a new event is added", async () => {
    await insertEvent("nest.create");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "x" });
    await flushTelemetry();
    const before = lastPayload().batch_id;

    await insertEvent("node.create");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "x" });
    await flushTelemetry();
    const after = lastPayload().batch_id;

    expect(after).not.toBe(before);
  });
});
