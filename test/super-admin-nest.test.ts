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
import { createNest } from "../src/nests/service.js";
import { ANON_USER_ID } from "../src/shared/constants.js";

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

  it("super-admin's GET /nests does NOT list another user's private nest", async () => {
    // Nest is private (last test reset it) and not shared with the admin.
    // Admin still ADMINISTERS it (direct-URL access resolves to 'admin'), but
    // it must not appear in their dashboard — governing a nest is not the same
    // as being shown someone else's private workspace.
    const res = await jsonRequest(app, "GET", "/nests", undefined, admin.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.nests.find((n: any) => n.id === nestId)).toBeUndefined();
  });

  it("super-admin still ACCESSES another user's private nest by direct URL", async () => {
    // Not listed, but still governable — GET /nests/:id resolves 'admin'.
    const res = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, admin.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.permission).toBe("admin");
  });

  it("super-admin DOES list an anon-owned (commons) nest, even when private", async () => {
    // The anon user isn't seeded in this key-mode test — insert the row so the
    // nest's user_id FK resolves.
    const { getDb } = await import("../src/db/client.js");
    await getDb().run(
      "INSERT OR IGNORE INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
      [ANON_USER_ID, "anonymous@local", "Anonymous", "x"],
    );
    // Seed a nest owned by the ANON user, then make it private so it can't
    // surface via public discovery — only the admin's anon-commons path does.
    const commons = await createNest(ANON_USER_ID, "Commons Nest");
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${commons.id}/visibility`,
      { visibility: "private" },
      admin.apiKey,
    );
    const adminRes = await jsonRequest(app, "GET", "/nests", undefined, admin.apiKey);
    expect(adminRes.data.nests.find((n: any) => n.id === commons.id)).toBeTruthy();
    // A plain user does NOT see a private commons nest.
    const nobodyRes = await jsonRequest(app, "GET", "/nests", undefined, nobody.apiKey);
    expect(nobodyRes.data.nests.find((n: any) => n.id === commons.id)).toBeUndefined();
  });

  it("non-super-admin's shared list does NOT include nests they have no grant on", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      "/nests",
      undefined,
      nobody.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.nests.find((n: any) => n.id === nestId)).toBeUndefined();
  });

  it("super-admin is not classified as a public reader on a public other-owned nest", async () => {
    // Flip to public so the public-reader path would otherwise apply, then
    // confirm isPublicReader returns false for the super-admin — they should
    // see drafts/pending like any admin, not be downgraded to approved-only.
    // Dynamic import: createTestApp's vi.resetModules invalidates any
    // top-level static binding, so import here to get the same module
    // instance the running app + access.yaml were loaded against.
    const { isPublicReader } = await import("../src/shared/access.js");
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public" },
      owner.apiKey,
    );
    expect(await isPublicReader(nestId, admin.userId)).toBe(false);
    // Sanity: a random user (no grant, not super-admin) still IS a public reader.
    expect(await isPublicReader(nestId, nobody.userId)).toBe(true);
  });
});

/**
 * Same governance scope, but for the LICENSE admin (PROMPTOWL_KEY owner) — the
 * default install's admin identity, with no access.yaml configured. The Share
 * dialog was 403/404-ing for license admins on other-owned nests because
 * resolveNestPermission only granted them 'owner' on anon-owned nests; for a
 * nest owned by a real user they fell through to read/none.
 */
describe("governance: license admin over nest visibility + collaborators", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let admin: { apiKey: string; userId: string };
  let owner: { apiKey: string; userId: string };
  let nobody: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    // ownerEmail makes isLicenseAdminEmail return true for admin@acme.com — no
    // access.yaml, so super_admins is empty and the only admin path is license.
    app = await createTestApp("key", { ownerEmail: "admin@acme.com" });
    admin = await registerUser(app, "admin@acme.com", "Admin");
    await resetAuthRateLimit();
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    nobody = await registerUser(app, "nobody@acme.com", "Nobody");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Owner's Nest" },
      owner.apiKey,
    );
    nestId = data.nest.id;
  });

  afterAll(() => env.cleanup());

  it("license admin can change visibility on another user's nest", async () => {
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

  it("license admin can manage collaborators on another user's nest", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "nobody@acme.com", permission: "read" },
      admin.apiKey,
    );
    expect(res.status).toBe(201);
  });

  it("license admin's GET /nests surfaces other users' nests with admin permission", async () => {
    const res = await jsonRequest(app, "GET", "/nests", undefined, admin.apiKey);
    expect(res.status).toBe(200);
    const row = res.data.nests.find((n: any) => n.id === nestId);
    expect(row).toBeTruthy();
    expect(row.is_owner).toBe(false);
    expect(row.permission).toBe("admin");
  });

  it("license admin is not classified as a public reader on a public other-owned nest", async () => {
    const { isPublicReader } = await import("../src/shared/access.js");
    // Already public from the visibility test above.
    expect(await isPublicReader(nestId, admin.userId)).toBe(false);
  });
});
