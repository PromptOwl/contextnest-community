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

  it("serves a write to concurrent readers, not a crawl that predates it", async () => {
    // Identical crawls are collapsed into one shared promise, so a write has to
    // drop the in-flight one too — otherwise every reader that arrives after
    // the write joins a walk that started before it and misses the document.
    const app = await createTestApp("key");
    const user = await registerUser(app, "cache3@example.com");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Cache3" }, user.apiKey);
    const nestId = nest.data.nest.id;

    // Warm the cache, then read again in parallel with the write landing.
    await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, user.apiKey);
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Parallel Doc", content: "# Parallel Doc\n\nbody" },
      user.apiKey,
    );

    const reads = await Promise.all(
      Array.from({ length: 5 }, () =>
        jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, user.apiKey),
      ),
    );
    for (const r of reads) {
      expect(r.data.nodes.some((n: any) => n.title === "Parallel Doc")).toBe(true);
    }
  });
});
