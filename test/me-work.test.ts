/**
 * /me/work — cross-nest inbox: visible-nest scoping + pagination.
 *
 * Covers the access-control-adjacent changes:
 *  - the queue is scoped to the caller's visible nests (listVisibleNests +
 *    getReviewQueue's nestIds filter), so another user's pending reviews never
 *    leak in;
 *  - the limit/offset/has_more pagination contract.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let bob: { apiKey: string; userId: string; email: string };
let aliceNest: string;
let bobNest: string;

/** Enable stewardship + make the owner a nest reviewer so submit-review
 *  produces a PENDING request (not an auto-approve). */
async function governedNest(owner: any, name: string): Promise<string> {
  const { data } = await jsonRequest(app, "POST", "/nests", { name }, owner.apiKey);
  const nestId = data.nest.id;
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true },
    owner.apiKey,
  );
  const nestPath = join(env.dataDir, "nests", nestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(
    join(nestPath, "stewards.yaml"),
    `version: 1\nnest:\n  - email: ${owner.email}, role: reviewer, can_approve: true\n`,
  );
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);
  return nestId;
}

async function submitDoc(owner: any, nestId: string, slug: string) {
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: slug, content: `# ${slug}\n\nbody` },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/nodes/${slug}/submit-review`,
    { note: "please review" },
    owner.apiKey,
  );
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  bob = await registerUser(app, "bob@acme.com", "Bob");

  aliceNest = await governedNest(alice, "Alice Nest");
  bobNest = await governedNest(bob, "Bob Nest");

  // Alice submits 3 docs (all pending, waiting on her own review).
  for (const slug of ["a-one", "a-two", "a-three"]) await submitDoc(alice, aliceNest, slug);
  // Bob submits one in HIS nest — must never appear in Alice's inbox.
  await submitDoc(bob, bobNest, "b-one");
});

afterAll(() => env.cleanup());

it("scopes the inbox to the caller's visible nests", async () => {
  const { status, data } = await jsonRequest(app, "GET", "/me/work", undefined, alice.apiKey);
  expect(status).toBe(200);
  // Alice submitted them, so they land in "waiting" (she asked), not "items".
  const all = [...data.items, ...data.waiting];
  expect(all.every((w: any) => w.nest_id === aliceNest)).toBe(true);
  // Bob's nest review is invisible to Alice.
  expect(all.some((w: any) => w.nest_id === bobNest)).toBe(false);
  expect(data.pagination.total).toBe(3);
});

it("paginates with limit/offset/has_more", async () => {
  const p1 = await jsonRequest(app, "GET", "/me/work?limit=2&offset=0", undefined, alice.apiKey);
  expect(p1.status).toBe(200);
  expect(p1.data.pagination).toMatchObject({ total: 3, limit: 2, offset: 0, has_more: true });
  expect(p1.data.items.length + p1.data.waiting.length).toBe(2);

  const p2 = await jsonRequest(app, "GET", "/me/work?limit=2&offset=2", undefined, alice.apiKey);
  expect(p2.data.pagination).toMatchObject({ total: 3, limit: 2, offset: 2, has_more: false });
  expect(p2.data.items.length + p2.data.waiting.length).toBe(1);
});

it("bob sees only his own nest's review", async () => {
  const { data } = await jsonRequest(app, "GET", "/me/work", undefined, bob.apiKey);
  const all = [...data.items, ...data.waiting];
  expect(all.length).toBe(1);
  expect(all[0].nest_id).toBe(bobNest);
});

it("hides approve-inbox items from an editor, shows them to a reviewer", async () => {
  // Only ONE fresh registration — /auth/register is rate-limited to 3/hr/IP and
  // beforeAll already spent 2 (alice, bob). Reuse bob as the reviewer.
  const carol = await registerUser(app, "carol@acme.com", "Carol"); // editor
  const nestId = await governedNest(alice, "Shared Nest");
  // Re-sync stewards: alice reviewer (owner), carol editor, bob reviewer.
  const nestPath = join(env.dataDir, "nests", nestId);
  writeFileSync(
    join(nestPath, "stewards.yaml"),
    `version: 1\nnest:\n  - email: ${alice.email}, role: reviewer\n` +
      `  - email: ${carol.email}, role: editor\n` +
      `  - email: ${bob.email}, role: reviewer\n`,
  );
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, alice.apiKey);
  await submitDoc(alice, nestId, "shared-doc"); // alice requests → pending

  const carolWork = await jsonRequest(app, "GET", "/me/work", undefined, carol.apiKey);
  const bobWork = await jsonRequest(app, "GET", "/me/work", undefined, bob.apiKey);

  // Editor can't approve → the pending review must NOT be in her actionable items.
  expect(carolWork.data.items.some((w: any) => w.nest_id === nestId)).toBe(false);
  // Reviewer can approve → it shows in his items.
  expect(bobWork.data.items.some((w: any) => w.nest_id === nestId)).toBe(true);

  // Belt-and-braces: the server hard-blocks an editor's approve attempt too.
  const approve = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/nodes/shared-doc/approve`,
    {},
    carol.apiKey,
  );
  expect(approve.status).toBe(403);
});

