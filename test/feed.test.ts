/**
 * Nest activity feed — GET /nests/:id/feed (CU-wdqcpzw7hw).
 *
 * The feed interleaves pending change submissions (the same rows the review
 * queue shows today) with annotation activity (new comment threads + replies),
 * newest first. It is an ADDITIVE sibling of /review-queue: that endpoint —
 * and the MCP context_review_queue tool built on the same service — must keep
 * their exact shape (regression-asserted below).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";
import { getDb } from "../src/db/client.js";

describe("activity feed: changes + comments, newest first", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let alphaId: string;
  let betaId: string;
  let reviewId: string;
  let betaThreadId: string;
  const LONG_BODY = "x".repeat(250);

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    alice = await registerUser(app, "alice@acme.com", "Alice");

    const nest = await jsonRequest(app, "POST", "/nests", { name: "Feed Nest" }, alice.apiKey);
    nestId = nest.data.nest.id;

    const alpha = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes`,
      { title: "Doc Alpha", content: "# Alpha\n\ndraft body" }, alice.apiKey,
    );
    alphaId = alpha.data.node.id;
    const beta = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes`,
      { title: "Doc Beta", content: "# Beta" }, alice.apiKey,
    );
    betaId = beta.data.node.id;

    // 08:00 — a thread on Beta that gets resolved (resolved state must surface).
    const resolvedThread = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/${betaId}/annotations`,
      { body: "resolve me" }, alice.apiKey,
    );
    await jsonRequest(
      app, "POST",
      `/nests/${nestId}/nodes/${betaId}/annotations/${resolvedThread.data.thread.id}/resolve`,
      {}, alice.apiKey,
    );

    // 09:00 — a new thread on Beta.
    const betaThread = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/${betaId}/annotations`,
      { body: "First thread on beta" }, alice.apiKey,
    );
    betaThreadId = betaThread.data.thread.id;

    // 10:00 — Alpha submitted for review (the pending change).
    const submitted = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/${alphaId}/submit-review`,
      { note: "please review", priority: "high" }, alice.apiKey,
    );
    reviewId = submitted.data.review.id;

    // 11:00 — a reply on the Beta thread.
    const replied = await jsonRequest(
      app, "POST",
      `/nests/${nestId}/nodes/${betaId}/annotations/${betaThreadId}/comments`,
      { body: "A reply arrives later" }, alice.apiKey,
    );
    expect(replied.status).toBe(200);

    // 12:00 — a long comment on Alpha (snippet truncation).
    await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/${alphaId}/annotations`,
      { body: LONG_BODY }, alice.apiKey,
    );

    // Everything above lands within the same wall-clock second — pin distinct
    // timestamps so newest-first ordering is deterministic to assert.
    const db = getDb();
    const setComment = (body: string, at: string) =>
      db.run("UPDATE annotation_comments SET created_at = ? WHERE body = ?", [at, body]);
    await setComment("resolve me", "2026-07-14 08:00:00");
    await setComment("First thread on beta", "2026-07-14 09:00:00");
    await db.run("UPDATE review_requests SET requested_at = ? WHERE id = ?", [
      "2026-07-14 10:00:00", reviewId,
    ]);
    await setComment("A reply arrives later", "2026-07-14 11:00:00");
    await setComment(LONG_BODY, "2026-07-14 12:00:00");
  });

  afterAll(() => env.cleanup());

  const getFeed = (qs: string) =>
    jsonRequest(app, "GET", `/nests/${nestId}/feed${qs}`, undefined, alice.apiKey);

  it("returns changes and comments interleaved, newest first", async () => {
    const { status, data } = await getFeed("");
    expect(status).toBe(200);
    expect(data.total).toBe(5);
    expect(data.counts).toEqual({ changes: 1, comments: 4, pending_pushes: 0 });

    expect(data.items.map((i: any) => i.type)).toEqual([
      "comment", // 12:00 long comment on Alpha
      "comment", // 11:00 reply on Beta
      "change",  // 10:00 Alpha submitted for review
      "comment", // 09:00 new thread on Beta
      "comment", // 08:00 resolved thread on Beta
    ]);
    // Strictly newest-first.
    for (let i = 1; i < data.items.length; i++) {
      expect(
        data.items[i - 1].createdAt >= data.items[i].createdAt,
      ).toBe(true);
    }

    // Change item keeps every field the queue shows today.
    const change = data.items[2];
    expect(change).toMatchObject({
      type: "change",
      id: reviewId,
      nestId,
      nodeId: alphaId,
      title: "Doc Alpha",
      requestedBy: alice.email,
      requestNote: "please review",
      status: "pending",
      priority: "high",
      createdAt: "2026-07-14 10:00:00",
    });
    expect(typeof change.canReview).toBe("boolean");

    // Comment items carry doc id + title, author, snippet, thread id,
    // resolved state, and whether they're a reply.
    const reply = data.items[1];
    expect(reply).toMatchObject({
      type: "comment",
      threadId: betaThreadId,
      nodeId: betaId,
      title: "Doc Beta",
      author: alice.email,
      snippet: "A reply arrives later",
      isReply: true,
      resolved: false,
    });
    const rootThread = data.items[3];
    expect(rootThread).toMatchObject({
      type: "comment",
      threadId: betaThreadId,
      nodeId: betaId,
      snippet: "First thread on beta",
      isReply: false,
    });
    const resolved = data.items[4];
    expect(resolved).toMatchObject({
      type: "comment",
      nodeId: betaId,
      snippet: "resolve me",
      isReply: false,
      resolved: true,
    });
  });

  it("truncates comment snippets to ~200 chars", async () => {
    const { data } = await getFeed("?filter=comments");
    const long = data.items.find((i: any) => i.createdAt === "2026-07-14 12:00:00");
    expect(long.snippet).toBe(`${"x".repeat(200)}…`);
    expect(long.nodeId).toBe(alphaId);
    expect(long.title).toBe("Doc Alpha");
  });

  it("filter=changes matches the existing review queue contents", async () => {
    const feed = await getFeed("?filter=changes");
    expect(feed.data.items.every((i: any) => i.type === "change")).toBe(true);
    expect(feed.data.total).toBe(1);

    const queue = await jsonRequest(
      app, "GET", `/nests/${nestId}/review-queue`, undefined, alice.apiKey,
    );
    expect(feed.data.items.map((i: any) => i.id).sort()).toEqual(
      queue.data.requests.map((r: any) => r.id).sort(),
    );
    // Every queue field survives on the feed's change item.
    const queueRow = queue.data.requests[0];
    const feedRow = feed.data.items.find((i: any) => i.id === queueRow.id);
    for (const key of [
      "id", "nestId", "nodeId", "title", "version",
      "requestedBy", "requestedAt", "requestNote", "status", "priority",
    ]) {
      expect(feedRow[key]).toEqual(queueRow[key]);
    }
  });

  it("filter=comments returns only annotation activity", async () => {
    const { data } = await getFeed("?filter=comments");
    expect(data.items).toHaveLength(4);
    expect(data.items.every((i: any) => i.type === "comment")).toBe(true);
    expect(data.total).toBe(4);
  });

  it("paginates the merged feed with limit/offset", async () => {
    const page1 = await getFeed("?limit=2&offset=0");
    const page2 = await getFeed("?limit=2&offset=2");
    const page3 = await getFeed("?limit=2&offset=4");

    expect(page1.data.items).toHaveLength(2);
    expect(page2.data.items).toHaveLength(2);
    expect(page3.data.items).toHaveLength(1);
    expect(page1.data.total).toBe(5);
    expect(page2.data.total).toBe(5);

    // Pages are disjoint and, concatenated, equal the unpaginated feed.
    const all = await getFeed("");
    const paged = [
      ...page1.data.items, ...page2.data.items, ...page3.data.items,
    ].map((i: any) => `${i.type}:${i.id}`);
    expect(new Set(paged).size).toBe(5);
    expect(paged).toEqual(all.data.items.map((i: any) => `${i.type}:${i.id}`));
  });

  it("returns an empty page with intact counts past the end of the feed", async () => {
    const { status, data } = await getFeed("?filter=comments&limit=2&offset=10");
    expect(status).toBe(200);
    expect(data.items).toEqual([]);
    // Totals stay authoritative even when the page is empty — the UI's
    // chip badge and load-more affordance bind to these.
    expect(data.total).toBe(4);
    expect(data.counts).toEqual({ changes: 1, comments: 4, pending_pushes: 0 });
    expect(data.offset).toBe(10);
    expect(data.limit).toBe(2);
  });

  it("clamps out-of-range limit and offset", async () => {
    // Negative / non-numeric values fall back to defaults, not errors.
    const bad = await getFeed("?limit=-5&offset=-3");
    expect(bad.status).toBe(200);
    expect(bad.data.limit).toBe(50);
    expect(bad.data.offset).toBe(0);
    expect(bad.data.items).toHaveLength(5);

    const junk = await getFeed("?limit=abc&offset=abc");
    expect(junk.data.limit).toBe(50);
    expect(junk.data.offset).toBe(0);
    expect(junk.data.items).toHaveLength(5);

    // Oversized values are capped (limit 200, offset 10_000) so the merge
    // window can't be grown without bound.
    const huge = await getFeed("?limit=99999&offset=99999999");
    expect(huge.data.limit).toBe(200);
    expect(huge.data.offset).toBe(10000);
    expect(huge.data.items).toEqual([]);
    expect(huge.data.total).toBe(5);
  });

  it("REGRESSION: the existing review-queue endpoint is unchanged", async () => {
    const { status, data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/review-queue`, undefined, alice.apiKey,
    );
    expect(status).toBe(200);
    // Same envelope as before the feed existed…
    expect(Object.keys(data).sort()).toEqual(["requests", "total"]);
    expect(data.total).toBe(1);
    const row = data.requests[0];
    // …and rows carry the queue's fields, no feed-only decorations.
    expect(row.id).toBe(reviewId);
    expect(row.nodeId).toBe(alphaId);
    expect(row.status).toBe("pending");
    expect(row).not.toHaveProperty("type");
    expect(row).not.toHaveProperty("createdAt");
    expect(row).toHaveProperty("canReview");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Access filtering: comment items only for docs the caller can read
// ═══════════════════════════════════════════════════════════════════════════

describe("activity feed: comments are access-filtered", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let reader: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let openDocId: string;
  let secretDocId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    reader = await registerUser(app, "reader@acme.com", "Reader");

    const nest = await jsonRequest(app, "POST", "/nests", { name: "Gated" }, owner.apiKey);
    nestId = nest.data.nest.id;

    // Created while ungoverned → auto-published + approved (public-readable).
    const openDoc = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes`,
      { title: "Open Doc", content: "# public" }, owner.apiKey,
    );
    openDocId = openDoc.data.node.id;

    // Governed from here on: the next doc stays a draft (no approved version),
    // which a public reader cannot read.
    await jsonRequest(
      app, "PATCH", `/nests/${nestId}/settings`,
      { stewardship_enabled: true }, owner.apiKey,
    );
    const secretDoc = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes`,
      { title: "Secret Doc", content: "# drafty" }, owner.apiKey,
    );
    secretDocId = secretDoc.data.node.id;

    await jsonRequest(
      app, "PATCH", `/nests/${nestId}/visibility`,
      { visibility: "public" }, owner.apiKey,
    );

    // Owner comments on both docs.
    await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/${openDocId}/annotations`,
      { body: "note on the open doc" }, owner.apiKey,
    );
    await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/${secretDocId}/annotations`,
      { body: "note on the secret draft" }, owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("excludes comments on docs the caller can't read (public reader)", async () => {
    const { status, data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/feed?filter=comments`,
      undefined, reader.apiKey,
    );
    expect(status).toBe(200);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].nodeId).toBe(openDocId);
    expect(data.items[0].snippet).toBe("note on the open doc");
    expect(
      data.items.some((i: any) => i.nodeId === secretDocId),
    ).toBe(false);
    // The totals must not leak the hidden discussion either.
    expect(data.counts.comments).toBe(1);
  });

  it("includes both docs' comments for the owner", async () => {
    const { data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/feed?filter=comments`,
      undefined, owner.apiKey,
    );
    const nodeIds = data.items.map((i: any) => i.nodeId).sort();
    expect(nodeIds).toEqual([secretDocId, openDocId].sort());
    expect(data.counts.comments).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// License gate: /feed is governance surface, locked like /review-queue
// ═══════════════════════════════════════════════════════════════════════════

describe("activity feed: license gate", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  /**
   * An app with the REAL license module (no PROMPTOWL_KEY → unlicensed).
   * createTestApp (used by the suites above) doMock's the license module to
   * report valid; drop that mock so the gate actually closes. Open mode so
   * requests don't need auth fixtures — the license gate sits before the
   * permission/404 resolution, so no nest needs to exist.
   */
  async function createUnlicensedApp() {
    process.env.AUTH_MODE = "open";
    vi.resetModules();
    vi.doUnmock("../src/auth/license.js");
    const dbClient = await import("../src/db/client.js");
    await dbClient.resetDb();
    await dbClient.initDb();
    const { createApp } = await import("../src/app.js");
    return createApp();
  }

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createUnlicensedApp();
  });

  afterAll(() => env.cleanup());

  it("503s /review-queue without a license (the gate the feed must match)", async () => {
    const res = await app.request("/nests/some-nest/review-queue");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("License required");
  });

  it("503s /feed without a license — including filter=changes", async () => {
    // Bare feed…
    const res = await app.request("/nests/some-nest/feed");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("License required");

    // …and the shape that would otherwise leak the review queue's rows
    // through the side door.
    const changes = await app.request("/nests/some-nest/feed?filter=changes");
    expect(changes.status).toBe(503);
    expect((await changes.json()).error).toBe("License required");
  });

  it("does NOT trip the gate for a node whose slug contains 'feed'", async () => {
    // Plain node reads stay open unlicensed. The guard matches the exact
    // /nests/:id/feed route shape, so nodes/product-feed must pass the
    // license gate (and then 404 on the missing nest — anything but 503).
    const res = await app.request("/nests/some-nest/nodes/nodes%2Fproduct-feed");
    expect(res.status).not.toBe(503);
  });
});
