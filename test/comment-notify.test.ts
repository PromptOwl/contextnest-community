/**
 * Comment-create notifications — a new comment reaches the people who follow
 * the document: its watchers and its reviewer stewards.
 *
 * Mentions already notify the person named (comment-mentions.test.ts); this
 * covers everyone else who should hear: watchers + reviewer stewards, never
 * the comment's author, never twice for someone the comment also mentions,
 * never anyone who can't open the document.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const { sendEmailToRecipient } = vi.hoisted(() => ({
  sendEmailToRecipient: vi.fn(async () => {}),
}));
vi.mock("../src/notify/email.js", async () => {
  const actual = await vi.importActual<typeof import("../src/notify/email.js")>(
    "../src/notify/email.js",
  );
  // Report SMTP as configured so the email half of the fan-out runs; the
  // send itself is the spy.
  return { ...actual, isEmailConfigured: () => true, sendEmailToRecipient };
});

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let alice: User; // commenter (write collaborator), also a watcher
let wally: User; // watcher (read collaborator)
let rita: User; // nest-scope reviewer steward
let mo: User; // watcher who also gets @mentioned
let stranger: User; // watcher row, but no access to the nest
let nestId: string;
const DOC = "nodes/charter";

async function inbox(u: User, kind: string) {
  const { data } = await jsonRequest(app, "GET", "/me/notifications", undefined, u.apiKey);
  return (
    data.notifications as Array<{ kind: string; message: string; node_id: string | null }>
  ).filter((n) => n.kind === kind);
}

async function watch(email: string) {
  const r = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/${DOC}/watchers`,
    { email },
    owner.apiKey,
  );
  expect(r.status).toBe(201);
}

const commentEmails = () =>
  sendEmailToRecipient.mock.calls
    .filter((c) => (c[1] as { status: string }).status === "comment")
    .map((c) => c[0] as string);

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  wally = await registerUser(app, "wally@acme.com", "Wally");
  await resetAuthRateLimit(); // REGISTER_LIMIT is 3 per IP
  rita = await registerUser(app, "rita@acme.com", "Rita");
  mo = await registerUser(app, "mo@acme.com", "Mo");
  stranger = await registerUser(app, "stranger@elsewhere.com", "Stranger");

  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Comments" }, owner.apiKey);
  nestId = data.nest.id;
  for (const [u, permission] of [
    [alice, "write"],
    [wally, "read"],
    [mo, "read"],
  ] as const) {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: u.email, permission },
      owner.apiKey,
    );
  }
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Charter", content: "the charter" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true },
    owner.apiKey,
  );
  const s = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    { scope: "nest", users: [{ email: rita.email, role: "reviewer" }] },
    owner.apiKey,
  );
  expect(s.status).toBe(201);
  for (const u of [alice, wally, mo, stranger]) await watch(u.email);
  sendEmailToRecipient.mockClear();
});

afterAll(() => env.cleanup());

describe("comment-create notification", () => {
  it("reaches watchers and reviewer stewards, linking the document — not the author", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${DOC}/annotations`,
      { body: "should section 2 cite the policy?" },
      alice.apiKey,
    );
    expect(r.status).toBe(201);

    for (const u of [wally, rita, mo]) {
      const rows = await inbox(u, "comment");
      expect(rows, u.email).toHaveLength(1);
      expect(rows[0].message).toContain(alice.email);
      expect(rows[0].message).toContain("Charter");
      expect(rows[0].node_id).toBe(DOC);
    }
    // The author watches the document too, and still hears nothing.
    expect(await inbox(alice, "comment")).toEqual([]);
    // The owner neither watches nor reviews.
    expect(await inbox(owner, "comment")).toEqual([]);

    expect(commentEmails().sort()).toEqual([mo.email, rita.email, wally.email].sort());
  });

  it("skips a watcher who can't open the document", async () => {
    expect(await inbox(stranger, "comment")).toEqual([]);
    expect(commentEmails()).not.toContain(stranger.email);
  });

  it("someone the comment mentions hears once — as a mention", async () => {
    sendEmailToRecipient.mockClear();
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${DOC}/comments`,
      { body: `@${mo.email} can you check the dates?` },
      wally.apiKey,
    );
    expect(r.status).toBe(201);

    expect(await inbox(mo, "mention")).toHaveLength(1);
    // Still the one row from the first test, nothing new for this comment.
    expect(await inbox(mo, "comment")).toHaveLength(1);
    // The other followers do get this one; its author (wally) does not.
    expect(await inbox(rita, "comment")).toHaveLength(2);
    expect(await inbox(alice, "comment")).toHaveLength(1);
    expect(await inbox(wally, "comment")).toHaveLength(1);
    expect(commentEmails()).not.toContain(wally.email);
    expect(commentEmails()).not.toContain(mo.email);
  });

  it("a watcher who is also a reviewer steward gets exactly one row", async () => {
    await watch(rita.email);
    const before = (await inbox(rita, "comment")).length;
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${DOC}/annotations`,
      { body: "one more question" },
      alice.apiKey,
    );
    expect(r.status).toBe(201);
    expect(await inbox(rita, "comment")).toHaveLength(before + 1);
  });

  it("a thread participant who also follows hears a reply once — as a reply", async () => {
    // rita (reviewer + watcher) opens the thread; wally replies.
    const { data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${DOC}/annotations`,
      { body: "thread for the dates" },
      rita.apiKey,
    );
    const comments = (await inbox(rita, "comment")).length;
    const replies = (await inbox(rita, "comment_reply")).length;
    const reply = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${DOC}/annotations/${data.thread.id}/comments`,
      { body: "dates look right" },
      wally.apiKey,
    );
    expect(reply.status).toBe(200);
    expect(await inbox(rita, "comment_reply")).toHaveLength(replies + 1);
    expect(await inbox(rita, "comment")).toHaveLength(comments);
  });

  it("a reply notifies the same followers", async () => {
    const { data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${DOC}/annotations`,
      { body: "opening a thread" },
      rita.apiKey,
    );
    const before = (await inbox(alice, "comment")).length;
    const reply = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${DOC}/annotations/${data.thread.id}/comments`,
      { body: "agreed" },
      wally.apiKey,
    );
    expect(reply.status).toBe(200);
    expect(await inbox(alice, "comment")).toHaveLength(before + 1);
  });
});
