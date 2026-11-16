/**
 * PO-1193: deciding a pending external edit takes approval authority, and a
 * document's name never lowers the access its write routes take.
 *
 *   POST /nests/:id/nodes/:nodeId/external-edits/:suggestionId/approve
 *   POST /nests/:id/nodes/:nodeId/external-edits/:suggestionId/reject
 *
 * An external edit is text typed into the file behind the server's back.
 * Approving it makes that text the approved version; rejecting it puts the
 * file back. Both are the decision a reviewer makes on a submitted version, so
 * both take the same authority:
 *
 *   - governed nest: whoever may approve a version of that document
 *     (`canUserApprove`), minus separation of duties — an external edit has no
 *     submitter;
 *   - open nest (stewardship off): there is no approval step, an edit is
 *     published by whoever may edit, so whoever may edit that document.
 *
 * A document the caller can't open answers like one that isn't there (404);
 * one they can open but may not decide answers 403.
 *
 * Blocks are named by acceptance criterion (AC-EED-*). AC-EED-03, -05 and -07
 * pin what must not change.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };
type Caller = { apiKey: string } | undefined;

const PRICING = "nodes/pricing-page"; // carries a pending external edit nobody below may decide
const HANDBOOK = "nodes/handbook";
const SHARED = "nodes/shared-doc";
const CHAT_DRAFT = "nodes/chat-draft";
const DRAFT = "nodes/secret-draft";
const NOWHERE = "nodes/no-such-document";
const EDIT_TEXT = "a paragraph typed straight into the file";
const REASON = "this change was not agreed";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let admin: User; // admin collaborator on the team nest
let writer: User; // write collaborator
let viewer: User; // read collaborator
let reviewer: User; // read collaborator + nest-wide reviewer steward on the team nest
let docReviewer: User; // reviewer steward of ONE document on the team nest
let outsider: User; // signed in, added to nothing
let guest: User; // a read share on ONE document of the team nest, nothing else
let root: User; // server admin, added to nothing
let pubNest: string; // governed, visibility = public
let orgNest: string; // governed, visibility = org
let teamNest: string; // governed, private
let openNest: string; // stewardship off, private
let openPubNest: string; // stewardship off, visibility = public
/** The pending external edit on each staged document, by nest then node. */
const suggestion: Record<string, Record<string, string>> = {};
/** What that edit typed into the file. */
const typed: Record<string, Record<string, string>> = {};
let edits = 0;

const get = (path: string, u?: Caller) => jsonRequest(app, "GET", path, undefined, u?.apiKey);
const post = (path: string, body: unknown, u?: Caller) => jsonRequest(app, "POST", path, body, u?.apiKey);
const patch = (path: string, body: unknown, u?: Caller) => jsonRequest(app, "PATCH", path, body, u?.apiKey);
const del = (path: string, u?: Caller) => jsonRequest(app, "DELETE", path, undefined, u?.apiKey);
const approve = (nest: string, node: string, u: Caller, id = suggestion[nest]?.[node] ?? "no-such-suggestion") =>
  post(`/nests/${nest}/nodes/${node}/external-edits/${id}/approve`, {}, u);
const reject = (nest: string, node: string, u: Caller, id = suggestion[nest]?.[node] ?? "no-such-suggestion") =>
  post(`/nests/${nest}/nodes/${node}/external-edits/${id}/reject`, { reason: REASON }, u);
const DECISIONS = [
  ["approve", approve],
  ["reject", reject],
] as const;

async function must(r: Promise<{ status: number; data: any }>, status?: number) {
  const res = await r;
  if (status) expect(res.status, JSON.stringify(res.data)).toBe(status);
  else expect(res.status, JSON.stringify(res.data)).toBeLessThan(300);
  return res.data;
}
const doc = (nest: string, title: string, by: Caller = owner) =>
  must(post(`/nests/${nest}/nodes`, { title, content: `# ${title}` }, by), 201);
const fileOf = (nest: string, node: string) => join(process.env.DATA_ROOT!, "nests", nest, `${node}.md`);
const onDisk = (nest: string, node: string) => readFileSync(fileOf(nest, node), "utf-8");

