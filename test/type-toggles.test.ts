/**
 * Content-type toggles (CU-wdqcpzwf2g): type_artifact_enabled /
 * type_table_enabled — superadmin runtime settings with env fallbacks
 * (TYPE_ARTIFACT_ENABLED / TYPE_TABLE_ENABLED). DEFAULT ON: only an explicit
 * "false" disables, so existing deployments see zero behavior change.
 *
 * Contract under test:
 *  - node CREATE of a disabled type is refused with a clear 400;
 *  - creation succeeds when the type is enabled (the default);
 *  - SOFT-disable only: an existing node of a disabled type still reads and
 *    versions (never data loss);
 *  - /admin/settings PATCH round-trips (live + persisted);
 *  - runnable types stay gated by FEATURE_WORKFLOW_PLANE exactly as before —
 *    the content toggles don't touch that surface.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

const OWNER_EMAIL = "owner@example.com";

/** Read a persisted setting straight from the DB the running app uses. */
async function persistedSetting(key: string): Promise<string | null | undefined> {
  const { getDb } = await import("../src/db/client.js");
  const row = (await getDb().get(
    "SELECT value FROM server_settings WHERE key = ?",
    [key],
  )) as { value: string | null } | undefined;
  return row ? row.value : undefined;
}

// Env keys these tests mutate — cleared between cases so leakage can't mask a bug.
const TOUCHED = [
  "TYPE_ARTIFACT_ENABLED",
  "TYPE_TABLE_ENABLED",
  "FEATURE_WORKFLOW_PLANE",
];

let env: ReturnType<typeof setupTestEnv>;

beforeEach(() => {
  env = setupTestEnv();
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  env.cleanup();
});

async function makeNest(app: any, apiKey: string): Promise<string> {
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Types" }, apiKey);
  expect(nest.status).toBe(201);
  return nest.data.nest.id;
}

describe("content-type toggles — defaults", () => {
  it("defaults ON: /health exposes both flags true and creation of every content type works", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.type_artifact_enabled).toBe(true);
    expect(health.data.type_table_enabled).toBe(true);

    const artifact = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Deck", content: "<h1>hi</h1>", type: "artifact" },
      admin.apiKey,
    );
    expect(artifact.status).toBe(201);

    const table = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Prices", content: "sku,price\nA,1", type: "table" },
      admin.apiKey,
    );
    expect(table.status).toBe(201);
  });
});

describe("content-type toggles — create enforcement", () => {
  it("rejects creating an artifact when TYPE_ARTIFACT_ENABLED=false, with a clear error", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    process.env.TYPE_ARTIFACT_ENABLED = "false";
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Deck", content: "<h1>hi</h1>", type: "artifact" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/Artifact nodes are disabled on this server/);

    // Tables and plain documents are untouched by the artifact toggle.
    const table = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Prices", content: "sku,price\nA,1", type: "table" },
      admin.apiKey,
    );
    expect(table.status).toBe(201);
    const doc = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Notes", content: "# Notes" },
      admin.apiKey,
    );
    expect(doc.status).toBe(201);
  });

  it("rejects creating a table when TYPE_TABLE_ENABLED=false, and re-enabling restores creation", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    process.env.TYPE_TABLE_ENABLED = "false";
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Prices", content: "sku,price\nA,1", type: "table" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/Table nodes are disabled on this server/);

    delete process.env.TYPE_TABLE_ENABLED;
    const ok = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Prices", content: "sku,price\nA,1", type: "table" },
      admin.apiKey,
    );
    expect(ok.status).toBe(201);
  });

  it("soft-disable: an existing artifact still reads and versions after the type is disabled", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Old Deck", content: "<h1>v1</h1>", type: "artifact" },
      admin.apiKey,
    );
    expect(created.status).toBe(201);
    const nodeId = created.data.node.id;

    process.env.TYPE_ARTIFACT_ENABLED = "false";

    // Still readable.
    const get = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}`,
      undefined,
      admin.apiKey,
    );
    expect(get.status).toBe(200);
    expect(get.data.node.type).toBe("artifact");

    // Still versions — an edit to the existing node is NOT a create.
    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "<h1>v2</h1>" },
      admin.apiKey,
    );
    expect(patch.status).toBe(200);

    const versions = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions`,
      undefined,
      admin.apiKey,
    );
    expect(versions.status).toBe(200);
  });
});

