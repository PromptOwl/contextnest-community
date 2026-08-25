/**
 * Importing PromptOwl teams. The PromptOwl token rides in an httpOnly cookie
 * (set at PromptOwl sign-in, or primed by a one-off device approval) — never
 * the database. PromptOwl is the source of truth on every import: a re-import
 * updates the same local team (matched on its PromptOwl id, so a rename on
 * either side survives) and reconciles the roster, removals included.
 *
 * PromptOwl itself is stubbed at fetch: these tests own the contract with
 * /api/user/teams, not PromptOwl's implementation of it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let other: { apiKey: string; userId: string; email: string };

/** Queue of responses the stubbed PromptOwl returns, oldest first. */
let poResponses: Array<{ status: number; body: unknown } | Error>;
let poRequests: Array<{ url: string; authorization: string | null }>;

const poTeam = (over: Record<string, unknown> = {}) => ({
  id: "po-team-1",
  name: "Platform",
  owned: true,
  your_role: "Owner",
  source: "manual",
  enterprise: null,
  updated_at: "2026-01-02T03:04:05.000Z",
  members: [
    { email: "owner@acme.com", role: "Owner" },
    { email: "dev@acme.com", role: "Editor" },
    { email: "watcher@acme.com", role: "Viewer" },
  ],
  ...over,
});

const queuePo = (teams: unknown[]) =>
  poResponses.push({ status: 200, body: { success: true, teams } });

beforeAll(async () => {
  env = setupTestEnv();
  // The PromptOwl team-import surface is OFF by default; these tests exercise
  // it, so opt in for the suite.
  process.env.PROMPTOWL_TEAMS_ENABLED = "true";
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  await resetAuthRateLimit();
  other = await registerUser(app, "other@acme.com", "Other");
  await resetAuthRateLimit();

  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    poRequests.push({
      url: String(url),
      authorization:
        ((init?.headers as Record<string, string>) || {})["Authorization"] ??
        null,
    });
    const next = poResponses.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
});

beforeEach(async () => {
  poResponses = [];
  poRequests = [];
  // PROMPTOWL_LIMIT is 10 per IP per 15 min and every test here shares one IP.
  await resetAuthRateLimit();
});

afterAll(() => {
  vi.unstubAllGlobals();
  env.cleanup();
});

/**
 * The PromptOwl token cookie a PromptOwl sign-in would have left. Every import
 * request carries it — there is no other way in.
 */
const PO_COOKIE = "cnst_po_token=po_device_tok";