/** Type into a document's file behind the server's back and have it picked up. */
async function stage(nest: string, node: string, by: Caller = owner): Promise<string> {
  const text = `${EDIT_TEXT} (${++edits})`;
  writeFileSync(fileOf(nest, node), `${onDisk(nest, node)}\n\n${text}\n`);
  await must(post(`/nests/${nest}/external-edits/scan`, {}, by));
  const pending = (await must(get(`/nests/${nest}/nodes/${node}/external-edits`, by))).pending;
  expect(pending, `${node} has a pending external edit`).toBeTruthy();
  (suggestion[nest] ??= {})[node] = pending.suggestion_id;
  (typed[nest] ??= {})[node] = text;
  return pending.suggestion_id;
}
const pendingId = async (nest: string, node: string, by: Caller = owner) =>
  (await must(get(`/nests/${nest}/nodes/${node}/external-edits`, by))).pending?.suggestion_id ?? null;
const versionOf = async (nest: string, node: string, by: Caller = owner) =>
  (await must(get(`/nests/${nest}/nodes/${node}`, by))).node.version as number;

/** Refused: the answer, and nothing about the edit or the document moved. */
async function expectRefused(
  nest: string,
  node: string,
  who: Caller,
  status: number,
  message: RegExp,
) {
  const before = await versionOf(nest, node);
  for (const [name, decide] of DECISIONS) {
    const res = await decide(nest, node, who);
    expect(res.status, `${name}: ${JSON.stringify(res.data)}`).toBe(status);
    expect(res.data.error, name).toMatch(message);
    expect(await pendingId(nest, node), `${name}: the edit is still pending`).toBe(suggestion[nest][node]);
    expect(onDisk(nest, node), `${name}: the file is untouched`).toContain(typed[nest][node]);
    expect(await versionOf(nest, node), `${name}: no new version`).toBe(before);
  }
}

/** Decided: approving commits a version, rejecting puts the file back. */
async function expectDecides(nest: string, node: string, who: Caller, by: Caller = owner) {
  await stage(nest, node, by);
  const rejected = await reject(nest, node, who);
  expect(rejected.status, JSON.stringify(rejected.data)).toBe(200);
  expect(rejected.data.rejected).toBe(true);
  expect(await pendingId(nest, node, by)).toBeNull();
  expect(onDisk(nest, node)).not.toContain(typed[nest][node]);

  await stage(nest, node, by);
  const before = await versionOf(nest, node, by);
  const approved = await approve(nest, node, who);
  expect(approved.status, JSON.stringify(approved.data)).toBe(200);
  expect(approved.data.approved).toBe(true);
  expect(await pendingId(nest, node, by)).toBeNull();
  expect(await versionOf(nest, node, by)).toBeGreaterThan(before);
  expect(onDisk(nest, node)).toContain(typed[nest][node]);
}

/**
 * A nest with published documents; `governed` turns stewardship on once they
 * exist, so each has an approved version an external edit can be staged on.
 */
