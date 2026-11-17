/**
 * PO-1192: the remaining governance reads, and the two comment writes, answer
 * only for documents the caller can read.
 *
 *   GET  /nests/:id/external-edits            (+ ?count=1, ?refresh=true)
 *   GET  /nests/:id/nodes/:nodeId/external-edits
 *   GET  /nests/:id/nodes/:nodeId/external-edits/:suggestionId
 *   GET  /nests/:id/nodes/:nodeId/watchers
 *   GET  /nests/:id/deletion-requests         (+ MCP context_deletion_queue)
 *   POST /nests/:id/nodes/:nodeId/comments
 *   POST /nests/:id/nodes/:nodeId/comments/:commentId/resolve
 *
 * Same rule and same answer shapes as the activity and comment reads
 * (test/activity-comment-read-access.test.ts): a document the caller can't
 * open answers like one that isn't there, lists leave it out, and a write to
 * it is not found. A pending external edit is text nobody approved, so it is
 * never served to someone who reaches the nest only through its visibility.
 *
 * Blocks are named by acceptance criterion (AC-GRW-*). AC-GRW-06 and
 * AC-GRW-07 pin what must not change.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };
type Caller = { apiKey: string } | undefined;

const APPROVED = "nodes/approved-doc";
const DRAFT = "nodes/secret-draft";
const CHAT_DRAFT = "nodes/chat-draft";
const SHARED = "nodes/shared-doc";
const NOWHERE = "nodes/no-such-document";
const EDIT_TEXT = "a paragraph typed straight into the file";
const DRAFT_NOTE = "unreleased pricing detail";
const CHAT_NOTE = "a note on the pending chat draft";
const DRAFT_REASON = "the draft names an unannounced customer";
const CHAT_REASON = "the chat draft repeats a private thread";
const APPROVED_REASON = "superseded by the new page";
const FOLDER_REASON = "the whole plan was cancelled";
const watcherOf = (node: string) => `watcher-of-${node.split("/").pop()}@grw.test`;

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
/** The owner's comment on each document, by nest then node. */
const commentId: Record<string, Record<string, string>> = {};
/** The pending external edit on each nest's approved document. */
const suggestionId: Record<string, string> = {};

const get = (path: string, u?: Caller) => jsonRequest(app, "GET", path, undefined, u?.apiKey);
const post = (path: string, body: unknown, u?: Caller) => jsonRequest(app, "POST", path, body, u?.apiKey);
const externalEdits = (nest: string, u?: Caller, qs = "") => get(`/nests/${nest}/external-edits${qs}`, u);
const pendingEdit = (nest: string, node: string, u?: Caller) => get(`/nests/${nest}/nodes/${node}/external-edits`, u);
const editDetail = (nest: string, node: string, u?: Caller, id = suggestionId[nest]) => get(`/nests/${nest}/nodes/${node}/external-edits/${id}`, u);
const watchers = (nest: string, node: string, u?: Caller) => get(`/nests/${nest}/nodes/${node}/watchers`, u);
const deletionQueue = (nest: string, u?: Caller, qs = "") => get(`/nests/${nest}/deletion-requests${qs}`, u);
const comments = (nest: string, node: string, u?: Caller) => get(`/nests/${nest}/nodes/${node}/comments`, u);
const addComment = (nest: string, node: string, u: Caller, body = "a new comment") => post(`/nests/${nest}/nodes/${node}/comments`, { body }, u);
const resolve = (nest: string, node: string, u: Caller, id = commentId[nest][node]) => post(`/nests/${nest}/nodes/${node}/comments/${id}/resolve`, {}, u);
const targets = (data: any): string[] => ((data?.requests ?? []) as Array<{ nodeId: string }>).map((r) => r.nodeId).sort();
const emails = (data: any): string[] => ((data?.watchers ?? []) as Array<{ user_email: string }>).map((w) => w.user_email);

