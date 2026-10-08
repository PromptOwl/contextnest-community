import { describe, it, expect, beforeEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

beforeEach(() => setupTestEnv());

// Submitting seals the draft into the engine's history chain. It already reads
// the history to see whether this version is sealed, and hands that read to
// createVersion — one read of history.yaml (a round trip on Cloud Storage), not two.
describe("submit for review: one history read", () => {
  it("seals the submitted version reading its history once", async () => {
    const app = await createTestApp("key");
    const owner = await registerUser(app, "owner@acme.com", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Submit IO" }, owner.apiKey);
    const nestId = nest.data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Draft", content: "draft body", status: "draft" },
      owner.apiKey,
    );
    const nodeId = created.data.node.id;

    const { NestStorage } = await import("@promptowl/contextnest-engine");
    const realReadHistory = (NestStorage.prototype as any).readHistory;
    let historyReads = 0;
    (NestStorage.prototype as any).readHistory = function (id: string, ...rest: any[]) {
      if (id === nodeId) historyReads++;
      return realReadHistory.call(this, id, ...rest);
    };
    let submitted;
    try {
      submitted = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes/${nodeId}/submit-review`,
        {},
        owner.apiKey,
      );
    } finally {
      (NestStorage.prototype as any).readHistory = realReadHistory;
    }

    expect(submitted.status).toBe(201);
    expect(historyReads).toBe(1);
    const { engineCache } = await import("../src/nodes/engine.js");
    const { storage } = await engineCache.get(nestId);
    const doc = await storage.readDocument(nodeId);
    const history = await storage.readHistory(nodeId);
    expect(history!.versions.at(-1)!.version).toBe(doc.frontmatter.version ?? 1);
    expect((await storage.verifyVaultIntegrity()).errors.filter((e) => e.document === nodeId)).toEqual([]);
  });
});
