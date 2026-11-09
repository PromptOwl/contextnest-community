/**
 * PO-1191: the activity and comment reads answer only for documents the caller
 * can read.
 *
 *   GET /nests/:id/activity
 *   GET /nests/:id/nodes/:nodeId/activity
 *   GET /nests/:id/nodes/:nodeId/comments
 *   GET /nests/:id/nodes/:nodeId/task-log
 *
 * An activity entry names a document, who touched it and an excerpt of the
 * comment or change note, so each of these follows the same rule as opening
 * the document itself (`canReadNode` / `filterAccessible`).
 *
 * Blocks are named by acceptance criterion (AC-ARG-*). AC-ARG-04 and
 * AC-ARG-05 pin what must not change: members read everything, and a caller
 * whose only way in is a document share stays scoped by the nest middleware.
 * AC-ARG-06 is the task log, a slice of the same timeline.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };
type Entry = { type: string; nodeId: string; actor: string; detail?: string };

const APPROVED = "nodes/approved-doc";
const DRAFT = "nodes/secret-draft";
const APPROVED_NOTE = "a note on the approved page";
const DRAFT_NOTE = "unreleased pricing detail";
const CHAT_DRAFT = "nodes/chat-draft";
const CHAT_NOTE = "a note on the pending chat draft";
const CHAT_TASK = "nodes/chat-task";
const TASK_NOTE = "called the unannounced customer";
const EVERYTHING = [APPROVED, DRAFT, CHAT_DRAFT, CHAT_TASK, "nodes/scoped-doc", "nodes/shared-doc"].sort();
const PENDING_FROM_CHAT = [CHAT_DRAFT, CHAT_TASK];

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let writer: User; // write collaborator on the team nest
let viewer: User; // read collaborator on every nest
let outsider: User; // signed in, added to nothing
let scoped: User; // steward (reviewer) of ONE document on the team nest, no collaborator row
let guest: User; // a share on ONE document of the team nest, nothing else
let pubNest: string; // governed, visibility = public
let orgNest: string; // governed, visibility = org
let teamNest: string; // governed, private

const get = (path: string, u?: { apiKey: string }) => jsonRequest(app, "GET", path, undefined, u?.apiKey);
const nestActivity = (nest: string, u?: { apiKey: string }) => get(`/nests/${nest}/activity?limit=1000`, u);
const nodeActivity = (nest: string, node: string, u?: { apiKey: string }) => get(`/nests/${nest}/nodes/${node}/activity`, u);
const nodeComments = (nest: string, node: string, u?: { apiKey: string }) => get(`/nests/${nest}/nodes/${node}/comments`, u);
const nodesIn = (data: any): string[] => [...new Set(((data?.activity ?? []) as Entry[]).map((e) => e.nodeId))];

async function must(r: Promise<{ status: number; data: any }>, status?: number) {
  const res = await r;
  if (status) expect(res.status, JSON.stringify(res.data)).toBe(status);
  else expect(res.status, JSON.stringify(res.data)).toBeLessThan(300);
  return res.data;
}
const doc = (nest: string, title: string) => must(jsonRequest(app, "POST", `/nests/${nest}/nodes`, { title, content: `# ${title}` }, owner.apiKey), 201);
const comment = (nest: string, node: string, body: string) =>
  must(jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/comments`, { body }, owner.apiKey), 201);

/** A governed nest with one approved document and one unapproved draft, each carrying a comment. */
async function governedNest(name: string): Promise<string> {
  const id = (await must(jsonRequest(app, "POST", "/nests", { name }, owner.apiKey))).nest.id as string;
  await doc(id, "Approved Doc"); // published: stewardship is still off
  await must(jsonRequest(app, "PATCH", `/nests/${id}/settings`, { stewardship_enabled: true }, owner.apiKey));
  await doc(id, "Secret Draft"); // never approved
  await comment(id, APPROVED, APPROVED_NOTE);
  await comment(id, DRAFT, DRAFT_NOTE);
  await must(jsonRequest(app, "POST", `/nests/${id}/collaborators`, { email: viewer.email, permission: "read" }, owner.apiKey));
  return id;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@arg.test", "Owner");
  writer = await registerUser(app, "writer@arg.test", "Writer");
  viewer = await registerUser(app, "viewer@arg.test", "Viewer");
  await resetAuthRateLimit();
  outsider = await registerUser(app, "outsider@else.test", "Outsider");
  scoped = await registerUser(app, "scoped@arg.test", "Scoped Steward");
  guest = await registerUser(app, "guest@else.test", "Guest");
  await resetAuthRateLimit();

  pubNest = await governedNest("Public Docs");
  await must(jsonRequest(app, "PATCH", `/nests/${pubNest}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey), 200);
  orgNest = await governedNest("Org Docs");
  await must(jsonRequest(app, "PATCH", `/nests/${orgNest}/visibility`, { visibility: "org" }, owner.apiKey), 200);

  teamNest = await governedNest("Team");
  await must(jsonRequest(app, "POST", `/nests/${teamNest}/collaborators`, { email: writer.email, permission: "write" }, owner.apiKey));
  for (const [title, note] of [
    ["Scoped Doc", "a note on the steward's document"],
    ["Shared Doc", "a note on the shared document"],
    ["Chat Draft", CHAT_NOTE],
  ]) {
    const id = (await doc(teamNest, title)).node.id as string;
    await comment(teamNest, id, note);
  }
  await must(
    jsonRequest(app, "POST", `/nests/${teamNest}/stewards`, { scope: "document", nodePattern: "nodes/scoped-doc", email: scoped.email, role: "reviewer" }, owner.apiKey),
  );
  await must(
    jsonRequest(app, "POST", `/nests/${teamNest}/grants`, { target_type: "document", target: "nodes/shared-doc", email: guest.email, role: "read" }, owner.apiKey),
    201,
  );
  await must(jsonRequest(app, "POST", `/nests/${teamNest}/nodes`, { title: "Chat Task", content: "# Chat Task", type: "task" }, owner.apiKey), 201);
  await must(jsonRequest(app, "POST", `/nests/${teamNest}/nodes/${CHAT_TASK}/task-log`, { note: TASK_NOTE, status: "working" }, owner.apiKey), 201);
  // "Chat Draft" and "Chat Task" were proposed from chat and are still waiting
  // for a person: hidden from everyone below write until they are approved.
  const db = (await import("../src/db/client.js")).getDb();
  const now = new Date().toISOString();
  const proposal = randomUUID();
  await db.run(
    "INSERT INTO surface_proposals (id, window_id, binding_id, nest_id, card_kind, state, forced, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'single', 'posted', 0, ?, ?, ?)",
    [proposal, randomUUID(), randomUUID(), teamNest, new Date(Date.now() + 86_400_000).toISOString(), now, now],
  );
  for (const node of PENDING_FROM_CHAT) {
    await db.run(
      "INSERT INTO surface_proposal_items (id, proposal_id, nest_id, node_id, item_kind, op, target_folder, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'decision', 'new', '', 'From chat', 'pending', ?, ?)",
      [randomUUID(), proposal, teamNest, node, now, now],
    );
  }
}, 120_000);

afterAll(async () => {
  await env.cleanup();
});

type Case = { nest: () => string; who: () => { apiKey: string } | undefined; hidden: string; hiddenNote: string; open: string; openNote: string };

/**
 * One test per read, for a caller who can't open `hidden` but can open `open`:
 * the hidden document leaves no trace, and the open one is served as before.
 */
function narrowed(ac: string, caller: string, c: Case) {
  it(`${ac} ${caller}: the document itself is refused, which is what makes its trail private`, async () => {
    expect((await get(`/nests/${c.nest()}/nodes/${c.hidden}`, c.who())).status).toBeGreaterThanOrEqual(403);
    expect((await get(`/nests/${c.nest()}/nodes/${c.open}`, c.who())).status).toBe(200);
  });

  it(`${ac} ${caller}: GET /activity leaves out what they can't read and keeps what they can`, async () => {
    const feed = await nestActivity(c.nest(), c.who());
    expect(feed.status).toBe(200);
    expect(nodesIn(feed.data), "names the document").not.toContain(c.hidden);
    expect(JSON.stringify(feed.data), "carries its comment").not.toContain(c.hiddenNote);
    expect(nodesIn(feed.data)).toContain(c.open);
    expect(JSON.stringify(feed.data)).toContain(c.openNote);
  });

  for (const [route, read, key] of [
    ["GET /nodes/:id/activity", nodeActivity, "activity"],
    ["GET /nodes/:id/comments", nodeComments, "comments"],
  ] as const) {
    it(`${ac} ${caller}: ${route} answers as for a document that doesn't exist`, async () => {
      const r = await read(c.nest(), c.hidden, c.who());
      const none = await read(c.nest(), "nodes/no-such-document", c.who());
      expect(r.data[key]).toEqual([]);
      expect(r.status).toBe(none.status);
      expect(r.data).toEqual(none.data);

      const mine = await read(c.nest(), c.open, c.who());
      expect(mine.status).toBe(200);
      expect(JSON.stringify(mine.data)).toContain(c.openNote);
    });
  }
}

