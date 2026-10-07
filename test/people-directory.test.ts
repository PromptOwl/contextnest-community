/**
 * The two read surfaces the autocomplete pickers need (CU-wdqcq01rxw).
 *
 * 1. GET /nests/:nestId/mentionable — the nest's people at READ tier, because
 *    commenting is a read-tier action while GET /collaborators is deliberately
 *    write-tier (so a public nest's read tier can't enumerate member emails).
 *    The narrower rule that keeps that property: you may see the roster if you
 *    are ON it.
 * 2. GET /people/suggest — the caller-visible people directory the add-a-person
 *    controls autocomplete against. /auth/teammates can't serve this: it is
 *    server-admin only, so a plain nest admin inviting someone would get a 403.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

describe("mentionable roster", () => {
  let app: any;
  let owner: { apiKey: string; email: string };
  let viewer: { apiKey: string; email: string };
  let stranger: { apiKey: string; email: string };
  let nestId: string;

  beforeAll(async () => {
    setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    viewer = await registerUser(app, "viewer@acme.com", "Vera Viewer");
    await resetAuthRateLimit();
    stranger = await registerUser(app, "stranger@acme.com", "Stranger");
    await resetAuthRateLimit();

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Roster" },
      owner.apiKey,
    );
    nestId = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: viewer.email, permission: "read" },
      owner.apiKey,
    );
  });

  it("gives a read-only member the roster the mention picker needs", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/mentionable`,
      undefined,
      viewer.apiKey,
    );
    expect(status).toBe(200);
    const emails = (data.people as Array<{ email: string; name: string | null }>)
      .map((p) => p.email.toLowerCase())
      .sort();
    expect(emails).toEqual([owner.email, viewer.email].sort());
    // Names ride along so the picker can show a person, not just an address.
    expect(
      (data.people as Array<{ email: string; name: string | null }>).find(
        (p) => p.email.toLowerCase() === viewer.email,
      )?.name,
    ).toBe("Vera Viewer");
  });

  it("is why the endpoint exists: the collaborator roster stays write-tier", async () => {
    const { status } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/collaborators`,
      undefined,
      viewer.apiKey,
    );
    expect(status).toBe(403);
  });

  it("refuses someone whose only access is a grant on one document", async () => {
    // A grant is a guest pass to one document, not membership, and
    // listNestPeople lists every grant holder in the nest — so if this
    // endpoint answered them, one shared document would unlock every member's
    // address. It doesn't: a grant-only caller resolves to permission "none",
    // and app.ts only admits those on an explicit allowlist of grant-visible
    // routes (the bare nest read, the node list, retrieval queries, pins,
    // definitions). `mentionable` is not on it, so they are refused as
    // "Nest not found" — the existence oracle, hence 404 rather than 403.
    //
    // Pinned because the refusal comes from that allowlist, not from anything
    // in this endpoint: adding `mentionable` to it later has to answer the
    // roster question deliberately instead of inheriting a 200.
    const guest = await registerUser(app, "guest@acme.com", "Guest");
    await resetAuthRateLimit();
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Shared Doc", content: "for the guest" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      {
        target_type: "document",
        target: "nodes/shared-doc",
        email: guest.email,
        role: "read",
      },
      owner.apiKey,
    );

    const { status } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/mentionable`,
      undefined,
      guest.apiKey,
    );
    expect(status).toBe(404);

    // A member who ALSO holds a grant is still a member: listNestPeople keeps
    // their strongest path, so the grant doesn't demote them.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      {
        target_type: "document",
        target: "nodes/shared-doc",
        email: viewer.email,
        role: "read",
      },
      owner.apiKey,
    );
    const asViewer = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/mentionable`,
      undefined,
      viewer.apiKey,
    );
    expect(asViewer.status).toBe(200);
  });

  it("refuses a signed-in non-member reading an org-visible nest", async () => {
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "org" },
      owner.apiKey,
    );
    // The stranger can READ this nest now — that must not hand them the
    // member list.
    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}`,
      undefined,
      stranger.apiKey,
    );
    expect(read.status).toBe(200);

    const { status } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/mentionable`,
      undefined,
      stranger.apiKey,
    );
    expect(status).toBe(403);
  });
});

describe("people suggestions", () => {
  let app: any;
  let owner: { apiKey: string; email: string; userId: string };
  let colleague: { apiKey: string; email: string; userId: string };
  let teammate: { apiKey: string; email: string; userId: string };
  let stranger: { apiKey: string; email: string; userId: string };

  const suggest = async (caller: { apiKey: string }, q?: string) => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/people/suggest${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`,
      undefined,
      caller.apiKey,
    );
    return {
      status,
      emails: (data.people as Array<{ email: string }>).map((p) =>
        p.email.toLowerCase(),
      ),
    };
  };

  beforeAll(async () => {
    setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Olive Owner");
    await resetAuthRateLimit();
    colleague = await registerUser(app, "colleague@acme.com", "Carl Colleague");
    await resetAuthRateLimit();
    teammate = await registerUser(app, "teammate@acme.com", "Tina Teammate");
    await resetAuthRateLimit();
    stranger = await registerUser(app, "stranger@other.com", "Stranger");
    await resetAuthRateLimit();

    // A shared nest is one path to being suggestible…
    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Shared" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${data.nest.id}/collaborators`,
      { email: colleague.email, permission: "write" },
      owner.apiKey,
    );

    // …a shared team is the other.
    const team = await jsonRequest(
      app,
      "POST",
      "/teams",
      { name: "Platform" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/teams/${team.data.team.id}/members`,
      { email: teammate.email, role: "editor" },
      owner.apiKey,
    );
  });

  it("suggests people you already share a nest or a team with", async () => {
    const { status, emails } = await suggest(owner);
    expect(status).toBe(200);
    expect(emails).toContain(colleague.email);
    expect(emails).toContain(teammate.email);
  });

  it("never suggests a stranger, or the caller themselves", async () => {
    const { emails } = await suggest(owner);
    expect(emails).not.toContain(stranger.email);
    expect(emails).not.toContain(owner.email);
  });

  it("filters on the typed query, by name or address", async () => {
    expect((await suggest(owner, "tina")).emails).toEqual([teammate.email]);
    expect((await suggest(owner, "colleague@")).emails).toEqual([
      colleague.email,
    ]);
    expect((await suggest(owner, "zzz")).emails).toEqual([]);
  });

  it("treats % and _ in the query as characters, not wildcards", async () => {
    // The filter runs as a SQL LIKE; an unescaped "%" would match everyone,
    // which reads as "the picker ignored what I typed".
    expect((await suggest(owner, "%")).emails).toEqual([]);
    expect((await suggest(owner, "colleague_acme.com")).emails).toEqual([]);
  });

  it("shows the other side of the share the same person", async () => {
    // Suggestions are symmetric: the colleague can autocomplete the owner.
    const { emails } = await suggest(colleague);
    expect(emails).toContain(owner.email);
    expect(emails).not.toContain(stranger.email);
  });

  it("is unreachable without credentials — the route trusts its middleware", async () => {
    // The handler reads c.get("userId") with no guard of its own, which is
    // safe because flexAuthMiddleware either sets it or 401s: the only
    // unauthenticated path it admits is a public nest read, and that
    // eligibility check requires a /nests/:id/... path. Pinned here rather
    // than guarded in the handler, so a future change to that predicate has
    // to fail a test instead of quietly admitting anonymous callers.
    const res = await app.request("/people/suggest");
    expect(res.status).toBe(401);
  });

  it("does not offer the whole user table by default", async () => {
    // The default matters more than the feature: this server may hold several
    // unrelated customers (the PromptOwl-hosted deployment does), where
    // "every registered account" is one customer's staff being handed
    // another's addresses. Off unless an operator turns it on.
    const { config } = await import("../src/config.js");
    expect(config.PEOPLE_SUGGEST_ALL_USERS).toBe(false);
    expect((await suggest(owner)).emails).not.toContain(stranger.email);
  });

  it("suggests nobody to a caller who shares nothing", async () => {
    const { status, emails } = await suggest(stranger);
    expect(status).toBe(200);
    expect(emails).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The directory toggle — for a server whose user table IS one company
// ═══════════════════════════════════════════════════════════════════════════

describe("people suggestions with the directory toggle on", () => {
  let app: any;
  let owner: { apiKey: string; email: string };
  let stranger: { apiKey: string; email: string };

  beforeAll(async () => {
    process.env.PEOPLE_SUGGEST_ALL_USERS = "true";
    setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Olive Owner");
    await resetAuthRateLimit();
    // Shares no nest and no team with the owner — invisible by default.
    stranger = await registerUser(app, "stranger@other.com", "Stranger");
    await resetAuthRateLimit();
  });

  afterAll(() => {
    delete process.env.PEOPLE_SUGGEST_ALL_USERS;
  });

  it("offers every registered account, not only shared ones", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      "/people/suggest",
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    const people = data.people as Array<{ email: string; source: string }>;
    expect(people.map((p) => p.email.toLowerCase())).toContain(stranger.email);
    // Labelled as coming from the directory, not from a shared nest or team,
    // so a caller can tell why someone is being offered.
    expect(
      people.find((p) => p.email.toLowerCase() === stranger.email)?.source,
    ).toBe("directory");
  });

  it("still excludes the caller, and still filters on the query", async () => {
    const all = (await jsonRequest(
      app,
      "GET",
      "/people/suggest",
      undefined,
      owner.apiKey,
    )).data.people as Array<{ email: string }>;
    expect(all.map((p) => p.email.toLowerCase())).not.toContain(owner.email);

    const filtered = (await jsonRequest(
      app,
      "GET",
      "/people/suggest?q=stranger",
      undefined,
      owner.apiKey,
    )).data.people as Array<{ email: string }>;
    expect(filtered.map((p) => p.email.toLowerCase())).toEqual([
      stranger.email,
    ]);
  });
});

// The board's assignee picker offers only members; a directory suggestion is
// marked so an owner can share the nest first instead of hitting a 400.
describe("mentionable marks who is on the nest", () => {
  let app: any;
  let owner: { apiKey: string; email: string };
  let outsider: { apiKey: string; email: string };
  let nestId: string;

  beforeAll(async () => {
    process.env.PEOPLE_SUGGEST_ALL_USERS = "true";
    setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    outsider = await registerUser(app, "outsider@acme.com", "Outsider");
    await resetAuthRateLimit();
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Board" }, owner.apiKey);
    nestId = data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "card", content: "x" }, owner.apiKey);
  });

  afterAll(() => {
    delete process.env.PEOPLE_SUGGEST_ALL_USERS;
  });

  const member = async (email: string) => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/mentionable`, undefined, owner.apiKey);
    return (data.people as Array<{ email: string; member: boolean }>).find(
      (p) => p.email.toLowerCase() === email,
    )?.member;
  };
  const assign = () =>
    jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/card`, { assignee: outsider.email }, owner.apiKey);

  it("a directory user is not a member and can't be assigned until shared", async () => {
    expect(await member(owner.email)).toBe(true);
    expect(await member(outsider.email)).toBe(false);
    expect((await assign()).status).toBe(400);

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: outsider.email, permission: "write" },
      owner.apiKey,
    );
    expect(await member(outsider.email)).toBe(true);
    expect((await assign()).status).toBe(200);
  });
});
