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
});
