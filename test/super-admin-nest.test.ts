/**
 * CU-wdqcpztgwj — org-wide super-admin. A server super-admin (access.yaml
 * `super_admins`) should be able to administer EVERY nest's visibility and
 * collaborators — matching the documented "always allowed on every nest" —
 * not only anon-owned nests. Previously resolveNestPermission ignored
 * super_admins entirely for nests owned by a different real user, so the
 * admin fell through to read/none and got 403/404 on those actions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
  registerUser,
  resetAuthRateLimit,
} from "./helpers";

describe("governance: org super-admin over nest visibility + collaborators", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let admin: { apiKey: string; userId: string };
  let owner: { apiKey: string; userId: string };
  let outsider: { apiKey: string; userId: string };
  let nobody: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["admin@acme.com"] });
    // 4 registrations from one IP exceeds the auth rate limit — reset between.
    admin = await registerUser(app, "admin@acme.com", "Admin");
    await resetAuthRateLimit();
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    outsider = await registerUser(app, "outsider@acme.com", "Outsider");
    await resetAuthRateLimit();
    nobody = await registerUser(app, "nobody@acme.com", "Nobody");

    // A nest owned by a DIFFERENT real user, kept private.
    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Owner's Private Nest" },
      owner.apiKey,
    );
    nestId = data.nest.id;
  });

  afterAll(() => env.cleanup());

  it("super-admin can change visibility on another user's nest", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public" },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.visibility).toBe("public");
  });

  it("super-admin can manage collaborators on another user's nest", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "outsider@acme.com", permission: "write" },
      admin.apiKey,
    );
    expect(res.status).toBe(201);
  });

  it("a non-super-admin with no grant still cannot administer the nest", async () => {
    // Reset to private (as the owner) so a non-collaborator has no read path.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "private" },
      owner.apiKey,
    );
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public" },
      nobody.apiKey,
    );
    expect(res.status).toBe(404);
  });
});
