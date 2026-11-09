/**
 * Team visibility follows the deployment kind.
 *
 * - Shared deployment (SHARED_DEPLOYMENT on: the PromptOwl-hosted server, many
 *   organizations on one install): a user sees only the teams they own or are
 *   a member of, and may share only a team they hold editor+ on.
 * - Single-organization deployment (SHARED_DEPLOYMENT off: self-hosted): the
 *   whole server is one company, so every team is listed and viewable, and a
 *   nest admin may share any team onto the nest. Managing a team (rename,
 *   members, roles) stays with its owner and admins on both.
 *
 * The MCP twin (context_nest_teams) lists, shares and unshares at REST parity.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

type U = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: U; // owns team "Finance" and nest "Alice's"
let bob: U; // owns nest "Bob's", is on no team
let carol: U; // viewer member of Finance
let financeId: string;
let aliceNest: string;
let bobNest: string;

beforeAll(async () => {
  env = setupTestEnv();
  delete process.env.SHARED_DEPLOYMENT;
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@scope.test", "Alice");
  await resetAuthRateLimit();
  bob = await registerUser(app, "bob@scope.test", "Bob");
  await resetAuthRateLimit();
  carol = await registerUser(app, "carol@scope.test", "Carol");
  await resetAuthRateLimit();
  financeId = (await jsonRequest(app, "POST", "/teams", { name: "Finance" }, alice.apiKey)).data.team.id;
  await jsonRequest(app, "POST", `/teams/${financeId}/members`, { user_id: carol.userId, role: "viewer" }, alice.apiKey);
  aliceNest = (await jsonRequest(app, "POST", "/nests", { name: "Alice's" }, alice.apiKey)).data.nest.id;
  bobNest = (await jsonRequest(app, "POST", "/nests", { name: "Bob's" }, bob.apiKey)).data.nest.id;
  await jsonRequest(app, "POST", `/nests/${bobNest}/nodes`, { title: "Bob doc", content: "# bob" }, bob.apiKey);
});

afterEach(async () => {
  delete process.env.SHARED_DEPLOYMENT;
  // Leave Bob's nest unshared between cases.
  await jsonRequest(app, "DELETE", `/nests/${bobNest}/teams/${financeId}`, undefined, bob.apiKey);
});

afterAll(() => env.cleanup());

const teamIds = async (u: U) =>
  ((await jsonRequest(app, "GET", "/teams", undefined, u.apiKey)).data.teams ?? []).map((t: any) => t.id);

describe("shared deployment: teams are scoped to the user", () => {
  it("GET /teams returns only teams the user owns or is a member of", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    expect(await teamIds(alice)).toContain(financeId);
    expect(await teamIds(carol)).toContain(financeId);
    expect(await teamIds(bob)).not.toContain(financeId);
  });

  it("a user who is not on a team cannot view it", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    expect((await jsonRequest(app, "GET", `/teams/${financeId}`, undefined, bob.apiKey)).status).toBe(403);
  });

  it("a nest admin who is not on the team cannot share it", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    const res = await jsonRequest(app, "POST", `/nests/${bobNest}/teams`, { team_id: financeId }, bob.apiKey);
    expect(res.status).toBe(403);
  });

  it("a view-only member cannot share the team onto a nest they own", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    const own = (await jsonRequest(app, "POST", "/nests", { name: "Carol shared" }, carol.apiKey)).data.nest.id;
    const res = await jsonRequest(app, "POST", `/nests/${own}/teams`, { team_id: financeId }, carol.apiKey);
    expect(res.status).toBe(403);
  });
});

describe("single-organization deployment: every team is visible", () => {
  it("GET /teams returns every team on the server", async () => {
    expect(await teamIds(bob)).toContain(financeId);
  });

  it("any signed-in user can view a team", async () => {
    const res = await jsonRequest(app, "GET", `/teams/${financeId}`, undefined, bob.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.team.name).toBe("Finance");
  });

  it("viewing a team does not let a non-member manage it", async () => {
    const rename = await jsonRequest(app, "PATCH", `/teams/${financeId}`, { name: "Hijacked" }, bob.apiKey);
    expect(rename.status).toBe(403);
  });

  it("a nest admin can share any team, and its members can then read the nest", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${bobNest}/teams`, { team_id: financeId }, bob.apiKey);
    expect(res.status).toBe(201);
    expect(res.data.teams.map((t: any) => t.teamId)).toContain(financeId);
    const read = await jsonRequest(app, "GET", `/nests/${bobNest}`, undefined, carol.apiKey);
    expect(read.status).toBe(200);
  });

  it("a user who is not a nest admin still cannot share a team onto it", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${aliceNest}/teams`, { team_id: financeId }, bob.apiKey);
    expect([403, 404]).toContain(res.status);
  });
});

// ─── MCP parity ──────────────────────────────────────────────────────────────

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function mcp(nestId: string, method: string, params: Record<string, unknown>, key: string): Promise<any> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : {};
}

const callTeams = async (nestId: string, args: Record<string, unknown>, key: string) => {
  const body = await mcp(nestId, "tools/call", { name: "context_nest_teams", arguments: args }, key);
  const text = body?.error?.message ?? (body?.result?.content ?? []).map((p: any) => p?.text ?? "").join("");
  return {
    isError: !!body?.result?.isError || !!body?.error,
    text,
    data: body?.result?.structuredContent,
  };
};

describe("MCP: context_nest_teams", () => {
  it("is advertised to the nest admin", async () => {
    const list = await mcp(bobNest, "tools/list", {}, bob.apiKey);
    expect((list?.result?.tools ?? []).map((t: any) => t.name)).toContain("context_nest_teams");
  });

  it("lists shared teams and the teams available to share", async () => {
    const r = await callTeams(bobNest, { action: "list" }, bob.apiKey);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Finance");
  });

  it("shares and unshares a team at REST parity", async () => {
    const shared = await callTeams(bobNest, { action: "share", team_id: financeId }, bob.apiKey);
    expect(shared.isError).toBe(false);
    const rest = await jsonRequest(app, "GET", `/nests/${bobNest}/teams`, undefined, bob.apiKey);
    expect(rest.data.teams.map((t: any) => t.teamId)).toContain(financeId);

    const unshared = await callTeams(bobNest, { action: "unshare", team_id: financeId }, bob.apiKey);
    expect(unshared.isError).toBe(false);
    const after = await jsonRequest(app, "GET", `/nests/${bobNest}/teams`, undefined, bob.apiKey);
    expect(after.data.teams.map((t: any) => t.teamId)).not.toContain(financeId);
  });

  it("refuses a share the REST route refuses (shared deployment, not on the team)", async () => {
    process.env.SHARED_DEPLOYMENT = "true";
    const r = await callTeams(bobNest, { action: "share", team_id: financeId }, bob.apiKey);
    expect(r.isError).toBe(true);
  });
});
