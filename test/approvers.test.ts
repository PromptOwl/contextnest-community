/**
 * GET /nodes/:id/approvers — who besides the caller could approve the
 * caller's submission (CU-wdqcq02t1r). The list must be exactly what the
 * approve gate allows: the submitter never appears, a reviewer steward and the
 * owner do, an editor doesn't, and a solo owner with self-approve off learns
 * that nobody can.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let alice: User;
let rex: User;
let outsider: User;
let nestId: string;

async function approvers(caller: User, nest: string, id: string) {
  return jsonRequest(app, "GET", `/nests/${nest}/nodes/${id}/approvers`, undefined, caller.apiKey);
}

const emails = (data: any) => data.approvers.map((a: any) => a.email).sort();

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  rex = await registerUser(app, "rex@acme.com", "Rex");
  await resetAuthRateLimit(); // REGISTER_LIMIT is 3 per IP
  outsider = await registerUser(app, "eve@acme.com", "Eve");

  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Nest" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
  for (const [u, role] of [[alice, "editor"], [rex, "reviewer"]] as const) {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: u.email, role }] },
      owner.apiKey,
    );
    expect(r.status).toBe(201);
  }
  const doc = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "plan", content: "v1" }, alice.apiKey);
  expect(doc.status).toBe(201);
  const submit = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/nodes/plan/submit-review`, {}, alice.apiKey);
  expect(submit.status).toBe(201);
});

afterAll(() => env.cleanup());

describe("GET /approvers", () => {
  it("lists the reviewer for an editor's submission — not the submitter, not a bare owner", async () => {
    // A bare owner approves only while self-approve is on (decideApproval).
    const { status, data } = await approvers(alice, nestId, "nodes/plan");
    expect(status).toBe(200);
    expect(data.approvers).toEqual([{ email: rex.email, name: "Rex" }]);
    // Well under the candidate cap, so the list is complete.
    expect(data.truncated).toBe(false);
  });

  it("is computed for the caller as submitter: the reviewer asking hears nobody else can", async () => {
    const { data } = await approvers(rex, nestId, "nodes/plan");
    expect(data.approvers).toEqual([]);
  });

  it("includes the owner once the nest allows self-approve", async () => {
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { allow_self_approve: true }, owner.apiKey);
    try {
      const { data } = await approvers(alice, nestId, "nodes/plan");
      expect(emails(data)).toEqual([owner.email, rex.email]);
    } finally {
      await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { allow_self_approve: false }, owner.apiKey);
    }
  });

  it("is empty for a solo owner with self-approve off — nobody else can approve", async () => {
    const solo = await jsonRequest(app, "POST", "/nests", { name: "Solo" }, owner.apiKey);
    const soloId = solo.data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${soloId}/settings`, { stewardship_enabled: true }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${soloId}/nodes`, { title: "mine", content: "v1" }, owner.apiKey);
    const { status, data } = await approvers(owner, soloId, "nodes/mine");
    expect(status).toBe(200);
    expect(data.approvers).toEqual([]);
  });

  it("refuses someone who is not on the nest", async () => {
    const { status } = await approvers(outsider, nestId, "nodes/plan");
    expect(status).toBeGreaterThanOrEqual(400);
  });
});
