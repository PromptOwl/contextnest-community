/**
 * Bulk approve/reject — one call, one decision, several documents.
 *
 * The batch is a wrapper over the single-document operations, so what matters
 * here is that it does NOT relax them: an item the caller can't review fails
 * on its own while the rest still land, and every item is reported.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let author: { apiKey: string; userId: string; email: string };
let reviewer: { apiKey: string; userId: string; email: string };
let nestId: string;

/** Create a document as the author and submit it for review. */
async function submitDoc(title: string): Promise<string> {
  const created = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title, content: `# ${title}` },
    author.apiKey,
  );
  const nodeId = created.data.node.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/${nodeId}/submit-review`,
    { note: "please review" },
    author.apiKey,
  );
  return nodeId;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  author = await registerUser(app, "author@acme.com", "Author");
  reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
  const nest = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Bulk Review" },
    owner.apiKey,
  );
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: author.email, permission: "write" },
    owner.apiKey,
  );
  // Approvals go to assigned reviewers, so the batch needs one — the same
  // rule the single-document flow enforces, and the nest owner can't steward
  // their own nest.
  // Read-only on purpose: a reviewer steward normally holds plain read
  // collaborator access, and the batch must admit them the way the
  // single-document approve/reject does.
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: reviewer.email, permission: "read" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] },
    owner.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("bulk review", () => {
  it("approves several pending documents in one call", async () => {
    const ids = [await submitDoc("Bulk One"), await submitDoc("Bulk Two")];
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/review-queue/bulk`,
      { nodeIds: ids, action: "approve", note: "batch ok" },
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.succeeded).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.results.map((r: any) => r.nodeId).sort()).toEqual(ids.sort());

    // Same end state as approving them one at a time.
    const queue = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      reviewer.apiKey,
    );
    expect(
      queue.data.requests.filter((r: any) => ids.includes(r.nodeId)),
    ).toHaveLength(0);
  });

  it("rejects with a shared reason, and requires one", async () => {
    const ids = [await submitDoc("Bulk Three")];
    const noReason = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/review-queue/bulk`,
      { nodeIds: ids, action: "reject" },
      reviewer.apiKey,
    );
    expect(noReason.status).toBe(400);

    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/review-queue/bulk`,
      { nodeIds: ids, action: "reject", note: "not yet" },
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.succeeded).toBe(1);
  });

  it("fails the items the caller can't review and keeps the rest", async () => {
    const mine = await submitDoc("Bulk Four");
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/review-queue/bulk`,
      {
        nodeIds: [mine, "nodes/not-a-real-document"],
        action: "approve",
      },
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.succeeded).toBe(1);
    expect(data.failed).toBe(1);
    const bad = data.results.find(
      (r: any) => r.nodeId === "nodes/not-a-real-document",
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });

  it("refuses an empty or oversized selection", async () => {
    const empty = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/review-queue/bulk`,
      { nodeIds: [], action: "approve" },
      reviewer.apiKey,
    );
    expect(empty.status).toBe(400);

    const tooMany = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/review-queue/bulk`,
      {
        nodeIds: Array.from({ length: 51 }, (_, i) => `nodes/doc-${i}`),
        action: "approve",
      },
      reviewer.apiKey,
    );
    expect(tooMany.status).toBe(400);
  });
});

describe("bulk review input safety", () => {
  it("refuses a traversal id outright rather than reporting it per item", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/review-queue/bulk`,
      { nodeIds: ["../other-nest/nodes/secret"], action: "approve" },
      reviewer.apiKey,
    );
    expect(status).toBe(400);
  });
});
