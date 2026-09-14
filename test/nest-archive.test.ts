import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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

    // The owner's notification must use archive terminology, not the deletion
    // wording the same code path uses for a real delete request — QA caught it
    // still saying "flagged for deletion" for an archive ask.
    const { data: ownerWork } = await jsonRequest(
      app,
      "GET",
      "/me/work",
      undefined,
      owner.apiKey,
    );
    const notification = ownerWork.notifications.find(
      (n: any) => n.kind === "deletion_requested",
    );
    expect(notification).toBeTruthy();
    expect(notification.message).toContain("was requested to be archived by");
    expect(notification.message).not.toContain("flagged for deletion");

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

  // The documented limitation, pinned so it cannot drift unnoticed. A pending
  // DELETION request is not answered by archiving — the two ask for different
  // outcomes — so it survives, and the honour route needs write tier, which an
  // archived nest denies everyone. The owner is not stuck: DELETE never passes
  // through the nest middleware, so deleting the nest outright still works and
  // takes the request row with it. See API.md.
  it("leaves a pending nest DELETION request unactionable while archived, but the nest still deletable", async () => {
    const asked = await jsonRequest(
      app,
      "POST",
      `/nests/${otherNestId}/request-deletion`,
      { targetType: "nest", target: otherNestId, reason: "superseded" },
      owner.apiKey,
    );
    expect(asked.status).toBe(201);

    await jsonRequest(
      app,
      "POST",
      `/nests/${otherNestId}/archive`,
      {},
      owner.apiKey,
    );

    // Survives the archive — it asked for deletion, which has not happened.
    const queue = await jsonRequest(
      app,
      "GET",
      `/nests/${otherNestId}/deletion-requests?status=pending`,
      null,
      owner.apiKey,
    );
    expect(
      queue.data.requests.some((r: any) => r.targetType === "nest"),
    ).toBe(true);

    // ...and cannot be honoured from the queue: write tier, which the cap denies.
    const honour = await jsonRequest(
      app,
      "POST",
      `/nests/${otherNestId}/deletion-requests/${asked.data.request.id}/delete`,
      {},
      owner.apiKey,
    );
    expect(honour.status).toBe(403);

    // The way out: delete the nest directly. Still open to its owner.
    const deleted = await jsonRequest(
      app,
      "DELETE",
      `/nests/${otherNestId}`,
      null,
      owner.apiKey,
    );
    expect(deleted.status).toBe(200);
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

// Open mode grants every caller "owner" outright and returns before the
// permission merge, so the archived cap never reaches it. That is the posture
// where a local agent is most likely pointed straight at a nest over MCP, so
// "archived is read-only" has to hold here too — and it needs its own app,
// because the suite above runs entirely in key mode.
describe("nest archive — open mode", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let user: { apiKey: string };
  let nestId: string;
  let nodeId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    user = await registerUser(app, "solo@acme.com", "Solo");

    const { data: nest } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Local Vault" },
      user.apiKey,
    );
    nestId = nest.nest.id;
    const { data: node } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Local Doc", content: "# Local" },
      user.apiKey,
    );
    nodeId = node.node.id;

    await jsonRequest(app, "POST", `/nests/${nestId}/archive`, {}, user.apiKey);
  }, 30000);

  afterAll(() => env.cleanup());

  it("still refuses writes even though everyone is 'owner' here", async () => {
    const write = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# Edited while archived" },
      user.apiKey,
    );
    expect(write.status).toBe(403);

    const create = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "New While Archived", content: "# No" },
      user.apiKey,
    );
    expect(create.status).toBe(403);
  });

  it("still reads, and still closes the MCP transport", async () => {
    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}`,
      null,
      user.apiKey,
    );
    expect(read.status).toBe(200);

    const mcp = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/mcp`,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      user.apiKey,
    );
    expect(mcp.status).toBe(404);
  });

  it("can still be restored — the cap must not strand the nest", async () => {
    const restored = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/restore`,
      {},
      user.apiKey,
    );
    expect(restored.status).toBe(200);

    const write = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# Edited after restore" },
      user.apiKey,
    );
    expect(write.status).toBe(200);
  });
});

// The MCP tool is a PARALLEL implementation of the REST honour route, so a
// target type missing from its switch does not fall through to something
// sensible: nest_archive reached the document branch with a nodeId that is
// really a nest id and threw "Node not found", leaving the request unactionable
// from that surface (CU-wdqcpzy80h review).
describe("nest archive — honouring an archive request over MCP", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let editor: { apiKey: string };
  let nestId: string;

  const mcpHeaders = (key: string) => ({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${key}`,
  });

  const callTool = async (key: string, name: string, args: any) => {
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: mcpHeaders(key),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("application/json")
      ? await res.json()
      : JSON.parse(
          (await res.text())
            .split("\n")
            .find((l: string) => l.startsWith("data: "))!
            .slice(6),
        );
    return (body.result?.content ?? []).map((x: any) => x.text).join("");
  };

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    editor = await registerUser(app, "editor@acme.com", "Editor");
    const { data: nest } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Mcp Archive" },
      owner.apiKey,
    );
    nestId = nest.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "editor@acme.com", permission: "write" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Keeper", content: "# Keeper" },
      owner.apiKey,
    );
  }, 30000);

  afterAll(() => env.cleanup());

  it("archives the nest instead of erroring on a bogus node id", async () => {
    const asked = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "nest_archive", target: nestId, reason: "wound down" },
      editor.apiKey,
    );
    expect(asked.status).toBe(201);

    const out = await callTool(owner.apiKey, "context_resolve_deletion", {
      request_id: asked.data.request.id,
      action: "delete",
    });
    expect(out).toContain("Archived");
    expect(out).not.toContain("Not found");
    expect(out).not.toContain("Irreversible");

    // Archived, not deleted — and now absent from the live list.
    const live = await jsonRequest(app, "GET", "/nests", null, owner.apiKey);
    expect(live.data.nests.map((n: any) => n.id)).not.toContain(nestId);
    const put = await jsonRequest(
      app,
      "GET",
      "/nests?archived=1",
      null,
      owner.apiKey,
    );
    expect(put.data.nests.map((n: any) => n.id)).toEqual([nestId]);
  });
});

