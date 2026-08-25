/**
 * wdqcpzrtt1 — server-side review lock. While a node has an open review
 * request (stewardship on), edits and deletes are rejected with 423. The
 * lock releases once the review is approved or rejected. Plain drafts (no
 * pending review) stay editable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
  registerUser,
} from "./helpers";

describe("governance: review lock (423)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let dev: { apiKey: string; userId: string };
  let reviewer: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["dev@acme.com"] });
    dev = await registerUser(app, "dev@acme.com", "Dev");
    reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Lock Vault" },
      dev.apiKey,
    );
    nestId = data.nest.id;

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "reviewer@acme.com", permission: "write" },
      dev.apiKey,
    );

    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:
  - email: reviewer@acme.com, role: reviewer, can_approve: true
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, dev.apiKey);
  });

  afterAll(() => env.cleanup());

  it("plain draft (no pending review) is editable", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Free Doc", content: "v1" },
      dev.apiKey,
    );
    const { status } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/free-doc`,
      { content: "v2" },
      dev.apiKey,
    );
    expect(status).toBe(200);
  });

  it("edit is locked with 423 for a non-author while a review is pending", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Locked Doc", content: "needs review" },
      dev.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/locked-doc/submit-review`,
      {},
      dev.apiKey,
    );

    // reviewer@acme.com did not submit this — a teammate's pending review is
    // what the steward is evaluating, so their edit stays locked.
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/locked-doc`,
      { content: "sneaky edit" },
      reviewer.apiKey,
    );
    expect(edit.status).toBe(423);
    // Delete under review is covered in admin-review-lock.test.ts: frozen for
    // an editor, allowed for approvers (who can reject and then delete).
  });

  it("author can revise their own pending review without withdrawing", async () => {
    // Author edits the doc they submitted — allowed, lands as a new draft
    // version, and the SAME review request repoints to it (no restart).
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/locked-doc`,
      { content: "author revision" },
      dev.apiKey,
    );
    expect(edit.status).toBe(200);

    // Still exactly one pending review (not a duplicate), now pointing at the
    // freshly drafted version.
    const queue = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      dev.apiKey,
    );
    const pending = queue.data.requests.filter(
      (r: any) => r.nodeId === "nodes/locked-doc",
    );
    expect(pending.length).toBe(1);
    expect(pending[0].version).toBe(2);
  });

  it("steward approves the author's final edited version", async () => {
    // Self-contained doc: submit, author revises, steward approves — the
    // approved content must be the edit, not the originally submitted version.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Approve Doc", content: "first draft" },
      dev.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/approve-doc/submit-review`,
      {},
      dev.apiKey,
    );
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/approve-doc`,
      { content: "final edited body" },
      dev.apiKey,
    );
    expect(edit.status).toBe(200);

    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/approve-doc/approve`,
      {},
      reviewer.apiKey,
    );
    expect(approve.status).toBe(200);

    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/approve-doc`,
      undefined,
      dev.apiKey,
    );
    expect(read.data.node.content).toContain("final edited body");
  });

  it("approve targets the author's latest revision, not the submitted version", async () => {
    // Approve reads the version to publish INSIDE the node write lock (not
    // from a value the route captured earlier), so it always lands on the
    // author's newest committed edit — even after several revisions.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Multi Edit Doc", content: "v1 submitted" },
      dev.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/multi-edit-doc/submit-review`,
      {},
      dev.apiKey,
    );
    for (const body of ["second body", "third body"]) {
      const r = await jsonRequest(
        app,
        "PATCH",
        `/nests/${nestId}/nodes/nodes/multi-edit-doc`,
        { content: body },
        dev.apiKey,
      );
      expect(r.status).toBe(200);
    }

    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/multi-edit-doc/approve`,
      {},
      reviewer.apiKey,
    );
    expect(approve.status).toBe(200);

    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/multi-edit-doc`,
      undefined,
      dev.apiKey,
    );
    expect(read.data.node.content).toContain("third body");
    expect(read.data.node.content).not.toContain("v1 submitted");
    // Version advanced past the originally submitted v1.
    expect(read.data.node.version).toBeGreaterThan(1);
  });

  it("a concurrent author edit and steward approve stay coherent (lock serializes them)", async () => {
    // Fire the author's edit and the steward's approve together. The shared
    // per-node write lock serializes them either way; neither errors, the
    // review resolves exactly once, and the version chain stays writable
    // (a corrupted/duplicated version would surface as a 500 on the next edit).
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Race Doc", content: "base" },
      dev.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/race-doc/submit-review`,
      {},
      dev.apiKey,
    );

    const [edit, approve] = await Promise.all([
      jsonRequest(
        app,
        "PATCH",
        `/nests/${nestId}/nodes/nodes/race-doc`,
        { content: "raced edit" },
        dev.apiKey,
      ),
      jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes/nodes/race-doc/approve`,
        {},
        reviewer.apiKey,
      ),
    ]);
    expect(edit.status).toBe(200);
    expect(approve.status).toBe(200);

    // Review resolved exactly once — no lingering pending row for this node.
    const queue = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      dev.apiKey,
    );
    expect(
      queue.data.requests.filter((r: any) => r.nodeId === "nodes/race-doc")
        .length,
    ).toBe(0);

    // Version chain intact: a follow-up edit still saves.
    const after = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/race-doc`,
      { content: "after race" },
      dev.apiKey,
    );
    expect(after.status).toBe(200);
  });

  it("revert is locked with 423 for a non-author while a review is pending", async () => {
    // Revert is an author-content edit routed through updateNode, so a
    // non-author is frozen the same way a direct edit is.
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/locked-doc/revert`,
      { targetVersion: 1 },
      reviewer.apiKey,
    );
    expect(status).toBe(423);
  });

  it("lock releases after the review is rejected", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/locked-doc/reject`,
      { note: "not yet" },
      reviewer.apiKey,
    );
    const { status } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/locked-doc`,
      { content: "edit after reject" },
      dev.apiKey,
    );
    expect(status).toBe(200);
  });

  // Disabling stewardship mid-workflow must release the lock AND clear the
  // queue — disableStewardshipAndWipeGovernance deletes pending reviews. Runs
  // last; it tears down governance nest-wide.
  it("disabling stewardship mid-review releases the lock and empties the queue", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Toggle Doc", content: "v1" },
      dev.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/toggle-doc/submit-review`,
      {},
      dev.apiKey,
    );

    // Lock is on: a non-author's edit is blocked while review pending.
    const locked = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/toggle-doc`,
      { content: "blocked" },
      reviewer.apiKey,
    );
    expect(locked.status).toBe(423);

    // Disable stewardship → wipes pending reviews + stewards.
    const off = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { stewardship_enabled: false },
      dev.apiKey,
    );
    expect(off.status).toBe(200);
    expect(off.data.stewardship_enabled).toBe(false);
    expect(off.data.wiped.pendingReviews).toBeGreaterThanOrEqual(1);

    // Lock released — edit now succeeds.
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/toggle-doc`,
      { content: "editable again" },
      dev.apiKey,
    );
    expect(edit.status).toBe(200);

    // Queue emptied.
    const queue = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      dev.apiKey,
    );
    expect(queue.data.requests.length).toBe(0);
  });
});
