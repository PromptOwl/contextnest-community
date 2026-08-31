/**
 * Unknown node `type` on create must fail as a clean 400 — not the opaque 500
 * it used to surface from deeper in the write path. Valid engine types and the
 * community extensions (artifact) still create normally.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Vault" }, owner.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env?.cleanup?.());

describe("node create — type validation", () => {
  it("rejects an unknown type with 400, not 500", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Bogus", content: "# x", type: "asset" },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/unknown node type/i);
    expect(String(res.data.error)).toContain("asset");
  });

  it("still accepts a core engine type", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "A Snippet", content: "# x", type: "snippet" },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.type).toBe("snippet");
  });

  it("still accepts the community artifact type", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "An Artifact", content: "<!doctype html><html></html>", type: "artifact" },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.type).toBe("artifact");
  });
});
