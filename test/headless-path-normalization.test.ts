/**
 * An access key must not reach a node sub-resource through an encoded or
 * oddly-shaped path the router still resolves (review on #341). Whatever
 * handler the router picks, the key must never get history back.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let key: string;
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  const owner = await registerUser(app, "owner@norm.test", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Norm" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Guide", content: "# Guide\n\nv1" }, owner.apiKey);
  await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/guide`, { content: "# Guide\n\nv2" }, owner.apiKey);
  await jsonRequest(app, "PUT", `/nests/${nestId}/headless`, { enabled: true }, owner.apiKey);
  key = (await jsonRequest(app, "POST", `/nests/${nestId}/headless/keys`, { label: "K" }, owner.apiKey)).data.api_key;
}, 30000);

afterAll(() => env.cleanup());

describe("encoded sub-resource paths", () => {
  for (const tail of [
    "nodes/guide/%76ersions",
    "nodes/guide/versions%2F1",
    "nodes/guide%2Fversions",
    "nodes/guide/VERSIONS",
    "nodes/guide//versions",
    "nodes/guide/versions/",
    "nodes/guide/./versions",
    "nodes/guide/%63omments",
  ]) {
    it(`never returns history or comments for ${tail}`, async () => {
      const res = await app.request(`/nests/${nestId}/nodes/${tail}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const body = await res.text();
      if (res.status === 200) {
        expect(body, tail).not.toMatch(/"versions"\s*:|"comments"\s*:/);
      }
    });
  }
});

describe("a service key that somehow lost its nest scope", () => {
  it("fails closed instead of falling back to a normal key", async () => {
    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    const { hashApiKey } = await import("../src/auth/keys.js");
    await db.run("UPDATE api_keys SET nest_id = NULL WHERE key_hash = ?", [hashApiKey(key)]);
    try {
      for (const [m, p] of [["POST", "/auth/keys"], ["GET", "/me/work"], ["POST", "/nests"]] as const) {
        const { status } = await jsonRequest(app, m, p, m === "POST" ? { label: "x", name: "x" } : undefined, key);
        expect(status, `${m} ${p}`).toBe(403);
      }
    } finally {
      await db.run("UPDATE api_keys SET nest_id = ? WHERE key_hash = ?", [nestId, hashApiKey(key)]);
    }
  });
});
