/**
 * "Sign in with Google" on the login page goes through PromptOwl's
 * community-sso route. /health exposes the target only when this server
 * accepts PromptOwl SSO tickets, so the button never dead-ends.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers.js";

afterEach(() => {
  delete process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
});

describe("/health promptowl_google_url", () => {
  it("is absent when no PromptOwl SSO secret is configured", async () => {
    setupTestEnv();
    const app = await createTestApp("key");
    const { data } = await jsonRequest(app, "GET", "/health");
    expect(data.promptowl_google_url).toBeUndefined();
  });

  it("points at PromptOwl community-sso when a secret is configured", async () => {
    setupTestEnv();
    process.env.OFFICIAL_COMMUNITY_SSO_SECRET = "s".repeat(32);
    const app = await createTestApp("key");
    const { data } = await jsonRequest(app, "GET", "/health");
    expect(data.promptowl_google_url).toMatch(
      /\/api\/auth\/community-sso\?provider=google$/,
    );
  });
});
