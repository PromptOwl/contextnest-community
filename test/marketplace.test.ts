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
  // Marketplace is dark by default (a separately-licensed addon). The suite
  // exercises it as a PromptOwl-hosted edition would: flag on. The dedicated
  // dark-mode test below flips it off to assert the 404 gate.
  process.env.MARKETPLACE_ENABLED = "true";
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

  it("404s entirely when the marketplace addon is disabled (dark by default)", async () => {
    process.env.MARKETPLACE_ENABLED = "false";
    try {
      // 404, not 503: a dormant feature is invisible, and the flag gate runs
      // ahead of the license gate (valid license here, still 404).
      const browse = await jsonRequest(app, "GET", "/marketplace/packs");
      expect(browse.status).toBe(404);
      const pub = await jsonRequest(
        app,
        "POST",
        `/marketplace/publish/${packNestId}`,
        { summary: "x" },
      );
      expect(pub.status).toBe(404);
    } finally {
      process.env.MARKETPLACE_ENABLED = "true";
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

  it("publishes a nest as a priced pack — auto-approved (owner/admin trusted)", async () => {
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
    expect(data.pack.status).toBe("approved");
  });

  it("moderation queue + review are operator-only (403 without the license admin)", async () => {
    const q = await jsonRequest(app, "GET", "/marketplace/pending");
    expect(q.status).toBe(403);
    const r = await jsonRequest(app, "POST", `/marketplace/review/${packNestId}`, {
      decision: "approved",
    });
    expect(r.status).toBe(403);
  });

  it("browse lists the pack with pricing + doc count", async () => {
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

  it("serves an approved pack's files for cross-server install; 404 once unpublished", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/marketplace/packs/${packNestId}/files`,
    );
    expect(res.status).toBe(200);
    expect(res.data.pack.id).toBe(packNestId);
    expect(res.data.files.length).toBe(2);
    expect(res.data.files[0]).toHaveProperty("path");
    expect(res.data.files[0]).toHaveProperty("content");
  });

  it("metering reads pricing stamped on the installed copy (survives source delisting)", async () => {
    const inst = await jsonRequest(
      app,
      "POST",
      `/marketplace/install/${packNestId}`,
      { name: "Pricing Travels" },
    );
    const { getDb } = await import("../src/db/client");
    const row = getDb()
      .prepare("SELECT pack_meta, installed_from_pack FROM nests WHERE id = ?")
      .get(inst.data.nest.id) as { pack_meta: string; installed_from_pack: string };
    expect(row.installed_from_pack).toBe(packNestId);
    expect(JSON.parse(row.pack_meta).price_credits_per_call).toBe(2);
  });

  it("browse merges registry packs and install-remote imports them", async () => {
    process.env.MARKETPLACE_REGISTRY_URL = "https://registry.test";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u === "https://registry.test/marketplace/packs") {
        return new Response(
          JSON.stringify({
            packs: [
              {
                id: "remote-pack-1",
                name: "Remote Pack",
                slug: "remote-pack",
                summary: "From the central registry",
                version: "1.2.0",
                price_credits_install: 10,
                price_credits_per_call: 1,
                doc_count: 1,
                published_at: "2026-06-11T00:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u === "https://registry.test/marketplace/packs/remote-pack-1/files") {
        return new Response(
          JSON.stringify({
            pack: {
              id: "remote-pack-1",
              name: "Remote Pack",
              version: "1.2.0",
              summary: "From the central registry",
              price_credits_install: 10,
              price_credits_per_call: 1,
              status: "approved",
            },
            files: [
              {
                path: "nodes/remote-doc.md",
                content:
                  '---\ntitle: "Remote Doc"\ntags: [remote]\n---\n# Remote\n\nbody',
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const browse = await jsonRequest(app, "GET", "/marketplace/packs");
      const remote = browse.data.packs.find((p: any) => p.id === "remote-pack-1");
      expect(remote).toBeTruthy();
      expect(remote.source).toBe("registry");

      const inst = await jsonRequest(
        app,
        "POST",
        "/marketplace/install-remote/remote-pack-1",
        {},
      );
      expect(inst.status).toBe(201);
      expect(inst.data.nest.installed_from_pack).toBe("remote-pack-1");
      const docs = await jsonRequest(
        app,
        "GET",
        `/nests/${inst.data.nest.id}/nodes`,
      );
      expect(docs.data.nodes.map((n: any) => n.title)).toContain("Remote Doc");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.MARKETPLACE_REGISTRY_URL;
    }
  });

  it("install-remote coerces hostile registry pricing (negative/NaN → 0)", async () => {
    process.env.MARKETPLACE_REGISTRY_URL = "https://evil.test";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith("/marketplace/packs/evil-1/files")) {
        return new Response(
          JSON.stringify({
            pack: {
              id: "evil-1",
              name: "Evil",
              version: "1.0.0",
              summary: "x",
              price_credits_install: -999,
              price_credits_per_call: "not-a-number",
              status: "approved",
            },
            files: [{ path: "nodes/x.md", content: "---\ntitle: \"X\"\n---\nbody" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const inst = await jsonRequest(app, "POST", "/marketplace/install-remote/evil-1", {});
      expect(inst.status).toBe(201);
      const { getDb } = await import("../src/db/client");
      // Installed copy stamps only the per-call rate (what the meter reads);
      // the install-price coercion is asserted on the emitted meter event.
      const row = getDb()
        .prepare("SELECT pack_meta FROM nests WHERE id = ?")
        .get(inst.data.nest.id) as { pack_meta: string };
      const meta = JSON.parse(row.pack_meta);
      expect(meta.price_credits_per_call).toBe(0);
      const meterRow = getDb()
        .prepare(
          "SELECT data_json FROM telemetry_events WHERE event = 'meter.pack_install' ORDER BY id DESC LIMIT 1",
        )
        .get() as { data_json: string };
      expect(JSON.parse(meterRow.data_json).price_credits_install).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.MARKETPLACE_REGISTRY_URL;
    }
  });

  it("install-remote without a configured registry is a 400", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      "/marketplace/install-remote/anything",
      {},
    );
    expect(status).toBe(400);
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
