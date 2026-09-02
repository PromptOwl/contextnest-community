/**
 * Public Docs Reader Mode — PATCH /nests/:id/reader-mode (superadmin-gated).
 *
 * Reader mode is a superadmin-enabled, read-only public docs view of a nest.
 * Only the server admin (license admin OR access.yaml `super_admins` ∪ the
 * DB-granted set) may configure it — the same gate as /nests/unsynced and
 * /admin/*. A nest OWNER who is not a superadmin is refused even though they
 * clear the "admin" tier the access middleware requires, and a read
 * collaborator / anonymous caller never reaches the handler at all.
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

describe("PATCH /nests/:id/reader-mode (superadmin-gated)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let admin: { apiKey: string; userId: string; email: string };
  let owner: { apiKey: string; userId: string; email: string };
  let reader: { apiKey: string; userId: string; email: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["admin@acme.com"] });
    admin = await registerUser(app, "admin@acme.com", "Admin");
    await resetAuthRateLimit();
    owner = await registerUser(app, "owner@acme.com", "Owner");
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

    // Grant the reader a read-only collaborator row.
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

  it("an owner who is NOT a superadmin is refused (403)", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/reader-mode`,
      { enabled: true },
      owner.apiKey,
    );
    expect(res.status).toBe(403);
    // …and the value was not changed as a side effect (still 1 from earlier).
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