/** Raw request so cookies and Set-Cookie headers are visible. */
const rawRequest = (
  path: string,
  opts: { method?: string; body?: any; cookie?: string | null; key?: string } = {},
) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${opts.key ?? owner.apiKey}`,
  };
  const cookie = opts.cookie === null ? undefined : (opts.cookie ?? PO_COOKIE);
  if (cookie) headers.Cookie = cookie;
  return app.request(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
};

const asJson = async (res: Response) => ({
  status: res.status,
  data: await res.json(),
});

const preview = (cookie?: string | null) =>
  rawRequest("/teams/promptowl", { cookie }).then(asJson);

const sync = (teamIds: string[], key = owner.apiKey, cookie?: string | null) =>
  rawRequest("/teams/promptowl/sync", {
    method: "POST",
    body: { team_ids: teamIds },
    key,
    cookie,
  }).then(asJson);

const poCookie = (res: Response) =>
  res.headers.getSetCookie().find((c: string) => c.startsWith("cnst_po_token="));

describe("feature flag gate", () => {
  it("404s the PromptOwl team routes when the feature is off", async () => {
    process.env.PROMPTOWL_TEAMS_ENABLED = "";
    try {
      const get = await rawRequest("/teams/promptowl", {
        cookie: "cnst_po_token=po_device_cookie",
      });
      expect(get.status).toBe(404);
      const post = await rawRequest("/teams/promptowl/sync", {
        method: "POST",
        cookie: "cnst_po_token=po_device_cookie",
        body: { team_ids: ["po-team-1"] },
      });
      expect(post.status).toBe(404);
      // Gate is upstream of any PromptOwl call.
      expect(poRequests).toHaveLength(0);
    } finally {
      process.env.PROMPTOWL_TEAMS_ENABLED = "true";
    }
  });
});

describe("only a PromptOwl sign-in can import", () => {
  it("uses the token cookie left by PromptOwl sign-in", async () => {
    queuePo([poTeam()]);
    const res = await rawRequest("/teams/promptowl", {
      cookie: "cnst_po_token=po_device_cookie",
    });
    expect(res.status).toBe(200);
    expect(poRequests[0].authorization).toBe("Bearer po_device_cookie");
  });

  it("refuses a caller with no PromptOwl session", async () => {
    // Signed in here, but not via PromptOwl — no token cookie exists.
    const res = await rawRequest("/teams/promptowl", { cookie: null });
    // 428, NOT 401: they ARE logged in. A 401 would read to the SPA as a dead
    // session and bounce them to the login screen.
    expect(res.status).toBe(428);
    expect((await res.json()).code).toBe("promptowl_connect_required");
    expect(poRequests).toHaveLength(0);
  });

  it("refuses a caller who supplies a token in the request body", async () => {
    // The token must come from a real PromptOwl sign-in. Accepting one off the
    // wire would let any user import by pasting a token, which is exactly the
    // rule the hidden tab is only half of.
    const res = await rawRequest("/teams/promptowl/sync", {
      method: "POST",
      cookie: null,
      body: { token: "po_device_smuggled", team_ids: ["po-team-1"] },
    });
    expect(res.status).toBe(428);
    expect(poRequests).toHaveLength(0);
  });

  it("ignores a forged cookie value instead of forwarding it upstream", async () => {
    const res = await rawRequest("/teams/promptowl", {
      cookie: "cnst_po_token=not-a-po-token",
    });
    expect(res.status).toBe(428);
    expect(poRequests).toHaveLength(0);
  });

  it("drops the cookie when PromptOwl rejects the token", async () => {
    poResponses.push({ status: 401, body: { error: "revoked" } });
    const res = await rawRequest("/teams/promptowl", {
      cookie: "cnst_po_token=po_device_revoked",
    });
    expect(res.status).toBe(428);
    expect((await res.json()).code).toBe("promptowl_connect_required");
    // Cleared, so we stop replaying a token PromptOwl has already refused.
    expect(poCookie(res)).toContain("Max-Age=0");
  });
});

describe("preview", () => {
  it("lists the caller's owned PromptOwl teams", async () => {
    queuePo([poTeam()]);
    const res = await preview();
    expect(res.status).toBe(200);
    expect(res.data.teams).toHaveLength(1);
    expect(res.data.teams[0].name).toBe("Platform");
  });

  it("sends the approval token as a bearer to PromptOwl", async () => {
    queuePo([]);
    await preview("cnst_po_token=po_device_abc");
    expect(poRequests[0].url).toContain("/api/user/teams");
    expect(poRequests[0].authorization).toBe("Bearer po_device_abc");
  });

  it("surfaces a rejected approval as a connect prompt", async () => {
    poResponses.push({ status: 401, body: { error: "bad key" } });
    const res = await preview();
    expect(res.status).toBe(428);
  });

  it("reports an unreachable PromptOwl instead of leaking a fetch error", async () => {
    poResponses.push(new Error("ECONNREFUSED"));
    const res = await preview();
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("Could not reach PromptOwl");
  });

  it("requires authentication", async () => {
    // No Authorization header and no session — the auth guard must 401 before
    // the PromptOwl handler ever runs.
    const res = await app.request("/teams/promptowl", { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe("first import", () => {
  it("creates the team with a mapped roster, minus the importer", async () => {
    queuePo([poTeam()]);
    const res = await sync(["po-team-1"]);
    expect(res.status).toBe(200);
    expect(res.data.results[0]).toMatchObject({
      external_id: "po-team-1",
      name: "Platform",
      created: true,
      removed: [],
      updated: [],
    });
    expect(res.data.results[0].added.sort()).toEqual([
      "dev@acme.com",
      "watcher@acme.com",
    ]);

    const team = await jsonRequest(
      app,
      "GET",
      `/teams/${res.data.results[0].team_id}`,
      undefined,
      owner.apiKey,
    );
    expect(team.data.team.source).toBe("promptowl");
    expect(team.data.team.external_id).toBe("po-team-1");
    expect(team.data.team.owner_id).toBe(owner.userId);
    // Owner is the team's owner here, not a roster entry.
    expect(team.data.team.members.map((m: any) => m.email).sort()).toEqual([
      "dev@acme.com",
      "watcher@acme.com",
    ]);
    const roles = Object.fromEntries(
      team.data.team.members.map((m: any) => [m.email, m.role]),
    );
    expect(roles["dev@acme.com"]).toBe("editor");
    expect(roles["watcher@acme.com"]).toBe("viewer");
  });

  it("mints invited placeholders for members with no account here", async () => {
    queuePo([
      poTeam({
        id: "po-team-placeholder",
        name: "Newcomers",
        members: [{ email: "nobody@acme.com", role: "Editor" }],
      }),
    ]);
    const res = await sync(["po-team-placeholder"]);
    const team = await jsonRequest(
      app,
      "GET",
      `/teams/${res.data.results[0].team_id}`,
      undefined,
      owner.apiKey,
    );
    expect(team.data.team.members[0]).toMatchObject({
      email: "nobody@acme.com",
      role: "editor",
      registered: false,
    });
  });

  it("maps PromptOwl's default 'User' role to least privilege", async () => {
    queuePo([
      poTeam({
        id: "po-team-roles",
        name: "Roles",
        members: [
          { email: "plain@acme.com", role: "User" },
          { email: "boss@acme.com", role: "Owner" },
          { email: "future@acme.com", role: "SomethingNew" },
        ],
      }),
    ]);
    const res = await sync(["po-team-roles"]);
    const team = await jsonRequest(
      app,
      "GET",
      `/teams/${res.data.results[0].team_id}`,
      undefined,
      owner.apiKey,
    );
    const roles = Object.fromEntries(
      team.data.team.members.map((m: any) => [m.email, m.role]),
    );
    expect(roles["plain@acme.com"]).toBe("viewer");
    expect(roles["boss@acme.com"]).toBe("admin");
    // An unrecognized upstream role must never widen access.
    expect(roles["future@acme.com"]).toBe("viewer");
  });

  it("imports several teams in one call", async () => {
    queuePo([
      poTeam({ id: "po-multi-a", name: "Alpha", members: [] }),
      poTeam({ id: "po-multi-b", name: "Beta", members: [] }),
    ]);
    const res = await sync(["po-multi-a", "po-multi-b"]);
    expect(res.data.results.map((r: any) => r.name)).toEqual(["Alpha", "Beta"]);
  });
});

describe("re-import", () => {
  let teamId: string;

  beforeEach(async () => {
    poResponses = [];
    queuePo([poTeam({ id: "po-resync", name: "Resync", members: [
      { email: "owner@acme.com", role: "Owner" },
      { email: "dev@acme.com", role: "Editor" },
    ] })]);
    const res = await sync(["po-resync"]);
    teamId = res.data.results[0].team_id;
  });

  it("updates the same team rather than creating a duplicate", async () => {
    queuePo([poTeam({ id: "po-resync", name: "Resync", members: [
      { email: "owner@acme.com", role: "Owner" },
      { email: "dev@acme.com", role: "Editor" },
    ] })]);
    const res = await sync(["po-resync"]);
    expect(res.data.results[0]).toMatchObject({
      team_id: teamId,
      created: false,
      added: [],
      updated: [],
      removed: [],
    });

    const list = await jsonRequest(app, "GET", "/teams", undefined, owner.apiKey);
    const copies = list.data.teams.filter(
      (t: any) => t.external_id === "po-resync",
    );
    expect(copies).toHaveLength(1);
  });

  it("follows an upstream rename onto the same team", async () => {
    queuePo([poTeam({ id: "po-resync", name: "Renamed Upstream", members: [
      { email: "owner@acme.com", role: "Owner" },
      { email: "dev@acme.com", role: "Editor" },
    ] })]);
    const res = await sync(["po-resync"]);
    expect(res.data.results[0].team_id).toBe(teamId);
    expect(res.data.results[0].name).toBe("Renamed Upstream");

    const team = await jsonRequest(
      app,
      "GET",
      `/teams/${teamId}`,
      undefined,
      owner.apiKey,
    );
    expect(team.data.team.name).toBe("Renamed Upstream");
  });

  it("applies upstream adds and role changes", async () => {
    queuePo([poTeam({ id: "po-resync", name: "Resync", members: [
      { email: "owner@acme.com", role: "Owner" },
      { email: "dev@acme.com", role: "Viewer" },
      { email: "fresh@acme.com", role: "Editor" },
    ] })]);
    const res = await sync(["po-resync"]);
    expect(res.data.results[0]).toMatchObject({
      added: ["fresh@acme.com"],
      updated: ["dev@acme.com"],
      removed: [],
    });

    const team = await jsonRequest(
      app,
      "GET",
      `/teams/${teamId}`,
      undefined,
      owner.apiKey,
    );
    const roles = Object.fromEntries(
      team.data.team.members.map((m: any) => [m.email, m.role]),
    );
    expect(roles["dev@acme.com"]).toBe("viewer");
    expect(roles["fresh@acme.com"]).toBe("editor");
  });

  it("removes a member dropped upstream", async () => {
    queuePo([poTeam({ id: "po-resync", name: "Resync", members: [
      { email: "owner@acme.com", role: "Owner" },
    ] })]);
    const res = await sync(["po-resync"]);
    expect(res.data.results[0].removed).toEqual(["dev@acme.com"]);

    const team = await jsonRequest(
      app,
      "GET",
      `/teams/${teamId}`,
      undefined,
      owner.apiKey,
    );
    expect(team.data.team.members).toEqual([]);
  });

  it("deletes a locally-added member, since PromptOwl is the source of truth", async () => {
    await jsonRequest(
      app,
      "POST",
      `/teams/${teamId}/members`,
      { email: "local@acme.com", role: "admin" },
      owner.apiKey,
    );
    queuePo([poTeam({ id: "po-resync", name: "Resync", members: [
      { email: "owner@acme.com", role: "Owner" },
      { email: "dev@acme.com", role: "Editor" },
    ] })]);
    const res = await sync(["po-resync"]);
    expect(res.data.results[0].removed).toEqual(["local@acme.com"]);
  });
});

describe("guards", () => {
  it("refuses a team the caller has nothing to do with upstream", async () => {
    // PromptOwl only returns teams the caller owns or belongs to, so an id
    // outside that set is either unrelated to them or nonexistent — both are
    // refused identically, so the error can't probe which ids exist.
    queuePo([poTeam()]);
    const res = await sync(["po-someone-elses"]);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("isn't available to import");
  });

  it("makes the importer the owner here even when they're only an Editor upstream", async () => {
    // Whoever imports a team owns the copy — that's what makes "who created
    // this team and what can they do with it" answerable locally, without
    // reaching back into PromptOwl. The upstream owner comes across as an
    // admin member (Owner → admin), which is the highest member role there is.
    queuePo([
      poTeam({
        id: "po-editor",
        name: "I Edit This",
        owned: false,
        your_role: "Editor",
        members: [
          { email: "boss@acme.com", role: "Owner" },
          { email: "owner@acme.com", role: "Editor" }, // the importer, upstream
        ],
      }),
    ]);
    const res = await sync(["po-editor"]);
    expect(res.status).toBe(200);
    expect(res.data.results[0].created).toBe(true);

    const team = await jsonRequest(
      app,
      "GET",
      `/teams/${res.data.results[0].team_id}`,
      undefined,
      owner.apiKey,
    );
    expect(team.data.team.owner_id).toBe(owner.userId);
    // The importer is the owner, not a member carrying their upstream role —
    // an owner already outranks every member role.
    expect(team.data.team.members.map((m: any) => m.email)).toEqual([
      "boss@acme.com",
    ]);
    expect(team.data.team.members[0].role).toBe("admin");
  });

  it("refuses a team the caller is only view-only on upstream", async () => {
    // Importing makes you owner of the copy here — free rein to rename it,
    // rewrite the roster, and share it onto a nest. A view-only member holds
    // none of that upstream and must not gain it by copying the team over.
    queuePo([
      poTeam({
        id: "po-viewer",
        name: "Not Mine",
        owned: false,
        your_role: "Viewer",
      }),
    ]);
    const res = await sync(["po-viewer"]);
    expect(res.status).toBe(403);
    expect(res.data.error).toContain("view-only");
  });

  it("refuses a team where the caller is PromptOwl's default 'User' role", async () => {
    queuePo([
      poTeam({ id: "po-plain", name: "Plain", owned: false, your_role: "User" }),
    ]);
    expect((await sync(["po-plain"])).status).toBe(403);
  });

  it("refuses a role it doesn't recognize rather than assuming authority", async () => {
    queuePo([
      poTeam({
        id: "po-future",
        name: "Future",
        owned: false,
        your_role: "SomethingNew",
      }),
    ]);
    expect((await sync(["po-future"])).status).toBe(403);
  });

  it("refuses the whole batch when one team is view-only", async () => {
    queuePo([
      poTeam({ id: "po-ok", name: "Mine", members: [] }),
      poTeam({
        id: "po-nope",
        name: "Not Mine",
        owned: false,
        your_role: "Viewer",
        members: [],
      }),
    ]);
    const res = await sync(["po-ok", "po-nope"]);
    expect(res.status).toBe(403);

    // And nothing from the batch landed — the guard runs before any writes.
    const list = await jsonRequest(app, "GET", "/teams", undefined, owner.apiKey);
    expect(list.data.teams.some((t: any) => t.external_id === "po-ok")).toBe(false);
  });

  it("refuses an empty selection", async () => {
    const res = await sync([]);
    expect(res.status).toBe(400);
    expect(poRequests).toHaveLength(0);
  });

  it("requires a PromptOwl connection before importing", async () => {
    const res = await app.request("/teams/promptowl/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${owner.apiKey}`,
      },
      body: JSON.stringify({ team_ids: ["po-team-1"] }),
    });
    expect(res.status).toBe(428);
    expect(poRequests).toHaveLength(0);
  });

  it("keeps two importers of the same upstream team apart", async () => {
    queuePo([poTeam({ id: "po-shared", name: "Shared", members: [] })]);
    const mine = await sync(["po-shared"]);
    queuePo([poTeam({ id: "po-shared", name: "Shared", members: [] })]);
    const theirs = await sync(["po-shared"], other.apiKey);

    expect(theirs.data.results[0].created).toBe(true);
    expect(theirs.data.results[0].team_id).not.toBe(mine.data.results[0].team_id);
  });

  it("requires authentication", async () => {
    const res = await jsonRequest(app, "POST", "/teams/promptowl/sync", {
      token: "po_device_tok",
      team_ids: ["po-team-1"],
    });
    expect(res.status).toBe(401);
  });
});

describe("hand-made teams are untouched", () => {
  it("carries no source or external id", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      "/teams",
      { name: "Hand Made" },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.team.source).toBeNull();
    expect(res.data.team.external_id).toBeNull();
  });
});