const draftCase = (nest: () => string, who: Case["who"]): Case => ({ nest, who, hidden: DRAFT, hiddenNote: DRAFT_NOTE, open: APPROVED, openNote: APPROVED_NOTE });

describe("AC-ARG-01: a public nest's unapproved drafts leave no trail for the public", () => {
  narrowed("AC-ARG-01", "someone not signed in", draftCase(() => pubNest, () => undefined));
  narrowed("AC-ARG-01", "a signed-in person who was never added", draftCase(() => pubNest, () => outsider));
});

describe("AC-ARG-02: an org-visible nest's unapproved drafts leave no trail for people who were never added", () => {
  narrowed("AC-ARG-02", "a signed-in person who was never added", draftCase(() => orgNest, () => outsider));

  it("AC-ARG-02 someone not signed in doesn't reach an org-visible nest at all", async () => {
    expect((await nestActivity(orgNest)).status).toBe(404);
    expect((await nodeActivity(orgNest, APPROVED)).status).toBe(404);
    expect((await nodeComments(orgNest, APPROVED)).status).toBe(404);
  });
});

describe("AC-ARG-03: a document proposed from chat stays unseen until a person approves it", () => {
  narrowed("AC-ARG-03", "a read-only collaborator", {
    nest: () => teamNest,
    who: () => viewer,
    hidden: CHAT_DRAFT,
    hiddenNote: CHAT_NOTE,
    open: DRAFT,
    openNote: DRAFT_NOTE,
  });

  it("AC-ARG-03 a read-only collaborator still gets every other document's entries", async () => {
    expect(nodesIn((await nestActivity(teamNest, viewer)).data).sort()).toEqual(EVERYTHING.filter((n) => !PENDING_FROM_CHAT.includes(n)));
  });

  it("AC-ARG-03 a writer, who reviews it, still reads its trail", async () => {
    const feed = await nestActivity(teamNest, writer);
    expect(nodesIn(feed.data)).toContain(CHAT_DRAFT);
    expect(JSON.stringify((await nodeComments(teamNest, CHAT_DRAFT, writer)).data)).toContain(CHAT_NOTE);
    expect(JSON.stringify((await nodeActivity(teamNest, CHAT_DRAFT, writer)).data)).toContain(CHAT_NOTE);
  });
});

