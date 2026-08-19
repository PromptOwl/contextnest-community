/**
 * Publish — gated public hosting of a single document at /p/<slug>.
 *
 * Covers the security-critical properties: only an owner/admin can publish;
 * a public link serves the document with no auth; a code-gated link shows a
 * gate and refuses the wrong code but opens on the right one; a revoked link
 * stops working; and every served view is logged for the owner.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Showcase" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Deck One", content: "# hello world deck" },
    owner.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("publish management", () => {
  it("owner publishes a document as a public link", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.publish.access_mode).toBe("public");
    expect(res.data.publish.slug).toBeTruthy();
    expect(res.data.link).toContain(`/p/${res.data.publish.slug}`);
  });

  it("a non-admin cannot publish", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      outsider.apiKey,
    );
    expect([403, 404]).toContain(res.status);
  });

  it("rejects an unsafe node id", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "../other/secret", access_mode: "public" },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
  });
});

describe("public render", () => {
  it("serves the document at /p/<slug> with no auth", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;
    const res = await app.request(`/p/${slug}`); // no Authorization header
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("hello world deck");
  });

  it("404s an unknown slug", async () => {
    const res = await app.request("/p/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("logs a view the owner can see", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    const id = created.data.publish.id;
    const slug = created.data.publish.slug;
    await app.request(`/p/${slug}`);
    const views = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/publications/${id}/views`,
      undefined,
      owner.apiKey,
    );
    expect(views.status).toBe(200);
    expect(views.data.count).toBeGreaterThanOrEqual(1);
  });
});

describe("code gate", () => {
  it("shows a gate, refuses a wrong code, and opens on the right one", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "code", code: "swordfish" },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;

    // Bare GET → the gate form, not the content.
    const gate = await app.request(`/p/${slug}`);
    expect(gate.status).toBe(200);
    const gateHtml = await gate.text();
    expect(gateHtml).toContain('name="code"');
    expect(gateHtml).not.toContain("hello world deck");

    // Wrong code → 401.
    const bad = await app.request(`/p/${slug}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=wrong",
    });
    expect(bad.status).toBe(401);

    // Right code → redirect + a scoped session cookie.
    const good = await app.request(`/p/${slug}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=swordfish",
    });
    expect([302, 303]).toContain(good.status);
    const cookie = good.headers.get("set-cookie") || "";
    expect(cookie).toContain(`cnp_${slug}=`);

    // Replaying the cookie unlocks the content.
    const opened = await app.request(`/p/${slug}`, {
      headers: { Cookie: cookie.split(";")[0] },
    });
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain("hello world deck");
  });
});

describe("email gate", () => {
  it("asks for an email instead of serving content", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "email" },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;
    const gate = await app.request(`/p/${slug}`);
    const html = await gate.text();
    expect(html).toContain('name="email"');
    expect(html).not.toContain("hello world deck");
  });
});

describe("revoke", () => {
  it("stops serving a revoked link", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    const { id, slug } = created.data.publish;
    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/publications/${id}`,
      undefined,
      owner.apiKey,
    );
    expect(del.status).toBe(200);
    const res = await app.request(`/p/${slug}`);
    expect(res.status).toBe(404);
  });
});