/** MCP context_deletion_queue as this caller: the tool's text. */
async function queueOverMcp(nest: string, u: { apiKey: string }): Promise<string> {
  const res = await app.request(`/nests/${nest}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${u.apiKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_deletion_queue", arguments: {} } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return body.result.content.map((c: any) => c.text).join("");
}

async function must(r: Promise<{ status: number; data: any }>, status?: number) {
  const res = await r;
  if (status) expect(res.status, JSON.stringify(res.data)).toBe(status);
  else expect(res.status, JSON.stringify(res.data)).toBeLessThan(300);
  return res.data;
}
const doc = (nest: string, title: string, folder?: string) =>
  must(post(`/nests/${nest}/nodes`, { title, content: `# ${title}`, ...(folder ? { folder } : {}) }, owner), 201);

/** Type into a document's file behind the server's back. */
function editOnDisk(nest: string, node: string, text: string) {
  const path = join(process.env.DATA_ROOT!, "nests", nest, `${node}.md`);
  writeFileSync(path, `${readFileSync(path, "utf-8")}\n\n${text}\n`);
}

/** One comment, one watcher and one deletion request on a document, all by the owner. */
async function annotate(nest: string, node: string, note: string, reason: string) {
  (commentId[nest] ??= {})[node] = (await must(addComment(nest, node, owner, note), 201)).comment.id;
  await must(post(`/nests/${nest}/nodes/${node}/watchers`, { email: watcherOf(node) }, owner), 201);
  await must(post(`/nests/${nest}/nodes/${node}/request-deletion`, { reason }, owner), 201);
}

/**
 * A governed nest with one approved document carrying a pending external edit,
 * and one unapproved draft. Each has a comment, a watcher and a deletion request.
 */
async function governedNest(name: string): Promise<string> {
  const id = (await must(post("/nests", { name }, owner))).nest.id as string;
  await doc(id, "Approved Doc"); // published: stewardship is still off
  await must(jsonRequest(app, "PATCH", `/nests/${id}/settings`, { stewardship_enabled: true }, owner.apiKey));
  await doc(id, "Secret Draft"); // never approved
  await annotate(id, APPROVED, "a note on the approved page", APPROVED_REASON);
  await annotate(id, DRAFT, DRAFT_NOTE, DRAFT_REASON);
  await must(post(`/nests/${id}/collaborators`, { email: viewer.email, permission: "read" }, owner));
  editOnDisk(id, APPROVED, EDIT_TEXT);
  expect((await must(post(`/nests/${id}/external-edits/scan`, {}, owner))).staged).toBe(1);
  suggestionId[id] = (await must(pendingEdit(id, APPROVED, owner))).pending.suggestion_id;
  return id;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@grw.test", "Owner");
  writer = await registerUser(app, "writer@grw.test", "Writer");
  viewer = await registerUser(app, "viewer@grw.test", "Viewer");
  await resetAuthRateLimit();
  outsider = await registerUser(app, "outsider@else.test", "Outsider");
  scoped = await registerUser(app, "scoped@grw.test", "Scoped Steward");
  guest = await registerUser(app, "guest@else.test", "Guest");
  await resetAuthRateLimit();

  pubNest = await governedNest("Public Docs");
  // A folder whose only document is an unapproved draft, flagged as a folder.
  await doc(pubNest, "Launch Plan", "plans");
  await must(post(`/nests/${pubNest}/request-deletion`, { targetType: "folder", target: "plans", reason: FOLDER_REASON }, owner), 201);
  await must(jsonRequest(app, "PATCH", `/nests/${pubNest}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey), 200);
  orgNest = await governedNest("Org Docs");
  await must(jsonRequest(app, "PATCH", `/nests/${orgNest}/visibility`, { visibility: "org" }, owner.apiKey), 200);

  teamNest = await governedNest("Team");
  await must(post(`/nests/${teamNest}/collaborators`, { email: writer.email, permission: "write" }, owner));
  for (const title of ["Scoped Doc", "Shared Doc", "Chat Draft"]) await doc(teamNest, title);
  await annotate(teamNest, SHARED, "a note on the shared document", "the shared page is stale");
  await annotate(teamNest, CHAT_DRAFT, CHAT_NOTE, CHAT_REASON);
  await must(post(`/nests/${teamNest}/stewards`, { scope: "document", nodePattern: "nodes/scoped-doc", email: scoped.email, role: "reviewer" }, owner));
  await must(post(`/nests/${teamNest}/grants`, { target_type: "document", target: SHARED, email: guest.email, role: "read" }, owner), 201);
  // "Chat Draft" was proposed from chat and is still waiting for a person:
  // hidden from everyone below write until it is approved.
  const db = (await import("../src/db/client.js")).getDb();
  const now = new Date().toISOString();
  const proposal = randomUUID();
  await db.run(
    "INSERT INTO surface_proposals (id, window_id, binding_id, nest_id, card_kind, state, forced, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'single', 'posted', 0, ?, ?, ?)",
    [proposal, randomUUID(), randomUUID(), teamNest, new Date(Date.now() + 86_400_000).toISOString(), now, now],
  );
  await db.run(
    "INSERT INTO surface_proposal_items (id, proposal_id, nest_id, node_id, item_kind, op, target_folder, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'decision', 'new', '', 'From chat', 'pending', ?, ?)",
    [randomUUID(), proposal, teamNest, CHAT_DRAFT, now, now],
  );
}, 120_000);

afterAll(async () => {
  await env.cleanup();
});

/** Callers who reach a nest only because of its visibility. */
const VISITORS: Array<[string, () => string, () => Caller]> = [
  ["someone not signed in on a public nest", () => pubNest, () => undefined],
  ["a signed-in person never added to a public nest", () => pubNest, () => outsider],
  ["a signed-in person never added to an org-visible nest", () => orgNest, () => outsider],
];

describe("AC-GRW-01: a pending external edit is not served to people who only read approved versions", () => {
  for (const [caller, nest, who] of VISITORS) {
    it(`AC-GRW-01 ${caller}: reads the approved document, and none of the three reads serves its pending edit`, async () => {
      const page = await get(`/nests/${nest()}/nodes/${APPROVED}`, who());
      expect(page.status).toBe(200);
      expect(JSON.stringify(page.data), "the approved body is what they read").not.toContain(EDIT_TEXT);

      const list = await externalEdits(nest(), who());
      expect(list.status).toBe(200);
      expect(list.data).toEqual({ entries: [], total: 0 });
      expect((await externalEdits(nest(), who(), "?count=1")).data).toEqual({ total: 0 });

      const pending = await pendingEdit(nest(), APPROVED, who());
      expect(pending.data).toEqual((await pendingEdit(nest(), NOWHERE, who())).data);
      expect(pending.data).toEqual({ pending: null });

      const detail = await editDetail(nest(), APPROVED, who());
      const unknown = await editDetail(nest(), APPROVED, who(), "no-such-suggestion");
      expect(JSON.stringify(detail.data), "the edit's text").not.toContain(EDIT_TEXT);
      expect(detail.status).toBe(404);
      expect(detail.data).toEqual(unknown.data);
    });
  }

  it("AC-GRW-01 a read-only collaborator: a document they can't open keeps its pending edit to itself", async () => {
    // Only reachable for a hidden document if an edit was staged before it was
    // hidden, so this pins the per-document rule on the two per-document reads.
    expect((await pendingEdit(teamNest, CHAT_DRAFT, viewer)).data).toEqual({ pending: null });
    expect((await editDetail(teamNest, CHAT_DRAFT, viewer)).status).toBe(404);
  });
});

describe("AC-GRW-02: ?refresh=true rescans the disk only for callers who could run the scan", () => {
  const staged = async (nest: string) => (await externalEdits(nest, owner)).data.total as number;

  it("AC-GRW-02 below write, the list is served and nothing new is staged", async () => {
    for (const [nest, who, label] of [
      [pubNest, undefined, "not signed in, public"],
      [pubNest, outsider, "never added, public"],
      [orgNest, outsider, "never added, org-visible"],
      [teamNest, viewer, "read-only collaborator"],
      [teamNest, scoped, "steward of one document"],
    ] as const) {
      const before = await staged(nest);
      editOnDisk(nest, APPROVED, `typed after the last scan (${label})`);
      const r = await externalEdits(nest, who, "?refresh=true&count=1");
      expect(r.status, label).toBe(200);
      expect(await staged(nest), label).toBe(before);
      // The scan itself is refused for the same caller.
      expect((await post(`/nests/${nest}/external-edits/scan`, {}, who)).status, label).toBeGreaterThanOrEqual(401);
      // Clear the drift so the next caller starts from the same place.
      expect((await must(post(`/nests/${nest}/external-edits/scan`, {}, owner))).staged, label).toBe(1);
    }
  });

  it("AC-GRW-02 a writer's refresh stages what changed on disk, as before", async () => {
    const before = await staged(teamNest);
    editOnDisk(teamNest, APPROVED, "typed after the last scan (writer)");
    const r = await externalEdits(teamNest, writer, "?refresh=true");
    expect(r.status).toBe(200);
    expect(r.data.total).toBe(before + 1);
    expect(await staged(teamNest)).toBe(before + 1);
  });
});

describe("AC-GRW-03: who watches a document is told only to people who can open it", () => {
  for (const [caller, nest, who] of VISITORS) {
    it(`AC-GRW-03 ${caller}: the unapproved draft's watchers answer as for a document that doesn't exist`, async () => {
      expect((await get(`/nests/${nest()}/nodes/${DRAFT}`, who())).status).toBeGreaterThanOrEqual(403);
      const r = await watchers(nest(), DRAFT, who());
      const none = await watchers(nest(), NOWHERE, who());
      expect(r.data).toEqual({ watchers: [] });
      expect(r.status).toBe(none.status);
      expect(r.data).toEqual(none.data);
    });

    it(`AC-GRW-03 ${caller}: no member's address comes with the approved document either`, async () => {
      const r = await watchers(nest(), APPROVED, who());
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.data)).not.toContain("@grw.test");
      expect(r.data).toEqual({ watchers: [] });
    });
  }

  it("AC-GRW-03 a read-only collaborator: a pending chat draft's watchers answer as for a document that doesn't exist", async () => {
    expect((await get(`/nests/${teamNest}/nodes/${CHAT_DRAFT}`, viewer)).status).toBeGreaterThanOrEqual(403);
    const r = await watchers(teamNest, CHAT_DRAFT, viewer);
    expect(r.data).toEqual({ watchers: [] });
    expect(r.data).toEqual((await watchers(teamNest, NOWHERE, viewer)).data);
    // …and every other document's watchers are still theirs to read.
    expect(emails((await watchers(teamNest, DRAFT, viewer)).data)).toEqual([watcherOf(DRAFT)]);
  });
});

