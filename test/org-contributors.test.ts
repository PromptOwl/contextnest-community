/**
 * Org contributors (CU-wdqcq05rz6): on an org nest with
 * `org_contributions: "drafts"`, anyone in the organization may create a
 * document or propose an edit WITHOUT being added — always as a draft that
 * goes to review, never published on their own authority.
 *
 * The capability is deliberately NOT a permission level. The caller's nest
 * permission stays 'read'; an explicit `orgContributor` flag admits exactly
 * the create / propose paths, so none of the generic `>= write` gates
 * (collaborators, env, connectors, settings, delete, move…) moves an inch.
 * Several cases below pin that from the outside.
 *
 * "In the org": every signed-in account on a self-hosted server; on a shared
 * deployment (SHARED_DEPLOYMENT=true) only an account whose email an identity
 * provider vouched for AND whose domain is exactly one of the nest's
 * `org_domains`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function callTool(
  app: any,
  nestId: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean; data?: any }> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  expect(payload.error).toBeUndefined();
  return {
    text: payload.result.content.map((c: any) => c.text).join(""),
    isError: payload.result.isError,
    data: payload.result.structuredContent,
  };
}

async function db() {
  return (await import("../src/db/client.js")).getDb();
}

/** What an identity provider sign-in records (OIDC / token exchange /
 *  PromptOwl). A password sign-up never sets it. */
async function markVerified(userId: string) {
  await (await db()).run(
    "UPDATE users SET email_verified_at = ? WHERE id = ?",
    [new Date().toISOString(), userId],
  ).catch(() => {
    // Only before the column exists (the fail-first run): the cases that
    // depend on it then fail on their own assertions, one by one.
  });
}

async function latestVersionRow(nestId: string, nodeId: string) {
  return (await (await db()).get(
    `SELECT version, status, author FROM node_versions
      WHERE nest_id = ? AND node_id = ? ORDER BY version DESC LIMIT 1`,
    [nestId, nodeId],
  )) as { version: number; status: string; author: string } | undefined;
}

async function approvedVersion(nestId: string, nodeId: string) {
  const row = (await (await db()).get(
    "SELECT approved_version AS version FROM approved_versions WHERE nest_id = ? AND node_id = ?",
    [nestId, nodeId],
  )) as { version: number } | undefined;
  return row?.version ?? null;
}

async function pendingReview(nestId: string, nodeId: string) {
  return (await (await db()).get(
    "SELECT id, requested_by, version FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending'",
    [nestId, nodeId],
  )) as { id: string; requested_by: string; version: number } | undefined;
}