async function nestWith(name: string, titles: string[], governed: boolean): Promise<string> {
  const id = (await must(post("/nests", { name }, owner))).nest.id as string;
  for (const title of titles) await doc(id, title);
  if (governed) await must(patch(`/nests/${id}/settings`, { stewardship_enabled: true }, owner));
  await must(post(`/nests/${id}/collaborators`, { email: viewer.email, permission: "read" }, owner));
  return id;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@eed.test"] });
  owner = await registerUser(app, "owner@eed.test", "Owner");
  admin = await registerUser(app, "admin@eed.test", "Admin");
  writer = await registerUser(app, "writer@eed.test", "Writer");
  await resetAuthRateLimit();
  viewer = await registerUser(app, "viewer@eed.test", "Viewer");
  reviewer = await registerUser(app, "reviewer@eed.test", "Reviewer");
  docReviewer = await registerUser(app, "doc-reviewer@eed.test", "Doc Reviewer");
  await resetAuthRateLimit();
  outsider = await registerUser(app, "outsider@else.test", "Outsider");
  guest = await registerUser(app, "guest@else.test", "Guest");
  root = await registerUser(app, "root@eed.test", "Root");
  await resetAuthRateLimit();

  pubNest = await nestWith("Public Docs", ["Pricing Page"], true);
  await doc(pubNest, "Secret Draft"); // never approved
  await stage(pubNest, PRICING);
  await must(patch(`/nests/${pubNest}/visibility`, { visibility: "public", acknowledge_public: true }, owner), 200);

  orgNest = await nestWith("Org Docs", ["Pricing Page"], true);
  await stage(orgNest, PRICING);
  await must(patch(`/nests/${orgNest}/visibility`, { visibility: "org" }, owner), 200);

  teamNest = await nestWith(
    "Team",
    ["Pricing Page", "Handbook", "Shared Doc", "Chat Draft", "Release Notes", "Roadmap", "Glossary", "Style Guide"],
    true,
  );
  await must(post(`/nests/${teamNest}/collaborators`, { email: writer.email, permission: "write" }, owner));
  await must(post(`/nests/${teamNest}/collaborators`, { email: admin.email, permission: "admin" }, owner));
  await must(post(`/nests/${teamNest}/collaborators`, { email: reviewer.email, permission: "read" }, owner));
  await must(post(`/nests/${teamNest}/stewards`, { scope: "nest", email: reviewer.email, role: "reviewer" }, owner));
  await must(post(`/nests/${teamNest}/stewards`, { scope: "document", nodePattern: HANDBOOK, email: docReviewer.email, role: "reviewer" }, owner));
  await must(post(`/nests/${teamNest}/grants`, { target_type: "document", target: SHARED, email: guest.email, role: "read" }, owner), 201);
  for (const node of [PRICING, SHARED, CHAT_DRAFT]) await stage(teamNest, node);
  // "Chat Draft" is now also a pending proposal from chat: hidden from
  // everyone below write until a person approves it.
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

  openNest = await nestWith("Open Team", ["Pricing Page", "Handbook", "Roadmap"], false);
  await must(post(`/nests/${openNest}/collaborators`, { email: writer.email, permission: "write" }, owner));
  await stage(openNest, PRICING);

  openPubNest = await nestWith("Open Public", ["Pricing Page"], false);
  await stage(openPubNest, PRICING);
  await must(patch(`/nests/${openPubNest}/visibility`, { visibility: "public", acknowledge_public: true }, owner), 200);
}, 180_000);

afterAll(async () => {
  await env.cleanup();
});

describe("AC-EED-01: on a governed nest, only someone who may approve the document decides its external edit", () => {
  const WITHOUT_AUTHORITY: Array<[string, () => string, string, () => Caller, RegExp]> = [
    ["a signed-in person never added to a public nest", () => pubNest, PRICING, () => outsider, /only reviewers|not a steward/i],
    ["a signed-in person never added to an org-visible nest", () => orgNest, PRICING, () => outsider, /only reviewers|not a steward/i],
    ["a read-only collaborator", () => teamNest, PRICING, () => viewer, /only reviewers/i],
    ["a write collaborator who is not a reviewer", () => teamNest, PRICING, () => writer, /only reviewers/i],
    ["a reviewer of one other document", () => teamNest, PRICING, () => docReviewer, /only reviewers|not a steward/i],
    ["someone holding only a read share on the document", () => teamNest, SHARED, () => guest, /only reviewers|not a steward/i],
    ["the owner, while approvals go to assigned reviewers (self-approve off)", () => teamNest, PRICING, () => owner, /self-approve is off/i],
  ];
  for (const [caller, nest, node, who, message] of WITHOUT_AUTHORITY) {
    it(`AC-EED-01 ${caller}: approve and reject are refused (403) and the edit stays pending`, async () => {
      expect((await get(`/nests/${nest()}/nodes/${node}`, who())).status, "they can open the document").toBe(200);
      await expectRefused(nest(), node, who(), 403, message);
    });
  }

  it("AC-EED-01 the refusal is the one the version-review route gives the same person", async () => {
    const submitted = "nodes/style-guide";
    await must(patch(`/nests/${teamNest}/nodes/${submitted}`, { content: "# Style Guide\n\nA draft by the writer." }, writer));
    await must(post(`/nests/${teamNest}/nodes/${submitted}/submit-review`, {}, writer), 201);
    for (const who of [viewer, writer]) {
      const version = await post(`/nests/${teamNest}/nodes/${submitted}/approve`, {}, who);
      expect(version.status).toBe(403);
      const external = await approve(teamNest, PRICING, who);
      expect(external.status).toBe(403);
      expect(external.data.error).toBe(version.data.error);
    }
  });
});