// The cap in resolveNestAccess clamps the NEST-WIDE permission. Two callers
// reach a write without one: a document/folder grantee (no collaborator row,
// so the merge is already "none" and there is nothing to clamp) and an editor
// steward (whose bypass fires precisely on the "read" shape the cap creates).
// Both are capped where they resolve — resolveNodeGrant and the bypass guard.
describe("nest archive — callers that bypass the nest-wide permission", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; email: string };
  let guest: { apiKey: string; email: string };
  let stewardUser: { apiKey: string; email: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    guest = await registerUser(app, "guest@acme.com", "Guest");
    stewardUser = await registerUser(app, "steward@acme.com", "Steward");

    const { data: nest } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Shared Then Archived" },
      owner.apiKey,
    );
    nestId = nest.nest.id;

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Shared One", content: "# shared" },
      owner.apiKey,
    );
    // A write grant on that document — guest is NOT a collaborator.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      {
        target_type: "document",
        target: "nodes/shared-one",
        email: guest.email,
        role: "write",
      },
      owner.apiKey,
    );
    // A read collaborator who is also a nest-scope editor steward — the pair
    // the bypass exists for.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: stewardUser.email, permission: "read" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", email: stewardUser.email, role: "editor" },
      owner.apiKey,
    );
  }, 30000);

  afterAll(() => env.cleanup());

  it("a write grantee can edit while the nest is live, and not once archived", async () => {
    const before = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      { content: "# edited while live" },
      guest.apiKey,
    );
    expect(before.status).toBe(200);

    const archived = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/archive`,
      {},
      owner.apiKey,
    );
    expect(archived.status).toBe(200);

    const after = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      { content: "# edited after archive" },
      guest.apiKey,
    );
    expect(after.status).toBe(403);

    // Still readable — the grant is capped to read, not revoked.
    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      null,
      guest.apiKey,
    );
    expect(read.status).toBe(200);

    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      null,
      guest.apiKey,
    );
    expect(del.status).toBe(403);
  });

  it("an editor steward's bypass does not survive the archive", async () => {
    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      { content: "# steward edit" },
      stewardUser.apiKey,
    );
    expect(patch.status).toBe(403);

    const restored = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/restore`,
      {},
      owner.apiKey,
    );
    expect(restored.status).toBe(200);

    // Restore hands both callers their write back.
    const again = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      { content: "# steward edit after restore" },
      stewardUser.apiKey,
    );
    expect(again.status).toBe(200);
    const grantee = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      { content: "# grantee edit after restore" },
      guest.apiKey,
    );
    expect(grantee.status).toBe(200);
  });
});

