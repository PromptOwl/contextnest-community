/**
 * An invited person is not a first run (PO-1391).
 *
 * PO-1185 called anyone who owns no nest a first run and put the welcome
 * screen in place of their nest list. Someone who was invited to another
 * person's nest then landed on the welcome screen, not the nest. The rule now:
 * a first run owns no nest AND reaches none through a grant. Visibility alone
 * (a public or org nest) is not a grant.
 *
 * One rule, one place: getOnboardingState. GET /onboarding and the MCP tool
 * context_onboarding both read it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed, resetAuthRateLimit } from "./helpers";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let rpc = 1;
async function mcp(app: any, key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(key) },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  return body.result as { content: Array<{ text: string }>; structuredContent?: any };
}
const mcpState = (r: { content: Array<{ text: string }>; structuredContent?: any }) =>
  r.structuredContent ?? JSON.parse(r.content[r.content.length - 1]!.text);

type User = Awaited<ReturnType<typeof registerUser>>;
let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let collaborator: User;
let teamMember: User;
let requester: User;
let visitor: User;
let leaver: User;
let privateNest: string;
let orgNest: string;
let publicNest: string;

const state = async (u: User) => (await jsonRequest(app, "GET", "/onboarding", undefined, u.apiKey)).data;
async function must<T extends { status: number; data: any }>(p: Promise<T>, status: number): Promise<T> {
  const r = await p;
  expect(r.status, JSON.stringify(r.data)).toBe(status);
  return r;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "olive@invited.test", "Olive");
  collaborator = await registerUser(app, "cole@invited.test", "Cole");
  teamMember = await registerUser(app, "tess@invited.test", "Tess");
  await resetAuthRateLimit();
  requester = await registerUser(app, "rae@invited.test", "Rae");
  visitor = await registerUser(app, "vic@invited.test", "Vic");
  leaver = await registerUser(app, "lee@invited.test", "Lee");
  await resetAuthRateLimit();
  privateNest = (await must(jsonRequest(app, "POST", "/nests", { name: "Olive private" }, owner.apiKey), 201)).data.nest.id;
  orgNest = (await must(jsonRequest(app, "POST", "/nests", { name: "Olive org" }, owner.apiKey), 201)).data.nest.id;
  publicNest = (await must(jsonRequest(app, "POST", "/nests", { name: "Olive public" }, owner.apiKey), 201)).data.nest.id;
  await must(jsonRequest(app, "PATCH", `/nests/${orgNest}/visibility`, { visibility: "org" }, owner.apiKey), 200);
  await must(jsonRequest(app, "PATCH", `/nests/${publicNest}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey), 200);
});
afterAll(() => env.cleanup());

describe("someone who reaches nothing through a grant is still a first run", () => {
  it("Given a person who owns no nest and can only read public and org-visible nests, When they open the app, Then the welcome screen shows", async () => {
    // They really can read both: visibility is access, but it is not an invitation.
    expect((await jsonRequest(app, "GET", `/nests/${orgNest}`, undefined, visitor.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${publicNest}`, undefined, visitor.apiKey)).status).toBe(200);
    const s = await state(visitor);
    expect(s.show).toBe(true);
    expect(s.first_run).toBe(true);
    expect(s.shared_nests).toBe(0);
  });
});

describe("a collaborator grant", () => {
  it("Given a person who owns no nest, When they are added to someone else's nest, Then they are not a first run and the welcome screen does not show", async () => {
    expect((await state(collaborator)).show).toBe(true);
    await must(jsonRequest(app, "POST", `/nests/${privateNest}/collaborators`, { email: collaborator.email, permission: "read" }, owner.apiKey), 201);
    const s = await state(collaborator);
    expect(s.show).toBe(false);
    expect(s.first_run).toBe(false);
    expect(s.shared_nests).toBe(1);
    // It is not theirs: the screen has no nest of their own to work on.
    expect(s.nest).toBeNull();
    expect(s.dismissed).toBe(false);
  });

  it("the nest they were invited to is in their nest list", async () => {
    const list = await must(jsonRequest(app, "GET", "/nests", undefined, collaborator.apiKey), 200);
    expect(JSON.stringify(list.data)).toContain(privateNest);
  });

  it("Getting started on Home still opens the welcome screen, and Skip closes it", async () => {
    const reopened = await must(jsonRequest(app, "POST", "/onboarding/reopen", {}, collaborator.apiKey), 200);
    expect(reopened.data.show).toBe(true);
    expect(reopened.data.first_run).toBe(false);
    expect(reopened.data.can_create_nest).toBe(true);
    const skipped = await must(jsonRequest(app, "POST", "/onboarding/dismiss", {}, collaborator.apiKey), 200);
    expect(skipped.data.show).toBe(false);
  });

  it("context_onboarding reports the same state as GET /onboarding", async () => {
    for (const u of [collaborator, visitor]) {
      const rest = await state(u);
      const r = await mcp(app, u.apiKey, "context_onboarding");
      const viaMcp = mcpState(r);
      expect(viaMcp.show).toBe(rest.show);
      expect(viaMcp.first_run).toBe(rest.first_run);
      expect(viaMcp.shared_nests).toBe(rest.shared_nests);
      expect(r.content[0]!.text).toMatch(rest.show ? /Welcome screen: shown/ : /Welcome screen: not shown/);
    }
    // An agent of an invited person is told what they reach, not only that they own nothing.
    expect((await mcp(app, collaborator.apiKey, "context_onboarding")).content[0]!.text).toMatch(/1 nest shared with you/);
  });

  it("Given the grant is removed, Then a person who never dismissed the screen is a first run again", async () => {
    await must(jsonRequest(app, "POST", `/nests/${privateNest}/collaborators`, { email: leaver.email, permission: "read" }, owner.apiKey), 201);
    expect((await state(leaver)).show).toBe(false);
    const rows = (await must(jsonRequest(app, "GET", `/nests/${privateNest}/collaborators`, undefined, owner.apiKey), 200)).data.collaborators;
    const row = rows.find((c: any) => (c.email ?? "").toLowerCase() === leaver.email);
    await must(jsonRequest(app, "DELETE", `/nests/${privateNest}/collaborators/${row.id}`, undefined, owner.apiKey), 200);
    const s = await state(leaver);
    expect(s.first_run).toBe(true);
    expect(s.show).toBe(true);
  });
});

describe("a team share", () => {
  it("Given a person who owns no nest, When a team they belong to is shared onto a nest, Then the welcome screen does not show", async () => {
    const team = (await must(jsonRequest(app, "POST", "/teams", { name: "Field" }, owner.apiKey), 201)).data.team.id;
    await must(jsonRequest(app, "POST", `/teams/${team}/members`, { user_id: teamMember.userId, role: "viewer" }, owner.apiKey), 201);
    // On a team, but the team is on no nest yet: still nothing to land on.
    expect((await state(teamMember)).show).toBe(true);
    await must(jsonRequest(app, "POST", `/nests/${privateNest}/teams`, { team_id: team }, owner.apiKey), 201);
    const s = await state(teamMember);
    expect(s.show).toBe(false);
    expect(s.first_run).toBe(false);
    expect(s.shared_nests).toBe(1);
  });
});

describe("an accepted access request", () => {
  it("Given a person who reads an org-visible nest and asks to edit it, When the owner approves, Then they are no longer a first run", async () => {
    const ask = await must(
      jsonRequest(app, "POST", `/nests/${orgNest}/access-requests`, { target_type: "nest", target_id: orgNest, level: "write" }, requester.apiKey),
      201,
    );
    // Asking is not being let in.
    expect((await state(requester)).show).toBe(true);
    await must(jsonRequest(app, "POST", `/nests/${orgNest}/access-requests/${ask.data.request.id}/approve`, {}, owner.apiKey), 200);
    const s = await state(requester);
    expect(s.show).toBe(false);
    expect(s.first_run).toBe(false);
  });
});

describe("the nest must be live", () => {
  it("Given the only nest a person was invited to is archived, Then they are a first run again", async () => {
    const nest = (await must(jsonRequest(app, "POST", "/nests", { name: "Olive short-lived" }, owner.apiKey), 201)).data.nest.id;
    await must(jsonRequest(app, "POST", `/nests/${nest}/collaborators`, { email: leaver.email, permission: "read" }, owner.apiKey), 201);
    expect((await state(leaver)).show).toBe(false);
    await must(jsonRequest(app, "POST", `/nests/${nest}/archive`, {}, owner.apiKey), 200);
    expect((await state(leaver)).show).toBe(true);
  });
});

describe("owners are unchanged", () => {
  it("Given a person who owns a nest, Then they are not a first run, with or without nests shared with them", async () => {
    const s = await state(owner);
    expect(s.show).toBe(false);
    expect(s.first_run).toBe(false);
    expect(s.nest?.id).toBeDefined();
  });
});
