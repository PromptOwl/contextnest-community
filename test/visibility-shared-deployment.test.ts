/**
 * Shared-deployment guardrail on nest visibility (CU-wdqcq02mek).
 *
 * 'org' visibility means "every authenticated account on this deployment".
 * On a single-company self-hosted server that is the company; on the
 * PromptOwl-hosted server, which holds many unrelated customers, it is every
 * customer. The SHARED_DEPLOYMENT setting (env + /admin/settings toggle)
 * tells the server which it is: when on, flipping a nest to 'org' needs the
 * same explicit acknowledgement 'public' always needs, and /health reports
 * the flag so the UI can word its tiers honestly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
  registerUser,
} from "./helpers";

const OWNER_EMAIL = "owner@acme.com";
let env: ReturnType<typeof setupTestEnv>;

beforeEach(() => {
  env = setupTestEnv();
  delete process.env.SHARED_DEPLOYMENT;
});
afterEach(() => {
  delete process.env.SHARED_DEPLOYMENT;
  env.cleanup();
});

async function ownerAndNest(app: any) {
  const owner = await registerUser(app, OWNER_EMAIL, "Owner");
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Docs" }, owner.apiKey);
  return { owner, nestId: data.nest.id as string };
}

async function visibilityOf(app: any, nestId: string, apiKey: string) {
  const got = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, apiKey);
  return got.data.nest.visibility as string;
}

describe("PATCH /nests/:id/visibility — 'org' on a shared deployment", () => {
  it("regression: off (default), org needs no acknowledgement", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const { owner, nestId } = await ownerAndNest(app);
    const res = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "org" }, owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.visibility).toBe("org");
  });

  it("on: org WITHOUT acknowledgement → 409, visibility unchanged", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const { owner, nestId } = await ownerAndNest(app);
    const res = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "org" }, owner.apiKey,
    );
    expect(res.status).toBe(409);
    expect(res.data.requires_acknowledgement).toBe(true);
    // The warning names the real boundary: every account on the server,
    // other organizations included — not "your organization".
    expect(res.data.warning).toMatch(/every account on this server/i);
    expect(res.data.warning).toMatch(/other organi[sz]ations/i);
    expect(await visibilityOf(app, nestId, owner.apiKey)).toBe("private");
  });

  it("on: org WITH acknowledgement → 200", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const { owner, nestId } = await ownerAndNest(app);
    const res = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`,
      { visibility: "org", acknowledge_public: true }, owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.visibility).toBe("org");
  });

  it("on: public still needs acknowledgement, and its warning names other organizations too", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const { owner, nestId } = await ownerAndNest(app);
    const res = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public" }, owner.apiKey,
    );
    expect(res.status).toBe(409);
    expect(res.data.warning).toMatch(/anyone on the internet/i);
    expect(res.data.warning).toMatch(/other organi[sz]ations/i);
  });

  it("on: back to private needs no acknowledgement", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const { owner, nestId } = await ownerAndNest(app);
    await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`,
      { visibility: "org", acknowledge_public: true }, owner.apiKey,
    );
    const res = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "private" }, owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.visibility).toBe("private");
  });
});

describe("SHARED_DEPLOYMENT — /health and the superadmin toggle", () => {
  it("/health reports shared_deployment (false by default, true when set)", async () => {
    let app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    let h = await jsonRequest(app, "GET", "/health");
    expect(h.data.shared_deployment).toBe(false);

    process.env.SHARED_DEPLOYMENT = "true";
    h = await jsonRequest(app, "GET", "/health");
    expect(h.data.shared_deployment).toBe(true);
  });

  it("PATCH /admin/settings flips it live, persists it, and the org guard follows", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const { owner, nestId } = await ownerAndNest(app);

    const before = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
    expect(before.status).toBe(200);
    expect(before.data.shared_deployment).toBe(false);

    const patch = await jsonRequest(
      app, "PATCH", "/admin/settings", { shared_deployment: true }, owner.apiKey,
    );
    expect(patch.status).toBe(200);
    expect(patch.data.settings.shared_deployment).toBe(true);

    // Live: the org guard now applies without a restart.
    const res = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "org" }, owner.apiKey,
    );
    expect(res.status).toBe(409);

    // Persisted: survives a restart / reaches every instance.
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get(
      "SELECT value FROM server_settings WHERE key = ?", ["SHARED_DEPLOYMENT"],
    )) as { value: string | null } | undefined;
    expect(row?.value).toBe("true");

    // Off again persists as a tombstone (unset already means off).
    const off = await jsonRequest(
      app, "PATCH", "/admin/settings", { shared_deployment: false }, owner.apiKey,
    );
    expect(off.data.settings.shared_deployment).toBe(false);
    const ok = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "org" }, owner.apiKey,
    );
    expect(ok.status).toBe(200);
  });
});

describe("GET /nests — discovered rows are marked", () => {
  it("a nest reachable only through org/public visibility carries discovered: true; member nests don't", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const { owner, nestId } = await ownerAndNest(app);
    const other = await registerUser(app, "other@beta.com", "Other");
    // Owner's second nest, shared with `other` directly.
    const shared = await jsonRequest(app, "POST", "/nests", { name: "Shared" }, owner.apiKey);
    await jsonRequest(
      app, "POST", `/nests/${shared.data.nest.id}/collaborators`,
      { email: "other@beta.com", permission: "read" }, owner.apiKey,
    );
    await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "org" }, owner.apiKey,
    );
    const mineToo = await jsonRequest(app, "POST", "/nests", { name: "Other's own" }, other.apiKey);

    const list = await jsonRequest(app, "GET", "/nests", undefined, other.apiKey);
    const byId = new Map(list.data.nests.map((n: any) => [n.id, n]));
    expect(byId.get(nestId)?.discovered).toBe(true);
    expect(byId.get(shared.data.nest.id)?.discovered).toBe(false);
    expect(byId.get(mineToo.data.nest.id)?.discovered).toBe(false);
    // The owner never sees their own nest as discovered.
    const own = await jsonRequest(app, "GET", "/nests", undefined, owner.apiKey);
    expect(own.data.nests.find((n: any) => n.id === nestId)?.discovered).toBe(false);
  });
});
