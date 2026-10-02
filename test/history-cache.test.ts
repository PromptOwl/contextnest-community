/**
 * Every approval publishes, and every publish seals a checkpoint that reads
 * every document's history. `withHistoryCache` (src/nodes/engine.ts) memoizes
 * that read. The risk is a checkpoint sealed from a stale history, so this
 * checks the sealed chain hashes against a fresh read from disk.
 */
import { it, expect } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

it("seals approval checkpoints from cached histories that match disk", async () => {
  const env = setupTestEnv();
  try {
    const app = await createTestApp("key");
    const owner = await registerUser(app, "owner@acme.com");
    const author = await registerUser(app, "author@acme.com");
    const reviewer = await registerUser(app, "reviewer@acme.com");
    const nestId = (await jsonRequest(app, "POST", "/nests", { name: "Hist" }, owner.apiKey)).data.nest.id;
    const call = (method: string, path: string, body: unknown, key: string) =>
      jsonRequest(app, method, `/nests/${nestId}${path}`, body, key);
    await call("PATCH", "/settings", { stewardship_enabled: true }, owner.apiKey);
    await call("POST", "/collaborators", { email: author.email, permission: "write" }, owner.apiKey);
    await call("POST", "/collaborators", { email: reviewer.email, permission: "read" }, owner.apiKey);
    await call("POST", "/stewards", { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] }, owner.apiKey);

    const create = async (title: string) =>
      (await call("POST", "/nodes", { title, content: `# ${title}` }, author.apiKey)).data.node.id as string;
    const approve = async (id: string) => {
      expect((await call("POST", `/nodes/${id}/submit-review`, { note: "r" }, author.apiKey)).status).toBeLessThan(300);
      expect((await call("POST", `/nodes/${id}/approve`, {}, reviewer.apiKey)).status).toBe(200);
    };
    const a = await create("Alpha");
    const b = await create("Beta");
    await approve(b); // warms the cache
    for (let i = 0; i < 2; i++) {
      // A's history changes after the cache is warm; each seal must see it.
      await call("PATCH", `/nodes/${a}`, { content: `# Alpha ${i}` }, author.apiKey);
      await approve(a);
    }

    const { engineCache } = await import("../src/nodes/engine.js");
    const { storage } = await engineCache.get(nestId);
    const fresh = await storage.findAllHistories(() => {}); // the callback bypasses the cache
    const last = (await storage.readCheckpointHistory())!.checkpoints.at(-1)!;
    expect(last.document_chain_hashes[a]).toBe(fresh.get(a)!.versions.at(-1)!.chain_hash);
    expect(last.document_chain_hashes[b]).toBe(fresh.get(b)!.versions.at(-1)!.chain_hash);
  } finally {
    env.cleanup();
  }
});
