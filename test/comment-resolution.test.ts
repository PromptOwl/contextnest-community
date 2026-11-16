/**
 * Comment resolution usability — "replies don't dismiss, they just stay".
 *
 * Server half of the fix:
 *   - a reply on a resolved thread reopens it, on the REST reply route AND
 *     the MCP context_comment reply (one rule, in addComment);
 *   - a reply notifies the thread's earlier participants (inbox row + email
 *     with a working document link), never the replier, and never twice for
 *     someone the same reply @mentions.
 * The feed half (resolved threads leave the Review tab) is in feed.test.ts.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const sendMail = vi.fn(async () => ({ messageId: "test" }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail, verify: async () => true, close() {} }),
  },
}));

type Caller = { apiKey: string; email: string };

let app: any;
let owner: Caller;
let editor: Caller;
let reviewer: Caller;
let nestId: string;
const DOC = "nodes/launch-plan";

const base = () => `/nests/${nestId}/nodes/${DOC}/annotations`;

const openThread = async (caller: Caller, body: string) => {
  const { status, data } = await jsonRequest(app, "POST", base(), { body }, caller.apiKey);
  expect(status).toBe(201);
  return data.thread.id as string;
};

const reply = async (caller: Caller, threadId: string, body: string) => {
  const res = await jsonRequest(
    app,
    "POST",
    `${base()}/${threadId}/comments`,
    { body },
    caller.apiKey,
  );
  expect(res.status).toBe(200);
  return res.data.thread;
};

const resolve = async (caller: Caller, threadId: string) => {
  const res = await jsonRequest(app, "POST", `${base()}/${threadId}/resolve`, {}, caller.apiKey);
  expect(res.data.thread.status).toBe("resolved");
};

const getThread = async (threadId: string) => {
  const { data } = await jsonRequest(app, "GET", base(), undefined, owner.apiKey);
  return (data.threads as any[]).find((t) => t.id === threadId);
};

const inbox = async (caller: Caller) => {
  const { data } = await jsonRequest(app, "GET", "/me/notifications", undefined, caller.apiKey);
  return data.notifications as Array<{
    kind: string;
    message: string;
    node_id: string | null;
  }>;
};

const ofKind = async (caller: Caller, kind: string) =>
  (await inbox(caller)).filter((n) => n.kind === kind);

/** Emails whose plain text carries this reply's words. */
const mailsFor = (words: string) =>
  sendMail.mock.calls
    .map((c: any[]) => c[0])
    .filter((m: any) => String(m.text || "").includes(words));

const mcpComment = async (caller: Caller, args: Record<string, unknown>) => {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${caller.apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_comment", arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  return res.text();
};

/** Fire-and-forget email delivery settles on the next ticks. */
const settle = () => new Promise((r) => setTimeout(r, 100));

beforeAll(async () => {
  process.env.SMTP_URL = "smtps://user:pass@smtp.test:465";
  process.env.NOTIFY_EMAIL_FROM = "nest@test.local";
  setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  await resetAuthRateLimit();
  editor = await registerUser(app, "editor@acme.com", "Eddie Editor");
  await resetAuthRateLimit();
  reviewer = await registerUser(app, "rev@acme.com", "Rita Reviewer");
  await resetAuthRateLimit();

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Resolution" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: editor.email, permission: "write" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: reviewer.email, permission: "read" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Launch Plan", content: "# Launch\n\nwe ship friday" },
    owner.apiKey,
  );
});

describe("a reply reopens a resolved thread", () => {
  it("over REST: status goes back to open and the resolve audit clears", async () => {
    const threadId = await openThread(owner, "is friday real?");
    await resolve(owner, threadId);

    const thread = await reply(editor, threadId, "actually, not yet");
    expect(thread.status).toBe("open");
    expect(thread.resolvedBy).toBeNull();
    expect(thread.resolvedAt).toBeNull();
    expect((await getThread(threadId)).status).toBe("open");
  });

  it("leaves an open thread open on a plain reply", async () => {
    const threadId = await openThread(owner, "second question");
    const thread = await reply(editor, threadId, "answered");
    expect(thread.status).toBe("open");
  });

  it("over MCP: an agent's reply on a resolved thread reopens it too", async () => {
    const threadId = await openThread(owner, "agent, please check the date");
    await resolve(owner, threadId);

    const text = await mcpComment(editor, {
      id: DOC,
      thread: threadId,
      body: "rechecked — the date moved",
    });
    expect(text).toContain("Replied on");

    const thread = await getThread(threadId);
    expect(thread.status).toBe("open");
    expect(thread.resolvedBy).toBeNull();
    expect(thread.comments).toHaveLength(2);
  });
});

