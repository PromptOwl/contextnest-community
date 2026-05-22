import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

describe("key mode (auth required)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string };

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");
  });

  afterAll(() => env.cleanup());

  it("rejects requests without API key", async () => {
    const { status, data } = await jsonRequest(app, "GET", "/nests");
    expect(status).toBe(401);
    // flexAuthMiddleware emits "Missing or invalid credentials" — that's
    // the actual contract today. Earlier the message said "API key
    // required" but the wording moved to a generic phrase when cookie
    // sessions joined Bearer keys as a transport.
    expect(data.error.toLowerCase()).toMatch(/credentials|api key/);
  });

  it("accepts requests with valid API key", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      "/nests",
      undefined,
      alice.apiKey,
    );
    expect(status).toBe(200);
    expect(data.nests).toEqual([]);
  });

  it("can register and login", async () => {
    const bob = await registerUser(app, "bob@test.com", "Bob");
    expect(bob.apiKey).toMatch(/^cnst_/);

    // Login. The server now uses an httpOnly session cookie rather than
    // returning an api_key in the body — the cookie is the credential
    // for browser flows. External Bearer keys come from /auth/keys.
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bob@test.com", password: "testpass" }),
    });
    const loginData = await loginRes.json();
    expect(loginRes.status).toBe(200);
    expect(loginData.user?.email).toBe("bob@test.com");
    expect(loginRes.headers.get("set-cookie") || "").toMatch(/cnst_session=/);
  });

  it("rejects login with wrong password", async () => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@test.com", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("full nest lifecycle with auth", async () => {
    // Create
    const { status: createStatus, data: createData } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Alice Vault" },
      alice.apiKey,
    );
    expect(createStatus).toBe(201);
    const nestId = createData.nest.id;

    // Create node
    const { status: nodeStatus } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Hello", content: "World" },
      alice.apiKey,
    );
    expect(nodeStatus).toBe(201);

    // List nodes
    const { data: nodesData } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      alice.apiKey,
    );
    expect(nodesData.count).toBe(1);

    // Delete nest
    const { status: delStatus } = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}`,
      undefined,
      alice.apiKey,
    );
    expect(delStatus).toBe(200);
  });

  it("API key management", async () => {
    // The server now enforces a single api_key per user — POST /auth/keys
    // 409s when a key already exists; clients must rotate instead.
    // Alice's helper-minted key counts as the existing one, so we go
    // straight to rotate.
    const { status: rotateStatus, data: rotateData } = await jsonRequest(
      app,
      "POST",
      "/auth/keys/rotate",
      { label: "ci-key" },
      alice.apiKey,
    );
    expect(rotateStatus).toBe(200);
    expect(rotateData.api_key).toMatch(/^cnst_/);

    // List keys — should still be one (rotate is atomic delete+insert).
    // Use the freshly-rotated key since the old one is now invalid.
    const { data: listData } = await jsonRequest(
      app,
      "GET",
      "/auth/keys",
      undefined,
      rotateData.api_key,
    );
    expect(listData.keys.length).toBe(1);
    expect(listData.keys[0].label).toBe("ci-key");

    // Delete the key — leaves alice without external Bearer access for
    // any subsequent test; this is intentionally the last test in this
    // describe block.
    const { status: delStatus } = await jsonRequest(
      app,
      "DELETE",
      `/auth/keys/${listData.keys[0].id}`,
      undefined,
      rotateData.api_key,
    );
    expect(delStatus).toBe(200);
  });
});

describe("sharing in key mode", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let reader: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@test.com", "Owner");
    reader = await registerUser(app, "reader@test.com", "Reader");

    // Owner creates a nest
    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Shared Vault" },
      owner.apiKey,
    );
    nestId = data.nest.id;

    // Add a node
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Shared Doc", content: "Shared content" },
      owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("other user cannot access unshared nest", async () => {
    const { status } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      reader.apiKey,
    );
    expect(status).toBe(404);
  });

  it("owner can share with another user", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { user_id: reader.userId, permission: "read" },
      owner.apiKey,
    );
    expect(status).toBe(201);
  });

  it("shared user can now read", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      reader.apiKey,
    );
    expect(status).toBe(200);
    expect(data.count).toBe(1);
  });

  it("shared user with read permission cannot write", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Sneaky", content: "Should fail" },
      reader.apiKey,
    );
    expect(status).toBe(403);
  });

  it("owner can share by email (creates placeholder user)", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "newperson@test.com", permission: "write" },
      owner.apiKey,
    );
    expect(status).toBe(201);
    expect(data.collaborator.user_id).toBeTruthy();
  });

  it("public nest is readable by anyone", async () => {
    // Make it public
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public" },
      owner.apiKey,
    );

    // New user who has no explicit access
    const stranger = await registerUser(app, "stranger@test.com");
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      stranger.apiKey,
    );
    expect(status).toBe(200);
    expect(data.count).toBe(1);
  });

  // ── Per-vault public unauth read (CU-86ahmvmcu) ───────────────────
  // The existing "public nest is readable by anyone" above tests an
  // *authenticated* stranger. The product request is for genuinely
  // unauthenticated reads of public nests — direct-URL access without a
  // login. flexAuthMiddleware used to 401 every credential-less request
  // in key mode; these tests pin the new behavior.

  it("public nest sub-routes are readable WITHOUT any credentials", async () => {
    // Nest was already made public by the previous test. Hit it with no
    // Authorization header at all.
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      // no apiKey — fully anonymous
    );
    expect(status).toBe(200);
    expect(data.count).toBe(1);
  });

  it("private nest sub-routes 404 for unauthenticated callers", async () => {
    // Flip back to private and try again with no credentials.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "private" },
      owner.apiKey,
    );
    const { status } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
    );
    // 404 hides existence (not 401), matching the same behavior
    // authenticated-but-unauthorized callers get.
    expect(status).toBe(404);

    // Restore for any downstream assumptions.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public" },
      owner.apiKey,
    );
  });

  it("admin endpoints (/collaborators, /visibility) stay 401 for unauth even on public nests", async () => {
    const { status: collabStatus } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "intruder@test.com", permission: "admin" },
    );
    expect(collabStatus).toBe(401);

    const { status: visStatus } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "private" },
    );
    expect(visStatus).toBe(401);
  });

  it("GET /nests list still requires credentials (no anon discovery leak)", async () => {
    const { status } = await jsonRequest(app, "GET", "/nests");
    expect(status).toBe(401);
  });
});