describe("AC-EED-02: a document the caller can't open answers like one that isn't there", () => {
  it("AC-EED-02 a read-only collaborator and a document hidden from them: 404, same as an unknown document", async () => {
    expect((await get(`/nests/${teamNest}/nodes/${CHAT_DRAFT}`, viewer)).status, "they can't open it").toBeGreaterThanOrEqual(403);
    await expectRefused(teamNest, CHAT_DRAFT, viewer, 404, /not found/i);
    for (const [name, decide] of DECISIONS) {
      const hidden = await decide(teamNest, CHAT_DRAFT, viewer);
      const unknown = await decide(teamNest, NOWHERE, viewer, suggestion[teamNest][CHAT_DRAFT]);
      expect(unknown.status, name).toBe(404);
      expect(hidden.data.error.replace(CHAT_DRAFT, NOWHERE), name).toBe(unknown.data.error);
    }
  });

  it("AC-EED-02 a visitor to a public nest and a draft that was never approved: 404, same as an unknown document", async () => {
    for (const [name, decide] of DECISIONS) {
      const draft = await decide(pubNest, DRAFT, outsider);
      const unknown = await decide(pubNest, NOWHERE, outsider);
      expect(draft.status, name).toBe(404);
      expect(unknown.status, name).toBe(404);
      expect(draft.data.error.replace(DRAFT, NOWHERE), name).toBe(unknown.data.error);
    }
  });
});

describe("AC-EED-03: whoever may approve a version of the document still decides its external edit", () => {
  it("AC-EED-03 a nest-wide reviewer who is otherwise read-only approves and rejects", async () => {
    await expectDecides(teamNest, "nodes/release-notes", reviewer);
  });

  it("AC-EED-03 a reviewer of that one document approves and rejects", async () => {
    await expectDecides(teamNest, HANDBOOK, docReviewer);
  });

  it("AC-EED-03 an admin collaborator approves and rejects", async () => {
    await expectDecides(teamNest, "nodes/glossary", admin);
  });

  it("AC-EED-03 the server admin approves and rejects", async () => {
    await expectDecides(teamNest, "nodes/glossary", root);
  });

  it("AC-EED-03 the owner approves and rejects once the nest allows self-approve", async () => {
    const nest = await nestWith("Seeding", ["Pricing Page"], true);
    await must(patch(`/nests/${nest}/settings`, { allow_self_approve: true }, owner));
    await expectDecides(nest, PRICING, owner);
  });

  it("AC-EED-03 a reviewer who wrote the document's current version still decides: an external edit has no submitter", async () => {
    const nest = (await must(post("/nests", { name: "Authored" }, owner))).nest.id as string;
    await must(post(`/nests/${nest}/collaborators`, { email: admin.email, permission: "admin" }, owner));
    await doc(nest, "Pricing Page", admin);
    await must(patch(`/nests/${nest}/settings`, { stewardship_enabled: true }, owner));
    // Their own version is one they may not approve (separation of duties)...
    expect((await must(get(`/nests/${nest}/nodes/${PRICING}/can-approve`, admin))).allowed).toBe(false);
    // ...but an edit made outside the app is not their submission.
    await expectDecides(nest, PRICING, admin);
  });
});

describe("AC-EED-04: on an open nest, whoever may edit the document decides its external edit", () => {
  it("AC-EED-04 a read-only collaborator: approve and reject are refused (403) and the edit stays pending", async () => {
    await expectRefused(openNest, PRICING, viewer, 403, /edit this document/i);
  });

  it("AC-EED-04 a signed-in person never added to a public open nest: approve and reject are refused (403)", async () => {
    await expectRefused(openPubNest, PRICING, outsider, 403, /edit this document/i);
  });

  it("AC-EED-05 the owner approves and rejects, with no reviewer and self-approve off, as before", async () => {
    await expectDecides(openNest, HANDBOOK, owner);
  });

  it("AC-EED-05 a write collaborator approves and rejects, as before", async () => {
    await expectDecides(openNest, "nodes/roadmap", writer, writer);
  });
});

