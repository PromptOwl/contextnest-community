/**
 * DB-backed superadmin management (CU-wdqcpzwf2n).
 *
 * Effective superadmin = access.yaml `super_admins` ∪ super_admins DB rows
 * (∪ the license owner). /admin/super-admins grants and revokes the DB kind
 * from the UI; access.yaml entries stay file-authoritative (never revocable
 * via the API — lockout safety), and a last-admin guard stops the final
 * effective superadmin from revoking themselves.
 *
 * Tests run in order and share state (grant → use → revoke → restart).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: { apiKey: string; userId: string; email: string };  // access.yaml admin
let alice: { apiKey: string; userId: string; email: string }; // granted, then revoked
let bob: { apiKey: string; userId: string; email: string };   // granted, survives restart

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
  root = await registerUser(app, "root@acme.com", "Root");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  bob = await registerUser(app, "bob@acme.com", "Bob");
});

afterAll(() => env.cleanup());

describe("GET /admin/super-admins", () => {
  it("lists the access.yaml admin with source=config and marks self", async () => {
    const res = await jsonRequest(app, "GET", "/admin/super-admins", undefined, root.apiKey);
    expect(res.status).toBe(200);
    const row = res.data.super_admins.find((r: any) => r.email === "root@acme.com");
    expect(row).toBeTruthy();
    expect(row.source).toBe("config");
    expect(row.self).toBe(true);
  });

  it("is superadmin-only", async () => {
    const res = await jsonRequest(app, "GET", "/admin/super-admins", undefined, alice.apiKey);
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/super-admins", () => {
  it("a non-superadmin cannot grant", async () => {
    const res = await jsonRequest(
      app, "POST", "/admin/super-admins", { email: bob.email }, alice.apiKey,
    );
    expect(res.status).toBe(403);
    // …and the target did not become an admin as a side effect.
    const trace = await jsonRequest(app, "GET", "/admin/trace", undefined, bob.apiKey);
    expect(trace.status).toBe(403);
  });

  it("400s an email with no user account", async () => {
    const res = await jsonRequest(
      app, "POST", "/admin/super-admins", { email: "ghost@acme.com" }, root.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/no user/i);
  });

  it("400s a missing or malformed email", async () => {
    const missing = await jsonRequest(app, "POST", "/admin/super-admins", {}, root.apiKey);
    expect(missing.status).toBe(400);
    const malformed = await jsonRequest(
      app, "POST", "/admin/super-admins", { email: "not-an-email" }, root.apiKey,
    );
    expect(malformed.status).toBe(400);
  });

  it("grant flips the target's access to superadmin-only endpoints (case-insensitive)", async () => {
    // Before: alice can't read the trace.
    const before = await jsonRequest(app, "GET", "/admin/trace", undefined, alice.apiKey);
    expect(before.status).toBe(403);

    const res = await jsonRequest(
      app, "POST", "/admin/super-admins", { email: "Alice@ACME.com" }, root.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.email).toBe("alice@acme.com"); // stored lowercased
    expect(res.data.granted_by).toBe("root@acme.com");

    const after = await jsonRequest(app, "GET", "/admin/trace", undefined, alice.apiKey);
    expect(after.status).toBe(200);

    const list = await jsonRequest(app, "GET", "/admin/super-admins", undefined, root.apiKey);
    const row = list.data.super_admins.find((r: any) => r.email === "alice@acme.com");
    expect(row.source).toBe("granted");
    expect(row.granted_by).toBe("root@acme.com");
    expect(row.self).toBe(false);
  });

  it("a granted superadmin gets the full server-admin surface (teammates, admin-status, granting)", async () => {
    const mates = await jsonRequest(app, "GET", "/auth/teammates", undefined, alice.apiKey);
    expect(mates.status).toBe(200);

    const status = await jsonRequest(app, "GET", "/auth/admin-status", undefined, alice.apiKey);
    expect(status.data.me.is_admin).toBe(true);

    // Granted admins can grant others.
    const res = await jsonRequest(
      app, "POST", "/admin/super-admins", { email: bob.email }, alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.granted_by).toBe("alice@acme.com");
    const trace = await jsonRequest(app, "GET", "/admin/trace", undefined, bob.apiKey);
    expect(trace.status).toBe(200);
  });

  it("409s when the target is already a superadmin (granted or config)", async () => {
    const dupGranted = await jsonRequest(
      app, "POST", "/admin/super-admins", { email: alice.email }, root.apiKey,
    );
    expect(dupGranted.status).toBe(409);
    const dupConfig = await jsonRequest(
      app, "POST", "/admin/super-admins", { email: root.email }, root.apiKey,
    );
    expect(dupConfig.status).toBe(409);
  });
});

describe("DELETE /admin/super-admins/:email", () => {
  it("a non-superadmin cannot revoke", async () => {
    // carol is nobody special; use a plain user token (alice is admin now, use a fresh check via bob-revoked later — here use an unauthenticated request instead)
    const res = await jsonRequest(app, "DELETE", `/admin/super-admins/${alice.email}`);
    expect([401, 403]).toContain(res.status);
  });

  it("revoke returns the target to 403", async () => {
    const res = await jsonRequest(
      app, "DELETE", `/admin/super-admins/${alice.email}`, undefined, root.apiKey,
    );
    expect(res.status).toBe(200);
    const trace = await jsonRequest(app, "GET", "/admin/trace", undefined, alice.apiKey);
    expect(trace.status).toBe(403);
    const mates = await jsonRequest(app, "GET", "/auth/teammates", undefined, alice.apiKey);
    expect(mates.status).toBe(403);
  });

  it("404s an email that has no granted row", async () => {
    const res = await jsonRequest(
      app, "DELETE", `/admin/super-admins/${alice.email}`, undefined, root.apiKey,
    );
    expect(res.status).toBe(404);
  });

  it("400s revoking an access.yaml admin (file is authoritative — lockout safety)", async () => {
    const res = await jsonRequest(
      app, "DELETE", `/admin/super-admins/${root.email}`, undefined, root.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/access\.yaml/i);
    // Still an admin.
    const trace = await jsonRequest(app, "GET", "/admin/trace", undefined, root.apiKey);
    expect(trace.status).toBe(200);
  });
});

describe("persistence and lockout", () => {
  it("grants survive a server restart (DB-backed, loaded at startup)", async () => {
    // Fresh app over the SAME data dir = a restart. bob's grant lives in the
    // super_admins table; the startup load must repopulate the sync cache.
    app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
    const trace = await jsonRequest(app, "GET", "/admin/trace", undefined, bob.apiKey);
    expect(trace.status).toBe(200);
  });

  it("the last effective superadmin cannot revoke themselves", async () => {
    // Drop root from access.yaml and reload on the module instance the app
    // uses — bob's DB grant is now the ONLY effective superadmin (the test
    // license mock has no ownerEmail).
    const access = await import("../src/governance/access-service.js");
    writeFileSync(join(env.dataDir, "access.yaml"), "mode: open\n");
    access.loadAccessConfig();

    const res = await jsonRequest(
      app, "DELETE", `/admin/super-admins/${bob.email}`, undefined, bob.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/last superadmin/i);
    // Nothing changed — bob is still an admin.
    const trace = await jsonRequest(app, "GET", "/admin/trace", undefined, bob.apiKey);
    expect(trace.status).toBe(200);

    // Once another admin exists again (root back in the file), self-revoke works.
    writeFileSync(
      join(env.dataDir, "access.yaml"),
      "super_admins:\n  - root@acme.com\n",
    );
    access.loadAccessConfig();
    const res2 = await jsonRequest(
      app, "DELETE", `/admin/super-admins/${bob.email}`, undefined, bob.apiKey,
    );
    expect(res2.status).toBe(200);
    const trace2 = await jsonRequest(app, "GET", "/admin/trace", undefined, bob.apiKey);
    expect(trace2.status).toBe(403);
  });
});
