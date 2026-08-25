/**
 * PROMPTOWL_SIGN_IN_GATE=admin-only — the ticket's headline behaviour.
 * Enforced at the identity point (POST /auth/promptowl, the token exchange):
 * the license owner (admin) may complete sign-in; any other PromptOwl account
 * is rejected with 403 so a non-admin can't auto-provision a user.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp } from "./helpers";

const OWNER_EMAIL = "owner@example.com";

let env: ReturnType<typeof setupTestEnv>;
let app: any;

/** Mock the PromptOwl /api/user/me round-trip so the token resolves to a
 *  chosen email without hitting the network. */
function mockPromptowlMe(email: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ user: { name: "X", email } }),
    })),
  );
}

beforeAll(async () => {
  env = setupTestEnv();
  process.env.PROMPTOWL_SIGN_IN_GATE = "admin-only";
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
});

afterAll(() => {
  delete process.env.PROMPTOWL_SIGN_IN_GATE;
  vi.unstubAllGlobals();
  env.cleanup();
});

describe("promptowl sign-in gate (admin-only)", () => {
  it("rejects a non-owner with 403", async () => {
    mockPromptowlMe("someone-else@example.com");
    const res = await app.request("/auth/promptowl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "tok" }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.gate).toBe("admin-only");
  });

  it("allows the license owner (admin) through", async () => {
    mockPromptowlMe(OWNER_EMAIL);
    const res = await app.request("/auth/promptowl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "tok" }),
    });
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(400);
  });
});
