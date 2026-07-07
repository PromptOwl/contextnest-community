/**
 * GET /nests enriches each nest with tile metadata: document_count plus
 * collaborator_count / steward_count, so the dashboard tiles can show how
 * much is in a nest and who's on it without an extra round-trip per card.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let emptyNestId: string;
let fullNestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  // alice is super admin so she can sync the steward roster.
  app = await createTestApp("key", { superAdmins: ["alice@acme.com"] });
  alice = await registerUser(app, "alice@acme.com", "Alice");
  await registerUser(app, "bob@acme.com", "Bob");
  await registerUser(app, "carol@acme.com", "Carol");

  // Nest with docs but no people → exercises the ?? 0 fallback path.
  const empty = await jsonRequest(app, "POST", "/nests", { name: "Empty" }, alice.apiKey);
  emptyNestId = empty.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${emptyNestId}/nodes`, { title: "One", content: "# One" }, alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${emptyNestId}/nodes`, { title: "Two", content: "# Two" }, alice.apiKey);

  // Nest with a collaborator and an active steward → exercises the Map-lookup path.
  const full = await jsonRequest(app, "POST", "/nests", { name: "Full" }, alice.apiKey);
  fullNestId = full.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${fullNestId}/nodes`, { title: "Doc", content: "# Doc" }, alice.apiKey);
  await jsonRequest(
    app,
    "POST",
    `/nests/${fullNestId}/collaborators`,
    { email: "bob@acme.com", permission: "write" },
    alice.apiKey,
  );
  const nestPath = join(env.dataDir, "nests", fullNestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(
    join(nestPath, "stewards.yaml"),
    `version: 1
nest:
  - email: carol@acme.com, role: reviewer, can_approve: true
`,
  );
  await jsonRequest(app, "POST", `/nests/${fullNestId}/stewards/sync`, {}, alice.apiKey);
});

afterAll(() => env.cleanup());

describe("GET /nests tile metadata", () => {
  it("reports document_count with people counts defaulting to zero", async () => {
    const res = await jsonRequest(app, "GET", "/nests", undefined, alice.apiKey);
    expect(res.status).toBe(200);
    const nest = res.data.nests.find((n: any) => n.id === emptyNestId);
    expect(nest).toBeTruthy();
    expect(nest.document_count).toBe(2);
    // No collaborators or stewards → zero, but the fields are always present.
    expect(nest.collaborator_count).toBe(0);
    expect(nest.steward_count).toBe(0);
  });

  it("counts collaborators and active stewards per nest", async () => {
    const res = await jsonRequest(app, "GET", "/nests", undefined, alice.apiKey);
    expect(res.status).toBe(200);
    const nest = res.data.nests.find((n: any) => n.id === fullNestId);
    expect(nest).toBeTruthy();
    expect(nest.document_count).toBe(1);
    expect(nest.collaborator_count).toBe(1);
    expect(nest.steward_count).toBe(1);
  });
});
