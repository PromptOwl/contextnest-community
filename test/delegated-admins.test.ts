/**
 * Delegated administration: a nest owner can hand people-management to
 * admin collaborators. The steward roster and nest settings — previously
 * server-admin / owner-only — are open to nest owner + admin collaborators
 * (canManageStewards / PATCH /settings). Write collaborators stay out.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let admin: { apiKey: string; userId: string; email: string };
let writer: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  // No superAdmins: nobody here is a server admin, so any roster access
  // proves the delegated (owner/admin-collaborator) path.
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  admin = await registerUser(app, "admin@acme.com", "Admin");
  writer = await registerUser(app, "writer@acme.com", "Writer");

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Delegated" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: admin.email, permission: "admin" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: writer.email, permission: "write" },
    owner.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("steward roster delegation", () => {
  it("nest owner (not a server admin) can assign and list stewards", async () => {
    const post = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", email: "rev@acme.com", role: "reviewer" },
      owner.apiKey,
    );
    expect(post.status).toBe(201);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/stewards`, undefined, owner.apiKey);
    expect(list.status).toBe(200);
    expect(list.data.stewards.some((s: any) => s.userEmail === "rev@acme.com")).toBe(true);
  });

  it("admin collaborator can manage the roster too", async () => {
    const post = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", email: "rev2@acme.com", role: "editor" },
      admin.apiKey,
    );
    expect(post.status).toBe(201);
  });

  it("write collaborator is still locked out of the roster", async () => {
    const post = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", email: "rev3@acme.com", role: "reviewer" },
      writer.apiKey,
    );
    expect(post.status).toBe(403);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/stewards`, undefined, writer.apiKey);
    expect(list.status).toBe(403);
  });
});

describe("nest settings delegation", () => {
  it("admin collaborator can update nest settings", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { allow_self_approve: true },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.allow_self_approve).toBe(true);
  });

  it("write collaborator cannot update nest settings", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { allow_self_approve: false },
      writer.apiKey,
    );
    expect(res.status).toBe(403);
  });
});