// The drift scanner is a background surface like trigger hooks and the
// scheduler: it STAGES suggestion files and marks the index stale, so it must
// stop on an archived nest. The GET ?refresh=true path is the sharp edge — a
// GET slips past the middleware's write-tier bump, so the gate has to live in
// scanNestForDrift itself.
describe("nest archive — drift scanner", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;
  let nodeId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    const { data: nest } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Drifting Then Archived" },
      owner.apiKey,
    );
    nestId = nest.nest.id;
    const { data: node } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Rate Limits", content: "# Rate Limits\n\n100 rpm.\n" },
      owner.apiKey,
    );
    nodeId = node.node.id;
  }, 30000);

  afterAll(() => env.cleanup());

  it("stages nothing while archived, and picks the same edit up after restore", async () => {
    const nestDir = join(process.env.DATA_ROOT!, "nests", nestId);
    const docFile = (
      readdirSync(nestDir, { recursive: true } as any) as string[]
    )
      .map(String)
      .find(
        (f) =>
          f.endsWith(".md") &&
          f.includes("nodes") &&
          !f.endsWith("INDEX.md") &&
          !f.endsWith("CONTEXT.md"),
      );
    expect(docFile).toBeTruthy();
    const docPath = join(nestDir, docFile!);

    await jsonRequest(app, "POST", `/nests/${nestId}/archive`, {}, owner.apiKey);
    writeFileSync(docPath, readFileSync(docPath, "utf-8") + "\n\nEdited on disk.\n");

    // The GET refresh path — a write side effect behind a read-tier method.
    const refreshed = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/external-edits?refresh=true`,
      undefined,
      owner.apiKey,
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.data.entries).toEqual([]);

    const pending = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/external-edits`,
      undefined,
      owner.apiKey,
    );
    expect(pending.data.pending).toBeFalsy();

    // Restore, and the very same on-disk edit is staged — the scan was
    // suspended, not the drift lost.
    await jsonRequest(app, "POST", `/nests/${nestId}/restore`, {}, owner.apiKey);
    const after = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/external-edits?refresh=true`,
      undefined,
      owner.apiKey,
    );
    expect(after.data.entries.length).toBe(1);
  });
});

// The Archived tab sorts by archived_at, not created_at — so a nest archived
// long after it was created still surfaces at the top when it's the one most
// recently put away.
describe("nest archive — archived list ordering", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let firstId: string;
  let secondId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");

    // Created out of archive order: "First" predates "Second" but is
    // archived after it, so created_at DESC and archived_at DESC disagree.
    const { data: first } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "First" },
      owner.apiKey,
    );
    firstId = first.nest.id;
    const { data: second } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Second" },
      owner.apiKey,
    );
    secondId = second.nest.id;

    await jsonRequest(app, "POST", `/nests/${secondId}/archive`, {}, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${firstId}/archive`, {}, owner.apiKey);
  }, 30000);

  afterAll(() => env.cleanup());

  it("orders the archived list by archived_at DESC, not created_at DESC", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      "/nests?archived=1",
      null,
      owner.apiKey,
    );
    expect(data.nests.map((n: any) => n.id)).toEqual([firstId, secondId]);
  });
});
