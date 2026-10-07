/**
 * Request access when a write is denied (CU-wdqcq041jn).
 *
 * A write refused for someone who can SEE the target used to be a dead end.
 * Now the 403 says they may ask (`can_request_access`, the target, the level),
 * `POST /nests/:id/access-requests` files the ask once, the nest owner/admins
 * get it in their inbox, and approving grants the access through the existing
 * share/collaborator paths, so the same write then succeeds. Hidden nests keep
 * their 404 with no hint. The same flow runs over MCP for agents.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeTargetForPath } from "../src/governance/access-request-service.js";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function callTool(
  app: any,
  nestId: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean; data?: any }> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  expect(payload.error).toBeUndefined();
  return {
    text: payload.result.content.map((c: any) => c.text).join(""),
    isError: payload.result.isError,
    data: payload.result.structuredContent,
  };
}

describe("request access on a denied write", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let admin: { apiKey: string; userId: string };
  let reader: { apiKey: string; userId: string };
  let grantee: { apiKey: string; userId: string };
  let stranger: { apiKey: string; userId: string };
  let nestId: string;
  let docId: string;
  let folderDocId: string;
  let otherDocId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    admin = await registerUser(app, "admin@acme.com", "Admin");
    await resetAuthRateLimit();
    reader = await registerUser(app, "reader@acme.com", "Reader");
    await resetAuthRateLimit();
    grantee = await registerUser(app, "grantee@acme.com", "Grantee");
    stranger = await registerUser(app, "stranger@acme.com", "Stranger");

    const { data: nestData } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Access Vault" },
      owner.apiKey,
    );
    nestId = nestData.nest.id;
    for (const [email, permission] of [
      ["admin@acme.com", "admin"],
      ["reader@acme.com", "read"],
    ]) {
      const r = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email, permission },
        owner.apiKey,
      );
      expect(r.status).toBe(201);
    }
    const mk = async (title: string, folder?: string) =>
      (
        await jsonRequest(
          app,
          "POST",
          `/nests/${nestId}/nodes`,
          { title, content: `# ${title}`, ...(folder ? { folder } : {}) },
          owner.apiKey,
        )
      ).data.node.id as string;
    docId = await mk("Pricing Notes");
    folderDocId = await mk("Deal Log", "gtm");
    otherDocId = await mk("Roadmap");

    // grantee reaches the nest only through a read share on one document.
    const g = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: docId, email: "grantee@acme.com", role: "read" },
      owner.apiKey,
    );
    expect(g.status).toBeLessThan(300);
  }, 30000);

  afterAll(() => env.cleanup());

  const patch = (key: string, id: string, content: string) =>
    jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content }, key);

  it("a viewer's refused edit says they can request write access to that document", async () => {
    const res = await patch(reader.apiKey, docId, "# edited");
    expect(res.status).toBe(403);
    expect(res.data).toMatchObject({
      code: "forbidden",
      can_request_access: true,
      target: { type: "node", id: docId },
      level: "write",
    });
    expect(typeof res.data.error).toBe("string");
  });

  it("a viewer's refused create points at the nest", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "New Doc", content: "x" },
      reader.apiKey,
    );
    expect(res.status).toBe(403);
    expect(res.data).toMatchObject({
      can_request_access: true,
      target: { type: "nest", id: nestId },
      level: "write",
    });
  });

  it("a read held at write tier is refused without an offer — only writes offer one", async () => {
    // The UI reads the roster on its own; offering "request access" there
    // would pop the prompt on a page the person only opened.
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/collaborators`, undefined, reader.apiKey);
    expect(res.status).toBe(403);
    expect(res.data.can_request_access).toBeUndefined();
  });

  it("a hidden nest stays a 404 with no hint", async () => {
    const res = await patch(stranger.apiKey, docId, "# edited");
    expect(res.status).toBe(404);
    expect(res.data.can_request_access).toBeUndefined();
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "nest", target_id: nestId, level: "write" },
      stranger.apiKey,
    );
    expect(ask.status).toBe(404);
  });

  it("files the request once, notifies the approvers, and shows it as pending", async () => {
    const first = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: docId, level: "write", note: "fixing typos" },
      reader.apiKey,
    );
    expect(first.status).toBe(201);
    expect(first.data.request).toMatchObject({
      status: "pending",
      target_type: "node",
      target_id: docId,
      level: "write",
      note: "fixing typos",
      requested_by: "reader@acme.com",
    });

    const again = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: docId, level: "write" },
      reader.apiKey,
    );
    expect(again.status).toBe(200);
    expect(again.data.request.id).toBe(first.data.request.id);

    // The next refused write carries the pending request, so the UI says
    // "Request pending" instead of offering a second ask.
    const denied = await patch(reader.apiKey, docId, "# edited");
    expect(denied.data.access_request).toMatchObject({
      id: first.data.request.id,
      status: "pending",
    });

    const mine = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/access-requests/mine?target_type=node&target_id=${encodeURIComponent(docId)}`,
      undefined,
      reader.apiKey,
    );
    expect(mine.status).toBe(200);
    expect(mine.data.request.status).toBe("pending");

    // Owner and admin both see it waiting on them; the requester sees it
    // waiting on others.
    for (const who of [owner, admin]) {
      const work = await jsonRequest(app, "GET", "/me/work", undefined, who.apiKey);
      expect(
        work.data.items.some(
          (i: any) => i.type === "access" && i.request_id === first.data.request.id,
        ),
      ).toBe(true);
    }
    const readerWork = await jsonRequest(app, "GET", "/me/work", undefined, reader.apiKey);
    expect(readerWork.data.items.some((i: any) => i.type === "access")).toBe(false);
    expect(
      readerWork.data.waiting.some(
        (i: any) => i.type === "access" && i.request_id === first.data.request.id,
      ),
    ).toBe(true);
    // Inbox row for the approver.
    expect(
      (await jsonRequest(app, "GET", "/me/work", undefined, owner.apiKey)).data.notifications.some(
        (n: any) => n.kind === "access_requested" && n.subject_id === first.data.request.id,
      ),
    ).toBe(true);
  });

  it("only the owner or a nest admin can decide; the requester cannot approve their own", async () => {
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/access-requests`,
      undefined,
      owner.apiKey,
    );
    const req = list.data.requests.find((r: any) => r.target_id === docId);
    const self = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests/${req.id}/approve`,
      {},
      reader.apiKey,
    );
    expect(self.status).toBe(403);
    // A viewer's list is only their own requests.
    const readerList = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/access-requests`,
      undefined,
      reader.apiKey,
    );
    expect(readerList.status).toBe(200);
    expect(
      readerList.data.requests.every((r: any) => r.requested_by === "reader@acme.com"),
    ).toBe(true);
  });

  it("approving a document request lets that edit through, and tells the requester", async () => {
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/access-requests`, undefined, admin.apiKey);
    const req = list.data.requests.find((r: any) => r.target_id === docId);
    const ok = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests/${req.id}/approve`,
      {},
      admin.apiKey,
    );
    expect(ok.status).toBe(200);
    expect(ok.data.request.status).toBe("approved");

    expect((await patch(reader.apiKey, docId, "# edited by reader")).status).toBe(200);
    // Only that document: the rest of the nest is still read-only for them.
    expect((await patch(reader.apiKey, otherDocId, "# nope")).status).toBe(403);

    const work = await jsonRequest(app, "GET", "/me/work", undefined, reader.apiKey);
    expect(
      work.data.notifications.some(
        (n: any) => n.kind === "access_approved" && n.subject_id === req.id,
      ),
    ).toBe(true);
    expect(work.data.waiting.some((i: any) => i.request_id === req.id)).toBe(false);
  });

  it("a denied request is visible on the next refusal, and can be asked again", async () => {
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      reader.apiKey,
    );
    expect(ask.status).toBe(201);
    const no = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests/${ask.data.request.id}/deny`,
      { note: "Roadmap is locked this week" },
      owner.apiKey,
    );
    expect(no.status).toBe(200);
    expect(no.data.request).toMatchObject({
      status: "denied",
      resolution_note: "Roadmap is locked this week",
      resolved_by: "owner@acme.com",
    });

    const denied = await patch(reader.apiKey, otherDocId, "# nope");
    expect(denied.status).toBe(403);
    expect(denied.data.access_request).toMatchObject({
      status: "denied",
      resolution_note: "Roadmap is locked this week",
    });

    const readerInbox = await jsonRequest(app, "GET", "/me/work", undefined, reader.apiKey);
    expect(
      readerInbox.data.notifications.some(
        (n: any) =>
          n.kind === "access_denied" &&
          n.subject_id === ask.data.request.id &&
          n.message.includes("Roadmap is locked this week"),
      ),
    ).toBe(true);

    const retry = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      reader.apiKey,
    );
    expect(retry.status).toBe(201);
    expect(retry.data.request.id).not.toBe(ask.data.request.id);
  });

  it("approving a folder request opens every document under it", async () => {
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "folder", target_id: "gtm", level: "write" },
      reader.apiKey,
    );
    expect(ask.status).toBe(201);
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests/${ask.data.request.id}/approve`,
      {},
      owner.apiKey,
    );
    expect((await patch(reader.apiKey, folderDocId, "# deal edit")).status).toBe(200);
  });

  it("someone reaching the nest only through a share can ask, and approval works", async () => {
    const refused = await patch(grantee.apiKey, docId, "# grantee edit");
    expect(refused.status).toBe(403);
    expect(refused.data).toMatchObject({
      can_request_access: true,
      target: { type: "node", id: docId },
    });
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: docId, level: "write" },
      grantee.apiKey,
    );
    expect(ask.status).toBe(201);
    // A grantee can't ask about a document they can't see.
    const blind = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      grantee.apiKey,
    );
    expect(blind.status).toBe(404);
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests/${ask.data.request.id}/approve`,
      {},
      owner.apiKey,
    );
    expect((await patch(grantee.apiKey, docId, "# grantee edit")).status).toBe(200);
  });

  it("approving a nest request makes the requester a write collaborator", async () => {
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "nest", target_id: nestId, level: "write" },
      reader.apiKey,
    );
    expect(ask.status).toBe(201);
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests/${ask.data.request.id}/approve`,
      {},
      owner.apiKey,
    );
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Reader Doc", content: "x" },
      reader.apiKey,
    );
    expect(created.status).toBe(201);
  });

  it("refuses a request for access the caller already has", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "nest", target_id: nestId, level: "write" },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("over MCP: a refused edit says how to ask, and context_request_access files it", async () => {
    await resetAuthRateLimit();
    const viewer = await registerUser(app, "agent-viewer@acme.com", "Agent Viewer");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "agent-viewer@acme.com", permission: "read" },
      owner.apiKey,
    );
    const refused = await callTool(app, nestId, viewer.apiKey, "context_update", {
      id: otherDocId,
      content: "# agent edit",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/context_request_access/);
    expect(refused.data).toMatchObject({
      code: "UNAUTHORIZED_ACTION",
      can_request_access: true,
      target: { type: "node", id: otherDocId },
      level: "write",
    });

    const filed = await callTool(app, nestId, viewer.apiKey, "context_request_access", {
      id: otherDocId,
      note: "agent needs to refresh stale pricing",
    });
    expect(filed.isError).toBeFalsy();
    expect(filed.data).toMatchObject({ status: "pending", target_type: "node", target_id: otherDocId });

    const queue = await callTool(app, nestId, owner.apiKey, "context_access_requests", {});
    expect(queue.text).toMatch(/agent-viewer@acme.com/);
    const decided = await callTool(app, nestId, owner.apiKey, "context_resolve_access_request", {
      request_id: filed.data.id,
      decision: "approve",
    });
    expect(decided.isError).toBeFalsy();
    const retried = await callTool(app, nestId, viewer.apiKey, "context_update", {
      id: otherDocId,
      content: "# agent edit",
    });
    expect(retried.isError).toBeFalsy();
  });
});

describe("writeTargetForPath", () => {
  const n = "nest-1";
  it("names the document on its own write routes, without the action suffix", () => {
    expect(writeTargetForPath(n, [n, "nodes", "nodes", "gtm", "deal"], "PATCH")).toEqual({
      type: "node",
      id: "nodes/gtm/deal",
    });
    expect(writeTargetForPath(n, [n, "nodes", "nodes", "deal", "revert"], "POST")).toEqual({
      type: "node",
      id: "nodes/deal",
    });
    expect(writeTargetForPath(n, [n, "nodes", "nodes", "deal", "watchers"], "DELETE")).toEqual({
      type: "node",
      id: "nodes/deal",
    });
  });
  it("keeps a document whose slug looks like an action", () => {
    expect(writeTargetForPath(n, [n, "nodes", "nodes", "move"], "DELETE")).toEqual({
      type: "node",
      id: "nodes/move",
    });
  });
  it("names the nest for creates, uploads and nest-level writes", () => {
    expect(writeTargetForPath(n, [n, "nodes"], "POST")).toEqual({ type: "nest", id: n });
    expect(writeTargetForPath(n, [n, "nodes", "pdf"], "POST")).toEqual({ type: "nest", id: n });
    expect(writeTargetForPath(n, [n, "edges"], "POST")).toEqual({ type: "nest", id: n });
  });
});
