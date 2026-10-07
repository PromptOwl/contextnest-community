import { describe, it, expect, beforeEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

beforeEach(() => setupTestEnv());

// After the engine publish, approve mirrors the published version into
// node_versions. The publish just wrote the document through this process, so
// the discovery cache holds exactly those bytes — approve takes them from there
// instead of reading the file back (a round trip on a Cloud Storage mount).
describe("approve: version mirror from the cache", () => {
  it("mirrors the published body without reading the document back", async () => {
    const app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
    const { NestStorage } = await import("@promptowl/contextnest-engine");
    // Installed before the nest exists: the cache binds readDocument up front.
    const realRead = (NestStorage.prototype as any).readDocument;
    let counting = false;
    let reviewServiceReads = 0;
    (NestStorage.prototype as any).readDocument = function (...a: any[]) {
      // Count only reads made by the governance layer itself, not the engine's
      // own reads inside the publish.
      if (counting && /review-service/.test(new Error().stack!.split("\n")[2] ?? "")) {
        reviewServiceReads++;
      }
      return realRead.apply(this, a);
    };
    try {
      const owner = await registerUser(app, "owner@acme.com", "Owner");
      const nest = await jsonRequest(app, "POST", "/nests", { name: "Mirror" }, owner.apiKey);
      const nestId = nest.data.nest.id;
      await jsonRequest(
        app,
        "PATCH",
        `/nests/${nestId}/settings`,
        { allow_self_approve: true, stewardship_enabled: true },
        owner.apiKey,
      );
      const created = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Mirrored", content: "mirrored body", status: "draft" },
        owner.apiKey,
      );
      const nodeId = created.data.node.id;
      await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/submit-review`, {}, owner.apiKey);

      counting = true;
      const approved = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/approve`, {}, owner.apiKey);
      counting = false;
      expect(approved.status).toBe(200);
      expect(reviewServiceReads).toBe(0);

      // The mirrored row is the published version, hashed over the body on disk.
      const { getDb } = await import("../src/db/client.js");
      const { hashContent } = await import("../src/governance/version-service.js");
      const { engineCache } = await import("../src/nodes/engine.js");
      const { storage } = await engineCache.get(nestId);
      const onDisk = await storage.readDocument(nodeId);
      const row = (await getDb().get(
        `SELECT version, status, content_hash FROM node_versions
           WHERE nest_id = ? AND node_id = ? ORDER BY version DESC LIMIT 1`,
        [nestId, nodeId],
      )) as { version: number; status: string; content_hash: string };
      expect(row.version).toBe(onDisk.frontmatter.version);
      expect(row.status).toBe("published");
      expect(row.content_hash).toBe(hashContent(onDisk.body || ""));
    } finally {
      (NestStorage.prototype as any).readDocument = realRead;
    }
  });
});
