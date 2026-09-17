/**
 * PATCH /auth/profile — a user renames themselves; the new name shows up on
 * /auth/admin-status, and an empty name clears it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
});

afterAll(() => env.cleanup());

describe("PATCH /auth/profile", () => {
  it("sets, reads back, and clears the display name", async () => {
    const user = await registerUser(app, "rename@example.com");

    let res = await jsonRequest(app, "PATCH", "/auth/profile", { name: "  Alan  " }, user.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.name).toBe("Alan");

    res = await jsonRequest(app, "GET", "/auth/admin-status", undefined, user.apiKey);
    expect(res.data.me.name).toBe("Alan");

    res = await jsonRequest(app, "PATCH", "/auth/profile", { name: "" }, user.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.name).toBeNull();
  });

  it("rejects a missing name, an overlong name, and anonymous callers", async () => {
    const user = await registerUser(app, "rename2@example.com");
    expect((await jsonRequest(app, "PATCH", "/auth/profile", {}, user.apiKey)).status).toBe(400);
    expect(
      (await jsonRequest(app, "PATCH", "/auth/profile", { name: "x".repeat(81) }, user.apiKey)).status,
    ).toBe(400);
    expect((await jsonRequest(app, "PATCH", "/auth/profile", { name: "Nope" })).status).toBe(401);
  });
});