describe("AC-EED-05: what was already refused, and what a decider is told, is unchanged", () => {
  it("AC-EED-05 not signed in: 401 on a public nest, governed or open", async () => {
    for (const nest of [pubNest, openPubNest]) {
      for (const [name, decide] of DECISIONS) {
        expect((await decide(nest, PRICING, undefined)).status, name).toBe(401);
      }
      expect(await pendingId(nest, PRICING)).toBe(suggestion[nest][PRICING]);
    }
  });

  it("AC-EED-05 someone with a share on a different document: 404", async () => {
    for (const [name, decide] of DECISIONS) {
      expect((await decide(teamNest, PRICING, guest)).status, name).toBe(404);
    }
    expect(await pendingId(teamNest, PRICING)).toBe(suggestion[teamNest][PRICING]);
  });

  it("AC-EED-05 a decider naming an edit that isn't there gets the same 400 as before", async () => {
    for (const [name, decide] of DECISIONS) {
      expect((await decide(teamNest, PRICING, reviewer, "no-such-suggestion")).status, name).toBe(400);
      expect((await decide(openNest, PRICING, owner, "no-such-suggestion")).status, name).toBe(400);
    }
  });

  it("AC-EED-05 a decider rejecting without a reason gets the same 400 as before", async () => {
    const res = await post(`/nests/${teamNest}/nodes/${PRICING}/external-edits/${suggestion[teamNest][PRICING]}/reject`, {}, reviewer);
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/reason is required/i);
  });
});

