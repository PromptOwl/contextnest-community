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
    expect(data.error).toContain("API key");
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

    // Login
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bob@test.com", password: "testpass" }),
    });
    const loginData = await loginRes.json();
    expect(loginRes.status).toBe(200);
    expect(loginData.api_key).toMatch(/^cnst_/);
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
    // Create additional key
    const { status: createStatus, data: keyData } = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "ci-key" },
      alice.apiKey,
    );
    expect(createStatus).toBe(201);
    expect(keyData.api_key).toMatch(/^cnst_/);

    // List keys
    const { data: listData } = await jsonRequest(
      app,
      "GET",
      "/auth/keys",
      undefined,
      alice.apiKey,
    );
    expect(listData.keys.length).toBeGreaterThanOrEqual(2);

    // Delete key
    const ciKey = listData.keys.find(
      (k: any) => k.label === "ci-key",
    );
    const { status: delStatus } = await jsonRequest(
      app,
      "DELETE",
      `/auth/keys/${ciKey.id}`,
      undefined,
      alice.apiKey,
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
});
