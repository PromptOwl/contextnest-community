import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// Archive a nest instead of deleting it (CU-wdqcpzy80h).
//
// The whole feature rests on two guarantees, and these are the tests for them:
// an archived nest is READ-ONLY everywhere (one cap in resolveNestAccess), and
// it is ABSENT from every listing that isn't the Archived tab — which is what
// takes its pending reviews out of the work inbox and its documents out of
// cross-nest search, for free. Restore has to put all of that back.
describe("nest archive", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let editor: { apiKey: string };
  let nestId: string;
  let otherNestId: string;
  let nodeId: string;
  let hookToken: string;

  beforeAll(async () => {
    // The trigger-hook and scheduler cases below are workflow-plane surfaces.
    process.env.FEATURE_WORKFLOW_PLANE = "true";
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    editor = await registerUser(app, "editor@acme.com", "Editor");

    const { data: nest } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Wound Down" },
      owner.apiKey,
    );
    nestId = nest.nest.id;

    // A second, live nest — so "the list is empty" can never pass a test that
    // means "the archived one is gone".
    const { data: other } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Still Running" },
      owner.apiKey,
    );
    otherNestId = other.nest.id;

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "editor@acme.com", permission: "write" },
      owner.apiKey,
    );

    const { data: node } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Zarquon Protocol", content: "# Zarquon Protocol" },
      owner.apiKey,
    );
    nodeId = node.node.id;

    // An agent node with a live webhook trigger and an enabled schedule — the
    // two ways a nest keeps working with nobody logged in.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Digest Agent", content: "# Digest", type: "agent" },
      owner.apiKey,
    );
    const { data: hook } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/hooks`,
      { agent_node: "nodes/digest-agent", preset: "webhook" },
      owner.apiKey,
    );
    hookToken = hook.hook.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/schedules`,
      { agent_node: "nodes/digest-agent", every_minutes: 60 },
      owner.apiKey,
    );
  }, 30000);

  const fireHook = (token: string) =>
    app.request(`http://localhost/hooks/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: "Foley" }),
    });

  afterAll(() => {
    delete process.env.FEATURE_WORKFLOW_PLANE;
    env.cleanup();
  });

  it("archives, hides from the default list, and shows under ?archived=1", async () => {
    const archived = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/archive`,
      {},
      owner.apiKey,
    );
    expect(archived.status).toBe(200);

    const live = await jsonRequest(app, "GET", "/nests", null, owner.apiKey);
    expect(live.data.nests.map((n: any) => n.id)).toEqual([otherNestId]);

    const put = await jsonRequest(
      app,
      "GET",
      "/nests?archived=1",
      null,
      owner.apiKey,
    );
    expect(put.data.nests.map((n: any) => n.id)).toEqual([nestId]);
    expect(put.data.nests[0].archived_at).toBeTruthy();
    // Capped at 'read', but still the owner's to restore or delete — the card
    // renders its actions off is_owner, so losing it would strand the nest.
    expect(put.data.nests[0].is_owner).toBe(true);
  });

  it("is readable but refuses every write, the owner's included", async () => {
    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}`,
      null,
      owner.apiKey,
    );
    expect(read.status).toBe(200);

    const write = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# Edited while archived" },
      owner.apiKey,
    );
    expect(write.status).toBe(403);

    const create = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "New While Archived", content: "# No" },
      editor.apiKey,
    );
    expect(create.status).toBe(403);
  });

  it("drops out of cross-nest search while archived", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=Zarquon",
      null,
      owner.apiKey,
    );
    expect(data.nodes.every((n: any) => n.nest_id !== nestId)).toBe(true);
  });

  // Both surfaces below run with nobody logged in — a webhook POST carries only
  // its token, and the scheduler tick has no request at all — so the read-only
  // permission cap never reaches either. Without their own archived check an
  // archived nest goes on firing agent runs, which is what archiving is for.
  it("stops answering its trigger hooks while archived", async () => {
    const res = await fireHook(hookToken);
    expect(res.status).toBe(404);
  });

  it("is skipped by the scheduler while archived", async () => {
    const { schedulerTick } = await import("../src/workflow/scheduler.js");
    const created = await schedulerTick(Date.now());
    expect(created.length).toBe(0);
  });

  it("is invisible to MCP by id, not just absent from the index", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/mcp`,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      owner.apiKey,
    );
    expect(status).toBe(404);
  });

  it("restores, and the nest works again exactly as before", async () => {
    const restored = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/restore`,
      {},
      owner.apiKey,
    );
    expect(restored.status).toBe(200);

    const live = await jsonRequest(app, "GET", "/nests", null, owner.apiKey);
    expect(live.data.nests.map((n: any) => n.id).sort()).toEqual(
      [nestId, otherNestId].sort(),
    );

    const write = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# Edited after restore" },
      owner.apiKey,
    );
    expect(write.status).toBe(200);

    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=Zarquon",
      null,
      owner.apiKey,
    );
    expect(data.nodes.some((n: any) => n.nest_id === nestId)).toBe(true);

    // Automation comes back too — archiving suspends hooks and schedules, it
    // does not disable them, so restoring needs no re-wiring.
    const fired = await fireHook(hookToken);
    expect(fired.status).toBe(201);
  });

  it("archiving answers a pending archive request instead of stranding it", async () => {
    const asked = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "nest_archive", target: nestId, reason: "wound down" },
      editor.apiKey,
    );
    expect(asked.status).toBe(201);

    // The owner archives directly rather than through the queue — nothing stops
    // them, and it grants exactly what was asked for.
    await jsonRequest(app, "POST", `/nests/${nestId}/archive`, {}, owner.apiKey);

    // The request must not survive: an archived nest caps everyone at read, so
    // a row left pending could never be actioned from the queue again.
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/deletion-requests?status=pending`,
      null,
      owner.apiKey,
    );
    expect(
      data.requests.filter((r: any) => r.targetType === "nest_archive"),
    ).toEqual([]);

    await jsonRequest(app, "POST", `/nests/${nestId}/restore`, {}, owner.apiKey);
  });

  it("an editor can only REQUEST an archive; honouring it archives, not deletes", async () => {
    const asked = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      {
        targetType: "nest_archive",
        target: nestId,
        reason: "project wound down",
      },
      editor.apiKey,
    );
    expect(asked.status).toBe(201);

    // The editor cannot act on their own ask — same bar as deleting outright.
    const selfHonour = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${asked.data.request.id}/delete`,
      {},
      editor.apiKey,
    );
    expect(selfHonour.status).toBe(403);

    const honoured = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${asked.data.request.id}/delete`,
      {},
      owner.apiKey,
    );
    expect(honoured.status).toBe(200);

    // Archived, NOT deleted — the documents are still there to restore to.
    const put = await jsonRequest(
      app,
      "GET",
      "/nests?archived=1",
      null,
      owner.apiKey,
    );
    expect(put.data.nests.map((n: any) => n.id)).toEqual([nestId]);
    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}`,
      null,
      owner.apiKey,
    );
    expect(read.status).toBe(200);
  });
});