describe("AC-EED-06: a document's name never lowers the access its write routes take", () => {
  // Ids that begin with, or are, the words the read-tier actions are named
  // after: the review actions, comments, annotations and the bulk review route.
  const NAMED: Array<[title: string, id: string, folder?: string]> = [
    ["Approved Vendors", "nodes/approved-vendors"],
    ["Rejected Ideas", "nodes/rejected-ideas"],
    ["Submit Review Notes", "nodes/submit-review-notes"],
    ["Cancel Review Log", "nodes/cancel-review-log"],
    ["Comments", "nodes/comments"],
    ["Annotations", "nodes/annotations"],
    ["Bulk", "nodes/review-queue/bulk", "review-queue"],
  ];
  let nests: Array<[string, string]>;
  let publicNest: string;

  async function namedNest(name: string, governed: boolean): Promise<string> {
    const nest = (await must(post("/nests", { name }, owner))).nest.id as string;
    await doc(nest, "Plain Page");
    for (const [title, id, folder] of NAMED) {
      const made = await must(post(`/nests/${nest}/nodes`, { title, content: `# ${title}`, ...(folder ? { folder } : {}) }, owner), 201);
      expect(made.node.id).toBe(id);
    }
    if (governed) await must(patch(`/nests/${nest}/settings`, { stewardship_enabled: true }, owner));
    await must(post(`/nests/${nest}/collaborators`, { email: viewer.email, permission: "read" }, owner));
    await must(post(`/nests/${nest}/collaborators`, { email: writer.email, permission: "write" }, owner));
    return nest;
  }

  beforeAll(async () => {
    nests = [
      ["a governed nest", await namedNest("Named Governed", true)],
      ["an open nest", await namedNest("Named Open", false)],
    ];
    publicNest = await namedNest("Named Public", false);
    await must(patch(`/nests/${publicNest}/visibility`, { visibility: "public", acknowledge_public: true }, owner), 200);
  }, 120_000);

  /** Every write a document takes, as this caller: all refused like any other document's. */
  async function expectWritesRefused(nest: string, node: string, who: Caller) {
    const plain = await patch(`/nests/${nest}/nodes/nodes/plain-page`, { content: "changed" }, who);
    expect(plain.status, "the same person and any other document").toBe(403);
    // Read from the file: a document named "Comments" can't be fetched by id,
    // because GET …/nodes/comments is the comments route of the node "nodes".
    const before = onDisk(nest, node);
    const attempts: Array<[string, { status: number; data: any }]> = [
      ["edit", await patch(`/nests/${nest}/nodes/${node}`, { content: "changed by someone who only reads" }, who)],
      ["move", await post(`/nests/${nest}/nodes/${node}/move`, { folder: "elsewhere" }, who)],
      ["add a watcher", await post(`/nests/${nest}/nodes/${node}/watchers`, { email: "someone@else.test" }, who)],
      ["delete", await del(`/nests/${nest}/nodes/${node}`, who)],
    ];
    for (const [what, res] of attempts) {
      expect(res.status, `${what} ${node}: ${JSON.stringify(res.data)}`).toBe(403);
      expect(res.data.required_permission, `${what} ${node}`).toBe(plain.data.required_permission);
    }
    expect(onDisk(nest, node), `${node} is where it was, unchanged`).toBe(before);
    expect((await must(get(`/nests/${nest}/nodes/${node}/watchers`, owner))).watchers).toEqual([]);
  }

  for (const [title, id] of NAMED) {
    it(`AC-EED-06 "${title}" (${id}): a read-only collaborator can't edit, move, watch-list or delete it`, async () => {
      for (const [, nest] of nests) await expectWritesRefused(nest, id, viewer);
    });

    it(`AC-EED-06 "${title}" (${id}): a signed-in visitor to a public nest can't edit, move, watch-list or delete it`, async () => {
      await expectWritesRefused(publicNest, id, outsider);
    });
  }

  it("AC-EED-07 a read-only collaborator still comments on such a document, and on any other", async () => {
    for (const [, nest] of nests) {
      for (const node of ["nodes/approved-vendors", "nodes/plain-page"]) {
        const made = await post(`/nests/${nest}/nodes/${node}/comments`, { body: "a reader's note" }, viewer);
        expect(made.status, JSON.stringify(made.data)).toBe(201);
        expect((await post(`/nests/${nest}/nodes/${node}/comments/${made.data.comment.id}/resolve`, {}, viewer)).status).toBe(200);
      }
    }
  });

  it("AC-EED-07 a write collaborator still edits and deletes such documents", async () => {
    for (const [label, nest] of nests) {
      for (const [title, id] of NAMED) {
        const edited = await patch(`/nests/${nest}/nodes/${id}`, { content: `# ${title}\n\nA real edit.` }, writer);
        expect(edited.status, `${label} ${id}: ${JSON.stringify(edited.data)}`).toBe(200);
      }
    }
    for (const [, id] of NAMED) {
      expect((await del(`/nests/${nests[1][1]}/nodes/${id}`, writer)).status, id).toBe(200);
    }
  });
});

describe("AC-EED-07: review actions still reach a reviewer who is otherwise read-only", () => {
  const node = "nodes/roadmap";
  const draft = async (text: string) => {
    await must(patch(`/nests/${teamNest}/nodes/${node}`, { content: `# Roadmap\n\n${text}` }, writer));
    await must(post(`/nests/${teamNest}/nodes/${node}/submit-review`, {}, writer), 201);
  };

  it("AC-EED-07 they reject, approve and withdraw a submitted version, and submit one", async () => {
    await draft("First try.");
    expect((await post(`/nests/${teamNest}/nodes/${node}/reject`, { note: "not yet" }, reviewer)).status).toBe(200);
    await draft("Second try.");
    expect((await post(`/nests/${teamNest}/nodes/${node}/approve`, {}, reviewer)).status).toBe(200);
    await draft("Third try.");
    expect((await post(`/nests/${teamNest}/nodes/${node}/cancel-review`, {}, reviewer)).status).toBe(200);
    expect((await post(`/nests/${teamNest}/nodes/${node}/submit-review`, {}, reviewer)).status).toBe(201);
    expect((await post(`/nests/${teamNest}/nodes/${node}/cancel-review`, {}, reviewer)).status).toBe(200);
    await must(post(`/nests/${teamNest}/nodes/${node}/submit-review`, {}, writer), 201);
    const bulk = await post(`/nests/${teamNest}/review-queue/bulk`, { nodeIds: [node], action: "reject", note: "still not" }, reviewer);
    expect(bulk.status).toBe(200);
    expect(bulk.data.succeeded).toBe(1);
  });

  it("AC-EED-07 a read-only collaborator with no reviewer role is still refused by each of them", async () => {
    await draft("Fourth try.");
    expect((await post(`/nests/${teamNest}/nodes/${node}/approve`, {}, viewer)).status).toBe(403);
    expect((await post(`/nests/${teamNest}/nodes/${node}/reject`, { note: "no" }, viewer)).status).toBe(403);
    expect((await post(`/nests/${teamNest}/nodes/${node}/approve-with-edits`, { content: "# Roadmap" }, viewer)).status).toBe(403);
    expect((await post(`/nests/${teamNest}/nodes/${node}/cancel-review`, {}, viewer)).status).toBe(403);
    await must(post(`/nests/${teamNest}/nodes/${node}/cancel-review`, {}, writer));
  });
});