describe("AC-GRW-04: the deletion queue lists only requests about what the caller can read", () => {
  for (const [caller, nest, who] of VISITORS) {
    it(`AC-GRW-04 ${caller}: GET /deletion-requests keeps the approved document's request and nothing else`, async () => {
      for (const qs of ["", "?status=all"]) {
        const r = await deletionQueue(nest(), who(), qs);
        expect(r.status).toBe(200);
        expect(targets(r.data), qs).toEqual([APPROVED]);
        expect(r.data.total, qs).toBe(1);
        const text = JSON.stringify(r.data);
        for (const hidden of [DRAFT_REASON, FOLDER_REASON, "Secret Draft", "plans"]) expect(text, hidden).not.toContain(hidden);
        expect(text).toContain(APPROVED_REASON);
      }
    });
  }

  for (const [caller, nest] of [
    ["a signed-in person never added to a public nest", () => pubNest],
    ["a signed-in person never added to an org-visible nest", () => orgNest],
  ] as const) {
    it(`AC-GRW-04 ${caller}: MCP context_deletion_queue says the same`, async () => {
      const text = await queueOverMcp(nest(), outsider);
      expect(text).toContain("Approved Doc");
      expect(text).toContain("1 item(s)");
      for (const hidden of [DRAFT_REASON, FOLDER_REASON, "Secret Draft", "plans"]) expect(text, hidden).not.toContain(hidden);
    });
  }

  it("AC-GRW-04 a read-only collaborator: a pending chat draft's request is left out, over REST and MCP", async () => {
    const r = await deletionQueue(teamNest, viewer);
    expect(targets(r.data)).toEqual([APPROVED, DRAFT, SHARED].sort());
    expect(JSON.stringify(r.data)).not.toContain(CHAT_REASON);
    const text = await queueOverMcp(teamNest, viewer);
    expect(text).toContain("3 item(s)");
    expect(text).not.toContain(CHAT_REASON);
    expect(text).not.toContain("Chat Draft");
  });
});

