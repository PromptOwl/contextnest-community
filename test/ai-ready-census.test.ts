/**
 * A document whose newer version is in review or sent back is still serving
 * its published one. The list row says which version is live, and the
 * census's AI Ready count includes it (CU-wdqcq05mu8).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { getDb } from "../src/db/client.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Live" }, owner.apiKey)).data.nest.id;
  for (const title of ["Sent Back", "In Review", "Plain"]) {
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: "# v1" }, owner.apiKey)).status).toBe(201);
  }
  // A newer version past the published v1: one rejected, one awaiting review.
  for (const [id, status] of [["nodes/sent-back", "rejected"], ["nodes/in-review", "pending_review"]]) {
    await getDb().run(
      `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status)
       VALUES (?, ?, 2, 'h', ?, ?)`,
      [nestId, id, owner.email, status],
    );
  }
});

afterAll(() => env.cleanup());

describe("live published version", () => {
  it("counts every document with a published version as AI Ready", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/census`, undefined, owner.apiKey);
    expect(data.census.aiReady).toBe(3);
  });

  it("names the live version on each list row", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, owner.apiKey);
    const row = (id: string) => data.nodes.find((n: any) => n.id === id);
    expect(row("nodes/sent-back")).toMatchObject({ status: "rejected", approvedVersion: 1 });
    expect(row("nodes/in-review").approvedVersion).toBe(1);
    expect(row("nodes/plain")).toMatchObject({ status: "published", approvedVersion: 1 });
  });
});
