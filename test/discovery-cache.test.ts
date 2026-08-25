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
