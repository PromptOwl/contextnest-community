import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import { isIdUnderFolder } from "../src/nodes/service.js";

// Request-deletion workflow (CU-wdqcpzxqcm): an editor flags a stale node with
// a reason, an owner/admin deletes it or declines with a note. Asking is an
// editor's act — a read-only collaborator is refused outright (see the viewer
// test below), because someone who cannot change a document has no standing to
// propose destroying it.
describe("deletion requests", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let editor: { apiKey: string };
  let reader: { apiKey: string };
  let nestId: string;
  let staleNode: string;
  let keeperNode: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
    owner = await registerUser(app, "owner@acme.com", "Owner");
    editor = await registerUser(app, "editor@acme.com", "Editor");
    reader = await registerUser(app, "reader@acme.com", "Reader");

    const { data: nestData } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Deletion Vault" },
      owner.apiKey,
    );
    nestId = nestData.nest.id;

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
      `/nests/${nestId}/collaborators`,
      { email: "reader@acme.com", permission: "read" },
      owner.apiKey,
    );

    const { data: a } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Stale Doc", content: "# Stale" },
      owner.apiKey,
    );
    staleNode = a.node.id;
    const { data: b } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Keeper Doc", content: "# Keeper" },
      owner.apiKey,
    );
    keeperNode = b.node.id;
  }, 30000);

  afterAll(() => env.cleanup());

  it("a viewer cannot flag anything — not a node, not a folder, not the nest", async () => {
    // A read-only collaborator can see this document and nothing more. Asking
    // for it to be deleted is withheld, not merely unhonoured.
    const node = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${staleNode}/request-deletion`,
      { reason: "I don't like it" },
      reader.apiKey,
    );
    expect(node.status).toBe(403);

    const folder = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "folder", target: "legacy/api", reason: "nope" },
      reader.apiKey,
    );
    expect(folder.status).toBe(403);

    const nest = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "nest", reason: "nope" },
      reader.apiKey,
    );
    expect(nest.status).toBe(403);

    // Nothing was recorded — a refused request must not park a row.
    const { data: queue } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/deletion-requests?status=all`,
      undefined,
      owner.apiKey,
    );
    expect(queue.requests).toHaveLength(0);
  });

  it("an editor can flag a node, and can't delete it directly", async () => {
    const direct = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/${staleNode}`,
      undefined,
      reader.apiKey,
    );
    expect(direct.status).toBe(403);

    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${staleNode}/request-deletion`,
      { reason: "superseded by the new runbook" },
      editor.apiKey,
    );
    expect(status).toBe(201);
    expect(data.request.status).toBe("pending");
    expect(data.request.requestedBy).toBe("editor@acme.com");

    // The node read carries the flag, so the UI can badge the doc and drop
    // its "Request deletion" affordance instead of 409ing on a second click.
    const { data: node } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${staleNode}`,
      undefined,
      reader.apiKey,
    );
    expect(node.node.deletionRequest.status).toBe("pending");
    expect(node.node.deletionRequest.reason).toBe(
      "superseded by the new runbook",
    );
  });

  it("rejects an empty reason and a second pending flag on the same node", async () => {
    const empty = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${keeperNode}/request-deletion`,
      { reason: "   " },
      editor.apiKey,
    );
    expect(empty.status).toBe(400);

    const dup = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${staleNode}/request-deletion`,
      { reason: "again" },
      editor.apiKey,
    );
    expect(dup.status).toBe(409);
  });

  it("404s a flag on a node that doesn't exist", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/ghost/request-deletion`,
      { reason: "gone" },
      editor.apiKey,
    );
    expect(status).toBe(404);
  });

  it("puts the flag in the admin's /me/work inbox and notifications", async () => {
    // Owner can action it → waiting-on-me bucket, with the reason to judge by.
    const { data: ownerWork } = await jsonRequest(
      app,
      "GET",
      "/me/work",
      undefined,
      owner.apiKey,
    );
    const item = ownerWork.items.find((i: any) => i.type === "deletion");
    expect(item).toBeTruthy();
    expect(item.title).toBe("Stale Doc");
    expect(item.reason).toBe("superseded by the new runbook");
    expect(item.request_id).toBeTruthy();
    // And an inbox notification, so it's visible without opening the nest.
    expect(
      ownerWork.notifications.some((n: any) => n.kind === "deletion_requested"),
    ).toBe(true);

    // The requester sees their own flag as waiting-on-others, never as work
    // for them — they can't delete, that's the whole point.
    const { data: editorWork } = await jsonRequest(
      app,
      "GET",
      "/me/work",
      undefined,
      editor.apiKey,
    );
    expect(editorWork.items.some((i: any) => i.type === "deletion")).toBe(false);
    expect(editorWork.waiting.some((i: any) => i.type === "deletion")).toBe(true);
  });

  it("declining keeps the node and records the note", async () => {
    const { data: queue } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/deletion-requests`,
      undefined,
      owner.apiKey,
    );
    expect(queue.requests).toHaveLength(1);
    const req = queue.requests[0];
    expect(req.title).toBe("Stale Doc");

    const noNote = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${req.id}/decline`,
      {},
      owner.apiKey,
    );
    expect(noNote.status).toBe(400);

    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${req.id}/decline`,
      { note: "still referenced by onboarding" },
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.request.status).toBe("declined");
    expect(data.request.resolvedBy).toBe("owner@acme.com");

    // Node survives; the queue is empty again; declining twice 404s.
    const node = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${staleNode}`,
      undefined,
      owner.apiKey,
    );
    expect(node.status).toBe(200);
    // The verdict rides along on the node read — how the person who asked
    // learns it was declined, and why. The doc can be flagged again.
    expect(node.data.node.deletionRequest.status).toBe("declined");
    expect(node.data.node.deletionRequest.resolutionNote).toBe(
      "still referenced by onboarding",
    );

    const { data: after } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/deletion-requests`,
      undefined,
      owner.apiKey,
    );
    expect(after.requests).toHaveLength(0);

    // ?status=all keeps the declined row visible so the list view can badge
    // the node with the verdict, not just drop the flag silently.
    const { data: all } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/deletion-requests?status=all`,
      undefined,
      reader.apiKey,
    );
    expect(all.requests).toHaveLength(1);
    expect(all.requests[0].status).toBe("declined");

    const again = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${req.id}/decline`,
      { note: "again" },
      owner.apiKey,
    );
    expect(again.status).toBe(404);

    // The requester is told the verdict — otherwise the flag just vanishes.
    const { data: editorWork } = await jsonRequest(
      app,
      "GET",
      "/me/work",
      undefined,
      editor.apiKey,
    );
    const verdict = editorWork.notifications.find(
      (n: any) => n.kind === "deletion_declined",
    );
    expect(verdict).toBeTruthy();
    expect(verdict.message).toContain("still referenced by onboarding");
  });

  it("flags a folder, and honouring it deletes every document under it", async () => {
    // Two docs in the folder, one outside it that must survive.
    for (const title of ["Folder Doc A", "Folder Doc B"]) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title, content: "# x", folder: "legacy/api" },
        owner.apiKey,
      );
    }
    const { data: outside } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Untouched Doc", content: "# keep", folder: "legacy" },
      owner.apiKey,
    );

    const missing = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "folder", target: "no/such/folder", reason: "stale" },
      editor.apiKey,
    );
    expect(missing.status).toBe(404);

    // The direct folder delete is owner/admin-only — an editor gets the
    // request path instead, never the bulk delete.
    const editorDirect = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/delete-folder`,
      { folder: "legacy/api" },
      editor.apiKey,
    );
    expect(editorDirect.status).toBe(403);

    // Leading slash / "nodes/" prefix normalize to the same target.
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "folder", target: "/nodes/legacy/api/", reason: "dead api docs" },
      editor.apiKey,
    );
    expect(status).toBe(201);
    expect(data.request.targetType).toBe("folder");
    expect(data.request.nodeId).toBe("legacy/api");

    const dup = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "folder", target: "legacy/api", reason: "again" },
      editor.apiKey,
    );
    expect(dup.status).toBe(409);

    const { data: queue } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/deletion-requests`,
      undefined,
      owner.apiKey,
    );
    const folderReq = queue.requests.find((r: any) => r.targetType === "folder");
    // Human folder name in the queue, not the slug path on disk.
    expect(folderReq.title).toBe("Legacy / Api");
    expect(folderReq.nodeId).toBe("legacy/api");

    // A write collaborator clears the middleware's 'write' bar, but honouring
    // a FOLDER request is a bulk delete — same tier as /delete-folder, which
    // 403s them. Otherwise flag-then-honour is a side door around that route.
    await resetAuthRateLimit();
    const writer2 = await registerUser(app, "writer2@acme.com", "Writer2");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "writer2@acme.com", permission: "write" },
      owner.apiKey,
    );
    const escalation = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${folderReq.id}/delete`,
      {},
      writer2.apiKey,
    );
    expect(escalation.status).toBe(403);
    // Refused means nothing was deleted.
    const stillThere = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      owner.apiKey,
    );
    expect(
      stillThere.data.nodes.filter((n: any) =>
        n.id.startsWith("nodes/legacy/api/"),
      ),
    ).toHaveLength(2);

    const honoured = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${folderReq.id}/delete`,
      {},
      owner.apiKey,
    );
    expect(honoured.status).toBe(200);
    expect(honoured.data.deleted).toBe(true);

    // Both docs under the folder are gone; the sibling outside it survives.
    const { data: nodes } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      owner.apiKey,
    );
    const ids = nodes.nodes.map((n: any) => n.id);
    expect(ids.some((id: string) => id.startsWith("nodes/legacy/api/"))).toBe(false);
    expect(ids).toContain(outside.node.id);

    // Honoured → leaves the queue, like a document request does.
    const { data: after } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/deletion-requests?status=all`,
      undefined,
      owner.apiKey,
    );
    expect(after.requests.some((r: any) => r.id === folderReq.id)).toBe(false);
  });

  it("a reader can't resolve a request; a writer's delete removes the node", async () => {
    const { data: flagged } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${keeperNode}/request-deletion`,
      { reason: "duplicate" },
      editor.apiKey,
    );
    const id = flagged.request.id;

    const denied = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${id}/delete`,
      {},
      reader.apiKey,
    );
    expect(denied.status).toBe(403);

    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${id}/delete`,
      {},
      owner.apiKey,
    );
    expect(status).toBe(200);

    const gone = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${keeperNode}`,
      undefined,
      owner.apiKey,
    );
    expect(gone.status).toBe(404);

    // The honoured request is purged with the node's other rows, so a doc
    // later recreated at that id doesn't inherit a stale flag.
    const { data: queue2 } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/deletion-requests`,
      undefined,
      owner.apiKey,
    );
    expect(queue2.requests).toHaveLength(0);

    // The document is gone, so the notification is the ONLY way the requester
    // learns their flag was honoured — it must carry the title, not the id.
    const { data: editorWork } = await jsonRequest(
      app,
      "GET",
      "/me/work",
      undefined,
      editor.apiKey,
    );
    const verdict = editorWork.notifications.find(
      (n: any) => n.kind === "deletion_deleted",
    );
    expect(verdict).toBeTruthy();
    expect(verdict.message).toContain("Keeper Doc");
  });

  it("a nest flag is owner/admin-only to honour, and takes the nest with it", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "nest", reason: "project wound down" },
      editor.apiKey,
    );
    expect(status).toBe(201);
    expect(data.request.targetType).toBe("nest");
    // The label is the nest's name, not its uuid.
    expect(data.request.title ?? "").not.toBe(nestId);

    // A write collaborator clears the middleware's 'write' bar but must NOT be
    // able to delete a whole nest through the queue — DELETE /nests/:id is
    // owner-only, and this path can't be a way around it.
    await resetAuthRateLimit();
    const writer = await registerUser(app, "writer@acme.com", "Writer");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "writer@acme.com", permission: "write" },
      owner.apiKey,
    );
    const escalation = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${data.request.id}/delete`,
      {},
      writer.apiKey,
    );
    expect(escalation.status).toBe(403);

    // The nest still exists after the refused attempt.
    const alive = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}`,
      undefined,
      owner.apiKey,
    );
    expect(alive.status).toBe(200);

    const honoured = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${data.request.id}/delete`,
      {},
      owner.apiKey,
    );
    expect(honoured.status).toBe(200);

    const gone = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}`,
      undefined,
      owner.apiKey,
    );
    expect(gone.status).toBe(404);
  });
});

// A nest whose files arrived without a top-level nodes/ dir (e.g. a folder
// import that carried another nest's data dir) reads as FLAT layout in the
// engine, so its document ids carry no "nodes/" prefix. Folder flagging and
// folder delete both looked up `nodes/<folder>/` only and 404'd on those
// nests — "Folder not found" on a folder that is plainly there.
describe("isIdUnderFolder", () => {
  it("matches structured and flat layout ids", () => {
    expect(isIdUnderFolder("nodes/legacy/api/doc", "legacy/api")).toBe(true);
    expect(
      isIdUnderFolder("b006e456/nodes/personal/creds", "b006e456/nodes/personal"),
    ).toBe(true);
    expect(isIdUnderFolder("nodes/legacy/doc", "legacy/api")).toBe(false);
    // Sibling folder sharing a name prefix is not "under" it.
    expect(isIdUnderFolder("nodes/legacy-api/doc", "legacy/api")).toBe(false);
  });
});
