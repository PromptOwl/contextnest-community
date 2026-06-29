/**
 * Password validation — register + change-password must reject empty and
 * whitespace-only secrets (e.g. 8 spaces), which a naive length check lets
 * through.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
});

afterAll(() => env.cleanup());

describe("password validation", () => {
  it("rejects a whitespace-only password on register", async () => {
    const { status, data } = await jsonRequest(app, "POST", "/auth/register", {
      email: "ws-register@example.com",
      password: "        ", // 8 spaces — long enough, but empty in practice
      name: "WS",
    });
    expect(status).toBe(400);
    expect(String(data.error)).toMatch(/whitespace/i);
  });

  it("rejects a whitespace-only new password on change", async () => {
    const user = await registerUser(app, "ws-change@example.com");
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/auth/password",
      { current: "testpass", next: "        " },
      user.apiKey,
    );
    expect(status).toBe(400);
    expect(String(data.error)).toMatch(/whitespace/i);
  });

  it("still accepts a valid new password", async () => {
    const user = await registerUser(app, "ok-change@example.com");
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/auth/password",
      { current: "testpass", next: "newpass123" },
      user.apiKey,
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });
});
