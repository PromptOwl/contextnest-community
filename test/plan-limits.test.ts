/**
 * Pricing plan limits (spec §3.3, §9.3): each person bills at their highest
 * role — owner/admin/reviewer = user, editor = subscriber, viewer = free —
 * and a role change that would pass the plan's cap is refused with 402
 * plan_limit. Joining is never refused; nothing already granted is removed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
type U = { apiKey: string; userId: string; email: string };
let owner: U, alice: U, bob: U, carol: U;
let nestId: string;
// Free: owner (Account Owner) + 2 nest owners fill a 3-user cap.
const entitlement: Record<string, any> = {
  plan: "free",
  maxUsers: 3,
  maxAccountOwners: 1,
  maxSubscribers: 0,
};

const newNest = (u: U, name: string) => jsonRequest(app, "POST", "/nests", { name }, u.apiKey);
const share = (email: string, permission: string) =>
  jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email, permission }, alice.apiKey);

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { ownerEmail: "owner@co.com", entitlement });
  owner = await registerUser(app, "owner@co.com");
  alice = await registerUser(app, "alice@co.com");
  await resetAuthRateLimit();
  bob = await registerUser(app, "bob@co.com");
  carol = await registerUser(app, "carol@co.com");
  const n = await newNest(alice, "Alice");
  expect(n.status).toBe(201);
  nestId = n.data.id ?? n.data.nest?.id;
});

afterAll(() => env.cleanup());

describe("plan limits at role grant", () => {
  it("counts a nest owner as a user and stops at the cap", async () => {
    expect((await newNest(bob, "Bob")).status).toBe(201); // user 3 of 3
    const res = await newNest(carol, "Carol");
    expect(res.status).toBe(402);
    expect(res.data).toMatchObject({ code: "plan_limit", limit: "users", max: 3 });
  });

  it("an existing user can own more nests without a new seat", async () => {
    expect((await newNest(alice, "Alice 2")).status).toBe(201);
  });

  it("viewers are free; Free has no editors", async () => {
    expect((await share("carol@co.com", "read")).status).toBe(201);
    const res = await share("dave@co.com", "write");
    expect(res.status).toBe(402);
    expect(res.data).toMatchObject({ code: "plan_limit", limit: "subscribers", max: 0 });
    expect(res.data.error).toMatch(/Editors need a paid plan/);
  });

  it("raising a viewer to admin or reviewer needs a user seat", async () => {
    const people = await jsonRequest(app, "GET", `/nests/${nestId}/collaborators`, undefined, alice.apiKey);
    const collab = (people.data.collaborators ?? people.data).find((c: any) => c.email === "carol@co.com");
    const res = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/collaborators/${collab.id}`, { permission: "admin" }, alice.apiKey,
    );
    expect(res.status).toBe(402);

    const steward = await jsonRequest(
      app, "POST", `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: "carol@co.com", role: "reviewer" }] }, alice.apiKey,
    );
    expect(steward.status).toBe(402);
  });

  it("paid subscriber seats let editors in, up to the count", async () => {
    entitlement.maxSubscribers = 1;
    expect((await share("erin@co.com", "write")).status).toBe(201);
    expect((await share("frank@co.com", "write")).status).toBe(402);
    entitlement.maxSubscribers = 0;
  });

  it("a team bills only once shared: sharing projects every member's role", async () => {
    const team = await jsonRequest(app, "POST", "/teams", { name: "Writers" }, alice.apiKey);
    const teamId = team.data.team.id;
    // Unshared, a team role reaches no nest, so it costs nothing.
    const add = await jsonRequest(
      app, "POST", `/teams/${teamId}/members`, { email: "gina@co.com", role: "editor" }, alice.apiKey,
    );
    expect(add.status).toBe(201);
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/teams`, { team_id: teamId }, alice.apiKey);
    expect(res.status).toBe(402);
    expect(res.data).toMatchObject({ code: "plan_limit", limit: "subscribers" });
  });

  it("Free has one Account Owner: no extra superadmins", async () => {
    const res = await jsonRequest(app, "POST", "/admin/super-admins", { email: "alice@co.com" }, owner.apiKey);
    expect(res.status).toBe(402);
    expect(res.data).toMatchObject({ code: "plan_limit", limit: "account_owners", max: 1 });
  });

  it("over the cap nothing is taken away, and demotions still work", async () => {
    entitlement.maxUsers = 1; // server now holds 3 users on a 1-user plan
    const people = await jsonRequest(app, "GET", `/nests/${nestId}/collaborators`, undefined, alice.apiKey);
    expect(people.status).toBe(200);
    const erin = (people.data.collaborators ?? people.data).find((c: any) => c.email === "erin@co.com");
    const demote = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/collaborators/${erin.id}`, { permission: "read" }, alice.apiKey,
    );
    expect(demote.status).toBe(200);
    expect((await newNest(carol, "Carol again")).status).toBe(402);
  });

  it("unlimited plans never check", async () => {
    Object.assign(entitlement, { plan: "enterprise", maxUsers: null, maxSubscribers: null, maxAccountOwners: null });
    expect((await newNest(carol, "Carol finally")).status).toBe(201);
    expect((await share("frank@co.com", "write")).status).toBe(201);
  });
});
