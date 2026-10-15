/**
 * POST /nodes/:id/approve-with-edits — a reviewer fixes a pending submission
 * and approves it in one step (CU-wdqcq04wnw). Only for someone who can both
 * edit and approve; the author stays the submitter (separation of duties), the
 * reviewer's edit is its own version, and prime documents are refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let alice: User; // editor steward — the author
let rex: User; // reviewer steward — approves, can't edit
let adam: User; // admin collaborator — edits and approves
let nestId: string;

const base = () => `/nests/${nestId}/nodes`;

async function submit(title: string, tags: string[] = []) {
  const created = await jsonRequest(app, "POST", base(), { title, content: "draft text", tags }, alice.apiKey);
  expect(created.status).toBe(201);
  const id = created.data.node?.id ?? `nodes/${title}`;
  const sent = await jsonRequest(app, "POST", `${base()}/${id}/submit-review`, {}, alice.apiKey);
  expect(sent.status).toBe(201);
  return id as string;
}

const editApprove = (caller: User, id: string, body: Record<string, unknown>) =>
  jsonRequest(app, "POST", `${base()}/${id}/approve-with-edits`, body, caller.apiKey);

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  rex = await registerUser(app, "rex@acme.com", "Rex");
  await resetAuthRateLimit(); // REGISTER_LIMIT is 3 per IP
  adam = await registerUser(app, "adam@acme.com", "Adam");

  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Nest" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
  for (const [u, role] of [[alice, "editor"], [rex, "reviewer"]] as const) {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: u.email, role }] },
      owner.apiKey,
    );
    expect(r.status).toBe(201);
  }
  const grant = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: adam.email, permission: "admin" },
    owner.apiKey,
  );
  expect(grant.status).toBe(201);
});

afterAll(() => env.cleanup());

describe("POST /approve-with-edits", () => {
  it("an editor-and-approver fixes the text and publishes it; history names both people", async () => {
    const id = await submit("plan");
    const { status } = await editApprove(adam, id, { content: "fixed text" });
    expect(status).toBe(200);

    const node = await jsonRequest(app, "GET", `${base()}/${id}`, undefined, alice.apiKey);
    expect(node.data.node.status).toBe("published");
    expect(node.data.node.content ?? node.data.node.body).toContain("fixed text");

    const versions = await jsonRequest(app, "GET", `${base()}/${id}/versions`, undefined, owner.apiKey);
    const authors = versions.data.versions.map((v: any) => String(v.editedBy).toLowerCase());
    expect(authors).toContain(adam.email);
    expect(authors).toContain(alice.email);
  });

  it("the author's approval notification says the reviewer edited it", async () => {
    const id = await submit("notified");
    expect((await editApprove(adam, id, { content: "fixed" })).status).toBe(200);
    const inbox = await jsonRequest(app, "GET", "/me/notifications", undefined, alice.apiKey);
    const row = inbox.data.notifications.find((n: any) => n.kind === "review_approved" && n.node_id === id);
    expect(row?.message).toContain(`edited and approved by ${adam.email}`);
  });

  it("refuses a reviewer who can't edit, and the author themselves", async () => {
    const id = await submit("second");
    expect((await editApprove(rex, id, { content: "x" })).status).toBe(403);
    expect((await editApprove(alice, id, { content: "x" })).status).toBe(403);
    // Nothing was written: still pending, original text.
    const node = await jsonRequest(app, "GET", `${base()}/${id}`, undefined, alice.apiKey);
    expect(node.data.node.status).toBe("pending_review");
  });

  it("409 when nothing is pending", async () => {
    const id = await submit("third");
    expect((await editApprove(adam, id, { content: "once" })).status).toBe(200);
    expect((await editApprove(adam, id, { content: "twice" })).status).toBe(409);
  });

  it("400 on a malformed body, before anything is written", async () => {
    const id = await submit("bad-body");
    expect((await editApprove(adam, id, { tags: "prime-document" })).status).toBe(400);
    expect((await editApprove(adam, id, { content: 42 })).status).toBe(400);
    const node = await jsonRequest(app, "GET", `${base()}/${id}`, undefined, alice.apiKey);
    expect(node.data.node.status).toBe("pending_review");
  });

  it("409 when the author changed the document after the reviewer opened it", async () => {
    const id = await submit("moving");
    const seen = (await jsonRequest(app, "GET", `${base()}/${id}`, undefined, adam.apiKey)).data.node.version;
    // The author keeps revising their own pending submission.
    const revise = await jsonRequest(app, "PATCH", `${base()}/${id}`, { content: "author's newer text" }, alice.apiKey);
    expect(revise.status).toBe(200);
    const res = await editApprove(adam, id, { content: "reviewer text", baseVersion: seen });
    expect(res.status).toBe(409);
    const node = await jsonRequest(app, "GET", `${base()}/${id}`, undefined, alice.apiKey);
    expect(node.data.node.status).toBe("pending_review");
    expect(node.data.node.content ?? node.data.node.body).toContain("author's newer text");
  });

  it("still goes through review when the admin would otherwise auto-publish (self-approve on)", async () => {
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { allow_self_approve: true }, owner.apiKey);
    try {
      const id = await submit("self-approve-on");
      // An auto-published edit would leave nothing pending, and approve would fail.
      expect((await editApprove(adam, id, { content: "fixed under self-approve" })).status).toBe(200);
      const node = await jsonRequest(app, "GET", `${base()}/${id}`, undefined, alice.apiKey);
      expect(node.data.node.status).toBe("published");
      expect(node.data.node.content ?? node.data.node.body).toContain("fixed under self-approve");
    } finally {
      await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { allow_self_approve: false }, owner.apiKey);
    }
  });

  it("refuses prime documents, and an edit that would make one prime", async () => {
    const prime = await submit("prime-doc", ["prime-document"]);
    expect((await editApprove(adam, prime, { content: "x" })).status).toBe(403);

    const plain = await submit("plain-doc");
    expect((await editApprove(adam, plain, { tags: ["prime-document"] })).status).toBe(403);
    const node = await jsonRequest(app, "GET", `${base()}/${plain}`, undefined, alice.apiKey);
    expect(node.data.node.status).toBe("pending_review");
  });
});
