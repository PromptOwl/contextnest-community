/**
 * GET /nests enriches each nest with tile metadata: document_count plus
 * collaborator_count / steward_count, so the dashboard tiles can show how
 * much is in a nest and who's on it without an extra round-trip per card.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Tiles" }, alice.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "One", content: "# One" }, alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Two", content: "# Two" }, alice.apiKey);
});

afterAll(() => env.cleanup());

describe("GET /nests tile metadata", () => {
  it("reports document_count and people counts per nest", async () => {
    const res = await jsonRequest(app, "GET", "/nests", undefined, alice.apiKey);
    expect(res.status).toBe(200);
    const nest = res.data.nests.find((n: any) => n.id === nestId);
    expect(nest).toBeTruthy();
    expect(nest.document_count).toBe(2);
    // No collaborators or stewards yet → zero, but the fields are always present.
    expect(nest.collaborator_count).toBe(0);
    expect(nest.steward_count).toBe(0);
  });
});
