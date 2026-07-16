import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

describe("PATCH /nests/:nestId", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string };
  let bob: { apiKey: string; userId: string };
  let aliceNestId: string;
  let bobCollabId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");
    bob = await registerUser(app, "bob@test.com", "Bob");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Original Name" },
      alice.apiKey,
    );
    aliceNestId = data.nest.id;
  });

  afterAll(() => env.cleanup());

  it("renames the nest, recomputes the slug", async () => {
    const { status, data } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${aliceNestId}`,
      { name: "Renamed Nest" },
      alice.apiKey,
    );
    expect(status).toBe(200);
    expect(data.nest.name).toBe("Renamed Nest");
    expect(data.nest.slug).toBe("renamed-nest");
  });

  it("updates the description independently of the name", async () => {
    const { status, data } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${aliceNestId}`,
      { description: "New description" },
      alice.apiKey,
    );
    expect(status).toBe(200);
    expect(data.nest.description).toBe("New description");
    expect(data.nest.name).toBe("Renamed Nest");
  });

  it("rejects empty names", async () => {
    const { status } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${aliceNestId}`,
      { name: "   " },
      alice.apiKey,
    );
    expect(status).toBe(400);
  });

  it("rejects a name whose slug collides with another nest from the same owner", async () => {
    const create = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Second" },
      alice.apiKey,
    );
    expect(create.status).toBe(201);
    const { status } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${create.data.nest.id}`,
      { name: "Renamed Nest" },
      alice.apiKey,
    );
    expect(status).toBe(400);
  });

  it("blocks non-owners (and non-admins) from renaming", async () => {
    const { status } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${aliceNestId}`,
      { name: "Hijacked" },
      bob.apiKey,
    );
    // Bob cannot see Alice's private nest at all → 404 is the right answer,
    // and matches how every other nest-scoped route behaves.
    expect(status).toBe(404);
  });

  it("403s a write collaborator (visible but below owner/admin)", async () => {
    const share = await jsonRequest(
      app,
      "POST",
      `/nests/${aliceNestId}/collaborators`,
      { email: "bob@test.com", permission: "write" },
      alice.apiKey,
    );
    expect(share.status).toBe(201);
    bobCollabId = share.data.collaborator.id;
    const { status, data } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${aliceNestId}`,
      { name: "Hijacked By Editor" },
      bob.apiKey,
    );
    // Bob can now SEE the nest, so this exercises the real ForbiddenError
    // branch (owner/admin-only) rather than the 404 invisibility path.
    expect(status).toBe(403);
    expect(String(data.error ?? "")).toMatch(/owner or an admin/i);
  });

  it("allows a nest-admin collaborator to rename", async () => {
    const upgrade = await jsonRequest(
      app,
      "PATCH",
      `/nests/${aliceNestId}/collaborators/${bobCollabId}`,
      { permission: "admin" },
      alice.apiKey,
    );
    expect(upgrade.status).toBe(200);
    const { status, data } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${aliceNestId}`,
      { name: "Admin Renamed" },
      bob.apiKey,
    );
    expect(status).toBe(200);
    expect(data.nest.name).toBe("Admin Renamed");
    expect(data.nest.slug).toBe("admin-renamed");
  });
});
