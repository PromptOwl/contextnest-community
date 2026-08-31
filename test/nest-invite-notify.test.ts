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
});
