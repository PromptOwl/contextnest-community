import { describe, it, expect, beforeEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

beforeEach(() => setupTestEnv());

// Single approve publishes before it records anything, like bulk approve: a
// document the engine will not publish must not end up recorded as approved
// with only a server log line to say otherwise.
describe("approve: publish first, then record", () => {
  it("refuses an approval the engine cannot publish and leaves the review pending", async () => {
    const app = await createTestApp("key");
    const owner = await registerUser(app, "owner@acme.com", "Owner");
    const reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Publish First" }, owner.apiKey);
    const nestId = nest.data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "reviewer@acme.com", permission: "read" },
      owner.apiKey,
    );
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Unpublishable", content: "body", status: "draft" },
      owner.apiKey,
    );
    const nodeId = created.data.node.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/submit-review`, {}, owner.apiKey);

    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    await db.run(
      `INSERT INTO stewards (id, nest_id, scope, node_pattern, user_email, role, assigned_by)
       VALUES ('st-1', ?, 'document', ?, 'reviewer@acme.com', 'reviewer', 'owner@acme.com')`,
      [nestId, nodeId],
    );
    // The engine refuses to publish a rejected document.
    const { engineCache } = await import("../src/nodes/engine.js");
    const { serializeDocument } = await import("@promptowl/contextnest-engine");
    const { storage } = await engineCache.get(nestId);
    const doc = await storage.readDocument(nodeId);
    doc.frontmatter.status = "rejected";
    await storage.writeDocument(nodeId, serializeDocument(doc));

    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/approve`,
      {},
      reviewer.apiKey,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.data.error).toMatch(/^Couldn't publish this document:/);
    const review = (await db.get(
      "SELECT status FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC LIMIT 1",
      [nestId, nodeId],
    )) as { status: string };
    expect(review.status).toBe("pending");
    expect(
      await db.get("SELECT 1 FROM approved_versions WHERE nest_id = ? AND node_id = ?", [nestId, nodeId]),
    ).toBeUndefined();
    const inbox = await jsonRequest(app, "GET", "/me/notifications?unread=true", undefined, owner.apiKey);
    expect(inbox.data.notifications.some((n: any) => n.kind === "review_approved")).toBe(false);
  });
});
