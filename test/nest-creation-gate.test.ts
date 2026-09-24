/**
 * NEST_CREATION=admins (the default): only a server admin may create or import
 * a nest — REST, folder import and MCP nest_create all route through the same
 * service guard. "everyone" opens it back up.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let admin: { apiKey: string };
let member: { apiKey: string };

beforeAll(async () => {
  env = setupTestEnv();
  process.env.NEST_CREATION = "admins";
  app = await createTestApp("key", { ownerEmail: "owner@co.com" });
  admin = await registerUser(app, "owner@co.com");
  member = await registerUser(app, "member@co.com");
});

afterAll(() => {
  process.env.NEST_CREATION = "everyone";
  env.cleanup();
});

describe("nest creation gate", () => {
  it("lets the server admin create a nest", async () => {
    const res = await jsonRequest(app, "POST", "/nests", { name: "Admin Nest" }, admin.apiKey);
    expect(res.status).toBe(201);
  });

  it("refuses a non-admin on create and import, with a pointer to the admin", async () => {
    const create = await jsonRequest(app, "POST", "/nests", { name: "Mine" }, member.apiKey);
    expect(create.status).toBe(403);
    expect(create.data.error).toMatch(/Only a server admin can create nests/);
    const imp = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Imported", files: [{ path: "a.md", content: "# A" }] },
      member.apiKey,
    );
    expect(imp.status).toBe(403);
  });

  it("reports the rule on /health so the UI can hide the create buttons", async () => {
    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.nest_creation).toBe("admins");
  });

  it("server admin can switch it from Settings; bad values are rejected", async () => {
    const bad = await jsonRequest(app, "PATCH", "/admin/settings", { nest_creation: "maybe" }, admin.apiKey);
    expect(bad.status).toBe(400);
    const on = await jsonRequest(app, "PATCH", "/admin/settings", { nest_creation: "everyone" }, admin.apiKey);
    expect(on.status).toBe(200);
    expect(on.data.settings.nest_creation).toBe("everyone");
    const res = await jsonRequest(app, "POST", "/nests", { name: "Now Allowed" }, member.apiKey);
    expect(res.status).toBe(201);
    const off = await jsonRequest(app, "PATCH", "/admin/settings", { nest_creation: "admins" }, admin.apiKey);
    expect(off.data.settings.nest_creation).toBe("admins");
    const denied = await jsonRequest(app, "POST", "/nests", { name: "Denied Again" }, member.apiKey);
    expect(denied.status).toBe(403);
  });

  it("NEST_CREATION=everyone lets any signed-in user create", async () => {
    process.env.NEST_CREATION = "everyone";
    const res = await jsonRequest(app, "POST", "/nests", { name: "Open Nest" }, member.apiKey);
    expect(res.status).toBe(201);
    process.env.NEST_CREATION = "admins";
  });
});
