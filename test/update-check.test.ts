/**
 * Update check: compare against npm's latest, tell only the server admin, and
 * fail quietly when the registry can't be reached.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

beforeEach(() => setupTestEnv());
afterEach(() => {
  delete process.env.UPDATE_CHECK;
});

const registry = (version: string) =>
  (async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch;

describe("isNewer", () => {
  it("compares x.y.z numerically and ignores pre-releases", async () => {
    const { isNewer } = await import("../src/ops/update-check.js");
    expect(isNewer("2.10.0", "2.9.9")).toBe(true);
    expect(isNewer("2.3.0", "2.3.0")).toBe(false);
    expect(isNewer("2.2.9", "2.3.0")).toBe(false);
    expect(isNewer("3.0.0-beta.1", "2.3.0")).toBe(false);
  });
});

describe("GET /admin/update-status", () => {
  it("reports a newer release to the server admin, with the command for this install", async () => {
    const app = await createTestApp("key", { ownerEmail: "admin@example.com" });
    const admin = await registerUser(app, "admin@example.com"); // the license owner is the server admin
    const { checkForUpdate } = await import("../src/ops/update-check.js");
    await checkForUpdate(registry("99.0.0"));

    const { status, data } = await jsonRequest(app, "GET", "/admin/update-status", undefined, admin.apiKey);
    expect(status).toBe(200);
    expect(data).toMatchObject({ enabled: true, latest: "99.0.0", update_available: true });
    expect(data.command).toContain("99.0.0");
  });

  it("is refused to everyone else", async () => {
    const app = await createTestApp("key", { ownerEmail: "admin@example.com" });
    await registerUser(app, "admin@example.com");
    const member = await registerUser(app, "member@example.com");
    const { status } = await jsonRequest(app, "GET", "/admin/update-status", undefined, member.apiKey);
    expect(status).toBe(403);
  });

  it("an unreachable registry reports nothing rather than failing", async () => {
    const app = await createTestApp("key", { ownerEmail: "admin@example.com" });
    const admin = await registerUser(app, "admin@example.com");
    const { checkForUpdate } = await import("../src/ops/update-check.js");
    await checkForUpdate((async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch);
    const { data } = await jsonRequest(app, "GET", "/admin/update-status", undefined, admin.apiKey);
    expect(data).toMatchObject({ latest: null, update_available: false });
  });

  it("UPDATE_CHECK=false reports the check as off", async () => {
    process.env.UPDATE_CHECK = "false";
    const app = await createTestApp("key", { ownerEmail: "admin@example.com" });
    const admin = await registerUser(app, "admin@example.com");
    const { data } = await jsonRequest(app, "GET", "/admin/update-status", undefined, admin.apiKey);
    expect(data.enabled).toBe(false);
  });
});
