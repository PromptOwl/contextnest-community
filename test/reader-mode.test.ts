/**
 * Public Docs Reader Mode — PATCH /nests/:id/reader-mode (owner/admin-gated).
 *
 * Reader mode is a read-only public docs view of a nest. It may be configured
 * by the server admin (license admin OR access.yaml `super_admins` ∪ the
 * DB-granted set — the same gate as /nests/unsynced and /admin/*, and unlike
 * that gate, not narrowed to nests the admin owns) OR by the nest's own
 * owner/admin collaborator, matching the "admin" tier the access middleware
 * already requires for this resource. A write/read collaborator or an
 * anonymous caller stays refused.
 *
 * The two additive columns (`reader_mode`, `reader_home_node`) ride on the
 * `SELECT *` getNest, so GET /nests/:id reflects them straight off the row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
  registerUser,
  resetAuthRateLimit,
} from "./helpers";

describe("PATCH /nests/:id/reader-mode (owner/admin-gated)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let admin: { apiKey: string; userId: string; email: string };
  let owner: { apiKey: string; userId: string; email: string };
  let nestAdmin: { apiKey: string; userId: string; email: string };
  let writer: { apiKey: string; userId: string; email: string };
  let reader: { apiKey: string; userId: string; email: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["admin@acme.com"] });
    admin = await registerUser(app, "admin@acme.com", "Admin");
    await resetAuthRateLimit();
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    nestAdmin = await registerUser(app, "nest-admin@acme.com", "Nest Admin");
    await resetAuthRateLimit();
    writer = await registerUser(app, "writer@acme.com", "Writer");
    await resetAuthRateLimit();
    reader = await registerUser(app, "reader@acme.com", "Reader");

    // A nest owned by a NON-superadmin real user.
    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Owner's Nest" },
      owner.apiKey,
    );
    nestId = data.nest.id;

    // Grant an admin collaborator, a write collaborator, and a read-only
    // collaborator, to cover every rung of the permission ladder.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: nestAdmin.email, permission: "admin" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: writer.email, permission: "write" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: reader.email, permission: "read" },
      owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("a superadmin can enable reader mode on any nest", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { enabled: true },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.reader_mode).toBe(1);
  });

  it("GET /nests/:id reflects reader_mode after enabling", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}`,
      undefined,
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.nest.reader_mode).toBe(1);
    // Not yet set — resolves by convention until a home node is designated.
    expect(res.data.nest.reader_home_node ?? null).toBe(null);
  });

  it("a superadmin can designate and clear the home node", async () => {
    const set = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { home_node: "welcome" },
      admin.apiKey,
    );
    expect(set.status).toBe(200);
    expect(set.data.reader_home_node).toBe("welcome");

    const got = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}`,
      undefined,
      admin.apiKey,
    );
    expect(got.data.nest.reader_home_node).toBe("welcome");

    // null clears it back to convention-resolution.
    const cleared = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { home_node: null },
      admin.apiKey,
    );
    expect(cleared.status).toBe(200);
    expect(cleared.data.reader_home_node ?? null).toBe(null);
  });

  it("an owner who is NOT a superadmin can enable reader mode on their own nest", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { enabled: true },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.reader_mode).toBe(1);
  });

  it("an admin collaborator (not the owner, not a superadmin) can configure reader mode", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { enabled: true },
      nestAdmin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.reader_mode).toBe(1);
  });

  it("a write collaborator is refused (403) — write clears 'write' but not 'admin'", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { enabled: false },
      writer.apiKey,
    );
    expect(res.status).toBe(403);
    // …and the value was not changed as a side effect.
    const got = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}`,
      undefined,
      admin.apiKey,
    );
    expect(got.data.nest.reader_mode).toBe(1);
  });

  it("a read collaborator is refused (403)", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { enabled: false },
      reader.apiKey,
    );
    expect(res.status).toBe(403);
  });

  it("an anonymous caller is refused (not 200)", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { enabled: false },
    );
    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);
  });

  it("rejects an invalid home_node (non-string, non-null) with 400", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { home_node: 42 as unknown as string },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("400s a body that updates neither field", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      {},
      admin.apiKey,
    );
    expect(res.status).toBe(400);
  });
});
