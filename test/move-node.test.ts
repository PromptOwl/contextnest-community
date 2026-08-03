/**
 * Node move: POST /nests/:id/nodes/:nodeId/move relocates a document to
 * another folder. The id changes; version history, review state, annotations,
 * workflow edges, document grants, and tag index all follow. Wiki-links keep
 * resolving because the title (and leaf slug) don't change.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Movable" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

const create = (title: string, folder?: string, content = `# ${title}`) =>
  jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title, content, ...(folder ? { folder } : {}), tags: ["move-test"] },
    alice.apiKey,
  );

const move = (nodeId: string, folder: string) =>
  jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/${nodeId}/move`,
    { folder },
    alice.apiKey,
  );

describe("node move", () => {
  it("moves a root document into a nested folder", async () => {
    await create("Playbook");
    const res = await move("nodes/playbook", "GTM/Deals");
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe("nodes/gtm/deals/playbook");
    expect(res.data.previousId).toBe("nodes/playbook");

    // Old id is gone, new id serves the same content.
    const old = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/nodes/playbook`, undefined, alice.apiKey,
    );
    expect(old.status).toBe(404);
    const moved = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/nodes/gtm/deals/playbook`, undefined, alice.apiKey,
    );
    expect(moved.status).toBe(200);
    expect(moved.data.node.title).toBe("Playbook");
  });

  it("preserves version history across the move", async () => {
    await create("Versioned");
    await jsonRequest(
      app, "PATCH", `/nests/${nestId}/nodes/nodes/versioned`,
      { content: "# Versioned\n\nv2 body" }, alice.apiKey,
    );
    const res = await move("nodes/versioned", "archive");
    expect(res.status).toBe(200);

    const versions = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/nodes/archive/versioned/versions`,
      undefined, alice.apiKey,
    );
    if (versions.status !== 200) console.log("versions body:", versions.data);
    expect(versions.status).toBe(200);
    const count = (versions.data.versions || versions.data).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("moving to the folder it is already in is a no-op", async () => {
    await create("Stay Put", "keep");
    const res = await move("nodes/keep/stay-put", "keep");
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe("nodes/keep/stay-put");
    expect(res.data.previousId).toBe("nodes/keep/stay-put");
  });

  it("moves a nested document back to the nest root with folder \"\"", async () => {
    await create("Rooted", "deep/inside");
    const res = await move("nodes/deep/inside/rooted", "");
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe("nodes/rooted");
  });

  it("409s when the target slug already exists", async () => {
    await create("Twin", "a");
    await create("Twin", "b");
    const res = await move("nodes/a/twin", "b");
    expect(res.status).toBe(409);
    // Source must be untouched after the refused move.
    const still = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/nodes/a/twin`, undefined, alice.apiKey,
    );
    expect(still.status).toBe(200);
  });

  it("slugifies traversal segments instead of escaping the vault", async () => {
    await create("Traveler");
    const res = await move("nodes/traveler", "../../etc//passwd");
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe("nodes/etc/passwd/traveler");
  });

  it("rejects a move deeper than 8 levels", async () => {
    await create("Too Deep");
    const res = await move("nodes/too-deep", "a/b/c/d/e/f/g/h/i");
    expect(res.status).toBe(400);
  });

  it("rejects a missing folder field", async () => {
    await create("No Folder");
    const res = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/nodes/no-folder/move`, {}, alice.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("404s for a nonexistent node", async () => {
    const res = await move("nodes/ghost", "anywhere");
    expect(res.status).toBe(404);
  });

  it("keeps [[Title]] wiki-links resolving after a move", async () => {
    await create("Link Target");
    await create("Linker", undefined, "# Linker\n\nSee [[Link Target]].");
    const res = await move("nodes/link-target", "moved/here");
    expect(res.status).toBe(200);

    const ctx = await jsonRequest(
      app, "POST", `/nests/${nestId}/context`,
      { selector: "[[Linker]]", hops: 1, max_tokens: 2000 }, alice.apiKey,
    );
    expect(ctx.status).toBe(200);
    expect(JSON.stringify(ctx.data)).toContain("Link Target");
  });

  it("strips a leading nodes/ segment on move, not just on create", async () => {
    // Same fix as the create-side regression in nested-folders.test.ts: both
    // callers share one folder-path helper, so move must not double-nest
    // either. A caller thinking in node ids writes "nodes/archive".
    await create("Prefixed Destination");
    const res = await move("nodes/prefixed-destination", "nodes/archive");
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe("nodes/archive/prefixed-destination");
  });

  it("lets an approver move a node while a review is pending", async () => {
    // Enable stewardship so submit-review works. The reviewer must not be
    // the nest owner (self-stewarding is rejected), so bring in bob.
    const bob = await registerUser(app, "bob@acme.com", "Bob");
    const enable = await jsonRequest(
      app, "POST", `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: bob.email, role: "reviewer" }] },
      alice.apiKey,
    );
    expect([200, 201]).toContain(enable.status);

    await create("Under Review");
    const submit = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/nodes/under-review/submit-review`,
      { note: "please look" }, alice.apiKey,
    );
    expect([200, 201]).toContain(submit.status);

    // alice owns the nest, so she can reject the review and then move — the
    // lock only stops people who can't clear it (see admin-review-lock.test.ts).
    const res = await move("nodes/under-review", "elsewhere");
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe("nodes/elsewhere/under-review");
  });
});