describe("AC-ARG-04: people added to the nest read all of it, as before", () => {
  it("AC-ARG-04 the owner and a read-only collaborator get the draft's activity and comments on a public nest", async () => {
    for (const u of [owner, viewer]) {
      const feed = await nestActivity(pubNest, u);
      expect(feed.status).toBe(200);
      expect(nodesIn(feed.data).sort(), u.email).toEqual([APPROVED, DRAFT]);
      expect(JSON.stringify(feed.data), u.email).toContain(DRAFT_NOTE);
      const comments = await nodeComments(pubNest, DRAFT, u);
      expect(comments.data.comments.map((c: any) => c.body), u.email).toEqual([DRAFT_NOTE]);
      const activity = await nodeActivity(pubNest, DRAFT, u);
      expect(nodesIn(activity.data), u.email).toEqual([DRAFT]);
      expect(JSON.stringify(activity.data), u.email).toContain(DRAFT_NOTE);
    }
  });

  it("AC-ARG-04 the owner and a writer get the whole private nest, and the feed keeps its shape", async () => {
    for (const u of [owner, writer]) {
      expect(nodesIn((await nestActivity(teamNest, u)).data).sort(), u.email).toEqual(EVERYTHING);
    }
    const two = await get(`/nests/${teamNest}/activity?limit=2`, owner);
    expect(two.data.activity).toHaveLength(2);
    expect(Object.keys(two.data.activity[0])).toEqual(expect.arrayContaining(["actor", "at", "nodeId", "type"]));
  });

  it("AC-ARG-04 a steward of one document is a person added to the nest: they read its drafts' trail like any viewer", async () => {
    // A steward row confers nest-level read (see resolveNestAccess), so this
    // caller opens every document that isn't a pending chat draft.
    expect((await get(`/nests/${teamNest}/nodes/${DRAFT}`, scoped)).status).toBe(200);
    expect(nodesIn((await nestActivity(teamNest, scoped)).data)).toEqual(expect.arrayContaining([DRAFT, "nodes/scoped-doc"]));
    expect((await nodeComments(teamNest, DRAFT, scoped)).data.comments.map((c: any) => c.body)).toEqual([DRAFT_NOTE]);
    expect(JSON.stringify((await nodeActivity(teamNest, DRAFT, scoped)).data)).toContain(DRAFT_NOTE);
  });
});