describe("a reply notifies the thread's participants", () => {
  it("notifies the thread opener, linking the document, but not the replier", async () => {
    const ownerBefore = (await ofKind(owner, "comment_reply")).length;
    const editorBefore = (await ofKind(editor, "comment_reply")).length;
    sendMail.mockClear();

    const threadId = await openThread(owner, "who owns the launch email?");
    await reply(editor, threadId, "I can take the launch email");
    await settle();

    const ownerRows = await ofKind(owner, "comment_reply");
    expect(ownerRows).toHaveLength(ownerBefore + 1);
    expect(ownerRows[0].message).toContain("Eddie Editor replied");
    expect(ownerRows[0].message).toContain("Launch Plan");
    // The inbox row opens the document the thread is on.
    expect(ownerRows[0].node_id).toBe(DOC);
    // The replier hears nothing about their own reply.
    expect(await ofKind(editor, "comment_reply")).toHaveLength(editorBefore);

    // One email, to the opener, whose link opens THIS document in THIS nest
    // on the origin the request came in on.
    const mails = mailsFor("I can take the launch email");
    expect(mails).toHaveLength(1);
    expect(JSON.stringify(mails[0].to)).toContain(owner.email);
    const link = String(mails[0].text).match(/https?:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    const url = new URL(link!);
    expect(url.origin).toBe("http://localhost");
    expect(url.searchParams.get("nest")).toBe(nestId);
    expect(url.searchParams.get("doc")).toBe(DOC);
  });

  it("notifies every earlier participant once, however often they posted", async () => {
    const threadId = await openThread(owner, "thread for three");
    await reply(editor, threadId, "editor weighs in");
    await reply(owner, threadId, "owner follows up");
    const ownerBefore = (await ofKind(owner, "comment_reply")).length;
    const editorBefore = (await ofKind(editor, "comment_reply")).length;

    await reply(reviewer, threadId, "reviewer joins late");

    expect(await ofKind(owner, "comment_reply")).toHaveLength(ownerBefore + 1);
    expect(await ofKind(editor, "comment_reply")).toHaveLength(editorBefore + 1);
    // Someone who was never in the thread isn't pulled in by it.
    const outsiderThread = await openThread(owner, "owner alone");
    const reviewerBefore = (await ofKind(reviewer, "comment_reply")).length;
    await reply(editor, outsiderThread, "editor answers owner");
    expect(await ofKind(reviewer, "comment_reply")).toHaveLength(reviewerBefore);
  });

  it("does not double-notify a participant the same reply @mentions", async () => {
    const threadId = await openThread(editor, "editor opens this one");
    const mentionBefore = (await ofKind(editor, "mention")).length;
    const replyBefore = (await ofKind(editor, "comment_reply")).length;
    sendMail.mockClear();

    await reply(owner, threadId, `@${editor.email} can you confirm?`);
    await settle();

    // One event, one row: the mention wins, the participant row is skipped.
    expect(await ofKind(editor, "mention")).toHaveLength(mentionBefore + 1);
    expect(await ofKind(editor, "comment_reply")).toHaveLength(replyBefore);
    // …and one email, not two.
    expect(mailsFor("can you confirm?")).toHaveLength(1);
  });

  it("gives an agent's reply the same working link (MCP passes ctx.baseUrl)", async () => {
    const threadId = await openThread(owner, "agent thread");
    const before = (await ofKind(owner, "comment_reply")).length;
    sendMail.mockClear();

    await mcpComment(editor, { id: DOC, thread: threadId, body: "agent reply lands" });
    await settle();

    expect(await ofKind(owner, "comment_reply")).toHaveLength(before + 1);
    const mails = mailsFor("agent reply lands");
    expect(mails).toHaveLength(1);
    const link = String(mails[0].text).match(/https?:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    const url = new URL(link!);
    expect(url.searchParams.get("nest")).toBe(nestId);
    expect(url.searchParams.get("doc")).toBe(DOC);
  });
});
