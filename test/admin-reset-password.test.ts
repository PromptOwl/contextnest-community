/**
 * POST /auth/admin/reset-password/:userId — admin in-platform password reset.
 * Security: only the license-admin user may call it.
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

describe("POST /auth/admin/reset-password/:userId", () => {
  it("denies a caller who is not the license admin", async () => {
    // No license installed in tests → nobody is admin → must be rejected.
    const { status } = await jsonRequest(
      app,
      "POST",
      "/auth/admin/reset-password/some-user-id",
      {},
    );
    expect([401, 403]).toContain(status);
  });
});