describe("AC-EED-05: with sign-in turned off (open mode), the one user still decides", () => {
  let openEnv: ReturnType<typeof setupTestEnv>;
  let open: any;
  const call = (method: string, path: string, body?: unknown) => jsonRequest(open, method, path, body);

  async function stageLocal(nest: string, node: string): Promise<string> {
    writeFileSync(fileOf(nest, node), `${onDisk(nest, node)}\n\n${EDIT_TEXT}\n`);
    await must(call("POST", `/nests/${nest}/external-edits/scan`, {}));
    return (await must(call("GET", `/nests/${nest}/nodes/${node}/external-edits`))).pending.suggestion_id;
  }
  const decideLocal = (nest: string, node: string, id: string, decision: "approve" | "reject") =>
    call("POST", `/nests/${nest}/nodes/${node}/external-edits/${id}/${decision}`, { reason: REASON });

  beforeAll(async () => {
    openEnv = setupTestEnv();
    open = await createTestApp("open");
  }, 60_000);

  afterAll(async () => {
    await openEnv.cleanup();
  });

  it("AC-EED-05 they approve and reject an external edit on a nest they made", async () => {
    const nest = (await must(call("POST", "/nests", { name: "Local" }))).nest.id as string;
    await must(call("POST", `/nests/${nest}/nodes`, { title: "Pricing Page", content: "# Pricing Page" }), 201);
    expect((await decideLocal(nest, PRICING, await stageLocal(nest, PRICING), "reject")).status).toBe(200);
    expect((await decideLocal(nest, PRICING, await stageLocal(nest, PRICING), "approve")).status).toBe(200);
  });

  it("AC-EED-01 on a governed nest they decide as they approve a version: once the nest allows self-approve", async () => {
    const nest = (await must(call("POST", "/nests", { name: "Local Governed" }))).nest.id as string;
    await must(call("POST", `/nests/${nest}/nodes`, { title: "Pricing Page", content: "# Pricing Page" }), 201);
    await must(call("PATCH", `/nests/${nest}/settings`, { stewardship_enabled: true }));
    const id = await stageLocal(nest, PRICING);
    for (const decision of ["approve", "reject"] as const) {
      const res = await decideLocal(nest, PRICING, id, decision);
      expect(res.status, decision).toBe(403);
      expect(res.data.error, decision).toMatch(/self-approve is off/i);
    }
    await must(call("PATCH", `/nests/${nest}/settings`, { allow_self_approve: true }));
    expect((await decideLocal(nest, PRICING, id, "approve")).status).toBe(200);
  });

  it("AC-EED-05 and on a nest that was made by an account from before sign-in was turned off", async () => {
    const nest = (await must(call("POST", "/nests", { name: "Inherited" }))).nest.id as string;
    await must(call("POST", `/nests/${nest}/nodes`, { title: "Pricing Page", content: "# Pricing Page" }), 201);
    const db = (await import("../src/db/client.js")).getDb();
    const earlier = randomUUID();
    await db.run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)", [earlier, "earlier@eed.test", "Earlier", "x"]);
    await db.run("UPDATE nests SET user_id = ? WHERE id = ?", [earlier, nest]);
    expect((await decideLocal(nest, PRICING, await stageLocal(nest, PRICING), "reject")).status).toBe(200);
    expect((await decideLocal(nest, PRICING, await stageLocal(nest, PRICING), "approve")).status).toBe(200);
  });
});