describe("org contributors — drafts without being added", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let bob: User; // bob@acme.com — the org contributor
  let carol: User; // carol@acme.com — another org member
  let eve: User; // eve@other.com
  let mallory: User; // mallory@evil-acme.com
  let dave: User; // dave@acme.com — signed up with a password, never verified
  let writer: User; // writer@acme.com — a real write collaborator
  let nestId: string;
  let privateNest: string;
  let publicNest: string;
  const publishedId = "nodes/handbook";

  const create = (key: string, body: Record<string, unknown>, nest = nestId) =>
    jsonRequest(app, "POST", `/nests/${nest}/nodes`, body, key);
  const settings = (body: Record<string, unknown>, nest = nestId) =>
    jsonRequest(app, "PATCH", `/nests/${nest}/settings`, body, owner.apiKey);

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    const reg = async (email: string) => {
      resetAuthRateLimit();
      return registerUser(app, email);
    };
    owner = await reg("owner@acme.com");
    bob = await reg("bob@acme.com");
    carol = await reg("carol@acme.com");
    eve = await reg("eve@other.com");
    mallory = await reg("mallory@evil-acme.com");
    dave = await reg("dave@acme.com");
    writer = await reg("writer@acme.com");
    for (const u of [bob, carol, eve, mallory, writer]) await markVerified(u.userId);

    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Acme Org" }, owner.apiKey)).data.nest.id;
    privateNest = (await jsonRequest(app, "POST", "/nests", { name: "Acme Private" }, owner.apiKey)).data.nest.id;
    publicNest = (await jsonRequest(app, "POST", "/nests", { name: "Acme Public" }, owner.apiKey)).data.nest.id;

    // A published document, made before governance is on (so it publishes).
    const doc = await create(owner.apiKey, { title: "Handbook", content: "Approved text." });
    expect(doc.status).toBe(201);
    expect(doc.data.node.id).toBe(publishedId);

    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "org" }, owner.apiKey)).status).toBe(200);
    expect(
      (await jsonRequest(app, "PATCH", `/nests/${publicNest}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey)).status,
    ).toBe(200);

    // Governed, and every posture that would otherwise self-publish is ON.
    expect(
      (await settings({ stewardship_enabled: true, creator_is_reviewer: true, prime_only_review: true })).status,
    ).toBe(200);

    const added = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: writer.email, permission: "write" },
      owner.apiKey,
    );
    expect(added.status).toBeLessThan(300);
  });

  afterAll(async () => {
    delete process.env.SHARED_DEPLOYMENT;
    await env.cleanup();
  });

  afterEach(() => {
    delete process.env.SHARED_DEPLOYMENT;
  });

  // ── Off by default ────────────────────────────────────────────────────

  it("with the setting off, a non-collaborator's create is refused (403, as today)", async () => {
    const s = await jsonRequest(app, "GET", `/nests/${nestId}/settings`, undefined, owner.apiKey);
    expect(s.data.org_contributions).toBe("off");
    expect(s.data.org_domains).toEqual([]);
    const res = await create(bob.apiKey, { title: "Too Early", content: "x" });
    expect(res.status).toBe(403);
  });

  // ── Settings ──────────────────────────────────────────────────────────

  it("rejects an unknown org_contributions value", async () => {
    expect((await settings({ org_contributions: "publish" })).status).toBe(400);
  });

  it("rejects malformed domains (wildcards, URLs, emails' local parts)", async () => {
    for (const bad of [["*.acme.com"], ["https://acme.com"], ["acme"], ["a b.com"], [42]]) {
      const res = await settings({ org_domains: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("normalizes domains to bare lowercase hosts, deduped", async () => {
    const res = await settings({ org_domains: [" @Acme.COM ", "acme.com"] });
    expect(res.status).toBe(200);
    expect(res.data.org_domains).toEqual(["acme.com"]);
    expect((await settings({ org_domains: [] })).data.org_domains).toEqual([]);
  });

  it("refuses to turn it on for a nest that isn't visibility 'org'", async () => {
    const res = await settings({ org_contributions: "drafts" }, privateNest);
    expect(res.status).toBe(400);
    const pub = await settings({ org_contributions: "drafts" }, publicNest);
    expect(pub.status).toBe(400);
  });

  it("only an owner/admin may change it", async () => {
    const res = await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { org_contributions: "drafts" }, writer.apiKey);
    expect(res.status).toBe(403);
  });

  it("on a shared deployment, enabling with no domains is a 400", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    const res = await settings({ org_contributions: "drafts" });
    expect(res.status).toBe(400);
    const s = await jsonRequest(app, "GET", `/nests/${nestId}/settings`, undefined, owner.apiKey);
    expect(s.data.org_contributions).toBe("off");
  });

  it("turns on (self-hosted, no domain list needed)", async () => {
    const res = await settings({ org_contributions: "drafts" });
    expect(res.status).toBe(200);
    expect(res.data.org_contributions).toBe("drafts");
  });

  // ── The capability itself ─────────────────────────────────────────────

  it("resolves an explicit orgContributor flag and leaves the permission at 'read'", async () => {
    const { resolveNestAccess } = await import("../src/shared/access.js");
    const access = await resolveNestAccess(nestId, bob.userId);
    expect(access.permission).toBe("read");
    expect(access.orgContributor).toBe(true);
    // The owner and a real collaborator are not "contributors" — they hold more.
    expect((await resolveNestAccess(nestId, owner.userId)).orgContributor).toBe(false);
    expect((await resolveNestAccess(nestId, writer.userId)).orgContributor).toBe(false);
  });

  it("reports org_contributor to the caller on GET /nests/:id", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, bob.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.nest?.org_contributor ?? res.data.org_contributor).toBe(true);
    expect(res.data.nest?.permission ?? res.data.permission).toBe("read");
  });

  let bobDoc: string;

  it("a contributor's create is a draft pending review, authored by them — even with creator_is_reviewer and prime_only_review on", async () => {
    const res = await create(bob.apiKey, { title: "Bob Proposal", content: "Bob's idea." });
    expect(res.status).toBe(201);
    bobDoc = res.data.node.id;
    expect(res.data.node.status).not.toBe("published");
    expect(res.data.review?.id).toBeTruthy();

    expect(await approvedVersion(nestId, bobDoc)).toBeNull();
    const row = await latestVersionRow(nestId, bobDoc);
    expect(row?.author).toBe(bob.email);
    expect(row?.status).toBe("pending_review");
    expect((await pendingReview(nestId, bobDoc))?.requested_by).toBe(bob.email);

    // creator_is_reviewer must NOT have stewarded the contributor.
    const steward = await (await db()).get(
      "SELECT 1 AS x FROM stewards WHERE nest_id = ? AND LOWER(user_email) = ?",
      [nestId, bob.email],
    );
    expect(steward).toBeUndefined();
  });

  it("a contributor may not set governance or runnable fields on a create", async () => {
    for (const extra of [{ prime: false }, { type: "agent" }, { status: "published" }, { schedule: "0 * * * *" }]) {
      const res = await create(bob.apiKey, { title: `Bad ${JSON.stringify(extra)}`, content: "x", ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(403);
    }
  });

  it("an edit to a published document is proposed as a draft for review; the published head is unchanged", async () => {
    const before = await approvedVersion(nestId, publishedId);
    expect(before).not.toBeNull();
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${publishedId}`,
      { content: "Bob's better text.", changeNote: "fix" },
      bob.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.review?.id).toBeTruthy();
    expect(await approvedVersion(nestId, publishedId)).toBe(before);
    expect((await pendingReview(nestId, publishedId))?.requested_by).toBe(bob.email);
    const row = await latestVersionRow(nestId, publishedId);
    expect(row?.author).toBe(bob.email);
    expect(row?.status).toBe("pending_review");

    // Everyone else still reads the approved text.
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${publishedId}`, undefined, carol.apiKey);
    expect(read.status).toBe(200);
    expect(read.data.content ?? read.data.node?.content).toContain("Approved text.");
  });

  it("a contributor may not change governance fields on an edit", async () => {
    for (const extra of [{ prime: true }, { status: "published" }, { type: "agent" }]) {
      const res = await jsonRequest(
        app,
        "PATCH",
        `/nests/${nestId}/nodes/${bobDoc}`,
        { content: "x", ...extra },
        bob.apiKey,
      );
      expect(res.status, JSON.stringify(extra)).toBe(403);
    }
  });

  it("a contributor can revise their own pending draft; it stays in the same review", async () => {
    const before = await pendingReview(nestId, bobDoc);
    expect(before).toBeTruthy();
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${bobDoc}`,
      { content: "Bob's idea.", tags: ["idea"] },
      bob.apiKey,
    );
    expect(res.status).toBe(200);
    const after = await pendingReview(nestId, bobDoc);
    expect(after?.id).toBe(before!.id);
    expect(after?.requested_by).toBe(bob.email);
    expect(await approvedVersion(nestId, bobDoc)).toBeNull();
  });

  it("another contributor can't propose over a document someone else has under review (423)", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${publishedId}`,
      { content: "Carol's version." },
      carol.apiKey,
    );
    expect(res.status).toBe(423);
  });

  it("a contributor can't edit someone else's never-approved draft (they can't see it)", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${bobDoc}`,
      { content: "Carol overwrites Bob." },
      carol.apiKey,
    );
    expect([403, 404]).toContain(res.status);
    const row = await latestVersionRow(nestId, bobDoc);
    expect(row?.author).toBe(bob.email);
    const mine = await jsonRequest(app, "GET", `/nests/${nestId}/contributions/mine`, undefined, bob.apiKey);
    expect(mine.data.contributions.find((c: any) => c.node_id === bobDoc)?.content).toContain("Bob's idea.");
  });

  it("refuses to clobber a collaborator's unsubmitted draft (409)", async () => {
    // Published (prime-only review, not prime), then a writer leaves an
    // unsubmitted draft on top once every edit goes through review.
    const made = await create(owner.apiKey, { title: "Owner Notes", content: "v1" });
    const id = made.data.node.id;
    expect(await approvedVersion(nestId, id)).not.toBeNull();
    await (await db()).run("UPDATE nests SET prime_only_review = 0 WHERE id = ?", [nestId]);
    try {
      const draft = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "writer wip" }, writer.apiKey);
      expect(draft.status).toBe(200);
      expect((await latestVersionRow(nestId, id))?.status).toBe("draft");
      const res = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "bob over it" }, bob.apiKey);
      expect(res.status).toBe(409);
      expect((await latestVersionRow(nestId, id))?.author).toBe(writer.email);
      // The REST X-Base-Version conflict body names who changed the document
      // and the working version — never shown to a contributor.
      const raw = await app.request(`/nests/${nestId}/nodes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bob.apiKey}`, "X-Base-Version": "1" },
        body: JSON.stringify({ content: "bob again" }),
      });
      expect(raw.status).toBe(409);
      const body = await raw.json();
      expect(body.updated_by).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(writer.email);
    } finally {
      await (await db()).run("UPDATE nests SET prime_only_review = 1 WHERE id = ?", [nestId]);
    }
  });

  it("two contributors proposing at once: one lands, the other is refused — never an overwrite", async () => {
    const made = await create(owner.apiKey, { title: "Race Target", content: "v1" });
    const id = made.data.node.id;
    expect(await approvedVersion(nestId, id)).not.toBeNull();
    const [a, b] = await Promise.all([
      jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "bob's take" }, bob.apiKey),
      jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "carol's take" }, carol.apiKey),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([409, 423]).toContain(statuses[1]);
    const winner = a.status === 200 ? bob.email : carol.email;
    expect((await pendingReview(nestId, id))?.requested_by).toBe(winner);
    expect((await latestVersionRow(nestId, id))?.author).toBe(winner);
  });

  it("a duplicate title on a contributor's create doesn't echo the hidden document's id", async () => {
    const res = await create(carol.apiKey, { title: "Bob Proposal", content: "same title as bob's hidden draft" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.data)).not.toContain(bobDoc);
  });

  it("caps a contributor's open suggestions per nest (429), and bounds their size (413)", async () => {
    const { MAX_OPEN_CONTRIBUTIONS } = await import("../src/governance/org-contribution.js");
    const open = (await jsonRequest(app, "POST", "/nests", { name: "Cap Org" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${open}/visibility`, { visibility: "org" }, owner.apiKey);
    expect((await settings({ org_contributions: "drafts" }, open)).status).toBe(200);
    for (let i = 0; i < MAX_OPEN_CONTRIBUTIONS; i++) {
      const ok = await create(carol.apiKey, { title: `Cap ${i}`, content: "x" }, open);
      expect(ok.status, `create ${i}`).toBe(201);
    }
    const over = await create(carol.apiKey, { title: "Cap over", content: "x" }, open);
    expect(over.status).toBe(429);
    // Someone else in the org isn't held to carol's count.
    expect((await create(bob.apiKey, { title: "Bob in cap nest", content: "x" }, open)).status).toBe(201);
    const huge = await create(bob.apiKey, { title: "Huge", content: "x".repeat(600_000) }, open);
    expect(huge.status).toBe(413);
  });

  it("MCP context_update refuses a rename instead of silently ignoring it", async () => {
    const out = await callTool(app, nestId, bob.apiKey, "context_update", {
      id: publishedId,
      title: "Renamed by Bob",
      content: "x",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/rename|title/i);
  });

  // ── What they still can't do ──────────────────────────────────────────

  it("can't approve, delete, move, or change settings (403)", async () => {
    const approve = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${bobDoc}/approve`, {}, bob.apiKey);
    expect(approve.status).toBe(403);
    const bulk = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/review-queue/bulk`,
      { action: "approve", nodeIds: [bobDoc] },
      bob.apiKey,
    );
    expect(bulk.status === 403 || bulk.data?.results?.every?.((r: any) => !r.ok) === true, JSON.stringify(bulk)).toBe(true);
    expect(await approvedVersion(nestId, bobDoc)).toBeNull();

    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/${publishedId}`, undefined, bob.apiKey);
    expect(del.status).toBe(403);
    const move = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${publishedId}/move`, { folder: "elsewhere" }, bob.apiKey);
    expect(move.status).toBe(403);
    const set = await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { org_contributions: "off" }, bob.apiKey);
    expect(set.status).toBe(403);
    const vis = await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "private" }, bob.apiKey);
    expect(vis.status).toBe(403);
  });

  it("generic write-gated routes still refuse an org contributor", async () => {
    const routes: Array<[string, string, unknown]> = [
      ["POST", `/nests/${nestId}/collaborators`, { email: "x@acme.com", permission: "write" }],
      ["GET", `/nests/${nestId}/collaborators`, undefined],
      ["PUT", `/nests/${nestId}/env`, { key: "K", value: "v" }],
      ["POST", `/nests/${nestId}/connectors`, { kind: "slack", name: "x" }],
      ["POST", `/nests/${nestId}/hooks`, { name: "x" }],
      ["POST", `/nests/${nestId}/nodes/${publishedId}/discard`, {}],
      ["POST", `/nests/${nestId}/nodes/bulk-update`, { ids: [publishedId], patch: { tags: ["x"] } }],
      ["POST", `/nests/${nestId}/nodes/bulk-delete`, { ids: [publishedId] }],
    ];
    for (const [method, path, body] of routes) {
      const res = await jsonRequest(app, method, path, body, bob.apiKey);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  // ── Seeing drafts ─────────────────────────────────────────────────────

  it("sees their own drafts", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/contributions/mine`, undefined, bob.apiKey);
    expect(res.status).toBe(200);
    const ids = res.data.contributions.map((c: any) => c.node_id);
    expect(ids).toContain(bobDoc);
    expect(ids).toContain(publishedId);
    const mine = res.data.contributions.find((c: any) => c.node_id === bobDoc);
    expect(mine.content.trim()).toBe("Bob's idea.");
    expect(mine.status).toBe("pending_review");
  });

  it("does not see other people's drafts — not in their list, the node list, the node itself, or the review queue", async () => {
    const mine = await jsonRequest(app, "GET", `/nests/${nestId}/contributions/mine`, undefined, carol.apiKey);
    expect(mine.status).toBe(200);
    expect(mine.data.contributions.map((c: any) => c.node_id)).not.toContain(bobDoc);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, carol.apiKey);
    const listIds = (list.data.nodes ?? list.data).map((n: any) => n.id);
    expect(listIds).not.toContain(bobDoc);

    const get = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${bobDoc}`, undefined, carol.apiKey);
    expect([403, 404]).toContain(get.status);

    const queue = await jsonRequest(app, "GET", `/nests/${nestId}/review-queue`, undefined, carol.apiKey);
    expect(queue.status).toBe(200);
    expect(queue.data.requests.map((r: any) => r.nodeId)).not.toContain(bobDoc);

    const feed = await jsonRequest(app, "GET", `/nests/${nestId}/feed?filter=changes`, undefined, carol.apiKey);
    expect(feed.status).toBe(200);
    expect(JSON.stringify(feed.data)).not.toContain(bobDoc);
    // Bob's own feed still has his.
    const bobFeed = await jsonRequest(app, "GET", `/nests/${nestId}/feed?filter=changes`, undefined, bob.apiKey);
    expect(JSON.stringify(bobFeed.data)).toContain(bobDoc);
  });

  it("the owner's review queue labels the request as an org contributor's", async () => {
    const queue = await jsonRequest(app, "GET", `/nests/${nestId}/review-queue`, undefined, owner.apiKey);
    const req = queue.data.requests.find((r: any) => r.nodeId === bobDoc);
    expect(req).toBeTruthy();
    expect(req.requestedByOrgContributor).toBe(true);
    const writerReq = queue.data.requests.find((r: any) => r.requestedBy === writer.email);
    if (writerReq) expect(writerReq.requestedByOrgContributor).toBe(false);
    const feed = await jsonRequest(app, "GET", `/nests/${nestId}/feed?filter=changes`, undefined, owner.apiKey);
    const item = (feed.data.items ?? []).find((i: any) => i.nodeId === bobDoc);
    expect(item?.requestedByOrgContributor, JSON.stringify(feed.data).slice(0, 300)).toBe(true);
  });

  it("the owner can approve a contributor's draft like any other", async () => {
    await (await db()).run("UPDATE nests SET allow_self_approve = 1 WHERE id = ?", [nestId]);
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${bobDoc}/approve`, {}, owner.apiKey);
    expect(res.status).toBe(200);
    expect(await approvedVersion(nestId, bobDoc)).not.toBeNull();
  });

  // ── Credentials that get no new reach ─────────────────────────────────

  it("an anonymous caller can't contribute", async () => {
    const res = await app.request(`/nests/${nestId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Anon", content: "x" }),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  it("a nest-scoped API key gets no contributor reach", async () => {
    const minted = await jsonRequest(app, "POST", "/auth/keys", { label: "scoped", nest_id: nestId }, bob.apiKey);
    expect(minted.status).toBeLessThan(300);
    const res = await create(minted.data.api_key, { title: "Scoped Key Doc", content: "x" });
    expect(res.status).toBe(403);
  });

  it("a read-only key gets no contributor reach", async () => {
    const minted = await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: nestId, capability: "read" }, bob.apiKey);
    expect(minted.status).toBeLessThan(300);
    const res = await create(minted.data.api_key, { title: "RO Key Doc", content: "x" });
    expect(res.status).toBe(403);
  });

  it("a system key gets no contributor reach", async () => {
    const sys = await jsonRequest(app, "POST", "/systems", { name: "Sync", capability: "write", nest_ids: [nestId] }, owner.apiKey);
    expect(sys.status).toBeLessThan(300);
    // Even a system made a READ collaborator is a service identity, never a person in the org.
    const { resolveNestAccess } = await import("../src/shared/access.js");
    const sysUser = (await (await db()).get(
      "SELECT user_id FROM api_keys WHERE key_hash = ?",
      [(await import("../src/auth/keys.js")).hashApiKey(sys.data.api_key)],
    )) as { user_id: string };
    expect((await resolveNestAccess(nestId, sysUser.user_id)).orgContributor).toBe(false);
    await (await db()).run(
      "UPDATE nest_collaborators SET permission = 'read' WHERE nest_id = ? AND user_id = ?",
      [nestId, sysUser.user_id],
    );
    const res = await create(sys.data.api_key, { title: "System Doc", content: "x" });
    expect(res.status).toBe(403);
  });

  // ── MCP parity ────────────────────────────────────────────────────────

  it("MCP context_create as an org contributor is a draft for review, same as REST", async () => {
    const out = await callTool(app, nestId, bob.apiKey, "context_create", {
      title: "Bob Via MCP",
      content: "From an agent.",
    });
    expect(out.isError).toBeFalsy();
    const id = out.data.id;
    expect(out.data.review?.id).toBeTruthy();
    expect(await approvedVersion(nestId, id)).toBeNull();
    expect((await pendingReview(nestId, id))?.requested_by).toBe(bob.email);
    expect((await latestVersionRow(nestId, id))?.author).toBe(bob.email);
  });

  it("MCP context_update as an org contributor proposes a draft for review", async () => {
    const made = await create(owner.apiKey, { title: "MCP Target", content: "v1" });
    const id = made.data.node.id;
    await (await db()).run("UPDATE nests SET allow_self_approve = 1 WHERE id = ?", [nestId]);
    // owner self-approve publishes the owner's own create
    const before = await approvedVersion(nestId, id);
    const out = await callTool(app, nestId, bob.apiKey, "context_update", { id, content: "Bob via MCP." });
    expect(out.isError).toBeFalsy();
    expect(await approvedVersion(nestId, id)).toBe(before);
    expect((await pendingReview(nestId, id))?.requested_by).toBe(bob.email);
  });

  it("MCP context_submit_review can't submit someone else's draft", async () => {
    const made = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Writer WIP", content: "w" }, writer.apiKey);
    expect(made.status).toBe(201);
    const out = await callTool(app, nestId, bob.apiKey, "context_submit_review", { id: made.data.node.id });
    expect(out.isError).toBe(true);
  });

  it("MCP context_delete stays refused", async () => {
    const out = await callTool(app, nestId, bob.apiKey, "context_delete", { id: publishedId });
    expect(out.isError).toBe(true);
    expect(await approvedVersion(nestId, publishedId)).not.toBeNull();
  });

  // ── Nests with other postures ─────────────────────────────────────────

  it("an ungoverned org nest still drafts the contribution; it publishes only when someone approves it", async () => {
    const open = (await jsonRequest(app, "POST", "/nests", { name: "Ungoverned Org" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${open}/visibility`, { visibility: "org" }, owner.apiKey);
    expect((await settings({ org_contributions: "drafts" }, open)).status).toBe(200);
    const res = await create(bob.apiKey, { title: "Ungoverned Idea", content: "x" }, open);
    expect(res.status).toBe(201);
    const id = res.data.node.id;
    expect(await approvedVersion(open, id)).toBeNull();
    expect((await pendingReview(open, id))?.requested_by).toBe(bob.email);
    // Someone has to be able to approve it: with no reviewer steward the
    // owner approves under self-approve, exactly as for any other draft.
    const refused = await jsonRequest(app, "POST", `/nests/${open}/nodes/${id}/approve`, {}, owner.apiKey);
    expect(refused.status).toBe(403);
    expect((await settings({ allow_self_approve: true }, open)).status).toBe(200);
    const ok = await jsonRequest(app, "POST", `/nests/${open}/nodes/${id}/approve`, {}, owner.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(await approvedVersion(open, id)).not.toBeNull();
  });

  it("a nest that holds agent writes refuses contributions over a key (no replay on a confirmer's authority)", async () => {
    await (await db()).run("UPDATE nests SET require_push_confirmation = 1 WHERE id = ?", [nestId]);
    try {
      const res = await create(bob.apiKey, { title: "Gated Key Doc", content: "x" });
      expect(res.status).toBe(403);
      const pending = await (await db()).get(
        "SELECT 1 AS x FROM pending_pushes WHERE nest_id = ?",
        [nestId],
      );
      expect(pending).toBeUndefined();
    } finally {
      await (await db()).run("UPDATE nests SET require_push_confirmation = 0 WHERE id = ?", [nestId]);
    }
  });

  // ── Where the setting does nothing ────────────────────────────────────

  it("a private or public nest with the setting forced on admits no contributor writes", async () => {
    for (const id of [privateNest, publicNest]) {
      await (await db()).run("UPDATE nests SET org_contributions = 'drafts' WHERE id = ?", [id]);
      const res = await create(bob.apiKey, { title: `Nope ${id}`, content: "x" }, id);
      expect([403, 404]).toContain(res.status);
    }
    const { resolveNestAccess } = await import("../src/shared/access.js");
    expect((await resolveNestAccess(publicNest, bob.userId)).orgContributor).toBe(false);
  });

  it("an archived org nest admits no contributor writes", async () => {
    const tmp = (await jsonRequest(app, "POST", "/nests", { name: "To Archive" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${tmp}/visibility`, { visibility: "org" }, owner.apiKey);
    expect((await settings({ org_contributions: "drafts" }, tmp)).status).toBe(200);
    expect((await jsonRequest(app, "POST", `/nests/${tmp}/archive`, {}, owner.apiKey)).status).toBe(200);
    const res = await create(bob.apiKey, { title: "Into Archive", content: "x" }, tmp);
    expect(res.status).toBe(403);
  });

  // ── Shared deployment: the email domain is the org boundary ───────────

  it("shared deployment: only a verified email on an exactly-listed domain contributes", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    expect((await settings({ org_domains: ["acme.com"] })).status).toBe(200);

    const ok = await create(bob.apiKey, { title: "Shared Bob", content: "x" });
    expect(ok.status).toBe(201);

    // Other company, and a suffix spoof of the right one.
    expect((await create(eve.apiKey, { title: "Shared Eve", content: "x" })).status).toBe(403);
    expect((await create(mallory.apiKey, { title: "Shared Mallory", content: "x" })).status).toBe(403);
    // Right domain, but a password sign-up nobody verified.
    expect((await create(dave.apiKey, { title: "Shared Dave", content: "x" })).status).toBe(403);

    const { resolveNestAccess } = await import("../src/shared/access.js");
    expect((await resolveNestAccess(nestId, mallory.userId)).orgContributor).toBe(false);
    expect((await resolveNestAccess(nestId, dave.userId)).orgContributor).toBe(false);
  });

  it("shared deployment: a subdomain is not the listed domain", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    resetAuthRateLimit();
    const sub = await registerUser(app, "sam@eng.acme.com");
    await markVerified(sub.userId);
    expect((await create(sub.apiKey, { title: "Shared Sub", content: "x" })).status).toBe(403);
  });

  it("shared deployment: clearing the domains while the setting is on is a 400", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    expect((await settings({ org_domains: [] })).status).toBe(400);
  });

  it("shared deployment: a domain list wiped behind the API's back fails closed", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    await (await db()).run("UPDATE nests SET org_domains = NULL WHERE id = ?", [nestId]);
    expect((await create(bob.apiKey, { title: "No Domains", content: "x" })).status).toBe(403);
    await (await db()).run("UPDATE nests SET org_domains = ? WHERE id = ?", [JSON.stringify(["acme.com"]), nestId]);
  });

  it("turning visibility back to private makes the setting inert", async () => {
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "private" }, owner.apiKey)).status).toBe(200);
    expect([403, 404]).toContain((await create(bob.apiKey, { title: "After Private", content: "x" })).status);
  });
});

describe("email verification is recorded, never assumed", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("a password sign-up leaves email_verified_at empty", async () => {
    resetAuthRateLimit();
    const u = await registerUser(app, "pw@acme.com");
    const row = (await (await db()).get("SELECT email_verified_at FROM users WHERE id = ?", [u.userId])) as {
      email_verified_at: string | null;
    };
    expect(row.email_verified_at).toBeNull();
  });
});

describe("which IdP sign-ins vouch for an address", () => {
  afterEach(() => {
    delete process.env.SHARED_DEPLOYMENT;
  });
  it("trusts email_verified: true; never false; an absent claim only for an `email` claim on a single-org server", async () => {
    const { idpVouchesForEmail } = await import("../src/auth/email-verified.js");
    expect(idpVouchesForEmail({ email: "a@acme.com", email_verified: true })).toBe(true);
    expect(idpVouchesForEmail({ email: "a@acme.com", email_verified: "true" })).toBe(true);
    expect(idpVouchesForEmail({ email: "a@acme.com", email_verified: false })).toBe(false);
    expect(idpVouchesForEmail({ email: "a@acme.com", email_verified: "false" })).toBe(false);
    expect(idpVouchesForEmail({ email: "a@acme.com" })).toBe(true);
    // Entra's UPN fallback is not an email claim the IdP asserted.
    expect(idpVouchesForEmail({ preferred_username: "a@acme.com" })).toBe(false);
    process.env.SHARED_DEPLOYMENT = "true";
    // On a shared server the domain is the tenant boundary: only an explicit true.
    expect(idpVouchesForEmail({ email: "a@acme.com" })).toBe(false);
    expect(idpVouchesForEmail({ email: "a@acme.com", email_verified: true })).toBe(true);
  });
});

describe("markEmailVerified keeps the first verification", () => {
  it("doesn't rewrite email_verified_at on later sign-ins", async () => {
    const env = setupTestEnv();
    const app = await createTestApp("key");
    resetAuthRateLimit();
    const u = await registerUser(app, "sso@acme.com");
    const { markEmailVerified } = await import("../src/auth/email-verified.js");
    await markEmailVerified(u.userId, "test");
    const first = ((await (await db()).get("SELECT email_verified_at AS v FROM users WHERE id = ?", [u.userId])) as { v: string }).v;
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 15));
    await markEmailVerified(u.userId, "test");
    const second = ((await (await db()).get("SELECT email_verified_at AS v FROM users WHERE id = ?", [u.userId])) as { v: string }).v;
    expect(second).toBe(first);
    await env.cleanup();
  });
});

describe("route table: the contributor PATCH can only ever reach the node update", () => {
  it("the app refuses to boot if another PATCH appears under /nests/:nestId/nodes", async () => {
    const { assertSoleNodePatchRoute } = await import("../src/governance/org-contribution.js");
    expect(() =>
      assertSoleNodePatchRoute([
        { method: "PATCH", path: "/nests/:nestId/nodes/:nodeId{.+}" },
        { method: "PATCH", path: "/nests/:nestId/nodes/:nodeId{.+}/pin" },
      ]),
    ).toThrow(/org contributor/i);
    expect(() =>
      assertSoleNodePatchRoute([{ method: "PATCH", path: "/nests/:nestId/nodes/:nodeId{.+}" }]),
    ).not.toThrow();
  });

  it("there is exactly one PATCH route under /nests/:nestId/nodes", async () => {
    const env = setupTestEnv();
    const app = await createTestApp("key");
    const patches = (app.routes as Array<{ method: string; path: string }>)
      .filter((r) => r.method === "PATCH" && r.path.startsWith("/nests/:nestId/nodes"))
      .map((r) => r.path);
    expect([...new Set(patches)]).toEqual(["/nests/:nestId/nodes/:nodeId{.+}"]);
    await env.cleanup();
  });
});
