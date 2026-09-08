import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// Nest names are plain text (CU-wdqcq015xt). A tag is refused outright rather
// than stripped (CU-wdqcq01e6t): stripping ate legitimate "<…>" text and made
// two distinct names collide on one slug.
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

  it("rejects a name carrying markup on create", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Research <b>Notes</b>" },
      alice.apiKey,
    );
    expect(status).toBe(400);
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

  it("keeps angle-bracket text that is not a tag", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Roadmap <2026> plan" },
      alice.apiKey,
    );
    expect(status).toBe(201);
    expect(data.nest.name).toBe("Roadmap <2026> plan");
  });

  it("rejects markup on rename", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Plain Nest" },
      alice.apiKey,
    );
    const { status } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${created.data.nest.id}`,
      { name: "<b>Renamed</b> Nest" },
      alice.apiKey,
    );
    expect(status).toBe(400);
  });
});
