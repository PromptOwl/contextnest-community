import { describe, it, expect, beforeEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

beforeEach(() => setupTestEnv());

// Bulk approve publishes every approvable document in ONE engine call: one
// checkpoint and one index rebuild for the batch. Per document it records the
// same rows and notifies the same people as a single approve, and a document
// that cannot be approved — not pending, not the caller's to approve, refused
// by the engine — fails on its own and stays exactly as it was.
describe("bulk approve: one batched publish", () => {
  it("approves the batch with one checkpoint and isolates every kind of failure", async () => {
    const app = await createTestApp("key");
    const owner = await registerUser(app, "owner@acme.com", "Owner");
    const reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Bulk" }, owner.apiKey);
    const nestId = nest.data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "reviewer@acme.com", permission: "read" },
      owner.apiKey,
    );

    const make = async (title: string, submit: boolean) => {
      const { data } = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title, content: `${title} body`, status: "draft" },
        owner.apiKey,
      );
      if (submit) {
        await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${data.node.id}/submit-review`, {}, owner.apiKey);
      }
      return data.node.id as string;
    };
    const ok = [await make("One", true), await make("Two", true), await make("Three", true)];
    const notPending = await make("Not Pending", false);
    const notMine = await make("Not Mine", true);
    const refused = await make("Refused", true);

    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    // The reviewer is a document-scope reviewer on everything except notMine.
    for (const [i, node] of [...ok, notPending, refused].entries()) {
      await db.run(
        `INSERT INTO stewards (id, nest_id, scope, node_pattern, user_email, role, assigned_by)
         VALUES (?, ?, 'document', ?, 'reviewer@acme.com', 'reviewer', 'owner@acme.com')`,
        [`st-${i}`, nestId, node],
      );
    }
    // The engine refuses to publish a rejected document.
    const { engineCache } = await import("../src/nodes/engine.js");
    const { serializeDocument } = await import("@promptowl/contextnest-engine");
    const { storage } = await engineCache.get(nestId);
    const doc = await storage.readDocument(refused);
    doc.frontmatter.status = "rejected";
    await storage.writeDocument(refused, serializeDocument(doc));

    const checkpointsBefore = (await storage.readCheckpointHistory())?.checkpoints.length ?? 0;
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/review-queue/bulk`,
      { action: "approve", nodeIds: [...ok, notPending, notMine, refused], note: "LGTM batch" },
      reviewer.apiKey,
    );

    expect(res.status).toBe(200);
    expect(res.data.succeeded).toBe(3);
    const byNode = new Map(res.data.results.map((r: any) => [r.nodeId, r]));
    for (const id of ok) expect(byNode.get(id)).toEqual({ nodeId: id, ok: true });
    expect((byNode.get(notPending) as any).error).toBe("No pending review for this node");
    expect((byNode.get(notMine) as any).ok).toBe(false);
    expect((byNode.get(refused) as any).ok).toBe(false);

    // One checkpoint for the whole batch, not one per document.
    expect((await storage.readCheckpointHistory())!.checkpoints.length).toBe(checkpointsBefore + 1);

    for (const id of ok) {
      const onDisk = await storage.readDocument(id);
      expect(onDisk.frontmatter.status).toBe("published");
      expect((await storage.readHistory(id))!.versions.at(-1)!.note).toBe("LGTM batch");
      const review = (await db.get(
        "SELECT status, resolved_by FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC LIMIT 1",
        [nestId, id],
      )) as { status: string; resolved_by: string };
      expect(review).toEqual({ status: "approved", resolved_by: "reviewer@acme.com" });
      const latest = (await db.get(
        "SELECT version, status FROM node_versions WHERE nest_id = ? AND node_id = ? ORDER BY version DESC LIMIT 1",
        [nestId, id],
      )) as { version: number; status: string };
      expect(latest).toEqual({ version: onDisk.frontmatter.version, status: "published" });
      const pin = (await db.get(
        "SELECT approved_version FROM approved_versions WHERE nest_id = ? AND node_id = ?",
        [nestId, id],
      )) as { approved_version: number };
      expect(pin.approved_version).toBe(onDisk.frontmatter.version);
    }

    // Failures were left untouched: still pending, never pinned.
    for (const id of [notMine, refused]) {
      const review = (await db.get(
        "SELECT status FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC LIMIT 1",
        [nestId, id],
      )) as { status: string };
      expect(review.status).toBe("pending");
      expect(
        await db.get("SELECT 1 FROM approved_versions WHERE nest_id = ? AND node_id = ?", [nestId, id]),
      ).toBeUndefined();
    }

    // The submitter hears each verdict.
    const inbox = await jsonRequest(app, "GET", "/me/notifications?unread=true", undefined, owner.apiKey);
    const verdicts = inbox.data.notifications.filter(
      (n: any) => n.kind === "review_approved" && n.nest_id === nestId,
    );
    expect(verdicts).toHaveLength(3);

    const report = await storage.verifyVaultIntegrity();
    expect(report.errors.filter((e) => ok.includes(e.document as string))).toEqual([]);
  });
});
