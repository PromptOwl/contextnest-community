import { describe, it, expect, beforeEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

beforeEach(() => setupTestEnv());

/**
 * Discovery reads every markdown file in the nest, so it is cached per nest
 * (see DISCOVERY_TTL_MS in src/nodes/engine.ts). The risk a cache adds is
 * serving a document set that a write already invalidated — that is what these
 * cover, not the speedup.
 */
describe("document discovery cache", () => {
  it("serves a write made through the API, not the pre-write document set", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "cache@example.com");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Cache" }, user.apiKey);
    const nestId = nest.data.nest.id;

    // Populate the cache.
    const before = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, user.apiKey);
    const countBefore = before.data.count;

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Fresh Doc", content: "# Fresh Doc\n\nbody" },
      user.apiKey,
    );

    // Same TTL window as the read above — only invalidation can make this pass.
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, user.apiKey);
    expect(after.data.count).toBe(countBefore + 1);
    expect(after.data.nodes.some((n: any) => n.title === "Fresh Doc")).toBe(true);
  });

  /**
   * A write used to clear the whole set, so the next reader re-crawled the
   * nest — and one MCP create asks for the set three times. On a Cloud Storage
   * mount that is a round trip per document, which is what pushed writes past
   * the MCP client's 60s timeout on a 500-node nest. Writes now fold the one
   * changed document into the cached set instead.
   */
  it("folds a write into the cached set instead of re-crawling", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "crawl@example.com");

    const engineMod = await import("@promptowl/contextnest-engine");
    let crawls = 0;
    const realDiscover = (engineMod.NestStorage.prototype as any).discoverDocuments;
    (engineMod.NestStorage.prototype as any).discoverDocuments = function (...a: any[]) {
      crawls++;
      return realDiscover.apply(this, a);
    };

    try {
      const nest = await jsonRequest(app, "POST", "/nests", { name: "Crawl" }, user.apiKey);
      const nestId = nest.data.nest.id;
      const { engineCache } = await import("../src/nodes/engine.js");
      const { storage } = await engineCache.get(nestId);

      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Warm Doc", content: "# Warm Doc\n\nbody" },
        user.apiKey,
      );
      await storage.discoverDocuments();

      crawls = 0;
      const created = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Second Doc", content: "# Second Doc\n\nbody" },
        user.apiKey,
      );
      expect(created.status).toBe(201);

      const docs = await storage.discoverDocuments();
      expect(docs.map((d) => d.id)).toContain("nodes/second-doc");
      // Sorted, as a real crawl returns them — callers page off this order.
      expect(docs.map((d) => d.id)).toEqual([...docs.map((d) => d.id)].sort());
      expect(crawls).toBe(0);

      await jsonRequest(
        app,
        "DELETE",
        `/nests/${nestId}/nodes/${encodeURIComponent("nodes/second-doc")}`,
        undefined,
        user.apiKey,
      );
      const after = await storage.discoverDocuments();
      expect(after.map((d) => d.id)).not.toContain("nodes/second-doc");
      expect(crawls).toBe(0);
    } finally {
      (engineMod.NestStorage.prototype as any).discoverDocuments = realDiscover;
    }
  });

  /**
   * Folding a write in means reading the one document back. On a network mount
   * that read can fail transiently — and "unreadable" must not be mistaken for
   * "deleted", or a document would vanish from every listing for the rest of
   * the TTL immediately after being created.
   */
  it("re-crawls instead of dropping a document whose read-back fails", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "readfail@example.com");

    const engineMod = await import("@promptowl/contextnest-engine");
    let crawls = 0;
    let armed = false;
    let failNextRead = false;
    const realDiscover = (engineMod.NestStorage.prototype as any).discoverDocuments;
    const realRead = (engineMod.NestStorage.prototype as any).readDocument;
    const realWrite = (engineMod.NestStorage.prototype as any).writeDocument;
    (engineMod.NestStorage.prototype as any).discoverDocuments = function (...a: any[]) {
      crawls++;
      return realDiscover.apply(this, a);
    };
    // Fail the read-back that immediately follows a write — the one the cache
    // does to fold the new document in — and nothing else.
    (engineMod.NestStorage.prototype as any).writeDocument = async function (...a: any[]) {
      const out = await realWrite.apply(this, a);
      if (armed) failNextRead = true;
      return out;
    };
    (engineMod.NestStorage.prototype as any).readDocument = function (...a: any[]) {
      // Not DocumentNotFoundError — a mount hiccup, which says nothing about
      // whether the document is there.
      if (failNextRead) {
        failNextRead = false;
        return Promise.reject(new Error("EIO: read failed"));
      }
      return realRead.apply(this, a);
    };

    try {
      const nest = await jsonRequest(app, "POST", "/nests", { name: "ReadFail" }, user.apiKey);
      const nestId = nest.data.nest.id;
      const { engineCache } = await import("../src/nodes/engine.js");
      const { storage } = await engineCache.get(nestId);
      await storage.discoverDocuments();

      armed = true;
      // The create writes the document; the cache's read-back of it fails.
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Flaky Doc", content: "# Flaky Doc\n\nbody" },
        user.apiKey,
      ).catch(() => null);
      armed = false;
      failNextRead = false;

      // Treating the failed read as a delete dropped the document from the
      // cached set, and the rest of the create then read that set back — so
      // the document stayed missing from every listing until the TTL expired.
      const docs = await storage.discoverDocuments();
      expect(docs.map((d) => d.id)).toContain("nodes/flaky-doc");
    } finally {
      (engineMod.NestStorage.prototype as any).discoverDocuments = realDiscover;
      (engineMod.NestStorage.prototype as any).readDocument = realRead;
      (engineMod.NestStorage.prototype as any).writeDocument = realWrite;
    }
  });

  it("stops listing a document once it is deleted", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "cache2@example.com");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Cache2" }, user.apiKey);
    const nestId = nest.data.nest.id;

    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Doomed Doc", content: "# Doomed Doc\n\nbody" },
      user.apiKey,
    );
    const nodeId = created.data.node.id;

    // Warm the cache with the document present.
    const listed = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, user.apiKey);
    expect(listed.data.nodes.some((n: any) => n.id === nodeId)).toBe(true);

    await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/${encodeURIComponent(nodeId)}`,
      undefined,
      user.apiKey,
    );

    const after = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, user.apiKey);
    expect(after.data.nodes.some((n: any) => n.id === nodeId)).toBe(false);
  });
});
