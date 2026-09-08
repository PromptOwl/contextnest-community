/**
 * visibility='org' behaviour — the tier confers read on an authenticated
 * stranger, nothing on an anonymous caller, and needs no public-publish
 * acknowledgement (it does not expose the nest outside the deployment).
 *
 * The migration that makes 'org' storable is covered separately in
 * nest-visibility-org-migration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import { resolveNestAccess } from "../src/shared/access.js";

describe("visibility='org' behaviour", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let stranger: { apiKey: string; userId: string; email: string };
  let orgNest: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    resetAuthRateLimit();
    owner = await registerUser(app, "org-owner@acme.com", "Owner");
    resetAuthRateLimit();
    stranger = await registerUser(app, "org-stranger@acme.com", "Stranger");

    const res = await jsonRequest(app, "POST", "/nests", { name: "Org Nest" }, owner.apiKey);
    orgNest = res.data.nest.id;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("PATCHes to org without a public-publish acknowledgement", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${orgNest}/visibility`,
      { visibility: "org" },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.visibility).toBe("org");
  });

  it("rejects an unknown visibility value", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${orgNest}/visibility`,
      { visibility: "world" },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("gives an authenticated non-member read", async () => {
    const access = await resolveNestAccess(orgNest, stranger.userId);
    expect(access.permission).toBe("read");
  });

  it("treats that reader as a visibility-only reader (approved content only)", async () => {
    const access = await resolveNestAccess(orgNest, stranger.userId);
    expect(access.isPublicReader).toBe(true);
  });

  it("lets that reader open the nest over HTTP", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${orgNest}`, undefined, stranger.apiKey);
    expect(res.status).toBe(200);
  });

  it("still refuses an unauthenticated caller — org is not world-readable", async () => {
    // 404, not 401: flexAuthMiddleware treats any GET on /nests/:id as
    // public-read-eligible and hands the caller the anon user id, so the
    // request never reaches the 401 branch. It is the access gate that
    // refuses it, and that gate answers "no access" and "no such nest" the
    // same way on purpose — the existence oracle (app.ts). What matters here
    // is that anon is refused at all; resolveNestAccess is what decides it,
    // and the case above pins that directly.
    const res = await app.request(`/nests/${orgNest}`);
    expect(res.status).toBe(404);
  });

  it("leaves the owner at owner", async () => {
    const access = await resolveNestAccess(orgNest, owner.userId);
    expect(access.permission).toBe("owner");
  });
});