it("bare owner sees the inbox item only when self-approve is on", async () => {
  // Owner with NO reviewer/admin steward role. canUserApprove gates such an
  // owner behind allow_self_approve: OFF → approvals go to reviewers (owner
  // can't approve → item must be hidden); ON → owner can approve → item shows.
  // Guards the regression where a pure role check (canApproveWith) treated
  // "owner" as always approve-capable and put a dead button back in front of
  // owners who delegated approval. Both nests are read in ONE /me/work call so
  // the 30s approve-cache can't make the two assertions race.
  const mkNest = async (name: string, selfApprove: boolean) => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name }, alice.apiKey);
    const id = data.nest.id;
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${id}/settings`,
      { stewardship_enabled: true, allow_self_approve: selfApprove },
      alice.apiKey,
    );
    // bob as EDITOR submits; alice (owner) holds no reviewer/admin role.
    const p = join(env.dataDir, "nests", id);
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "stewards.yaml"),
      `version: 1\nnest:\n  - email: ${bob.email}, role: editor\n`,
    );
    await jsonRequest(app, "POST", `/nests/${id}/stewards/sync`, {}, alice.apiKey);
    return id;
  };
  const offNest = await mkNest("SA Off", false);
  const onNest = await mkNest("SA On", true);
  await submitDoc(bob, offNest, "off-doc"); // requestedBy = bob, not alice
  await submitDoc(bob, onNest, "on-doc");

  const { data } = await jsonRequest(app, "GET", "/me/work", undefined, alice.apiKey);
  // Bare owner, self-approve OFF → hidden (approving it would 403).
  expect(data.items.some((w: any) => w.nest_id === offNest)).toBe(false);
  // Bare owner, self-approve ON → shown.
  expect(data.items.some((w: any) => w.nest_id === onNest)).toBe(true);
});

it("a review verdict notification carries the document it is about", async () => {
  // The inbox links to the referenced document; subject_id is the review id,
  // so the node has to be resolved from review_requests on the read.
  const nestId = await governedNest(alice, "Verdict Nest");
  writeFileSync(
    join(env.dataDir, "nests", nestId, "stewards.yaml"),
    `version: 1\nnest:\n  - email: ${alice.email}, role: editor\n` +
      `  - email: ${bob.email}, role: reviewer, can_approve: true\n`,
  );
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, alice.apiKey);
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: bob.email, permission: "write" },
    alice.apiKey,
  );
  await submitDoc(alice, nestId, "verdict-doc");
  const approve = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/nodes/verdict-doc/approve`,
    {},
    bob.apiKey,
  );
  expect(approve.status).toBe(200);

  const inbox = await jsonRequest(app, "GET", "/me/notifications", undefined, alice.apiKey);
  const verdict = inbox.data.notifications.find(
    (n: any) => n.kind === "review_approved" && n.nest_id === nestId,
  );
  expect(verdict).toBeTruthy();
  expect(verdict.node_id).toBe("nodes/verdict-doc");
});
