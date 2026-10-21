/**
 * Billing confirmation (pricing spec v21, CU-wdqcq04t06): a role change that
 * raises someone's billed class (viewer → editor → user) is refused with 409
 * billing_confirm until the caller confirms — X-Confirm-Billing on REST,
 * confirm_billing on MCP. Demotions, viewers and your own new nest never ask.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, resetAuthRateLimit } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
type U = { apiKey: string; userId: string; email: string };
let owner: U, alice: U, bob: U, carol: U, dan: U, erin: U, fay: U, hank: U, ivy: U;
let nestId: string;
// Unlimited, so only the confirmation gate is in play (plan caps: plan-limits.test.ts).
const entitlement: Record<string, any> = {
  plan: "enterprise",
  maxUsers: null,
  maxAccountOwners: null,
  maxSubscribers: null,
};

/** jsonRequest always confirms; this sends the header only when asked. */
async function req(method: string, path: string, body: unknown, u: U, confirm = false) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${u.apiKey}` };
  if (confirm) headers["X-Confirm-Billing"] = "true";
  const res = await app.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

/** Refused without the header, saved with it; returns the confirmed response. */
async function confirmRequired(method: string, path: string, body: unknown, u: U, change: Record<string, unknown>) {
  const refused = await req(method, path, body, u);
  expect(refused.status).toBe(409);
  expect(refused.data.code).toBe("billing_confirm");
  expect(refused.data.changes).toEqual([expect.objectContaining(change)]);
  const saved = await req(method, path, body, u, true);
  expect(saved.status).toBeLessThan(300);
  return saved;
}

async function mcp(apiKey: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  return body.result as { content: { text: string }[]; structuredContent?: any; isError?: boolean };
}

const collabId = async (email: string) => {
  const people = await req("GET", `/nests/${nestId}/collaborators`, undefined, alice);
  return (people.data.collaborators ?? people.data).find((c: any) => c.email === email).id;
};

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { ownerEmail: "owner@co.com", entitlement });
  owner = await registerUser(app, "owner@co.com");
  alice = await registerUser(app, "alice@co.com");
  bob = await registerUser(app, "bob@co.com");
  await resetAuthRateLimit();
  carol = await registerUser(app, "carol@co.com");
  dan = await registerUser(app, "dan@co.com");
  erin = await registerUser(app, "erin@co.com");
  await resetAuthRateLimit();
  fay = await registerUser(app, "fay@co.com");
  hank = await registerUser(app, "hank@co.com");
  ivy = await registerUser(app, "ivy@co.com");
  const n = await req("POST", "/nests", { name: "Alice" }, alice);
  expect(n.status).toBe(201);
  nestId = n.data.id ?? n.data.nest?.id;
});

afterAll(() => env.cleanup());

describe("billing confirmation on a raise", () => {
  it("creating your own nest never asks (plan cap only)", async () => {
    expect((await req("POST", "/nests", { name: "Bob" }, bob)).status).toBe(201);
  });

  it("adding a viewer is free, so it never asks", async () => {
    expect((await req("POST", `/nests/${nestId}/collaborators`, { email: carol.email, permission: "read" }, alice)).status).toBe(201);
  });

  it("collaborator invite: write bills as an editor", async () => {
    const res = await req("POST", `/nests/${nestId}/collaborators`, { email: erin.email, permission: "write" }, alice);
    expect(res.status).toBe(409);
    expect(res.data.changes).toEqual([{ userId: erin.userId, email: erin.email, from: "viewer", to: "subscriber" }]);
    expect((await req("POST", `/nests/${nestId}/collaborators`, { email: erin.email, permission: "write" }, alice, true)).status).toBe(201);
  });

  it("collaborator role change: viewer → editor, then editor → admin, each confirmed", async () => {
    const id = await collabId(carol.email);
    await confirmRequired("PATCH", `/nests/${nestId}/collaborators/${id}`, { permission: "write" }, alice, {
      from: "viewer",
      to: "subscriber",
    });
    await confirmRequired("PATCH", `/nests/${nestId}/collaborators/${id}`, { permission: "admin" }, alice, {
      email: carol.email,
      from: "subscriber",
      to: "user",
    });
  });

  it("a demotion or same-class change never asks", async () => {
    const id = await collabId(carol.email);
    expect((await req("PATCH", `/nests/${nestId}/collaborators/${id}`, { permission: "read" }, alice)).status).toBe(200);
  });

  it("steward: a reviewer bills as a user", async () => {
    await confirmRequired(
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: dan.email, role: "reviewer" }] },
      alice,
      { email: dan.email, from: "viewer", to: "user" },
    );
  });

  it("document grant: write bills as an editor", async () => {
    await confirmRequired(
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "folder", target: "nodes/gtm", email: fay.email, role: "write" },
      alice,
      { email: fay.email, from: "viewer", to: "subscriber" },
    );
  });

  it("team: sharing onto a nest raises every member it moves up", async () => {
    const team = await req("POST", "/teams", { name: "Writers" }, alice, true);
    const teamId = team.data.team.id;
    // Unshared, a team role reaches no nest: nothing to confirm.
    const add = await req("POST", `/teams/${teamId}/members`, { email: "gina@co.com", role: "editor" }, alice);
    expect(add.status).toBe(201);
    await confirmRequired("POST", `/nests/${nestId}/teams`, { team_id: teamId }, alice, {
      email: "gina@co.com",
      from: "viewer",
      to: "subscriber",
    });
  });

  it("superadmin: a new Account Owner bills as a user", async () => {

    await confirmRequired("POST", "/admin/super-admins", { email: hank.email }, owner, {
      email: hank.email,
      from: "viewer",
      to: "user",
    });
  });

  it("access request: approving write raises the requester", async () => {

    expect((await req("POST", `/nests/${nestId}/collaborators`, { email: ivy.email, permission: "read" }, alice)).status).toBe(201);
    const filed = await req("POST", `/nests/${nestId}/access-requests`, { target_type: "nest", level: "write" }, ivy);
    expect(filed.status).toBe(201);
    await confirmRequired("POST", `/nests/${nestId}/access-requests/${filed.data.request.id}/approve`, {}, alice, {
      email: ivy.email,
      from: "viewer",
      to: "subscriber",
    });
  });

  it("MCP: the tool names the change, and confirm_billing saves it", async () => {
    const refused = await mcp(alice.apiKey, "context_share_nest", { email: "jo@co.com", permission: "write" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/jo@co\.com \(viewer → editor\).*confirm_billing: true/);
    expect(refused.structuredContent).toMatchObject({ code: "BILLING_CONFIRMATION_REQUIRED" });
    const saved = await mcp(alice.apiKey, "context_share_nest", {
      email: "jo@co.com",
      permission: "write",
      confirm_billing: true,
    });
    expect(saved.isError).toBeFalsy();
    expect(saved.content[0].text).toMatch(/as editor/);
  });

  it("a plan that has no room refuses (402) before asking", async () => {
    Object.assign(entitlement, { plan: "free", maxUsers: 100, maxAccountOwners: 1, maxSubscribers: 0 });
    const res = await req("POST", `/nests/${nestId}/collaborators`, { email: "kim@co.com", permission: "write" }, alice);
    expect(res.status).toBe(402);
    expect(res.data.code).toBe("plan_limit");
  });
});
