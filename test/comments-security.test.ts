import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// Security regressions for the comments layer:
//  1. A node slug starting with "comments" must NOT be mistaken for a comment
//     action and skip the write-permission check (substring vs segment bug).
//  2. Resolve must be scoped to the node in the URL (no cross-node resolve).
//  3. Re-resolving must not overwrite the original resolver.
//  4. A non-numeric ?limit= must not silently empty the activity feed.
describe("comments: security & input hardening", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let reader: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let collisionNodeId: string; // slug starts with "comments"
  let nodeA: string;
  let nodeB: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
    owner = await registerUser(app, "owner@acme.com", "Owner");
    reader = await registerUser(app, "reader@acme.com", "Reader");

    const { data: nestData } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Sec Vault" },
      owner.apiKey,
    );
    nestId = nestData.nest.id;

    // reader = read-only collaborator (can comment, must NOT edit docs).
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "reader@acme.com", permission: "read" },
      owner.apiKey,
    );

    // Node whose slug starts with "comments" — the collision case.
    const { data: cn } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Comments Draft", content: "# Draft\n\nsecret" },
      owner.apiKey,
    );
    collisionNodeId = cn.node.id; // expected: nodes/comments-draft

    const { data: a } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Node A", content: "# A" },
      owner.apiKey,
    );
    nodeA = a.node.id;
    const { data: b } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Node B", content: "# B" },
      owner.apiKey,
    );
    nodeB = b.node.id;
  }, 30000);

  afterAll(() => env.cleanup());

  it("sanity: the collision node's slug really contains '/comments'", () => {
    expect(collisionNodeId).toBe("nodes/comments-draft");
    expect(`/nests/${nestId}/nodes/${collisionNodeId}`).toContain("/comments");
  });

  it("read-only collaborator CANNOT PATCH a 'comments*' node (no bypass)", async () => {
    const { status } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${collisionNodeId}`,
      { content: "# Hacked by a read-only user" },
      reader.apiKey,
    );
    // Middleware must require 'write' → 403 for a read collaborator. Before the
    // fix this returned a success status (the write check was skipped).
    expect(status).toBe(403);
  });

  it("read-only collaborator CAN still comment on that node", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${collisionNodeId}/comments`,
      { body: "looks good" },
      reader.apiKey,
    );
    expect(status).toBe(201);
  });

  it("resolve is scoped to the node in the URL (no cross-node resolve)", async () => {
    const { data: created } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeA}/comments`,
      { body: "on node A" },
      owner.apiKey,
    );
    const commentId = created.comment.id;

    // Resolve via node B's path with A's commentId → must fail.
    const wrong = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeB}/comments/${commentId}/resolve`,
      {},
      owner.apiKey,
    );
    expect(wrong.status).toBe(404);

    // Resolve via the correct node → ok.
    const right = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeA}/comments/${commentId}/resolve`,
      {},
      owner.apiKey,
    );
    expect(right.status).toBe(200);
    expect(right.data.comment.status).toBe("resolved");
    expect(right.data.comment.resolvedBy).toBe("owner@acme.com");

    // Re-resolving must be rejected (don't clobber the original resolver) —
    // 409 Conflict, distinct from the 404 "not found" path.
    const again = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeA}/comments/${commentId}/resolve`,
      {},
      reader.apiKey,
    );
    expect(again.status).toBe(409);
  });

  it("non-numeric ?limit= does not empty the activity feed", async () => {
    // Seed at least one event.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeB}/comments`,
      { body: "an event" },
      owner.apiKey,
    );
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeB}/activity?limit=abc`,
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.activity.length).toBeGreaterThanOrEqual(1);
  });
});
