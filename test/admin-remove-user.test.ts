/**
 * DELETE /auth/users/:userId — admin removes a user. Security: license-admin only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
});

afterAll(() => env.cleanup());

describe("DELETE /auth/users/:userId", () => {
  it("denies a caller who is not the license admin", async () => {
    const { status } = await jsonRequest(
      app,
      "DELETE",
      "/auth/users/some-user-id",
    );
    expect([401, 403]).toContain(status);
  });
});
