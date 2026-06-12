/**
 * Marketplace primitives — packs ARE nests. publish → browse → install →
 * metered consumption with pack attribution.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

// The license gate: createTestApp's helpers already mock a VALID test
// license (ownerEmail null → the caller is never the marketplace operator,
// so moderation paths stay exercised). The unlicensed 503 path flips the
// helpers' __TEST_LICENSE_INVALID__ global.

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let packNestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
  const created = await jsonRequest(app, "POST", "/nests", {
    name: "Author Pack Nest",
  });
  packNestId = created.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${packNestId}/nodes`, {
    title: "Pack Doc One",
    content: "# One\n\nfirst body",
    tags: ["alpha"],
  });
  await jsonRequest(app, "POST", `/nests/${packNestId}/nodes`, {
    title: "Pack Doc Two",
    content: "# Two\n\nsecond body links [[Pack Doc One]]",
    tags: ["beta"],
  });
});

afterAll(() => env.cleanup());

describe("marketplace publish → browse → install", () => {
  it("the whole marketplace 503s without a valid license", async () => {
    (globalThis as any).__TEST_LICENSE_INVALID__ = true;
    try {
      const browse = await jsonRequest(app, "GET", "/marketplace/packs");
      expect(browse.status).toBe(503);
      expect(browse.data.error).toBe("License required");
      const pub = await jsonRequest(
        app,
        "POST",
        `/marketplace/publish/${packNestId}`,
        { summary: "x" },
      );
      expect(pub.status).toBe(503);
    } finally {
      (globalThis as any).__TEST_LICENSE_INVALID__ = false;
    }
  });

  it("rejects publish without a summary", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/marketplace/publish/${packNestId}`,
      {},
    );
    expect(status).toBe(400);
  });

  it("publishes a nest as a priced pack — pending approval (caller isn't the marketplace operator)", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/marketplace/publish/${packNestId}`,
      {
        summary: "Two docs of pure value",
        version: "1.0.0",
        price_credits_install: 50,
        price_credits_per_call: 2,
      },
    );
    expect(status).toBe(200);
    expect(data.pack.price_credits_install).toBe(50);
    expect(data.pack.status).toBe("pending");
  });

  it("pending packs are NOT browsable and NOT installable", async () => {
    const browse = await jsonRequest(app, "GET", "/marketplace/packs");
    expect(browse.data.packs.find((p: any) => p.id === packNestId)).toBeUndefined();
    const install = await jsonRequest(
      app,
      "POST",
      `/marketplace/install/${packNestId}`,
      {},
    );
    expect(install.status).toBe(404);
  });

  it("moderation queue + review are operator-only (403 without the license admin)", async () => {
    const q = await jsonRequest(app, "GET", "/marketplace/pending");
    expect(q.status).toBe(403);
    const r = await jsonRequest(app, "POST", `/marketplace/review/${packNestId}`, {
      decision: "approved",
    });
    expect(r.status).toBe(403);
  });

  it("browse lists the pack with pricing + doc count once approved", async () => {
    // No license admin exists in tests — flip the moderation bit directly
    // (the operator-only review endpoint is asserted above).
    const { getDb } = await import("../src/db/client");
    const row = getDb()
      .prepare("SELECT pack_meta FROM nests WHERE id = ?")
      .get(packNestId) as { pack_meta: string };
    const meta = JSON.parse(row.pack_meta);
    meta.status = "approved";
    getDb()
      .prepare("UPDATE nests SET pack_meta = ? WHERE id = ?")
      .run(JSON.stringify(meta), packNestId);
    const { status, data } = await jsonRequest(app, "GET", "/marketplace/packs");
    expect(status).toBe(200);
    const pack = data.packs.find((p: any) => p.id === packNestId);
    expect(pack).toBeTruthy();
    expect(pack.summary).toBe("Two docs of pure value");
    expect(pack.price_credits_per_call).toBe(2);
    expect(pack.doc_count).toBe(2);
  });

  it("install copies docs into a fresh nest with pack provenance", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/marketplace/install/${packNestId}`,
      { name: "My Installed Copy" },
    );
    expect(status).toBe(201);
    expect(data.nest.installed_from_pack).toBe(packNestId);
    const docs = await jsonRequest(app, "GET", `/nests/${data.nest.id}/nodes`);
    const titles = docs.data.nodes.map((n: any) => n.title).sort();
    expect(titles).toEqual(["Pack Doc One", "Pack Doc Two"]);
  });

  it("consumption on an installed nest emits a meter event with pack attribution", async () => {
    const inst = await jsonRequest(
      app,
      "POST",
      `/marketplace/install/${packNestId}`,
      { name: "Metered Copy" },
    );
    const nestId = inst.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/context`, {
      prompt: "pack doc one",
      max_tokens: 1000,
    });
    // Meter rides telemetry_events — assert directly on the local store.
    const { getDb } = await import("../src/db/client");
    const rows = getDb()
      .prepare(
        "SELECT data_json FROM telemetry_events WHERE event = 'meter.context_call' ORDER BY id DESC LIMIT 5",
      )
      .all() as Array<{ data_json: string }>;
    const mine = rows
      .map((r) => JSON.parse(r.data_json))
      .find((d) => d.nest_id === nestId);
    expect(mine).toBeTruthy();
    expect(mine.pack_id).toBe(packNestId);
    expect(mine.price_credits_per_call).toBe(2);
  });

  it("install 404s for an unpublished nest", async () => {
    await jsonRequest(app, "POST", `/marketplace/unpublish/${packNestId}`, {});
    const { status } = await jsonRequest(
      app,
      "POST",
      `/marketplace/install/${packNestId}`,
      {},
    );
    expect(status).toBe(404);
  });
});
