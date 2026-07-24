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
