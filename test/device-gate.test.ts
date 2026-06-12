/**
 * PROMPTOWL_SIGN_IN_GATE enforced at the device-auth entry points. With the
 * gate "disabled", /auth/device and /auth/device/poll are blocked with 403
 * before any PromptOwl round-trip (closing the gap where a non-admin could
 * run the whole device flow and only be rejected at token exchange).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;

beforeAll(async () => {
  env = setupTestEnv();
  process.env.PROMPTOWL_SIGN_IN_GATE = "disabled";
  app = await createTestApp("open");
});

afterAll(() => {
  delete process.env.PROMPTOWL_SIGN_IN_GATE;
  env.cleanup();
});

describe("device-auth gate (disabled)", () => {
  it("blocks POST /auth/device with 403", async () => {
    const res = await app.request("/auth/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName: "x" }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.gate).toBe("disabled");
  });

  it("blocks GET /auth/device/poll with 403", async () => {
    const res = await app.request(
      "/auth/device/poll?code=abc&client_secret=def",
      { method: "GET" },
    );
    expect(res.status).toBe(403);
  });
});
