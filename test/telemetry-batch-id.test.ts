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
    delete process.env.POSTHOG_KEY;
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

describe("flushTelemetry → PostHog", () => {
  let env: ReturnType<typeof setupTestEnv>;
  const fetchMock = vi.fn();

  beforeEach(() => {
    env = setupTestEnv();
    process.env.TELEMETRY_ENABLED = "true";
    process.env.PROMPTOWL_KEY = "pk_test";
    process.env.POSTHOG_KEY = "phc_test";
    delete process.env.POSTHOG_HOST;
    getDb();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    env.cleanup();
  });

  async function insertEvent(name: string, data?: unknown): Promise<void> {
    await getDb().run(
      "INSERT INTO telemetry_events (event, data_json) VALUES (?, ?)",
      [name, data ? JSON.stringify(data) : null],
    );
  }

  function posthogBody(): { api_key: string; batch: Array<Record<string, any>> } {
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("posthog"),
    );
    if (!call) throw new Error("PostHog was not called");
    return JSON.parse(call[1].body);
  }

  it("mirrors pending events and appends a heartbeat", async () => {
    await insertEvent("nest.create", { nestId: "n1" });
    await flushTelemetry();

    const { api_key, batch } = posthogBody();
    expect(api_key).toBe("phc_test");
    expect(batch.map((e) => e.event)).toEqual(["nest.create", "server.heartbeat"]);
    expect(batch[0].properties.nestId).toBe("n1");
    expect(batch[1].properties).toMatchObject({ users: 0, nests: 0 });
    // Same install, so both rows carry the same stable server id.
    expect(batch[0].properties.server_id).toBe(batch[1].properties.server_id);
  });

  it("never sends email addresses, and keys the event on the user id", async () => {
    await insertEvent("user.login", { userId: "u1", userEmail: "a@b.com" });
    await flushTelemetry();

    const [ev] = posthogBody().batch;
    expect(ev.distinct_id).toBe("u1");
    expect(JSON.stringify(ev)).not.toContain("a@b.com");
  });

  it("reuses the same event uuid across a retried batch so PostHog dedupes", async () => {
    await insertEvent("node.create");
    // PromptOwl 500 → events stay pending and the next flush resends them.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("posthog")
        ? { ok: true, status: 200, statusText: "OK" }
        : { ok: false, status: 500, statusText: "err" },
    );
    await flushTelemetry();
    const first = posthogBody().batch[0].uuid;
    fetchMock.mockClear();
    await flushTelemetry();
    expect(posthogBody().batch[0].uuid).toBe(first);
  });

  it("stays off when no project key is configured", async () => {
    delete process.env.POSTHOG_KEY;
    await insertEvent("nest.create");
    await flushTelemetry();
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("posthog")),
    ).toBe(false);
  });
});
