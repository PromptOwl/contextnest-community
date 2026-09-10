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
import { describe, it, expect, beforeAll } from "vitest";
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

  it("suggests nobody to a caller who shares nothing", async () => {
    const { status, emails } = await suggest(stranger);
    expect(status).toBe(200);
    expect(emails).toEqual([]);
  });
});