describe("AC-GRW-05: a comment can't be left or resolved on a document the caller can't open", () => {
  for (const [caller, nest, who, hidden] of [
    ["a signed-in person never added to a public nest", () => pubNest, () => outsider, DRAFT],
    ["a signed-in person never added to an org-visible nest", () => orgNest, () => outsider, DRAFT],
    ["a read-only collaborator, on a pending chat draft", () => teamNest, () => viewer, CHAT_DRAFT],
  ] as const) {
    it(`AC-GRW-05 ${caller}: POST /comments is not found and nothing is written`, async () => {
      const before = (await comments(nest(), hidden, owner)).data.comments.length;
      const r = await addComment(nest(), hidden, who(), "left by someone who can't read this");
      expect(r.status, JSON.stringify(r.data)).toBe(404);
      expect(JSON.stringify(r.data)).not.toContain("left by someone");
      expect((await comments(nest(), hidden, owner)).data.comments).toHaveLength(before);
    });

    it(`AC-GRW-05 ${caller}: POST /comments/:id/resolve answers as for a comment that doesn't exist, and the comment stays open`, async () => {
      const r = await resolve(nest(), hidden, who());
      const unknown = await resolve(nest(), APPROVED, who(), randomUUID());
      expect(r.status, JSON.stringify(r.data)).toBe(404);
      expect(r.data).toEqual(unknown.data);
      const mine = (await comments(nest(), hidden, owner)).data.comments.find((c: any) => c.id === commentId[nest()][hidden]);
      expect(mine.status).toBe("open");
    });
  }

  it("AC-GRW-05 someone not signed in can't write a comment anywhere (unchanged)", async () => {
    expect((await addComment(pubNest, APPROVED, undefined)).status).toBe(401);
    expect((await addComment(pubNest, DRAFT, undefined)).status).toBe(401);
    expect((await resolve(pubNest, DRAFT, undefined)).status).toBe(401);
  });
});

