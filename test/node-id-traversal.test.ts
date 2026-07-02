/**
 * SECURITY regression: node ids become filesystem paths in the storage layer,
 * so a `../` id must never let a caller reach another nest's files. Guards the
 * live GET/PATCH/DELETE/revert node routes (pre-existing flaw, not gated).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let bob: { apiKey: string; userId: string; email: string };
let aliceNest: string;
let bobNest: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  bob = await registerUser(app, "bob@acme.com", "Bob");
  const an = await jsonRequest(app, "POST", "/nests", { name: "Alice Nest" }, alice.apiKey);
  aliceNest = an.data.nest.id;
  const bn = await jsonRequest(app, "POST", "/nests", { name: "Bob Nest" }, bob.apiKey);
  bobNest = bn.data.nest.id;
  // Bob's private secret doc.
  await jsonRequest(
    app,
    "POST",
    `/nests/${bobNest}/nodes`,
    { title: "Secret", content: "# TOP SECRET bob-only content" },
    bob.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("node-id path traversal", () => {
  const evilIds = [
    `..%2F${""}`, // filled per-test below
  ];

  it("GET cannot escape the caller's nest to read another tenant's doc", async () => {
    // alice, scoped to her own nest, tries to reach bob's secret via ../
    const target = `..%2F${bobNest}%2Fnodes%2Fsecret`;
    const res = await app.request(`/nests/${aliceNest}/nodes/${target}`, {
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toMatch(/invalid node id/i);
    expect(text).not.toContain("TOP SECRET");
  });

  it("blocks traversal variants (double-encoded, nested, absolute)", async () => {
    for (const evil of [
      `nodes%2F..%2F..%2F${bobNest}%2Fnodes%2Fsecret`,
      `%252e%252e%2f${bobNest}%2fnodes%2fsecret`,
      `%2Fetc%2Fpasswd`,
    ]) {
      const res = await app.request(`/nests/${aliceNest}/nodes/${evil}`, {
        headers: { Authorization: `Bearer ${alice.apiKey}` },
      });
      expect([400]).toContain(res.status);
      expect(await res.text()).not.toContain("TOP SECRET");
    }
  });

  it("DELETE and PATCH also reject traversal", async () => {
    const target = `..%2F${bobNest}%2Fnodes%2Fsecret`;
    const del = await app.request(`/nests/${aliceNest}/nodes/${target}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    expect(del.status).toBe(400);
    const patch = await app.request(`/nests/${aliceNest}/nodes/${target}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.apiKey}` },
      body: JSON.stringify({ content: "hacked" }),
    });
    expect(patch.status).toBe(400);
    // Bob's doc is intact.
    const check = await jsonRequest(app, "GET", `/nests/${bobNest}/nodes/nodes/secret`, undefined, bob.apiKey);
    expect(check.status).toBe(200);
    expect(check.data.node.content).toContain("TOP SECRET");
  });

  it("legitimate ids still work (guard doesn't over-block)", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${aliceNest}/nodes`,
      { title: "Normal Doc", content: "# ok" },
      alice.apiKey,
    );
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${aliceNest}/nodes/nodes/normal-doc`,
      undefined,
      alice.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.node.title).toBe("Normal Doc");
  });
});
