/**
 * Per-nest steward trace view: GET /nests/:id/trace serves the same rows/
 * shape as GET /admin/trace but always pinned to that nest server-side, and
 * only for the nest owner / admin collaborators (canManageStewards rule).
 * Also proves the superadmin /admin/trace surface is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let superadmin: { apiKey: string; userId: string; email: string };
let owner: { apiKey: string; userId: string; email: string };
let collab: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let nestA: string;
let nestB: string;
let collabId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["admin@acme.com"] });
  superadmin = await registerUser(app, "admin@acme.com", "Admin");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  collab = await registerUser(app, "collab@acme.com", "Collab");
  // Registration rate limit allows 3 per IP — clear before the 4th.
  await resetAuthRateLimit();
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");

  // Two nests owned by different people, each with traced activity.
  const a = await jsonRequest(app, "POST", "/nests", { name: "Nest A" }, owner.apiKey);
  nestA = a.data.nest.id;
  const b = await jsonRequest(app, "POST", "/nests", { name: "Nest B" }, outsider.apiKey);
  nestB = b.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestA}/nodes`,
    { title: "Doc A", content: "# A" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestB}/nodes`,
    { title: "Doc B", content: "# B" },
    outsider.apiKey,
  );

  // A write collaborator on nest A — enough to read/edit docs, NOT enough to
  // read the nest's activity trace.
  const added = await jsonRequest(
    app,
    "POST",
    `/nests/${nestA}/collaborators`,
    { email: collab.email, permission: "write" },
    owner.apiKey,
  );
  collabId = added.data.collaborator.id;

  // Trace writes are fire-and-forget — let the inserts flush.
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => env.cleanup());

describe("GET /nests/:id/trace", () => {
  it("returns only this nest's events, with the /admin/trace shape", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestA}/trace`,
      undefined,
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    // Same envelope as /admin/trace.
    expect(res.data).toMatchObject({ limit: 25, offset: 0 });
    expect(typeof res.data.total).toBe("number");
    expect(res.data.count).toBe(res.data.events.length);
    // Only nest A rows — nest B has activity, none of it may appear here.
    expect(res.data.events.length).toBeGreaterThan(0);
    expect(res.data.events.every((e: any) => e.nest_id === nestA)).toBe(true);
    const nodeRow = res.data.events.find(
      (e: any) => e.path === `/nests/${nestA}/nodes` && e.method === "POST",
    );
    expect(nodeRow).toBeTruthy();
    expect(nodeRow.caller).toBe(owner.email);
  });

  it("pins the nest server-side — a ?nest= override is ignored", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestA}/trace?nest=${encodeURIComponent(nestB)}`,
      undefined,
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.events.length).toBeGreaterThan(0);
    expect(res.data.events.every((e: any) => e.nest_id === nestA)).toBe(true);
  });

  it("supports the same kind/limit/offset filters as /admin/trace", async () => {
    const page = await jsonRequest(
      app,
      "GET",
      `/nests/${nestA}/trace?limit=1&offset=0`,
      undefined,
      owner.apiKey,
    );
    expect(page.status).toBe(200);
    expect(page.data.events.length).toBe(1);
    expect(page.data.limit).toBe(1);
    expect(page.data.total).toBeGreaterThan(1);

    const api = await jsonRequest(
      app,
      "GET",
      `/nests/${nestA}/trace?kind=api`,
      undefined,
      owner.apiKey,
    );
    expect(api.data.events.every((e: any) => e.kind === "api")).toBe(true);
  });

  it("403s a write collaborator (nest access, but not owner/admin)", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestA}/trace`,
      undefined,
      collab.apiKey,
    );
    expect(res.status).toBe(403);
  });

  it("404s a caller with no access to the nest", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestA}/trace`,
      undefined,
      outsider.apiKey,
    );
    expect(res.status).toBe(404);
  });

  it("allows an admin collaborator", async () => {
    const bump = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestA}/collaborators/${collabId}`,
      { permission: "admin" },
      owner.apiKey,
    );
    expect(bump.status).toBe(200);
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestA}/trace`,
      undefined,
      collab.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.events.every((e: any) => e.nest_id === nestA)).toBe(true);
  });
});

describe("GET /admin/trace stays the superadmin cross-nest surface", () => {
  it("still returns rows across every nest for the superadmin", async () => {
    const res = await jsonRequest(app, "GET", "/admin/trace", undefined, superadmin.apiKey);
    expect(res.status).toBe(200);
    const nestIds = new Set(res.data.events.map((e: any) => e.nest_id));
    expect(nestIds.has(nestA)).toBe(true);
    expect(nestIds.has(nestB)).toBe(true);
  });

  it("still 403s a nest owner who is not a server admin", async () => {
    const res = await jsonRequest(app, "GET", "/admin/trace", undefined, owner.apiKey);
    expect(res.status).toBe(403);
  });
});
