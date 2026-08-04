/**
 * /me/drafts — the "my unsubmitted drafts" list.
 *
 * A draft that was never submitted has no review_requests row, so it appeared
 * in no queue and no inbox. Covers: it shows up for its author, it leaves the
 * list once submitted, it's scoped to the caller, and deleting the document
 * doesn't leave a ghost behind (node_versions rows outlive a node delete).
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
import { folderForNode } from "../src/governance/title-resolver.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let bob: { apiKey: string; userId: string; email: string };
let aliceNest: string;
let bobNest: string;

/** Stewardship on + owner as reviewer, so submit-review yields a PENDING
 *  request instead of an auto-approve. */
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

async function createDoc(
  owner: any,
  nestId: string,
  title: string,
  folder?: string,
) {
  const { data } = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title, content: `# ${title}\n\nbody`, folder },
    owner.apiKey,
  );
  return data.node.id as string;
}

const drafts = async (user: any) =>
  (await jsonRequest(app, "GET", "/me/drafts", undefined, user.apiKey)).data.drafts;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  bob = await registerUser(app, "bob@acme.com", "Bob");
  aliceNest = await governedNest(alice, "Alice Nest");
  bobNest = await governedNest(bob, "Bob Nest");
});

afterAll(() => env.cleanup());

it("lists an unsubmitted draft with its nest and folder", async () => {
  await createDoc(alice, aliceNest, "Cohere Kill Sheet", "gtm");
  const list = await drafts(alice);
  const row = list.find((d: any) => d.title === "Cohere Kill Sheet");
  expect(row).toBeTruthy();
  expect(row.nest_id).toBe(aliceNest);
  expect(row.status).toBe("draft");
  expect(row.folder).toBe("gtm");
  // The submit dialog names the version it's about to send.
  expect(row.version).toBeGreaterThan(0);
});

it("drops out of the list once submitted for review", async () => {
  const nodeId = await createDoc(alice, aliceNest, "Ready Doc");
  expect((await drafts(alice)).some((d: any) => d.node_id === nodeId)).toBe(true);

  await jsonRequest(
    app,
    "POST",
    `/nests/${aliceNest}/nodes/${nodeId}/submit-review`,
    { note: "please review" },
    alice.apiKey,
  );

  expect((await drafts(alice)).some((d: any) => d.node_id === nodeId)).toBe(false);
  // It moved to the inbox's "waiting on others" bucket, not nowhere.
  const { data } = await jsonRequest(app, "GET", "/me/work", undefined, alice.apiKey);
  expect(data.waiting.some((w: any) => w.node_id === nodeId)).toBe(true);
});

it("never leaks another user's drafts", async () => {
  await createDoc(bob, bobNest, "Bob Secret Draft");
  const aliceList = await drafts(alice);
  expect(aliceList.some((d: any) => d.nest_id === bobNest)).toBe(false);
  const bobList = await drafts(bob);
  expect(bobList.some((d: any) => d.title === "Bob Secret Draft")).toBe(true);
  expect(bobList.some((d: any) => d.nest_id === aliceNest)).toBe(false);
});

it("paginates with limit/offset/has_more", async () => {
  await createDoc(alice, aliceNest, "Page Filler One");
  await createDoc(alice, aliceNest, "Page Filler Two");
  const all = await drafts(alice);
  expect(all.length).toBeGreaterThan(1);

  const p1 = await jsonRequest(app, "GET", "/me/drafts?limit=1&offset=0", undefined, alice.apiKey);
  expect(p1.status).toBe(200);
  expect(p1.data.drafts.length).toBe(1);
  expect(p1.data.pagination).toMatchObject({ total: all.length, limit: 1, offset: 0, has_more: true });

  const p2 = await jsonRequest(app, "GET", "/me/drafts?limit=1&offset=1", undefined, alice.apiKey);
  expect(p2.data.drafts.length).toBe(1);
  expect(p2.data.drafts[0].node_id).not.toBe(p1.data.drafts[0].node_id);

  // Last page reports no more.
  const last = await jsonRequest(
    app,
    "GET",
    `/me/drafts?limit=1&offset=${all.length - 1}`,
    undefined,
    alice.apiKey,
  );
  expect(last.data.pagination.has_more).toBe(false);
});

it("exposes the same list over MCP as context_my_drafts", async () => {
  const res = await app.request(`/nests/${aliceNest}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${alice.apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_my_drafts", arguments: {} },
    }),
  });
  const body = await res.json();
  const text = (body.result?.content || []).map((c: any) => c.text).join("");
  expect(text).toContain("Cohere Kill Sheet");
  // Submitted docs are not drafts — the same rule the REST list applies.
  expect(text).not.toContain("Ready Doc");
  // Bob's nest is a different nest; this tool is nest-scoped.
  expect(text).not.toContain("Bob Secret Draft");
});

it("strips an imported vault's id prefix from the folder path", () => {
  // Imported vaults carry "<nestId>/nodes/…" ids; the folder used to render as
  // a raw uuid path ("b006e456-…/nodes/partners") in the drafts list.
  expect(folderForNode("b006e456-15de/nodes/partners/tsd-outreach")).toBe("partners");
  expect(folderForNode("nodes/gtm/cohere")).toBe("gtm");
  expect(folderForNode("nodes/cohere")).toBe("");
});

it("leaves no ghost behind when the draft is deleted", async () => {
  const nodeId = await createDoc(alice, aliceNest, "Throwaway");
  expect((await drafts(alice)).some((d: any) => d.node_id === nodeId)).toBe(true);

  await jsonRequest(
    app,
    "DELETE",
    `/nests/${aliceNest}/nodes/${nodeId}`,
    undefined,
    alice.apiKey,
  );
  expect((await drafts(alice)).some((d: any) => d.node_id === nodeId)).toBe(false);
});
