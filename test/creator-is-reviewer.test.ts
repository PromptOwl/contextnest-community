/**
 * Creator reviews their documents — `creator_is_reviewer`.
 *
 * A per-nest flag (off by default) that turns the governed nest into the
 * GitHub model: anyone with write access creates documents, and the person who
 * created a document is its reviewer. On create, the author is stewarded as a
 * document-scope reviewer and the first version publishes immediately — they
 * are the authority on it, nobody else needs to bless v1.
 *
 * Everything after v1 is the ordinary review cycle. Separation of duties is
 * untouched: the creator approves OTHER people's changes to their document,
 * and their own later edits go to the nest's other reviewers.
 *
 * Prime still wins: a prime document lands as a draft even with the flag on.
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
let alice: User;
let bob: User;
let rex: User;
let nestId: string;

async function statusOf(caller: User, id: string): Promise<string> {
  const { data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes/${id}`,
    undefined,
    caller.apiKey,
  );
  return data.node.status;
}

async function docStewards(id: string): Promise<Array<{ email: string; role: string; scope: string }>> {
  const { data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes/${id}/stewards`,
    undefined,
    owner.apiKey,
  );
  return data.stewards
    .filter((s: any) => s.scope === "document")
    .map(({ email, role, scope }: any) => ({ email, role, scope }));
}

async function canApprove(caller: User, id: string): Promise<boolean> {
  const { data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes/${id}/can-approve`,
    undefined,
    caller.apiKey,
  );
  return data.allowed;
}

async function createDoc(caller: User, body: Record<string, unknown>) {
  return jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, caller.apiKey);
}

async function editAndSubmit(caller: User, id: string, content: string) {
  const edit = await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/nodes/${id}`,
    { content },
    caller.apiKey,
  );
  expect(edit.status).toBe(200);
  const submit = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/${id}/submit-review`,
    {},
    caller.apiKey,
  );
  expect(submit.status).toBe(201);
}

async function setSettings(caller: User, body: Record<string, unknown>) {
  return jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, body, caller.apiKey);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  bob = await registerUser(app, "bob@acme.com", "Bob");
  await resetAuthRateLimit(); // REGISTER_LIMIT is 3 per IP
  rex = await registerUser(app, "rex@acme.com", "Rex");

  const { data } = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Nest" },
    owner.apiKey,
  );
  nestId = data.nest.id;
  await setSettings(owner, { stewardship_enabled: true });

  // Two editors who can write anywhere, one nest-wide reviewer for the
  // creator's own edits. The owner keeps self-approve OFF so nothing publishes
  // for a reason other than the flag under test.
  for (const u of [alice, bob]) {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: u.email, role: "editor" }] },
      owner.apiKey,
    );
    expect(r.status).toBe(201);
  }
  const r = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    { scope: "nest", users: [{ email: rex.email, role: "reviewer" }] },
    owner.apiKey,
  );
  expect(r.status).toBe(201);
});

afterAll(() => env.cleanup());

describe("the setting", () => {
  it("is off by default and readable", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/settings`,
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.creator_is_reviewer).toBe(false);
  });

  it("an editor cannot flip it", async () => {
    const { status } = await setSettings(alice, { creator_is_reviewer: true });
    expect(status).toBe(403);
  });

  it("the owner can flip it, and it reads back", async () => {
    const { status, data } = await setSettings(owner, { creator_is_reviewer: true });
    expect(status).toBe(200);
    expect(data.creator_is_reviewer).toBe(true);
    await setSettings(owner, { creator_is_reviewer: false });
    const after = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/settings`,
      undefined,
      owner.apiKey,
    );
    expect(after.data.creator_is_reviewer).toBe(false);
  });
});

describe("flag off (regression — today's behaviour)", () => {
  it("an editor's new document is a draft with no document steward", async () => {
    const { status } = await createDoc(alice, { title: "plain", content: "v1" });
    expect(status).toBe(201);
    expect(await statusOf(alice, "nodes/plain")).toBe("draft");
    expect(await docStewards("nodes/plain")).toEqual([]);
  });
});

describe("flag on", () => {
  beforeAll(async () => {
    await setSettings(owner, { creator_is_reviewer: true });
  });

  it("an editor's new document publishes at v1 and the editor is its reviewer", async () => {
    const { status, data } = await createDoc(alice, {
      title: "alice-doc",
      content: "v1",
    });
    expect(status).toBe(201);
    expect(await statusOf(alice, "nodes/alice-doc")).toBe("published");
    expect(await docStewards("nodes/alice-doc")).toEqual([
      { email: alice.email, role: "reviewer", scope: "document" },
    ]);
    // The create response already carries the resolved roster.
    expect(data.stewards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: alice.email, role: "reviewer" }),
      ]),
    );
  });

  it("a teammate's change goes to the creator, who approves it", async () => {
    await editAndSubmit(bob, "nodes/alice-doc", "bob's edit");
    expect(await statusOf(alice, "nodes/alice-doc")).toBe("pending_review");
    expect(await canApprove(bob, "nodes/alice-doc")).toBe(false);
    expect(await canApprove(alice, "nodes/alice-doc")).toBe(true);

    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/alice-doc/approve`,
      {},
      alice.apiKey,
    );
    expect(status).toBe(200);
    expect(await statusOf(alice, "nodes/alice-doc")).toBe("published");
  });

  it("the creator's own later edit still needs another reviewer", async () => {
    await editAndSubmit(alice, "nodes/alice-doc", "alice's edit");
    expect(await statusOf(alice, "nodes/alice-doc")).toBe("pending_review");
    expect(await canApprove(alice, "nodes/alice-doc")).toBe(false);
    expect(await canApprove(rex, "nodes/alice-doc")).toBe(true);
  });

  it("the nest owner is not stewarded — they already approve everything", async () => {
    const { status } = await createDoc(owner, { title: "owner-doc", content: "v1" });
    expect(status).toBe(201);
    expect(await statusOf(owner, "nodes/owner-doc")).toBe("published");
    expect(await docStewards("nodes/owner-doc")).toEqual([]);
  });

  it("a prime document still lands as a draft, but the creator is its reviewer", async () => {
    const { status } = await createDoc(alice, {
      title: "alice-prime",
      content: "v1",
      tags: ["prime-document"],
    });
    expect(status).toBe(201);
    expect(await statusOf(alice, "nodes/alice-prime")).toBe("draft");
    expect(await docStewards("nodes/alice-prime")).toEqual([
      { email: alice.email, role: "reviewer", scope: "document" },
    ]);
  });

  it("a lesser role someone pre-assigned is kept, and v1 drafts", async () => {
    // An admin can steward a document id that doesn't exist yet. If that row
    // says "editor", the creator can't approve — so v1 must NOT publish on
    // the promise that they can, and the row is not silently promoted.
    const pre = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      {
        scope: "document",
        documentId: "nodes/pre-assigned",
        users: [{ email: alice.email, role: "editor" }],
      },
      owner.apiKey,
    );
    expect(pre.status).toBe(201);

    const { status } = await createDoc(alice, {
      title: "pre-assigned",
      content: "v1",
    });
    expect(status).toBe(201);
    expect(await statusOf(alice, "nodes/pre-assigned")).toBe("draft");
    expect(await docStewards("nodes/pre-assigned")).toEqual([
      { email: alice.email, role: "editor", scope: "document" },
    ]);
  });

  it("creating twice never doubles the steward row", async () => {
    // A retried create onto a fresh id after a conflict, or two documents by
    // the same author, must each get exactly one row for their own id.
    await createDoc(alice, { title: "alice-two", content: "v1" });
    expect(await docStewards("nodes/alice-two")).toHaveLength(1);
    expect(await docStewards("nodes/alice-doc")).toHaveLength(1);
  });
});

describe("flag on, stewardship off", () => {
  let ungoverned: string;

  beforeAll(async () => {
    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Open" },
      owner.apiKey,
    );
    ungoverned = data.nest.id;
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${ungoverned}/settings`,
      { creator_is_reviewer: true },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${ungoverned}/collaborators`,
      { email: alice.email, permission: "write" },
      owner.apiKey,
    );
  });

  it("nobody is stewarded — there is nothing to review", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${ungoverned}/nodes`,
      { title: "free", content: "v1" },
      alice.apiKey,
    );
    expect(status).toBe(201);
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${ungoverned}/nodes/nodes/free/stewards`,
      undefined,
      owner.apiKey,
    );
    expect(data.stewards).toEqual([]);
    const settings = await jsonRequest(
      app,
      "GET",
      `/nests/${ungoverned}/settings`,
      undefined,
      owner.apiKey,
    );
    expect(settings.data.stewardship_enabled).toBe(false);
  });
});
