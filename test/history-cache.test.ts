/**
 * Every approval publishes, and every publish seals a checkpoint that reads
 * every document's history. `withHistoryCache` (src/nodes/engine.ts) memoizes
 * that read. The risk is a checkpoint sealed from a stale history, so these
 * check the sealed chain hashes against a fresh read from disk.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { NestStorage, publishDocument, serializeDocument, withVaultLock } from "@promptowl/contextnest-engine";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, settleSeals } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
beforeEach(() => {
  env = setupTestEnv();
});
afterEach(() => env.cleanup());

/** A stewarded nest with an author and a reviewer, plus doc helpers. */
async function setup() {
  const app = await createTestApp("key");
  const owner = await registerUser(app, "owner@acme.com");
  const author = await registerUser(app, "author@acme.com");
  const reviewer = await registerUser(app, "reviewer@acme.com");
  const nestId = (await jsonRequest(app, "POST", "/nests", { name: "Hist" }, owner.apiKey)).data.nest.id;
  const call = (method: string, path: string, body: unknown, key: string) =>
    jsonRequest(app, method, `/nests/${nestId}${path}`, body, key);
  await call("PATCH", "/settings", { stewardship_enabled: true }, owner.apiKey);
  await call("POST", "/collaborators", { email: author.email, permission: "write" }, owner.apiKey);
  await call("POST", "/collaborators", { email: reviewer.email, permission: "read" }, owner.apiKey);
  await call("POST", "/stewards", { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] }, owner.apiKey);

  const create = async (title: string) =>
    (await call("POST", "/nodes", { title, content: `# ${title}` }, author.apiKey)).data.node.id as string;
  const approve = async (id: string) => {
    expect((await call("POST", `/nodes/${id}/submit-review`, { note: "r" }, author.apiKey)).status).toBeLessThan(300);
    expect((await call("POST", `/nodes/${id}/approve`, {}, reviewer.apiKey)).status).toBe(200);
  };
  const edit = (id: string, content: string) => call("PATCH", `/nodes/${id}`, { content }, author.apiKey);

  const { engineCache } = await import("../src/nodes/engine.js");
  const { resolveNestPath } = await import("../src/nests/service.js");
  const { storage } = await engineCache.get(nestId);
  const engine = await engineCache.get(nestId);
  return { create, approve, edit, storage, engine, nestPath: resolveNestPath(nestId) };
}

/** Each (version, hash) pair the head sealed must exist in the history on disk. */
async function expectHeadMatchesDisk(storage: NestStorage) {
  await settleSeals();
  const fresh = await storage.findAllHistories(() => {}); // the callback bypasses the cache
  const last = (await storage.readCheckpointHistory())!.checkpoints.at(-1)!;
  for (const [id, hash] of Object.entries(last.document_chain_hashes)) {
    const entry = fresh.get(id)!.versions.find((v) => v.version === last.document_versions[id]);
    expect(entry?.chain_hash).toBe(hash);
  }
  return { last, fresh };
}

it("seals approval checkpoints from cached histories that match disk", async () => {
  const { create, approve, edit, storage } = await setup();
  const a = await create("Alpha");
  const b = await create("Beta");
  await approve(b); // warms the cache
  for (let i = 0; i < 2; i++) {
    // A's history changes after the cache is warm; each seal must see it.
    await edit(a, `# Alpha ${i}`);
    await approve(a);
  }
  const { last, fresh } = await expectHeadMatchesDisk(storage);
  expect(last.document_chain_hashes[a]).toBe(fresh.get(a)!.versions.at(-1)!.chain_hash);
  expect(last.document_chain_hashes[b]).toBe(fresh.get(b)!.versions.at(-1)!.chain_hash);
});

it("stays consistent when another process publishes to the same nest", async () => {
  const { create, approve, storage, engine, nestPath } = await setup();
  const a = await create("Alpha");
  const b = await create("Beta");
  await approve(b); // warms the cache

  // A second process: its own storage instance on the same folder. It writes
  // under the vault lock, as every engine operation does, so it cannot land in
  // the middle of this process's queued seal.
  await settleSeals();
  const other = new NestStorage(nestPath);
  await withVaultLock(nestPath, async () => {
    const node = await other.readDocument(b);
    node.body = "\n# Beta\n\nedited elsewhere\n";
    await other.writeDocument(b, serializeDocument(node));
    await publishDocument(other, b, { editedBy: "other" });
  });
  // Discovery picks the new version up on its next refresh (its TTL). Drop it
  // now, but leave the history cache alone: that is the case under test.
  engine.dropDiscoveryCache();

  await approve(a);
  await expectHeadMatchesDisk(storage);
});
