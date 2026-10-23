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
  // Mutated by the plan-limit case; read by the mocked license on every call.
  const plan: { maxSubscribers?: number | null } = {};
  const db = async () => (await import("../src/db/client.js")).getDb();

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { entitlement: plan });
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
    // …and when asking opens again, so the client can say so instead of
    // offering a button that 429s.
    expect(Date.parse(denied.data.access_request.can_ask_again_at)).toBeGreaterThan(Date.now());

    const readerInbox = await jsonRequest(app, "GET", "/me/work", undefined, reader.apiKey);
    expect(
      readerInbox.data.notifications.some(
        (n: any) =>
          n.kind === "access_denied" &&
          n.subject_id === ask.data.request.id &&
          n.message.includes("Roadmap is locked this week"),
      ),
    ).toBe(true);

    // A "no" holds for a while, so a denied person can't re-file on every
    // refused save and flood the admins.
    const tooSoon = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      reader.apiKey,
    );
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.data.error).toMatch(/ask again in \d+ minute/);

    // After the cooldown they can ask again.
    await (await db()).run(
      "UPDATE access_requests SET resolved_at = '2000-01-01 00:00:00' WHERE id = ?",
      [ask.data.request.id],
    );
    const retry = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      reader.apiKey,
    );
    expect(retry.status).toBe(201);
    expect(retry.data.request.id).not.toBe(ask.data.request.id);
    // Leave nothing pending on this document for the cases below.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests/${retry.data.request.id}/deny`,
      {},
      owner.apiKey,
    );
    await (await db()).run(
      "UPDATE access_requests SET resolved_at = '2000-01-01 00:00:00' WHERE id = ?",
      [retry.data.request.id],
    );
  });

  it("an approve and a deny racing: exactly one lands, and access matches the row", async () => {
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      reader.apiKey,
    );
    expect(ask.status).toBe(201);
    const id = ask.data.request.id;
    const [a, d] = await Promise.all([
      jsonRequest(app, "POST", `/nests/${nestId}/access-requests/${id}/approve`, {}, owner.apiKey),
      jsonRequest(app, "POST", `/nests/${nestId}/access-requests/${id}/deny`, {}, admin.apiKey),
    ]);
    expect([a.status, d.status].sort()).toEqual([200, 404]);
    const row = (await (await db()).get("SELECT status FROM access_requests WHERE id = ?", [id])) as {
      status: string;
    };
    const edit = await patch(reader.apiKey, otherDocId, "# race");
    expect(edit.status).toBe(row.status === "approved" ? 200 : 403);
    // Put the document back to read-only for the reader, whatever won.
    await (await db()).run(
      "DELETE FROM grants WHERE nest_id = ? AND target = ?",
      [nestId, otherDocId],
    );
    await (await db()).run(
      "UPDATE access_requests SET resolved_at = '2000-01-01 00:00:00' WHERE id = ?",
      [id],
    );
  });

  it("an approval the plan refuses (402) leaves the request pending", async () => {
    // A fresh viewer: someone who already holds a write share is already an
    // editor seat, so the plan would have nothing new to refuse.
    await resetAuthRateLimit();
    const fresh = await registerUser(app, "plan-viewer@acme.com", "Plan Viewer");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "plan-viewer@acme.com", permission: "read" },
      owner.apiKey,
    );
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      fresh.apiKey,
    );
    expect(ask.status).toBe(201);
    plan.maxSubscribers = 0;
    try {
      const refused = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/access-requests/${ask.data.request.id}/approve`,
        {},
        owner.apiKey,
      );
      expect(refused.status).toBe(402);
    } finally {
      delete plan.maxSubscribers;
    }
    const row = (await (await db()).get("SELECT status, resolved_by FROM access_requests WHERE id = ?", [
      ask.data.request.id,
    ])) as { status: string; resolved_by: string | null };
    expect(row).toEqual({ status: "pending", resolved_by: null });
    expect((await patch(fresh.apiKey, otherDocId, "# nope")).status).toBe(403);
  });

  it("an archived nest can't have access granted into it, but its requests can still be denied", async () => {
    const { data: n } = await jsonRequest(app, "POST", "/nests", { name: "Archive Vault" }, owner.apiKey);
    await jsonRequest(
      app,
      "POST",
      `/nests/${n.nest.id}/collaborators`,
      { email: "reader@acme.com", permission: "read" },
      owner.apiKey,
    );
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${n.nest.id}/access-requests`,
      { target_type: "nest", target_id: n.nest.id, level: "write" },
      reader.apiKey,
    );
    expect(ask.status).toBe(201);
    expect((await jsonRequest(app, "POST", `/nests/${n.nest.id}/archive`, {}, owner.apiKey)).status).toBe(200);
    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${n.nest.id}/access-requests/${ask.data.request.id}/approve`,
      {},
      owner.apiKey,
    );
    expect(approve.status).toBe(400);
    expect(approve.data.error).toMatch(/archived/);
    const deny = await jsonRequest(
      app,
      "POST",
      `/nests/${n.nest.id}/access-requests/${ask.data.request.id}/deny`,
      {},
      owner.apiKey,
    );
    expect(deny.status).toBe(200);
  });

  it("the cooldown holds whatever shape the stored timestamp has (Postgres-style ISO too)", async () => {
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      reader.apiKey,
    );
    expect(ask.status).toBe(201);
    await jsonRequest(app, "POST", `/nests/${nestId}/access-requests/${ask.data.request.id}/deny`, {}, owner.apiKey);
    await (await db()).run("UPDATE access_requests SET resolved_at = ? WHERE id = ?", [
      new Date().toISOString(),
      ask.data.request.id,
    ]);
    const again = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      reader.apiKey,
    );
    expect(again.status).toBe(429);
    await (await db()).run(
      "UPDATE access_requests SET resolved_at = '2000-01-01 00:00:00' WHERE id = ?",
      [ask.data.request.id],
    );
  });

  it("two asks racing file one request", async () => {
    const body = { target_type: "folder", target_id: "gtm/racing", level: "write" };
    // A folder needs a document in it to be askable.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Racing Doc", content: "x", folder: "gtm/racing" },
      owner.apiKey,
    );
    const [a, b] = await Promise.all([
      jsonRequest(app, "POST", `/nests/${nestId}/access-requests`, body, reader.apiKey),
      jsonRequest(app, "POST", `/nests/${nestId}/access-requests`, body, reader.apiKey),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.data.request.id).toBe(b.data.request.id);
    await jsonRequest(app, "POST", `/nests/${nestId}/access-requests/${a.data.request.id}/deny`, {}, owner.apiKey);
  });

  it("an approval whose grant never happened (crash between claim and grant) is recoverable by asking again", async () => {
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      reader.apiKey,
    );
    expect(ask.status).toBe(201);
    // Simulate the crash: the row says approved, no grant exists.
    await (await db()).run(
      "UPDATE access_requests SET status = 'approved', resolved_by = 'owner@acme.com', resolved_at = '2000-01-01 00:00:00' WHERE id = ?",
      [ask.data.request.id],
    );
    const refused = await patch(reader.apiKey, otherDocId, "# still refused");
    expect(refused.status).toBe(403);
    expect(refused.data.can_request_access).toBe(true);
    expect(refused.data.access_request).toBeUndefined();
    const again = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: otherDocId, level: "write" },
      reader.apiKey,
    );
    expect(again.status).toBe(201);
    await jsonRequest(app, "POST", `/nests/${nestId}/access-requests/${again.data.request.id}/approve`, {}, owner.apiKey);
    expect((await patch(reader.apiKey, otherDocId, "# recovered")).status).toBe(200);
    // Back to read-only for the cases below.
    await (await db()).run("DELETE FROM grants WHERE nest_id = ? AND target = ?", [nestId, otherDocId]);
  });

  it("a document write share doesn't open nest-level writes (creating stays refused)", async () => {
    // reader holds a write share on docId (approved above) but only nest read.
    expect((await patch(reader.apiKey, docId, "# still fine")).status).toBe(200);
    const create = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Sneaky", content: "x" },
      reader.apiKey,
    );
    expect(create.status).toBe(403);
    expect(create.data.target).toEqual({ type: "nest", id: nestId });
  });

  it("caps how many different asks one person can have waiting in a nest", async () => {
    await resetAuthRateLimit();
    const busy = await registerUser(app, "busy-viewer@acme.com", "Busy Viewer");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "busy-viewer@acme.com", permission: "read" },
      owner.apiKey,
    );
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const { data } = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: `Cap Doc ${i}`, content: "x", folder: "cap" },
        owner.apiKey,
      );
      ids.push(data.node.id);
    }
    for (const id of ids.slice(0, 10)) {
      const r = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/access-requests`,
        { target_type: "node", target_id: id },
        busy.apiKey,
      );
      expect(r.status).toBe(201);
    }
    const eleventh = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "node", target_id: ids[10] },
      busy.apiKey,
    );
    expect(eleventh.status).toBe(429);
    expect(eleventh.data.error).toMatch(/10 access requests waiting/);
    // Clear them so the inbox assertions elsewhere aren't swamped.
    await (await db()).run("DELETE FROM access_requests WHERE requested_by = 'busy-viewer@acme.com'");
  });

  it("a document write share doesn't make its holder a reviewer of that document", async () => {
    // reader holds a write share on docId (approved above). Approving a
    // review stays a steward's / owner's call, whatever the share says.
    const submitted = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${docId}/submit-review`,
      {},
      owner.apiKey,
    );
    expect(submitted.status).toBeLessThan(300);
    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${docId}/approve`,
      {},
      reader.apiKey,
    );
    expect(approve.status).toBe(403);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${docId}/cancel-review`, {}, owner.apiKey);
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

  it("approving an older read request never lowers a write share given since", async () => {
    await resetAuthRateLimit();
    const late = await registerUser(app, "late@acme.com", "Late");
    const share = (target_type: string, target: string, role: string) =>
      jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/grants`,
        { target_type, target, email: "late@acme.com", role },
        owner.apiKey,
      );
    expect((await share("document", folderDocId, "read")).status).toBeLessThan(300);
    const ask = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests`,
      { target_type: "folder", target_id: "gtm", level: "read" },
      late.apiKey,
    );
    expect(ask.status).toBe(201);
    expect((await share("folder", "nodes/gtm", "write")).status).toBeLessThan(300);
    const ok = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/access-requests/${ask.data.request.id}/approve`,
      {},
      owner.apiKey,
    );
    expect(ok.status).toBe(200);
    expect((await patch(late.apiKey, folderDocId, "# late edit")).status).toBe(200);
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
      // Approving write raises the viewer to a billed editor.
      confirm_billing: true,
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
  it("reads a trailing action word the way the router does", () => {
    // POST …/nodes/gtm/move IS the move route for nodes/gtm — the router
    // matches /:nodeId{.+}/move first — so naming nodes/gtm agrees with what
    // the request actually does. PATCH has no suffix routes, so a document
    // named "move" in a folder is named whole there.
    expect(writeTargetForPath(n, [n, "nodes", "nodes", "gtm", "move"], "POST")).toEqual({
      type: "node",
      id: "nodes/gtm",
    });
    expect(writeTargetForPath(n, [n, "nodes", "nodes", "gtm", "move"], "PATCH")).toEqual({
      type: "node",
      id: "nodes/gtm/move",
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

describe("access-request emails escape what the requester typed", () => {
  it("never renders the note or address as HTML", async () => {
    const { renderEmail } = await import("../src/notify/email-render.js");
    for (const status of ["access_requested", "access_approved", "access_denied"] as const) {
      const { html, subject } = renderEmail({
        status,
        docTitle: "Pricing <b>Notes</b>",
        path: "Vault",
        actor: "<img src=x onerror=alert(1)>@acme.com",
        permission: "write",
        note: '<script>alert("x")</script> <!channel>',
      });
      expect(html).not.toMatch(/<script|<img|<!channel>|<b>Notes/);
      expect(html).toContain("&lt;script&gt;");
      expect(subject).not.toMatch(/\r|\n/);
    }
  });
});
