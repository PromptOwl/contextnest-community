/**
 * po-1406 (AC-6): open auth mode is not superadmin. Everyone there is an
 * anonymous admin, so the Control room's page-only reads refuse it, as the
 * superadmin message log does. (Surfaces, and with it /surfaces/cold-start,
 * is off in open mode altogether.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest, registerUser } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let N: string;

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  app = await createTestApp("open");
  N = (await jsonRequest(app, "POST", "/nests", { name: "Open nest" })).data.nest.id;
});

afterAll(async () => {
  for (const k of ["FEATURE_WORKFLOW_PLANE"]) delete process.env[k];
  await env?.cleanup();
});

describe("po-1406: open mode is not superadmin", () => {
  it("AC-6: the page-only reads answer 403 in open mode", async () => {
    for (const path of ["/ledger", "/rollups", `/nests/${N}/ledger`, `/nests/${N}/rollups`]) {
      const r = await jsonRequest(app, "GET", path);
      expect(r.status, `GET ${path} in open mode`).toBe(403);
    }
  });

  it("AC-6: agent reporting still works in open mode", async () => {
    const reg = await jsonRequest(app, "POST", `/nests/${N}/agents`, { name: "Open agent", runtime: "claude-code" });
    expect(reg.status).toBe(201);
  });

  it("AC-6: a nest-scoped agent key still reads its own nest's ledger and rollups in open mode", async () => {
    const user = await registerUser(app, "agent@open.test");
    const nest = (await jsonRequest(app, "POST", "/nests", { name: "Agent nest" }, user.apiKey)).data.nest.id;
    const res = await jsonRequest(app, "POST", "/auth/keys", { label: "open-agent", nest_id: nest }, user.apiKey);
    const key = res.data?.api_key;
    expect(key, JSON.stringify(res)).toMatch(/^cnst_/);
    for (const path of [`/nests/${nest}/ledger`, `/nests/${nest}/rollups`]) {
      const r = await jsonRequest(app, "GET", path, undefined, key);
      expect(r.status, `GET ${path} with a nest key in open mode`).toBe(200);
    }
  });
});
