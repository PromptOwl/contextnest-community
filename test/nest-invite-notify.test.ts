/**
 * Nest invite → Hootie inbox row. Being added to a nest must land in the
 * invitee's /me inbox (kind 'nest_invite'), the same human-in-the-loop surface
 * review requests use — so the invite is visible in ContextNest Desktop, not
 * only as an external Slack/email ping.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let bob: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  bob = await registerUser(app, "bob@acme.com", "Bob");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Invite Nest" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

describe("nest invite inbox", () => {
  it("drops a nest_invite notification for the invitee", async () => {
    const invite = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "bob@acme.com", permission: "admin" },
      alice.apiKey,
    );
    expect(invite.status).toBe(201);

    const inbox = await jsonRequest(app, "GET", "/me/notifications", undefined, bob.apiKey);
    expect(inbox.status).toBe(200);
    const invited = inbox.data.notifications.find((n: any) => n.kind === "nest_invite");
    expect(invited).toBeTruthy();
    expect(invited.nest_id).toBe(nestId);
    expect(invited.message).toContain("Invite Nest");
    // User-facing role, never the raw permission token.
    expect(invited.message).toContain("Admin");
    expect(invited.message).not.toContain("as admin");
  });

  it("does not notify the granter about their own action", async () => {
    const inbox = await jsonRequest(app, "GET", "/me/notifications", undefined, alice.apiKey);
    expect(inbox.status).toBe(200);
    expect(inbox.data.notifications.find((n: any) => n.kind === "nest_invite")).toBeFalsy();
  });

  it("notifies team members when their team is granted access", async () => {
    const carol = await registerUser(app, "carol@acme.com", "Carol");
    const team = await jsonRequest(app, "POST", "/teams", { name: "Platform" }, alice.apiKey);
    expect(team.status).toBe(201);
    const teamId = team.data.team.id;
    await jsonRequest(
      app,
      "POST",
      `/teams/${teamId}/members`,
      { user_id: carol.userId, role: "viewer" },
      alice.apiKey,
    );
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Team Nest" }, alice.apiKey);
    const teamNestId = nest.data.nest.id;
    const share = await jsonRequest(
      app,
      "POST",
      `/nests/${teamNestId}/teams`,
      { team_id: teamId },
      alice.apiKey,
    );
    expect(share.status).toBe(201);

    const inbox = await jsonRequest(app, "GET", "/me/notifications", undefined, carol.apiKey);
    const shared = inbox.data.notifications.find(
      (n: any) => n.kind === "nest_invite" && n.nest_id === teamNestId,
    );
    expect(shared).toBeTruthy();
    // Names the team the access came through, the nest, and the role in
    // user-facing terms — not the raw permission token.
    expect(shared.message).toContain("Platform");
    expect(shared.message).toContain("Team Nest");
    expect(shared.message).toContain("Viewer");
    expect(shared.message).not.toContain("as read");

    // The sharer hears nothing about their own action.
    const own = await jsonRequest(app, "GET", "/me/notifications", undefined, alice.apiKey);
    expect(
      own.data.notifications.find(
        (n: any) => n.kind === "nest_invite" && n.nest_id === teamNestId,
      ),
    ).toBeFalsy();
  });
});