describe("AC-GRW-06: people added to the nest read and write all of it, as before", () => {
  it("AC-GRW-06 the owner, a writer, a read-only collaborator and a steward get the pending external edit and its text", async () => {
    for (const u of [owner, writer, viewer, scoped]) {
      const list = await externalEdits(teamNest, u);
      expect(list.status, u.email).toBe(200);
      expect(list.data.entries.map((e: any) => e.document_id), u.email).toContain(APPROVED);
      expect(list.data.total, u.email).toBe(list.data.entries.length);
      expect((await externalEdits(teamNest, u, "?count=1")).data, u.email).toEqual({ total: list.data.total });
      expect((await pendingEdit(teamNest, APPROVED, u)).data.pending.suggestion_id, u.email).toBeTruthy();
      const detail = await editDetail(teamNest, APPROVED, u);
      expect(detail.status, u.email).toBe(200);
      expect(detail.data.entry.patch, u.email).toContain(EDIT_TEXT);
    }
  });

  it("AC-GRW-06 a read-only collaborator on a public nest is not a visitor: drafts' watchers, the whole queue, the pending edit", async () => {
    for (const u of [owner, viewer]) {
      expect(emails((await watchers(pubNest, DRAFT, u)).data), u.email).toEqual([watcherOf(DRAFT)]);
      expect(emails((await watchers(pubNest, APPROVED, u)).data), u.email).toEqual([watcherOf(APPROVED)]);
      const queue = await deletionQueue(pubNest, u);
      expect(targets(queue.data), u.email).toEqual([APPROVED, DRAFT, "plans"].sort());
      expect(queue.data.total, u.email).toBe(3);
      expect(JSON.stringify(queue.data), u.email).toContain(FOLDER_REASON);
      expect(await queueOverMcp(pubNest, u), u.email).toContain("3 item(s)");
      expect((await editDetail(pubNest, APPROVED, u)).data.entry.patch, u.email).toContain(EDIT_TEXT);
    }
  });

  it("AC-GRW-06 the owner and a writer still see the pending chat draft's watchers and its deletion request", async () => {
    for (const u of [owner, writer]) {
      expect(emails((await watchers(teamNest, CHAT_DRAFT, u)).data), u.email).toEqual([watcherOf(CHAT_DRAFT)]);
      const queue = await deletionQueue(teamNest, u);
      expect(targets(queue.data), u.email).toEqual([APPROVED, CHAT_DRAFT, DRAFT, SHARED].sort());
      expect(Object.keys(queue.data.requests[0]), u.email).toEqual(expect.arrayContaining(["id", "nodeId", "title", "requestedBy", "reason", "status"]));
      expect(await queueOverMcp(teamNest, u), u.email).toContain(CHAT_REASON);
    }
  });

  it("AC-GRW-06 a read-only collaborator and a steward still comment on, and resolve comments on, an unapproved draft", async () => {
    for (const u of [viewer, scoped]) {
      const made = await addComment(teamNest, DRAFT, u, `a question from ${u.email}`);
      expect(made.status, u.email).toBe(201);
      const done = await resolve(teamNest, DRAFT, u, made.data.comment.id);
      expect(done.status, u.email).toBe(200);
      expect(done.data.comment.status, u.email).toBe("resolved");
    }
  });

  it("AC-GRW-06 a writer, who reviews it, comments on the pending chat draft and resolves its comment", async () => {
    const made = await addComment(teamNest, CHAT_DRAFT, writer, "a review note from the writer");
    expect(made.status).toBe(201);
    const done = await resolve(teamNest, CHAT_DRAFT, writer, made.data.comment.id);
    expect(done.status).toBe(200);
    expect(done.data.comment.resolvedBy).toBe(writer.email);
  });
});

