import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// Nest names are plain text (CU-wdqcq015xt). Markup must not reach storage —
// exports and email render some of these values unescaped.
describe("nest names are stored as plain text", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string };

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");
  });

  afterAll(() => env.cleanup());

  it("strips markup on create", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Research <b>Notes</b>" },
      alice.apiKey,
    );
    expect(status).toBe(201);
    expect(data.nest.name).toBe("Research Notes");
  });

  it("rejects a name that is only markup", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "<img src=x onerror=alert(1)>" },
      alice.apiKey,
    );
    expect(status).toBe(400);
  });

  it("strips markup on rename", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Plain Nest" },
      alice.apiKey,
    );
    const { status, data } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${created.data.nest.id}`,
      { name: "<b>Renamed</b> Nest" },
      alice.apiKey,
    );
    expect(status).toBe(200);
    expect(data.nest.name).toBe("Renamed Nest");
  });
});