describe("AC-ARG-05: a document share reaches that document's trail and nothing else", () => {
  it("AC-ARG-05 the shared document's comments and activity are served", async () => {
    const comments = await nodeComments(teamNest, "nodes/shared-doc", guest);
    expect(comments.status).toBe(200);
    expect(comments.data.comments.map((c: any) => c.body)).toEqual(["a note on the shared document"]);
    const activity = await nodeActivity(teamNest, "nodes/shared-doc", guest);
    expect(activity.status).toBe(200);
    expect(nodesIn(activity.data)).toEqual(["nodes/shared-doc"]);
  });

  it("AC-ARG-05 the nest-wide activity and every other document's trail are not found", async () => {
    expect((await nestActivity(teamNest, guest)).status).toBe(404);
    for (const node of [APPROVED, DRAFT, "nodes/scoped-doc"]) {
      expect((await nodeActivity(teamNest, node, guest)).status, node).toBe(404);
      expect((await nodeComments(teamNest, node, guest)).status, node).toBe(404);
    }
  });

  it("AC-ARG-05 someone added to nothing doesn't reach a private nest", async () => {
    expect((await nestActivity(teamNest, outsider)).status).toBe(404);
    expect((await nodeComments(teamNest, APPROVED, outsider)).status).toBe(404);
  });
});

describe("AC-ARG-06: the task log of a task the caller can't open is empty", () => {
  const taskLog = (u: { apiKey: string }, node = CHAT_TASK) => get(`/nests/${teamNest}/nodes/${node}/task-log`, u);

  it("AC-ARG-06 a read-only collaborator: GET /nodes/:id/task-log answers as for a task that doesn't exist", async () => {
    expect((await get(`/nests/${teamNest}/nodes/${CHAT_TASK}`, viewer)).status).toBeGreaterThanOrEqual(403);
    const r = await taskLog(viewer);
    const none = await taskLog(viewer, "nodes/no-such-task");
    expect(r.data.entries).toEqual([]);
    expect(r.status).toBe(none.status);
    expect(r.data).toEqual(none.data);
  });

  it("AC-ARG-06 a read-only collaborator: the same entries stay out of the activity reads", async () => {
    expect(JSON.stringify((await nestActivity(teamNest, viewer)).data)).not.toContain(TASK_NOTE);
    expect((await nodeActivity(teamNest, CHAT_TASK, viewer)).data.activity).toEqual([]);
  });

  it("AC-ARG-06 the owner and a writer still read the task's log", async () => {
    for (const u of [owner, writer]) {
      const r = await taskLog(u);
      expect(r.status, u.email).toBe(200);
      expect(r.data.entries.map((e: any) => e.note), u.email).toEqual([TASK_NOTE]);
    }
  });
});