describe("AC-GRW-07: callers these routes already kept out stay out", () => {
  it("AC-GRW-07 a document share reaches that document's watchers, pending edit and comments", async () => {
    expect(emails((await watchers(teamNest, SHARED, guest)).data)).toEqual([watcherOf(SHARED)]);
    expect((await pendingEdit(teamNest, SHARED, guest)).data).toEqual({ pending: null });
    const made = await addComment(teamNest, SHARED, guest, "a note from the person it was shared with");
    expect(made.status).toBe(201);
    expect((await resolve(teamNest, SHARED, guest, made.data.comment.id)).status).toBe(200);
  });

  it("AC-GRW-07 a document share reaches nothing else: every other document and both nest-wide lists are not found", async () => {
    expect((await externalEdits(teamNest, guest)).status).toBe(404);
    expect((await deletionQueue(teamNest, guest)).status).toBe(404);
    for (const node of [APPROVED, DRAFT, CHAT_DRAFT]) {
      expect((await watchers(teamNest, node, guest)).status, node).toBe(404);
      expect((await pendingEdit(teamNest, node, guest)).status, node).toBe(404);
      expect((await editDetail(teamNest, node, guest)).status, node).toBe(404);
      expect((await addComment(teamNest, node, guest)).status, node).toBe(404);
    }
  });

  it("AC-GRW-07 someone added to nothing doesn't reach a private nest, and someone not signed in doesn't reach an org-visible one", async () => {
    for (const [nest, who] of [[teamNest, outsider], [orgNest, undefined]] as const) {
      expect((await externalEdits(nest, who)).status).toBe(404);
      expect((await deletionQueue(nest, who)).status).toBe(404);
      expect((await watchers(nest, APPROVED, who)).status).toBe(404);
      expect((await editDetail(nest, APPROVED, who)).status).toBe(404);
    }
    expect((await addComment(teamNest, APPROVED, outsider)).status).toBe(404);
  });

  it("AC-GRW-07 a headless access key is refused all of these routes", async () => {
    const nest = (await must(post("/nests", { name: "Headless" }, owner))).nest.id as string;
    await doc(nest, "Guide");
    await must(jsonRequest(app, "PUT", `/nests/${nest}/headless`, { enabled: true }, owner.apiKey));
    const key = { apiKey: (await must(post(`/nests/${nest}/headless/keys`, { label: "Reader" }, owner), 201)).api_key as string };
    expect((await get(`/nests/${nest}/nodes/nodes/guide`, key)).status).toBe(200);
    for (const path of ["/external-edits", "/deletion-requests", "/nodes/nodes/guide/watchers", "/nodes/nodes/guide/external-edits", "/nodes/nodes/guide/external-edits/x"]) {
      const r = await get(`/nests/${nest}${path}`, key);
      expect(r.status, path).toBe(403);
      expect(r.data.code, path).toBe("headless_reader");
    }
    expect((await addComment(nest, "nodes/guide", key)).data.code).toBe("headless_reader");
  });
});

