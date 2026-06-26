import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// Granular share permissions (CU-wdqcpzudw5)
//
// Inviting people no longer requires nest admin. Any write+ collaborator can
// bring others in — but only up to their OWN permission level (no privilege
// escalation). Changing or removing existing collaborators, and granting
// admin, stay admin-only. Read-only collaborators can't invite at nest level.
// ═══════════════════════════════════════════════════════════════════════════

describe("share permissions: escalation-capped invites", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let editor: { apiKey: string; userId: string }; // write collaborator
  let viewer: { apiKey: string; userId: string }; // read collaborator
  let adminCollab: { apiKey: string; userId: string }; // admin collaborator
  let nestId: string;
  let seedCollabId: string;

  const collabs = (caller: { apiKey: string }) =>
    jsonRequest(app, "GET", `/nests/${nestId}/collaborators`, undefined, caller.apiKey);

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
    // Registering >3 users from one IP trips the per-IP register limit;
    // clear the bucket between registrations (see helpers.resetAuthRateLimit).
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    editor = await registerUser(app, "editor@acme.com", "Editor");
    await resetAuthRateLimit();
    viewer = await registerUser(app, "viewer@acme.com", "Viewer");
    await resetAuthRateLimit();
    adminCollab = await registerUser(app, "adm@acme.com", "Adm");
    await resetAuthRateLimit();

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Shared Vault" },
      owner.apiKey,
    );
    nestId = data.nest.id;

    // Owner seeds the roster (owner is admin-tier, so all of these are allowed).
    for (const [email, permission] of [
      ["editor@acme.com", "write"],
      ["viewer@acme.com", "read"],
      ["adm@acme.com", "admin"],
    ] as const) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email, permission },
        owner.apiKey,
      );
    }
    const { data: list } = await collabs(owner);
    seedCollabId = list.collaborators.find(
      (x: any) => x.email === "editor@acme.com",
    ).id;
  }, 30000);

  afterAll(() => env.cleanup());

  it("a write collaborator can view the roster (GET is write-tier)", async () => {
    const { status, data } = await collabs(editor);
    expect(status).toBe(200);
    expect(Array.isArray(data.collaborators)).toBe(true);
  });

  it("a read-only collaborator cannot view the roster (no public email leak)", async () => {
    const { status } = await collabs(viewer);
    expect(status).toBe(403);
  });

  it("a write collaborator can invite someone at read (≤ own level)", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "newreader@acme.com", permission: "read" },
      editor.apiKey,
    );
    expect(status).toBe(201);
  });

  it("a write collaborator can invite someone at write (= own level)", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "newwriter@acme.com", permission: "write" },
      editor.apiKey,
    );
    expect(status).toBe(201);
  });

  it("a write collaborator CANNOT grant admin (escalation blocked)", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "wannabe-admin@acme.com", permission: "admin" },
      editor.apiKey,
    );
    expect(status).toBe(403);
  });

  it("a read-only collaborator cannot invite at all", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "sneaky@acme.com", permission: "read" },
      viewer.apiKey,
    );
    expect(status).toBe(403);
  });

  it("an admin collaborator can grant admin", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "another-admin@acme.com", permission: "admin" },
      adminCollab.apiKey,
    );
    expect(status).toBe(201);
  });

  it("the owner can still grant admin", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "owner-grant-admin@acme.com", permission: "admin" },
      owner.apiKey,
    );
    expect(status).toBe(201);
  });

  it("a write collaborator cannot change another collaborator's permission", async () => {
    const { status } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/collaborators/${seedCollabId}`,
      { permission: "admin" },
      editor.apiKey,
    );
    expect(status).toBe(403);
  });

  it("a write collaborator cannot remove another collaborator", async () => {
    const { status } = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/collaborators/${seedCollabId}`,
      undefined,
      editor.apiKey,
    );
    expect(status).toBe(403);
  });
});
