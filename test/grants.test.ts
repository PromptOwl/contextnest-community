/**
 * Document + folder share grants: an owner/admin shares a single doc or a
 * folder with a person who is NOT a nest collaborator. The grantee can reach
 * exactly the granted node(s) — read or write per the grant — and nothing
 * else in the nest. The security-critical property is the negative: no
 * over-reach to sibling docs or nest management.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let guest: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  guest = await registerUser(app, "guest@acme.com", "Guest");
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Private" }, owner.apiKey);
  nestId = nest.data.nest.id;
  // A shared doc, a sibling doc (never shared), and a folder with two docs.
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Shared One", content: "# shared" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Sibling Secret", content: "# secret sibling" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Deal A", content: "# a", folder: "gtm/deals" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Deal B", content: "# b", folder: "gtm/deals" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "GTM Other", content: "# other", folder: "gtm" }, owner.apiKey);
});

afterAll(() => env.cleanup());

describe("managing grants", () => {
  it("owner shares one document read-only with guest", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/shared-one", email: guest.email, role: "read" },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.grant.role).toBe("read");
  });

  it("a non-admin cannot manage grants", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/shared-one", email: outsider.email, role: "read" },
      guest.apiKey,
    );
    // Denied — either 403 (reached the handler) or 404 (a grant-only caller
    // can't even see /grants). Both prove a non-admin can't share.
    expect([403, 404]).toContain(res.status);
  });

  it("validates target_type and role", async () => {
    for (const body of [
      { target_type: "bogus", target: "nodes/x", email: guest.email, role: "read" },
      { target_type: "document", target: "nodes/x", email: guest.email, role: "admin" },
      { target_type: "document", target: "", email: guest.email, role: "read" },
    ]) {
      const res = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, body, owner.apiKey);
      expect(res.status).toBe(400);
    }
  });

  it("rejects a bare-root folder target (would share the whole nest)", async () => {
    // Every node id is `nodes/…`, so a folder grant on the `nodes` root would
    // match ALL of them. Reject it (and its trailing-slash spelling) so a
    // scoped share can't silently become nest-wide.
    for (const target of ["nodes", "nodes/"]) {
      const res = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/grants`,
        { target_type: "folder", target, email: guest.email, role: "read" },
        owner.apiKey,
      );
      expect(res.status).toBe(400);
    }
    // (A legit subfolder grant is exercised in the folder-grant block below.)
  });
});

describe("document grant — access is scoped to exactly that doc", () => {
  it("guest can READ the shared doc", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/shared-one`, undefined, guest.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.node.content).toContain("shared");
  });

  it("guest CANNOT read the sibling secret (no grant)", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/sibling-secret`, undefined, guest.apiKey);
    expect(res.status).toBe(404);
  });

  it("guest's node list shows ONLY the shared doc, not the whole nest", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, guest.apiKey);
    expect(res.status).toBe(200);
    const ids = res.data.nodes.map((n: any) => n.id);
    expect(ids).toEqual(["nodes/shared-one"]);
  });

  it("read grant does NOT allow writing", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      { content: "hacked" },
      guest.apiKey,
    );
    expect(res.status).toBe(403);
  });

  it("a READ grantee cannot even request the document's deletion", async () => {
    // Being shown something is not standing to propose destroying it. Must run
    // before the write upgrade below, which legitimately earns that right.
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/shared-one/request-deletion`,
      { reason: "don't want it" },
      guest.apiKey,
    );
    expect(res.status).toBe(403);
  });

  it("upgrading to write lets guest edit that doc", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/shared-one", email: guest.email, role: "write" },
      owner.apiKey,
    );
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      { append: "\nedited by guest" },
      guest.apiKey,
    );
    expect(res.status).toBe(200);
    // Still can't touch the sibling.
    const sib = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/sibling-secret`,
      { content: "x" },
      guest.apiKey,
    );
    expect(sib.status).toBe(404);
  });

  it("a WRITE grantee may request that document's deletion", async () => {
    // A write grant is edit rights on that document, which is exactly the
    // standing the deletion gate asks for — scoped to it, nothing else.
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/shared-one/request-deletion`,
      { reason: "superseded" },
      guest.apiKey,
    );
    expect(res.status).toBe(201);
    // Clean up so the later revoke test isn't reading a flagged node.
    const roster = await jsonRequest(app, "GET", `/nests/${nestId}/deletion-requests`, undefined, owner.apiKey);
    const req = roster.data.requests.find((r: any) => r.nodeId === "nodes/shared-one");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/deletion-requests/${req.id}/decline`,
      { note: "keeping it" },
      owner.apiKey,
    );
  });

  it("guest cannot reach nest management (settings/grants)", async () => {
    const settings = await jsonRequest(app, "GET", `/nests/${nestId}/settings`, undefined, guest.apiKey);
    expect([403, 404]).toContain(settings.status);
    const grants = await jsonRequest(app, "GET", `/nests/${nestId}/grants`, undefined, guest.apiKey);
    expect([403, 404]).toContain(grants.status);
  });
});

describe("folder grant — covers everything under the prefix", () => {
  it("sharing the gtm/deals folder gives outsider both deals, not gtm/other", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "folder", target: "nodes/gtm/deals", email: outsider.email, role: "read" },
      owner.apiKey,
    );
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, outsider.apiKey);
    const ids = list.data.nodes.map((n: any) => n.id).sort();
    expect(ids).toEqual(["nodes/gtm/deals/deal-a", "nodes/gtm/deals/deal-b"]);
    // gtm/other is one level up — NOT under gtm/deals — so it's excluded.
    expect(ids).not.toContain("nodes/gtm/gtm-other");

    const dealA = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/gtm/deals/deal-a`, undefined, outsider.apiKey);
    expect(dealA.status).toBe(200);
    const other = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/gtm/gtm-other`, undefined, outsider.apiKey);
    expect(other.status).toBe(404);
  });

  it("a folder-prefix grant doesn't leak to a sibling with a shared name-prefix", async () => {
    // nodes/gtm/deals must NOT match a hypothetical nodes/gtm/deals-archive.
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Archive X", content: "# arch", folder: "gtm/deals-archive" }, owner.apiKey);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, outsider.apiKey);
    const ids = list.data.nodes.map((n: any) => n.id);
    expect(ids).not.toContain("nodes/gtm/deals-archive/archive-x");
  });
});

describe("revoking", () => {
  it("deleting the grant removes access", async () => {
    const roster = await jsonRequest(app, "GET", `/nests/${nestId}/grants`, undefined, owner.apiKey);
    const g = roster.data.grants.find((x: any) => x.email === guest.email);
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/grants/${g.id}`, undefined, owner.apiKey);
    expect(del.status).toBe(200);
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/shared-one`, undefined, guest.apiKey);
    expect(read.status).toBe(404);
  });
});

// Grants must work identically whether or not the nest has stewardship (the
// review-governance mode) enabled. The handler-level access guards
// (canReadNode / filterAccessible) gate reads via steward roles when
// stewardship is on — they are grants-aware so a grantee isn't 403'd on a
// governed nest even though the coarse middleware already let them in.
describe("grants under stewardship (governed nest)", () => {
  let govNest: string;

  beforeAll(async () => {
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Governed" }, owner.apiKey);
    govNest = nest.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${govNest}/nodes`, { title: "Gov Shared", content: "# gov shared" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${govNest}/nodes`, { title: "Gov Secret", content: "# gov secret" }, owner.apiKey);
    const s = await jsonRequest(app, "PATCH", `/nests/${govNest}/settings`, { stewardship_enabled: true }, owner.apiKey);
    expect(s.status).toBe(200);
    expect(s.data.stewardship_enabled).toBe(true);
  });

  it("read grantee can READ the granted doc and it appears in their list", async () => {
    const share = await jsonRequest(app, "POST", `/nests/${govNest}/grants`,
      { target_type: "document", target: "nodes/gov-shared", email: guest.email, role: "read" }, owner.apiKey);
    expect(share.status).toBe(201);

    const read = await jsonRequest(app, "GET", `/nests/${govNest}/nodes/nodes/gov-shared`, undefined, guest.apiKey);
    expect(read.status).toBe(200);
// Being shared something is worthless if you can't find it. A grantee has no
// nest-wide permission, so the nest must still be listed for them — as a
// viewer of their slice, never describing the parts they can't see.
describe("discovery — the grantee finds the nest by logging in", () => {
  it("the shared nest appears in the grantee's own nest list", async () => {
    const res = await jsonRequest(app, "GET", "/nests", undefined, guest.apiKey);
    expect(res.status).toBe(200);
    const card = res.data.nests.find((n: any) => n.id === nestId);
    expect(card).toBeTruthy();
    expect(card.permission).toBe("read");
    expect(card.is_owner).toBe(false);
    expect(card.roles).toEqual(["viewer"]);
    expect(card.owner_email).toBe(owner.email);
  });

  it("the grantee can open the nest detail page", async () => {
    // Regression: the middleware admitted a grantee, then GET /nests/:id
    // 404'd them because they hold no nest-wide permission — the nest they
    // were just shared into reported "Nest not found".
    const res = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, guest.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.nest.id).toBe(nestId);
    expect(res.data.permission).toBe("read");
    expect(res.data.grant_only).toBe(true);
    expect(res.data.roles).toEqual(["viewer"]);
    expect(res.data.myStewards).toEqual([]);
  });

  it("read access still buys no nest-wide power", async () => {
    // Reporting a grantee as a reader inside the nest routes must not become
    // authority. Denial can come from the middleware (404 — these paths are
    // not on the grantee's allow-list at all) or the handler (403); what
    // matters is that none of it succeeds.
    for (const [method, path, body] of [
      ["PATCH", `/nests/${nestId}`, { name: "Hijacked" }],
      ["DELETE", `/nests/${nestId}`, undefined],
      ["PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: false }],
      ["GET", `/nests/${nestId}/stewards`, undefined],
      ["GET", `/nests/${nestId}/collaborators`, undefined],
    ] as const) {
      const res = await jsonRequest(app, method, path, body as any, guest.apiKey);
      expect([403, 404]).toContain(res.status);
    }
  });

  it("the card counts the grantee's slice, not the nest", async () => {
    // guest holds one document grant; outsider holds a folder grant over the
    // two deals. Neither may learn how big the nest really is.
    const asGuest = await jsonRequest(app, "GET", "/nests", undefined, guest.apiKey);
    const guestCard = asGuest.data.nests.find((n: any) => n.id === nestId);
    expect(guestCard.document_count).toBe(1);

    const asOutsider = await jsonRequest(app, "GET", "/nests", undefined, outsider.apiKey);
    const outsiderCard = asOutsider.data.nests.find((n: any) => n.id === nestId);
    expect(outsiderCard.document_count).toBe(2);
  });

  it("the card does not leak the nest's people", async () => {
    const res = await jsonRequest(app, "GET", "/nests", undefined, guest.apiKey);
    const card = res.data.nests.find((n: any) => n.id === nestId);
    expect(card.collaborator_emails).toEqual([]);
    expect(card.steward_emails).toEqual([]);
    expect(card.collaborator_count).toBe(0);
    expect(card.steward_count).toBe(0);
  });

  it("a user with no grant still doesn't see the nest at all", async () => {
    resetAuthRateLimit();
    const stranger = await registerUser(app, "stranger@acme.com", "Stranger");
    const res = await jsonRequest(app, "GET", "/nests", undefined, stranger.apiKey);
    expect(res.data.nests.map((n: any) => n.id)).not.toContain(nestId);
  });
});

    expect(read.data.node.content).toContain("gov shared");

    const list = await jsonRequest(app, "GET", `/nests/${govNest}/nodes`, undefined, guest.apiKey);
    expect(list.status).toBe(200);
    expect(list.data.nodes.map((n: any) => n.id)).toEqual(["nodes/gov-shared"]);
  });

  it("read grantee can SEARCH and get CONTEXT, scoped to their grant (not 404)", async () => {
    // Retrieval routes were 404 for grant-only callers before they were added

  it("and drops the nest off the grantee's list", async () => {
    const res = await jsonRequest(app, "GET", "/nests", undefined, guest.apiKey);
    expect(res.data.nests.map((n: any) => n.id)).not.toContain(nestId);
  });
    // to the grant middleware allow-list; results self-scope via filterAccessible.
    const search = await jsonRequest(app, "GET", `/nests/${govNest}/search?q=gov`, undefined, guest.apiKey);
    expect(search.status).toBe(200);
    expect(search.data.nodes.map((n: any) => n.id)).toEqual(["nodes/gov-shared"]);

    // POST /context is read-tier for a grantee (body is a query, not a mutation).
    const ctx = await jsonRequest(
      app,
      "POST",
      `/nests/${govNest}/context`,
      { prompt: "gov", include_drafts: true },
      guest.apiKey,
    );
    expect(ctx.status).toBe(200);
    // Whatever context assembled, it must never include the non-granted sibling.
    expect(ctx.data.nodes.map((n: any) => n.id)).not.toContain("nodes/gov-secret");
    expect(JSON.stringify(ctx.data)).not.toContain("gov secret");
  });

  it("grantee still CANNOT reach a non-granted sibling", async () => {
    const sib = await jsonRequest(app, "GET", `/nests/${govNest}/nodes/nodes/gov-secret`, undefined, guest.apiKey);
    expect(sib.status).toBe(404);
  });

  it("read grant does NOT permit writing (no read/write split loophole)", async () => {
    const write = await jsonRequest(app, "PATCH", `/nests/${govNest}/nodes/nodes/gov-shared`,
      { content: "hacked" }, guest.apiKey);
    expect(write.status).toBe(403);
  });

  it("write grantee can both READ and WRITE the same doc (consistent, no view/edit split)", async () => {
    await jsonRequest(app, "POST", `/nests/${govNest}/grants`,
      { target_type: "document", target: "nodes/gov-shared", email: guest.email, role: "write" }, owner.apiKey);

    const read = await jsonRequest(app, "GET", `/nests/${govNest}/nodes/nodes/gov-shared`, undefined, guest.apiKey);
    expect(read.status).toBe(200);
    const write = await jsonRequest(app, "PATCH", `/nests/${govNest}/nodes/nodes/gov-shared`,
      { append: "\nedited by guest" }, guest.apiKey);
    expect(write.status).toBe(200);
  });
});
