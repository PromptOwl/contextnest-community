/**
 * Experimental cross-nest document stream — GET /me/stream (CU-wdqcq02crv).
 *
 * One item per node version across every nest the caller can read, newest
 * first, access-filtered, with nest / tag / type / author facets. Behind its
 * own superadmin switch (EXPERIMENTAL_DOC_STREAM, default off), surfaced in
 * /health as `experimental.doc_stream`.
 *
 * Regression guards ride along: the per-nest governance feed keeps its shape,
 * a nest the caller can't read never leaks (items, totals or facet counts),
 * and the unlicensed 503 is asserted with the REAL license module (the #145
 * lesson — a mocked license hides a missing gate).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  seedPeople,
  resetAuthRateLimit,
} from "./helpers.js";
import { FREE_TIER_MAX_USERS } from "../src/auth/free-tier.js";

const OWNER_EMAIL = "owner@acme.com";

async function db() {
  // The post-resetModules instance the running app uses.
  return (await import("../src/db/client.js")).getDb();
}

// ═══════════════════════════════════════════════════════════════════════════
// The switch: off by default, superadmin-only, live, mirrored in /health
// ═══════════════════════════════════════════════════════════════════════════

describe("doc stream switch (EXPERIMENTAL_DOC_STREAM)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let admin: { apiKey: string };
  let member: { apiKey: string };

  beforeAll(async () => {
    env = setupTestEnv();
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    admin = await registerUser(app, OWNER_EMAIL, "Owner");
    member = await registerUser(app, "member@acme.com", "Member");
  });

  afterAll(async () => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    await env.cleanup();
  });

  it("is off by default: /me/stream 404s and /health says doc_stream false", async () => {
    const stream = await jsonRequest(app, "GET", "/me/stream", undefined, member.apiKey);
    expect(stream.status).toBe(404);
    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.experimental).toEqual({ doc_stream: false });
    const settings = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(settings.data.experimental_doc_stream_enabled).toBe(false);
  });

  it("refuses a non-superadmin PATCH (403) and persists nothing", async () => {
    const res = await jsonRequest(
      app, "PATCH", "/admin/settings", { experimental_doc_stream_enabled: true }, member.apiKey,
    );
    expect(res.status).toBe(403);
    const row = await (await db()).get(
      "SELECT value FROM server_settings WHERE key = ?", ["EXPERIMENTAL_DOC_STREAM"],
    );
    expect(row).toBeUndefined();
    expect((await jsonRequest(app, "GET", "/health")).data.experimental.doc_stream).toBe(false);
  });

  it("a superadmin flips it on without a restart, and back off", async () => {
    const on = await jsonRequest(
      app, "PATCH", "/admin/settings", { experimental_doc_stream_enabled: true }, admin.apiKey,
    );
    expect(on.status).toBe(200);
    expect(on.data.settings.experimental_doc_stream_enabled).toBe(true);
    const row = (await (await db()).get(
      "SELECT value FROM server_settings WHERE key = ?", ["EXPERIMENTAL_DOC_STREAM"],
    )) as { value: string | null };
    expect(row.value).toBe("true");
    expect((await jsonRequest(app, "GET", "/health")).data.experimental).toEqual({ doc_stream: true });
    const stream = await jsonRequest(app, "GET", "/me/stream", undefined, member.apiKey);
    expect(stream.status).toBe(200);
    expect(stream.data.items).toEqual([]);

    const off = await jsonRequest(
      app, "PATCH", "/admin/settings", { experimental_doc_stream_enabled: false }, admin.apiKey,
    );
    expect(off.status).toBe(200);
    expect(off.data.settings.experimental_doc_stream_enabled).toBe(false);
    expect((await jsonRequest(app, "GET", "/health")).data.experimental.doc_stream).toBe(false);
    expect((await jsonRequest(app, "GET", "/me/stream", undefined, member.apiKey)).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The stream itself
// ═══════════════════════════════════════════════════════════════════════════

describe("doc stream: access-filtered, newest first, faceted", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string; email: string };
  let bob: { apiKey: string; userId: string; email: string };
  let carol: { apiKey: string; userId: string; email: string };
  let nestA: string;
  let nestB: string;
  let fmtDoc: string;
  let gerdDoc: string;
  let draftDoc: string;
  let bFmtDoc: string;

  const stream = (qs: string, who: { apiKey: string } = carol) =>
    jsonRequest(app, "GET", `/me/stream${qs}`, undefined, who.apiKey);

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@acme.com", "Alice");
    bob = await registerUser(app, "bob@acme.com", "Bob");
    carol = await registerUser(app, "carol@acme.com", "Carol");

    nestA = (await jsonRequest(app, "POST", "/nests", { name: "Alpha Nest" }, alice.apiKey)).data.nest.id;
    nestB = (await jsonRequest(app, "POST", "/nests", { name: "Bravo Nest" }, bob.apiKey)).data.nest.id;

    fmtDoc = (await jsonRequest(app, "POST", `/nests/${nestA}/nodes`, {
      title: "FMT Guide", content: "# FMT\n\nFecal transplant primer body.", tags: ["fmt"], type: "reference",
    }, alice.apiKey)).data.node.id;
    gerdDoc = (await jsonRequest(app, "POST", `/nests/${nestA}/nodes`, {
      title: "GERD Notes", content: "# GERD\n\nReflux notes.", tags: ["#gerd"],
    }, alice.apiKey)).data.node.id;
    // A second version of the FMT guide (kind: updated).
    const edit = await jsonRequest(app, "PATCH", `/nests/${nestA}/nodes/${fmtDoc}`, {
      content: "# FMT\n\nFecal transplant primer, revised.",
    }, alice.apiKey);
    expect(edit.status).toBe(200);
    // Governed from here: the next document stays a draft.
    await jsonRequest(app, "PATCH", `/nests/${nestA}/settings`, { stewardship_enabled: true }, alice.apiKey);
    draftDoc = (await jsonRequest(app, "POST", `/nests/${nestA}/nodes`, {
      title: "Draft Idea", content: "# Draft\n\nnot ready", tags: ["fmt"],
    }, alice.apiKey)).data.node.id;

    // Nest B — carol has no access at all.
    bFmtDoc = (await jsonRequest(app, "POST", `/nests/${nestB}/nodes`, {
      title: "Bravo FMT", content: "# Secret\n\nbravo secret body", tags: ["fmt"], type: "reference",
    }, bob.apiKey)).data.node.id;
    await jsonRequest(app, "POST", `/nests/${nestB}/nodes`, {
      title: "Bravo Only", content: "# B\n\nb", tags: ["bravo-only"],
    }, bob.apiKey);

    // Carol: a read collaborator on A only.
    const share = await jsonRequest(app, "POST", `/nests/${nestA}/collaborators`, {
      user_id: carol.userId, permission: "read",
    }, alice.apiKey);
    expect(share.status).toBe(201);

    // Pin distinct timestamps so newest-first is deterministic.
    const d = await db();
    const rows = (await d.all(
      "SELECT id FROM node_versions ORDER BY id ASC",
    )) as Array<{ id: number }>;
    let minute = 0;
    for (const r of rows) {
      minute++;
      await d.run("UPDATE node_versions SET created_at = ? WHERE id = ?", [
        `2026-10-01 09:${String(minute).padStart(2, "0")}:00`, r.id,
      ]);
    }
  });

  afterAll(async () => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    await env.cleanup();
  });

  it("shows only the readable nest's versions, newest first, with the item fields", async () => {
    const { status, data } = await stream("");
    expect(status).toBe(200);
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((i: any) => i.nestId === nestA)).toBe(true);
    expect(data.items.some((i: any) => i.nodeId === bFmtDoc)).toBe(false);
    const ats = data.items.map((i: any) => i.at);
    expect(ats).toEqual([...ats].sort().reverse());

    const expected = Number(((await (await db()).get(
      "SELECT COUNT(*) AS c FROM node_versions WHERE nest_id = ?", [nestA],
    )) as { c: number }).c);
    expect(data.total).toBe(expected);
    expect(data.items).toHaveLength(expected);

    const latestFmt = data.items.find((i: any) => i.nodeId === fmtDoc);
    expect(latestFmt).toMatchObject({
      nestId: nestA,
      nestName: "Alpha Nest",
      nodeId: fmtDoc,
      title: "FMT Guide",
      type: "reference",
      tags: ["fmt"],
      version: 2,
      author: "alice@acme.com",
      // An ungoverned edit goes live without a review.
      kind: "published",
      commentCount: 0,
    });
    expect(typeof latestFmt.status).toBe("string");
    expect(typeof latestFmt.at).toBe("string");
    expect(latestFmt.summary).toContain("revised");
    expect(latestFmt.summary.length).toBeLessThanOrEqual(201);
    const firstFmt = data.items.find((i: any) => i.nodeId === fmtDoc && i.version === 1);
    expect(firstFmt.kind).toBe("created");
  });

  it("never leaks a nest the caller can't read — not via ?nest=, totals or counts", async () => {
    const { status, data } = await stream(`?nest=${nestB}`);
    expect(status).toBe(200);
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
    const all = await stream("");
    expect(all.data.counts.nest.map((n: any) => n.id)).toEqual([nestA]);
    expect(all.data.counts.tag.map((t: any) => t.value)).not.toContain("bravo-only");
    expect(all.data.counts.author.map((a: any) => a.value)).not.toContain("bob@acme.com");
    // And the owner of B sees only B (no access to A).
    const bobs = await stream("", bob);
    expect(bobs.data.items.length).toBeGreaterThan(0);
    expect(bobs.data.items.every((i: any) => i.nestId === nestB)).toBe(true);
  });

  it("filters by tag (with or without #), composes nest + type, and counts stay unfiltered", async () => {
    const unfiltered = await stream("");
    const fmt = await stream("?tag=fmt");
    expect(fmt.status).toBe(200);
    expect(fmt.data.items.length).toBeGreaterThan(0);
    expect(fmt.data.items.every((i: any) => i.tags.includes("fmt"))).toBe(true);
    expect(fmt.data.items.some((i: any) => i.nodeId === gerdDoc)).toBe(false);
    expect((await stream("?tag=%23fmt")).data.total).toBe(fmt.data.total);

    const composed = await stream(`?nest=${nestA}&type=reference`);
    expect(composed.data.items.length).toBe(2);
    expect(composed.data.items.every((i: any) => i.nodeId === fmtDoc)).toBe(true);

    // Multi-select within a facet is OR.
    const both = await stream("?tag=fmt,gerd");
    expect(both.data.total).toBe(unfiltered.data.total);

    // Facet counts are the unfiltered per-facet totals — not the page slice,
    // not the filtered set (the #145 bug).
    expect(fmt.data.counts).toEqual(unfiltered.data.counts);
    const limited = await stream("?limit=1");
    expect(limited.data.items).toHaveLength(1);
    expect(limited.data.counts).toEqual(unfiltered.data.counts);
    const fmtCount = unfiltered.data.counts.tag.find((t: any) => t.value === "fmt").count;
    expect(fmtCount).toBe(fmt.data.total);
    const typeRef = unfiltered.data.counts.type.find((t: any) => t.value === "reference").count;
    expect(typeRef).toBe(2);
  });

  it("filters by author", async () => {
    const mine = await stream("?author=alice@acme.com");
    expect(mine.data.total).toBe((await stream("")).data.total);
    expect((await stream("?author=nobody@acme.com")).data.total).toBe(0);
  });

  it("filters by since", async () => {
    const all = (await stream("")).data;
    const newest = all.items[0].at as string;
    const since = await stream(`?since=${encodeURIComponent(newest)}`);
    expect(since.data.items.every((i: any) => i.at >= newest)).toBe(true);
    expect(since.data.total).toBeLessThan(all.total);
    expect((await stream("?since=not-a-date")).status).toBe(400);
  });

  it("marks a version a review approved as kind approved", async () => {
    const d = await db();
    await d.run(
      `INSERT INTO review_requests (id, nest_id, node_id, version, requested_by, status, resolved_by)
       VALUES ('rr-stream-1', ?, ?, 1, 'alice@acme.com', 'approved', 'alice@acme.com')`,
      [nestA, gerdDoc],
    );
    const gerd = (await stream("")).data.items.find((i: any) => i.nodeId === gerdDoc);
    expect(gerd.kind).toBe("approved");
  });

  it("includes a draft version the caller can read, as status draft", async () => {
    const { data } = await stream("");
    const draft = data.items.find((i: any) => i.nodeId === draftDoc);
    expect(draft).toBeDefined();
    expect(draft.status).toBe("draft");
  });

  it("a comment posted from the card lands on the document and bumps commentCount", async () => {
    const before = (await stream("")).data.items.find((i: any) => i.nodeId === gerdDoc);
    expect(before.commentCount).toBe(0);
    const posted = await jsonRequest(
      app, "POST", `/nests/${nestA}/nodes/${gerdDoc}/annotations`, { body: "nice notes" }, carol.apiKey,
    );
    expect(posted.status).toBe(201);
    const after = (await stream("")).data.items.find((i: any) => i.nodeId === gerdDoc);
    expect(after.commentCount).toBe(1);
  });

  it("rejects nest-scoped keys (the /me surface is account-wide)", async () => {
    const minted = await jsonRequest(app, "POST", "/auth/keys", { label: "scoped", nest_id: nestA }, alice.apiKey);
    expect([200, 201]).toContain(minted.status);
    const res = await jsonRequest(app, "GET", "/me/stream", undefined, minted.data.api_key);
    expect(res.status).toBe(403);
  });

  it("leaves the per-nest governance feed exactly as it was", async () => {
    const feed = await jsonRequest(app, "GET", `/nests/${nestA}/feed`, undefined, alice.apiKey);
    expect(feed.status).toBe(200);
    expect(Object.keys(feed.data).sort()).toEqual(["counts", "filter", "items", "limit", "offset", "total"]);
    expect(Object.keys(feed.data.counts).sort()).toEqual(["changes", "comments", "pending_pushes"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Visibility: a public reader never sees drafts, or who wrote what
// ═══════════════════════════════════════════════════════════════════════════

describe("doc stream: public nest, read without membership", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let reader: { apiKey: string };
  let nestId: string;
  let openDoc: string;
  let secretDoc: string;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@pub.com", "Owner");
    reader = await registerUser(app, "reader@pub.com", "Reader");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Public Nest" }, owner.apiKey)).data.nest.id;
    openDoc = (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Open Doc", content: "# open\n\npublic body",
    }, owner.apiKey)).data.node.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
    secretDoc = (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Secret Doc", content: "# drafty\n\nsecret",
    }, owner.apiKey)).data.node.id;
    const vis = await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, {
      visibility: "public", acknowledge_public: true,
    }, owner.apiKey);
    expect(vis.status).toBe(200);
  });

  afterAll(async () => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    await env.cleanup();
  });

  it("shows the public reader approved versions only, with no author", async () => {
    const { status, data } = await jsonRequest(app, "GET", "/me/stream", undefined, reader.apiKey);
    expect(status).toBe(200);
    const mine = data.items.filter((i: any) => i.nestId === nestId);
    expect(mine.some((i: any) => i.nodeId === openDoc)).toBe(true);
    expect(mine.some((i: any) => i.nodeId === secretDoc)).toBe(false);
    expect(mine.every((i: any) => i.status !== "draft")).toBe(true);
    expect(mine.every((i: any) => i.author === null)).toBe(true);
    expect(data.counts.author).toEqual([]);
    // Filtering by the owner's email must not reveal their public work.
    const byOwner = await jsonRequest(app, "GET", "/me/stream?author=owner@pub.com", undefined, reader.apiKey);
    expect(byOwner.data.total).toBe(0);
  });

  it("never shows a public reader a draft's title, tags or comment activity", async () => {
    // Tag the approved doc, then leave an unreviewed draft on top of it that
    // renames and retags it, and comment on it.
    const d = await db();
    await d.run(
      "INSERT INTO node_tag_index (nest_id, node_id, tag_name) VALUES (?, ?, 'pub-tag')",
      [nestId, openDoc],
    );
    const draft = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${openDoc}`, {
      title: "Secret Rename", tags: ["secret-tag"], content: "# renamed\n\nsecret draft body",
    }, owner.apiKey);
    expect(draft.status).toBe(200);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${openDoc}/annotations`, { body: "internal note" }, owner.apiKey);

    const { data } = await jsonRequest(app, "GET", "/me/stream", undefined, reader.apiKey);
    const items = data.items.filter((i: any) => i.nodeId === openDoc);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.title).toBe("Open Doc");
      expect(i.tags).not.toContain("secret-tag");
      expect(i.summary).not.toContain("secret");
      expect(i.commentCount).toBeNull();
    }
    expect(data.counts.tag.map((t: any) => t.value)).not.toContain("secret-tag");
    const probe = await jsonRequest(app, "GET", "/me/stream?tag=secret-tag", undefined, reader.apiKey);
    expect(probe.data.total).toBe(0);
  });

  it("the owner sees the draft too", async () => {
    const { data } = await jsonRequest(app, "GET", "/me/stream", undefined, owner.apiKey);
    expect(data.items.some((i: any) => i.nodeId === secretDoc && i.status === "draft")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scoped readers: a share grantee sees only the documents their grants cover
// ═══════════════════════════════════════════════════════════════════════════

describe("doc stream: scoped readers (share grants)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let guest: { apiKey: string; userId: string };
  let nestId: string;
  let sharedDoc: string;
  let hiddenDoc: string;
  const BULK = 33_000;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@grant.com", "Owner");
    guest = await registerUser(app, "guest@grant.com", "Guest");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Granted" }, owner.apiKey)).data.nest.id;
    sharedDoc = (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Shared Doc", content: "# shared\n\nshared body", tags: ["open-topic"],
    }, owner.apiKey)).data.node.id;
    hiddenDoc = (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Hidden Doc", content: "# hidden\n\nhidden body", tags: ["hidden-topic"],
    }, owner.apiKey)).data.node.id;
    const g = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, {
      target_type: "document", target: sharedDoc, email: "guest@grant.com", role: "read",
    }, owner.apiKey);
    expect(g.status).toBe(201);
    // A version authored under a mixed-case address (legacy row).
    const d = await db();
    await d.run(
      `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status, created_at)
       VALUES (?, ?, 99, 'hmixed', 'Mixed@Grant.com', 'published', '2026-10-03 00:00:00')`,
      [nestId, sharedDoc],
    );
  }, 60000);

  afterAll(async () => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    await env.cleanup();
  });

  it("shows a grantee only the granted document — items and counts", async () => {
    const { status, data } = await jsonRequest(app, "GET", "/me/stream", undefined, guest.apiKey);
    expect(status).toBe(200);
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((i: any) => i.nodeId === sharedDoc)).toBe(true);
    expect(data.items.some((i: any) => i.nodeId === hiddenDoc)).toBe(false);
    expect(data.counts.tag.map((t: any) => t.value)).toEqual(["open-topic"]);
    expect(data.counts.nest).toEqual([{ id: nestId, name: "Granted", count: data.total }]);
  });

  it("matches an author filter case-insensitively against the stored address", async () => {
    const { data } = await jsonRequest(app, "GET", "/me/stream?author=mixed@grant.com", undefined, owner.apiKey);
    expect(data.total).toBe(1);
    expect(data.counts.author.map((a: any) => a.value)).toContain("mixed@grant.com");
  });

  it("survives a grant covering tens of thousands of documents (no SQL variable limit)", async () => {
    const d = await db();
    const fm = JSON.stringify({ title: "bulk" });
    for (let start = 0; start < BULK; start += 400) {
      const n = Math.min(400, BULK - start);
      const ids = Array.from({ length: n }, (_, k) => `nodes/bulk/d${start + k}`);
      await d.run(
        `INSERT INTO node_index (nest_id, node_id, folder, title, type, status, updated_at, frontmatter_json)
         VALUES ${ids.map(() => "(?, ?, 'bulk', 'bulk', 'document', 'published', NULL, ?)").join(",")}`,
        ids.flatMap((id) => [nestId, id, fm]),
      );
      await d.run(
        `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status, created_at)
         VALUES ${ids.map(() => "(?, ?, 1, 'hb', 'owner@grant.com', 'published', '2026-10-04 00:00:00')").join(",")}`,
        ids.flatMap((id) => [nestId, id]),
      );
    }
    const g = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, {
      target_type: "folder", target: "nodes/bulk", email: "guest@grant.com", role: "read",
    }, owner.apiKey);
    expect(g.status).toBe(201);
    const { status, data } = await jsonRequest(app, "GET", "/me/stream?limit=5", undefined, guest.apiKey);
    expect(status).toBe(200);
    expect(data.items.some((i: any) => i.nodeId === hiddenDoc)).toBe(false);
    const sharedVersions = Number(((await d.get(
      "SELECT COUNT(*) AS c FROM node_versions WHERE nest_id = ? AND node_id = ?", [nestId, sharedDoc],
    )) as { c: number }).c);
    expect(data.total).toBe(BULK + sharedVersions);
  }, 120000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Paging: 300 versions, limit=50 — no duplicates, no gaps
// ═══════════════════════════════════════════════════════════════════════════

describe("doc stream: paging", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    app = await createTestApp("key");
    await resetAuthRateLimit();
    alice = await registerUser(app, "alice@page.com", "Alice");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Paged" }, alice.apiKey)).data.nest.id;
    const nodeId = (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Busy Doc", content: "# busy\n\nbody",
    }, alice.apiKey)).data.node.id;
    // 299 more version rows straight into the table; every third pair shares a
    // timestamp so the id tie-break is what keeps pages stable.
    const d = await db();
    for (let v = 2; v <= 300; v++) {
      const sec = Math.floor(v / 2);
      await d.run(
        `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'approved', ?)`,
        [nestId, nodeId, v, `h${v}`, "alice@page.com",
          `2026-10-02 ${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}:00`],
      );
    }
  }, 60000);

  afterAll(async () => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    await env.cleanup();
  });

  it("pages through 300 versions without duplicates or gaps; past the end is empty", async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < 300; offset += 50) {
      const { status, data } = await jsonRequest(
        app, "GET", `/me/stream?limit=50&offset=${offset}`, undefined, alice.apiKey,
      );
      expect(status).toBe(200);
      expect(data.total).toBe(300);
      expect(data.items).toHaveLength(50);
      for (const i of data.items) seen.push(`${i.nodeId}@${i.version}`);
    }
    expect(new Set(seen).size).toBe(300);
    const versions = seen.map((s) => Number(s.split("@")[1])).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));

    const past = await jsonRequest(app, "GET", "/me/stream?limit=50&offset=400", undefined, alice.apiKey);
    expect(past.status).toBe(200);
    expect(past.data.items).toEqual([]);
    expect(past.data.total).toBe(300);
    expect(past.data.has_more).toBe(false);
  }, 60000);
});

// ═══════════════════════════════════════════════════════════════════════════
// License gate: same 503 body as /feed, real license module
// ═══════════════════════════════════════════════════════════════════════════

describe("doc stream: license gate (license module NOT mocked)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    process.env.AUTH_MODE = "open";
    vi.resetModules();
    vi.doUnmock("../src/auth/license.js");
    const dbClient = await import("../src/db/client.js");
    await dbClient.resetDb();
    await dbClient.initDb();
    await seedPeople(FREE_TIER_MAX_USERS + 1);
    const { createApp } = await import("../src/app.js");
    app = createApp();
  });

  afterAll(async () => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    await env.cleanup();
  });

  it("503s /me/stream with exactly the body /feed answers", async () => {
    const feed = await app.request("/nests/some-nest/feed");
    expect(feed.status).toBe(503);
    const feedBody = await feed.json();
    const res = await app.request("/me/stream");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(feedBody);
  });

  it("still 404s when the switch is off, licensed or not", async () => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    const res = await app.request("/me/stream");
    expect(res.status).toBe(404);
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
  });
});

describe("doc stream: kind mapping", () => {
  it("names each version's event", async () => {
    const { kindOf } = await import("../src/governance/stream-service.js");
    expect(kindOf(1, "draft", false)).toBe("created");
    expect(kindOf(1, "published", false)).toBe("created");
    expect(kindOf(3, "draft", false)).toBe("updated");
    expect(kindOf(3, "pending_review", false)).toBe("updated");
    expect(kindOf(3, "published", false)).toBe("published");
    expect(kindOf(3, "published", true)).toBe("approved");
    expect(kindOf(1, "published", true)).toBe("approved");
    expect(kindOf(2, "rejected", false)).toBe("rejected");
  });
});
