/**
 * "Request changes" and "Reject" both close a review as rejected. The kind is
 * stored in review_requests.resolution_kind and returned by /versions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { getDb } from "../src/db/client.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let dev: { apiKey: string };
let reviewer: { apiKey: string };
let viewer: { apiKey: string };
let nestId: string;
const DOC = "nodes/kind-doc";

const kindOf = async (version: number) =>
  ((await getDb().get(
    "SELECT resolution_kind FROM review_requests WHERE nest_id = ? AND node_id = ? AND version = ? ORDER BY requested_at DESC LIMIT 1",
    [nestId, DOC, version],
  )) as { resolution_kind: string | null } | undefined)?.resolution_kind;

const versions = async () =>
  (await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${DOC}/versions`, undefined, dev.apiKey)).data.versions as any[];

async function editAndSubmit(content: string) {
  const r = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${DOC}`, { content }, dev.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  const s = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${DOC}/submit-review`, {}, dev.apiKey);
  expect(s.status, JSON.stringify(s.data)).toBeLessThan(300);
  return s.data.review.version as number;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["dev@acme.com"] });
  dev = await registerUser(app, "dev@acme.com", "Dev");
  reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
  viewer = await registerUser(app, "viewer@acme.com", "Viewer");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Kind Vault" }, dev.apiKey)).data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "reviewer@acme.com", permission: "write" }, dev.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "viewer@acme.com", permission: "read" }, dev.apiKey);
  const nestPath = join(env.dataDir, "nests", nestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(join(nestPath, "stewards.yaml"), "nest:\n  - email: reviewer@acme.com, role: reviewer, can_approve: true\n");
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, dev.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Kind Doc", content: "v1" }, dev.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${DOC}/submit-review`, {}, dev.apiKey);
});
afterAll(() => env?.cleanup?.());

describe("review resolution kind", () => {
  it("refuses an unknown kind", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${DOC}/reject`, { note: "x", kind: "nuke" }, reviewer.apiKey);
    expect(r.status).toBe(400);
  });

  it("a viewer cannot reject", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${DOC}/reject`, { note: "x", kind: "reject" }, viewer.apiKey);
    expect(r.status).toBe(403);
  });

  it("Request changes (no kind) stores 'changes' and reads 'changes'", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${DOC}/reject`, { note: "Fix the intro" }, reviewer.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const v = r.data.review.version as number;
    expect(await kindOf(v)).toBe("changes");
    const row = (await versions()).find((x) => x.version === v);
    expect(row).toMatchObject({ resolutionStatus: "rejected", resolutionKind: "changes" });
  });

  it("Reject stores 'reject' and reads 'reject'", async () => {
    const v = await editAndSubmit("v2");
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${DOC}/reject`, { note: "Out of scope", kind: "reject" }, reviewer.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(await kindOf(v)).toBe("reject");
    const row = (await versions()).find((x) => x.version === v);
    expect(row).toMatchObject({ resolutionStatus: "rejected", resolutionKind: "reject", resolutionNote: "Out of scope" });
  });

  it("an approved version carries no kind", async () => {
    const v = await editAndSubmit("v3");
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${DOC}/approve`, {}, reviewer.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const row = (await versions()).find((x) => x.version === v);
    expect(row?.resolutionStatus).toBe("approved");
    expect(row?.resolutionKind).toBeUndefined();
  });
});