describe("AC-GRW-06: with sign-in turned off (open mode), the one user still gets everything", () => {
  let openEnv: ReturnType<typeof setupTestEnv>;
  let open: any;
  const call = (method: string, path: string, body?: unknown) => jsonRequest(open, method, path, body);

  beforeAll(async () => {
    openEnv = setupTestEnv();
    open = await createTestApp("open");
  }, 60_000);

  afterAll(async () => {
    await openEnv.cleanup();
  });

  it("AC-GRW-06 a governed nest's external edits, watchers, deletion queue and comments all answer", async () => {
    const nest = (await must(call("POST", "/nests", { name: "Local" }))).nest.id as string;
    await must(call("POST", `/nests/${nest}/nodes`, { title: "Approved Doc", content: "# Approved Doc" }), 201);
    await must(call("PATCH", `/nests/${nest}/settings`, { stewardship_enabled: true }));
    const plan = (await must(call("POST", `/nests/${nest}/nodes`, { title: "Launch Plan", content: "# Launch Plan", folder: "plans" }), 201)).node.id as string;
    expect((await call("GET", `/nests/${nest}/nodes/${plan}`)).status).toBe(200);

    const made = await must(call("POST", `/nests/${nest}/nodes/${plan}/comments`, { body: "a local note" }), 201);
    expect((await call("POST", `/nests/${nest}/nodes/${plan}/comments/${made.comment.id}/resolve`, {})).status).toBe(200);

    await must(call("POST", `/nests/${nest}/nodes/${plan}/watchers`, { email: watcherOf(plan) }), 201);
    expect(emails((await call("GET", `/nests/${nest}/nodes/${plan}/watchers`)).data)).toEqual([watcherOf(plan)]);

    await must(call("POST", `/nests/${nest}/nodes/${plan}/request-deletion`, { reason: DRAFT_REASON }), 201);
    await must(call("POST", `/nests/${nest}/request-deletion`, { targetType: "folder", target: "plans", reason: FOLDER_REASON }), 201);
    expect(targets((await call("GET", `/nests/${nest}/deletion-requests`)).data)).toEqual([plan, "plans"].sort());

    editOnDisk(nest, APPROVED, EDIT_TEXT);
    const list = await call("GET", `/nests/${nest}/external-edits?refresh=true`);
    expect(list.data.total).toBe(1);
    const id = list.data.entries[0].suggestion_id;
    expect((await call("GET", `/nests/${nest}/nodes/${APPROVED}/external-edits`)).data.pending.suggestion_id).toBe(id);
    expect((await call("GET", `/nests/${nest}/nodes/${APPROVED}/external-edits/${id}`)).data.entry.patch).toContain(EDIT_TEXT);
  });
});
