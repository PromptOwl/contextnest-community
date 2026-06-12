/**
 * POST /nests/:id/nodes/:nodeId/revert — restore an earlier version.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let nodeId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
  const created = await jsonRequest(app, "POST", "/nests", {
    name: "Revert Test Nest",
  });
  nestId = created.data.nest.id;
  const node = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Revert Me",
    content: "# V1\n\noriginal body",
    tags: ["x"],
  });
  nodeId = node.data.node.id;
});

afterAll(() => env.cleanup());

describe("POST /nests/:id/nodes/:nodeId/revert", () => {
  it("400s without a targetVersion", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/revert`,
      {},
    );
    expect(status).toBe(400);
  });

  it("restores an earlier version as a new version", async () => {
    // Bump to v2, then revert back to v1.
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${nodeId}`, {
      content: "# V2\n\nsecond body",
    });
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/revert`,
      { targetVersion: 1 },
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.version).toBeGreaterThan(2);
  });
});
