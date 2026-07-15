/**
 * Teams: a reusable, owner-managed group whose members each carry a role. A
 * team shared onto a nest grants every member their own role there. Covers
 * team CRUD + membership, sharing, the access resolution (per-member role,
 * highest-wins when combined with a direct collaborator grant), cascade
 * revocation on member removal / team deletion, and the sharing gate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
let viewerU: { apiKey: string; userId: string; email: string };
let editorU: { apiKey: string; userId: string; email: string };
let adminU: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let nestId: string;
let teamId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  // REGISTER_LIMIT is 3 per IP — clear the bucket between registrations.
  owner = await registerUser(app, "owner@acme.com", "Owner");
  await resetAuthRateLimit();
  viewerU = await registerUser(app, "viewer@acme.com", "Viewer");
  await resetAuthRateLimit();
  editorU = await registerUser(app, "editor@acme.com", "Editor");
  await resetAuthRateLimit();
  adminU = await registerUser(app, "admin@acme.com", "Admin");
  await resetAuthRateLimit();
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");
  await resetAuthRateLimit();
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Private" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Doc One", content: "# one" }, owner.apiKey);
});

afterAll(() => env.cleanup());

describe("team CRUD + membership", () => {
  it("owner creates a team", async () => {
    const res = await jsonRequest(app, "POST", "/teams", { name: "Platform" }, owner.apiKey);
    expect(res.status).toBe(201);
    expect(res.data.team.name).toBe("Platform");
    expect(res.data.team.members).toEqual([]);
    teamId = res.data.team.id;
  });

  it("adds members with per-member roles", async () => {
    for (const [u, role] of [
      [viewerU, "viewer"],
      [editorU, "editor"],
      [adminU, "admin"],
    ] as const) {
      const res = await jsonRequest(app, "POST", `/teams/${teamId}/members`, { user_id: u.userId, role }, owner.apiKey);
      expect(res.status).toBe(201);
    }
    const team = await jsonRequest(app, "GET", `/teams/${teamId}`, undefined, owner.apiKey);
    expect(team.data.team.members).toHaveLength(3);
    expect(team.data.team.members.find((m: any) => m.userId === editorU.userId).role).toBe("editor");
  });

  it("flags member registration status and owner email", async () => {
    // Registered user (has an account) vs an invited placeholder email.
    await jsonRequest(app, "POST", `/teams/${teamId}/members`, { email: "ghost@acme.com", role: "viewer" }, owner.apiKey);
    const team = (await jsonRequest(app, "GET", `/teams/${teamId}`, undefined, owner.apiKey)).data.team;
    expect(team.owner_email).toBe(owner.email);
    expect(team.members.find((m: any) => m.userId === viewerU.userId).registered).toBe(true);
    expect(team.members.find((m: any) => m.email === "ghost@acme.com").registered).toBe(false);
    // cleanup so later member-count assertions stay stable
    const ghost = team.members.find((m: any) => m.email === "ghost@acme.com");
    await jsonRequest(app, "DELETE", `/teams/${teamId}/members/${ghost.userId}`, undefined, owner.apiKey);
  });

  it("rejects an invalid role", async () => {
    const res = await jsonRequest(app, "POST", `/teams/${teamId}/members`, { user_id: outsider.userId, role: "owner" }, owner.apiKey);
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate member", async () => {
    const res = await jsonRequest(app, "POST", `/teams/${teamId}/members`, { user_id: viewerU.userId, role: "editor" }, owner.apiKey);
    expect(res.status).toBe(409);
  });

  it("a viewer member cannot add people", async () => {
    const res = await jsonRequest(app, "POST", `/teams/${teamId}/members`, { user_id: outsider.userId, role: "viewer" }, viewerU.apiKey);
    expect(res.status).toBe(403);
  });

  it("an editor member can add people, capped to their own level", async () => {
    // editor can add up to editor...
    const ok = await jsonRequest(app, "POST", `/teams/${teamId}/members`, { email: "capguest@acme.com", role: "editor" }, editorU.apiKey);
    expect(ok.status).toBe(201);
    // ...but not above it (admin)
    const denied = await jsonRequest(app, "POST", `/teams/${teamId}/members`, { email: "capadmin@acme.com", role: "admin" }, editorU.apiKey);
    expect(denied.status).toBe(403);
    // editors can't remove — the owner cleans up so member counts stay stable
    const team = (await jsonRequest(app, "GET", `/teams/${teamId}`, undefined, owner.apiKey)).data.team;
    const added = team.members.find((m: any) => m.email === "capguest@acme.com");
    await jsonRequest(app, "DELETE", `/teams/${teamId}/members/${added.userId}`, undefined, owner.apiKey);
  });

  it("ignores a caller-supplied email when user_id is given (no spoofing)", async () => {
    // Adding by user_id with a bogus email must store the account's real
    // address — otherwise the roster would display a forged identity.
    const res = await jsonRequest(app, "POST", `/teams/${teamId}/members`, { user_id: outsider.userId, email: "ceo@acme.com", role: "viewer" }, owner.apiKey);
    expect(res.status).toBe(201);
    const member = res.data.team.members.find((m: any) => m.userId === outsider.userId);
    expect(member.email).toBe(outsider.email);
    expect(res.data.team.members.some((m: any) => m.email === "ceo@acme.com")).toBe(false);
    // cleanup so later member-count assertions stay stable
    await jsonRequest(app, "DELETE", `/teams/${teamId}/members/${outsider.userId}`, undefined, owner.apiKey);
  });

  it("a non-admin member cannot rename the team or change roles", async () => {
    const rename = await jsonRequest(app, "PATCH", `/teams/${teamId}`, { name: "Hijacked" }, editorU.apiKey);
    expect(rename.status).toBe(403);
    const role = await jsonRequest(app, "PATCH", `/teams/${teamId}/members/${viewerU.userId}`, { role: "admin" }, editorU.apiKey);
    expect(role.status).toBe(403);
  });

  it("lists teams the caller owns or is a member of", async () => {
    // owner sees it because they own it; a member sees it because they're on it
    const asOwner = await jsonRequest(app, "GET", "/teams", undefined, owner.apiKey);
    expect(asOwner.data.teams.map((t: any) => t.id)).toContain(teamId);
    const asMember = await jsonRequest(app, "GET", "/teams", undefined, viewerU.apiKey);
    expect(asMember.data.teams.map((t: any) => t.id)).toContain(teamId);
  });

  it("a member may view the team, an outsider may not", async () => {
    expect((await jsonRequest(app, "GET", `/teams/${teamId}`, undefined, viewerU.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/teams/${teamId}`, undefined, outsider.apiKey)).status).toBe(403);
  });
});

describe("sharing a team onto a nest", () => {
  it("owner shares the team", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/teams`, { team_id: teamId }, owner.apiKey);
    expect(res.status).toBe(201);
    expect(res.data.teams.map((t: any) => t.teamId)).toContain(teamId);
  });

  it("is idempotent-guarded (re-share conflicts)", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/teams`, { team_id: teamId }, owner.apiKey);
    expect(res.status).toBe(409);
  });

  it("lists shared teams with members", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/teams`, undefined, owner.apiKey);
    const t = res.data.teams.find((x: any) => x.teamId === teamId);
    expect(t.members).toHaveLength(3);
  });

  it("a nest admin cannot share a team they have no relationship to", async () => {
    // outsider owns a team; owner administers the nest but isn't on that team.
    // Nest-admin alone must not be enough to attach someone else's team (it
    // would pull in their members and expose the roster via GET .../teams).
    const foreign = await jsonRequest(app, "POST", "/teams", { name: "Foreign" }, outsider.apiKey);
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/teams`, { team_id: foreign.data.team.id }, owner.apiKey);
    expect(res.status).toBe(403);
  });

  it("a non-admin cannot share a team", async () => {
    // viewerU reaches the nest via the team (read), but sharing is admin-tier.
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/teams`, { team_id: teamId }, viewerU.apiKey);
    expect([403, 404]).toContain(res.status);
  });
});

describe("access resolution via team membership", () => {
  it("viewer member reads but cannot write", async () => {
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, viewerU.apiKey)).status).toBe(200);
    const write = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "V", content: "# v" }, viewerU.apiKey);
    expect(write.status).toBe(403);
  });

  it("editor member can write", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "By Editor", content: "# e" }, editorU.apiKey);
    expect(res.status).toBe(201);
  });

  it("admin member can perform an admin action (change visibility)", async () => {
    const res = await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public" }, adminU.apiKey);
    expect(res.status).toBe(200);
    // restore
    await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "private" }, owner.apiKey);
  });

  it("a team member sees the shared nest in their dashboard list with their role", async () => {
    const res = await jsonRequest(app, "GET", "/nests", undefined, viewerU.apiKey);
    const nests = (res.data.nests ?? []) as any[];
    const card = nests.find((n) => n.id === nestId);
    expect(card).toBeTruthy();
    expect(card.permission).toBe("read");
    expect(card.roles).toContain("viewer");
  });

  it("outsider has no access", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, outsider.apiKey);
    expect([403, 404]).toContain(res.status);
  });

  it("highest-wins: read collaborator + editor via team resolves to write", async () => {
    // outsider is a read-only direct collaborator...
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { user_id: outsider.userId, permission: "read" }, owner.apiKey);
    let write = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "O1", content: "# o" }, outsider.apiKey);
    expect(write.status).toBe(403);
    // ...and also an editor member of a shared team → write wins.
    const t2 = await jsonRequest(app, "POST", "/teams", { name: "Extra" }, owner.apiKey);
    await jsonRequest(app, "POST", `/teams/${t2.data.team.id}/members`, { user_id: outsider.userId, role: "editor" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/teams`, { team_id: t2.data.team.id }, owner.apiKey);
    write = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "O2", content: "# o2" }, outsider.apiKey);
    expect(write.status).toBe(201);
  });
});

describe("cascade revocation + rename", () => {
  it("removing a member revokes their access immediately", async () => {
    const before = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "E-before", content: "# x" }, editorU.apiKey);
    expect(before.status).toBe(201);
    const rm = await jsonRequest(app, "DELETE", `/teams/${teamId}/members/${editorU.userId}`, undefined, owner.apiKey);
    expect(rm.status).toBe(200);
    const after = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "E-after", content: "# x" }, editorU.apiKey);
    // Zero remaining access → the nest is hidden entirely (404), not merely
    // forbidden (403). Either proves the write path is revoked.
    expect([403, 404]).toContain(after.status);
  });

  it("renaming a team is reflected in the nest's shared-team list", async () => {
    await jsonRequest(app, "PATCH", `/teams/${teamId}`, { name: "Platform Core" }, owner.apiKey);
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/teams`, undefined, owner.apiKey);
    const t = res.data.teams.find((x: any) => x.teamId === teamId);
    expect(t.teamName).toBe("Platform Core");
  });

  it("deleting a team removes the share and revokes access", async () => {
    // adminU's admin access comes solely from this team.
    const del = await jsonRequest(app, "DELETE", `/teams/${teamId}`, undefined, owner.apiKey);
    expect(del.status).toBe(200);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/teams`, undefined, owner.apiKey);
    expect(list.data.teams.map((t: any) => t.teamId)).not.toContain(teamId);
    const act = await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public" }, adminU.apiKey);
    expect([403, 404]).toContain(act.status);
  });
});
