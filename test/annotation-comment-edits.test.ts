/** po-1229: editing and deleting one's own comment on a document. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, jsonRequest, registerUser, setupTestEnv } from "./helpers.js";

describe("po-1229 own comments", () => {
  const env = setupTestEnv();
  let app: any;
  let alice: any;
  let bob: any;
  let base: string;
  let nestId: string;

  const post = (path: string, body: unknown, who: any) => jsonRequest(app, "POST", base + path, body, who.apiKey);
  const threads = async () => (await jsonRequest(app, "GET", base, undefined, alice.apiKey)).data.threads as any[];

  beforeAll(async () => {
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@acme.com", "Alice");
    bob = await registerUser(app, "bob@acme.com", "Bob");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Edits" }, alice.apiKey)).data.nest.id;
    // Bob can only read: commenting is read tier, so are his own edits.
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "bob@acme.com", permission: "read" }, alice.apiKey);
    const doc = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Doc", content: "# Doc\n\ntext" }, alice.apiKey);
    base = `/nests/${nestId}/nodes/${doc.data.node.id}/annotations`;
  });
  afterAll(() => env.cleanup());

  it("the author edits their comment, and it reads as edited", async () => {
    const made = await post("", { body: "tpyo" }, bob);
    expect(made.status).toBe(201);
    const at = `/${made.data.thread.id}/comments/${made.data.comment_id}`;
    const res = await post(`${at}/edit`, { body: "typo" }, bob);
    expect(res.status).toBe(200);
    const [c] = res.data.thread.comments;
    expect(c.body).toBe("typo");
    expect(c.editedAt).toBeTruthy();
    expect((await post(`${at}/edit`, { body: "  " }, bob)).status).toBe(400);
  });

  it("nobody else edits or deletes it, the nest owner included", async () => {
    const [t] = await threads();
    const at = `/${t.id}/comments/${t.comments[0].id}`;
    expect((await post(`${at}/edit`, { body: "mine now" }, alice)).status).toBe(403);
    expect((await post(`${at}/delete`, {}, alice)).status).toBe(403);
    expect((await threads())[0].comments[0].body).toBe("typo");
  });

  it("a comment is reached only through its own thread", async () => {
    const other = await post("", { body: "another thread" }, bob);
    const [t] = await threads();
    expect((await post(`/${other.data.thread.id}/comments/${t.comments[0].id}/delete`, {}, bob)).status).toBe(404);
    await post(`/${other.data.thread.id}/comments/${other.data.comment_id}/delete`, {}, bob);
  });

  it("a deleted reply leaves the thread; the last comment takes the thread and its count with it", async () => {
    const [t] = await threads();
    const reply = await post(`/${t.id}/comments`, { body: "a reply" }, alice);
    const gone = await post(`/${t.id}/comments/${reply.data.comment_id}/delete`, {}, alice);
    expect(gone.data.thread.comments.map((c: any) => c.body)).toEqual(["typo"]);
    expect((await post(`/${t.id}/comments/${reply.data.comment_id}/edit`, { body: "back" }, alice)).status).toBe(404);

    const last = await post(`/${t.id}/comments/${t.comments[0].id}/delete`, {}, bob);
    expect(last.data.thread).toBeNull();
    expect(await threads()).toEqual([]);
    const counts = await jsonRequest(app, "GET", `/nests/${nestId}/comment-counts`, undefined, alice.apiKey);
    expect(counts.data.counts).toEqual({});
    const feed = await jsonRequest(app, "GET", `/nests/${nestId}/feed?filter=comments`, undefined, alice.apiKey);
    expect(feed.data.items.filter((i: any) => i.type === "comment")).toEqual([]);
  });
});