describe("content-type toggles — bulk publish enforcement", () => {
  it("POST /publish rejects the whole batch when it contains a disabled type, before any write", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    process.env.TYPE_ARTIFACT_ENABLED = "false";

    // Batch mixes a fine document with a disabled artifact — a policy
    // violation fails the WHOLE batch (nothing written, document included).
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      {
        documents: [
          { title: "Fine Doc", content: "# ok" },
          { title: "Sneaky Deck", content: "<h1>hi</h1>", type: "artifact" },
        ],
      },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/Artifact nodes are disabled on this server/);

    // Nothing from the batch landed — not even the valid document.
    const fineDoc = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/fine-doc`,
      undefined,
      admin.apiKey,
    );
    expect(fineDoc.status).toBe(404);
    const sneaky = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/sneaky-deck`,
      undefined,
      admin.apiKey,
    );
    expect(sneaky.status).toBe(404);

    // Same gate for tables.
    process.env.TYPE_TABLE_ENABLED = "false";
    const table = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      { documents: [{ title: "Prices", content: "sku,price\nA,1", type: "table" }] },
      admin.apiKey,
    );
    expect(table.status).toBe(400);
    expect(table.data.error).toMatch(/Table nodes are disabled on this server/);

    // Re-enabled → the same batch publishes.
    delete process.env.TYPE_ARTIFACT_ENABLED;
    delete process.env.TYPE_TABLE_ENABLED;
    const ok = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      {
        documents: [
          { title: "Fine Doc", content: "# ok" },
          { title: "Sneaky Deck", content: "<h1>hi</h1>", type: "artifact" },
        ],
      },
      admin.apiKey,
    );
    expect(ok.status).toBe(201);
    expect(ok.data.published).toBe(2);
  });
});

describe("content-type toggles — /admin/settings round-trip", () => {
  it("PATCH disables/enables live and persists (enable clears the row back to the default)", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    const before = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(before.status).toBe(200);
    expect(before.data.type_artifact_enabled).toBe(true);
    expect(before.data.type_table_enabled).toBe(true);

    const off = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { type_artifact_enabled: false, type_table_enabled: false },
      admin.apiKey,
    );
    expect(off.status).toBe(200);
    expect(off.data.settings.type_artifact_enabled).toBe(false);
    expect(off.data.settings.type_table_enabled).toBe(false);
    // Persisted as the explicit "false" (the only disabled state).
    expect(await persistedSetting("TYPE_ARTIFACT_ENABLED")).toBe("false");
    expect(await persistedSetting("TYPE_TABLE_ENABLED")).toBe("false");

    // Live: create is refused and /health mirrors the flags.
    const rejected = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Deck", content: "<h1>hi</h1>", type: "artifact" },
      admin.apiKey,
    );
    expect(rejected.status).toBe(400);
    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.type_artifact_enabled).toBe(false);
    expect(health.data.type_table_enabled).toBe(false);

    // Re-enable: the row tombstones back to null (default ON).
    const on = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { type_artifact_enabled: true, type_table_enabled: true },
      admin.apiKey,
    );
    expect(on.status).toBe(200);
    expect(on.data.settings.type_artifact_enabled).toBe(true);
    expect(on.data.settings.type_table_enabled).toBe(true);
    expect(await persistedSetting("TYPE_ARTIFACT_ENABLED")).toBeNull();
    expect(await persistedSetting("TYPE_TABLE_ENABLED")).toBeNull();

    const okAgain = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Deck", content: "<h1>hi</h1>", type: "artifact" },
      admin.apiKey,
    );
    expect(okAgain.status).toBe(201);
  });
});

describe("content-type toggles — runnable gating unchanged", () => {
  it("agent creation and the workflow plane are untouched by the content toggles", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    process.env.TYPE_ARTIFACT_ENABLED = "false";
    process.env.TYPE_TABLE_ENABLED = "false";

    // Runnable node creation goes through exactly as before (the plane gates
    // its ROUTES, not node creation — unchanged by this feature).
    const agent = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Digest Agent", content: "Summarize.", type: "agent" },
      admin.apiKey,
    );
    expect(agent.status).toBe(201);

    // Plane flag stays independent: off by default, and toggling it on via
    // settings works with both content types disabled.
    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.workflow_plane_enabled).toBe(false);

    const patch = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { workflow_plane_enabled: true },
      admin.apiKey,
    );
    expect(patch.status).toBe(200);
    expect(patch.data.settings.workflow_plane_enabled).toBe(true);
    expect(patch.data.settings.type_artifact_enabled).toBe(false);
    expect(patch.data.settings.type_table_enabled).toBe(false);
  });
});
