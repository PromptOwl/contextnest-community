/**
 * CU-wdqcq007pe — withdrawing a pending review. The submitter can cancel
 * their own submission (the document returns to draft); a teammate who
 * cannot approve cannot cancel it for them.
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

describe("governance: withdraw a pending review", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let dev: { apiKey: string; userId: string };
  let reviewer: { apiKey: string; userId: string };
  let peer: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["dev@acme.com"] });
    dev = await registerUser(app, "dev@acme.com", "Dev");
    reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
    peer = await registerUser(app, "peer@acme.com", "Peer");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Withdraw Vault" },
      dev.apiKey,
    );
    nestId = data.nest.id;

    for (const email of ["reviewer@acme.com", "peer@acme.com"]) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email, permission: "write" },
        dev.apiKey,
      );
    }

    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:
  - email: reviewer@acme.com, role: reviewer, can_approve: true
  - email: peer@acme.com, role: editor, can_approve: false
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, dev.apiKey);

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Withdraw Doc", content: "draft body" },
      dev.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/withdraw-doc/submit-review`,
      {},
      dev.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("a non-approving teammate cannot withdraw someone else's submission", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/withdraw-doc/cancel-review`,
      {},
      peer.apiKey,
    );
    expect(status).toBe(403);

    const queue = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      dev.apiKey,
    );
    expect(
      queue.data.requests.filter((r: any) => r.nodeId === "nodes/withdraw-doc")
        .length,
    ).toBe(1);
  });

  it("the submitter withdraws their own review and the document is editable again", async () => {
    const cancel = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/withdraw-doc/cancel-review`,
      {},
      dev.apiKey,
    );
    expect(cancel.status).toBe(200);

    const queue = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      dev.apiKey,
    );
    expect(
      queue.data.requests.filter((r: any) => r.nodeId === "nodes/withdraw-doc")
        .length,
    ).toBe(0);

    // Withdrawn, not deleted: the document is still there and the review lock
    // that a pending request holds is gone.
    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/withdraw-doc`,
      undefined,
      dev.apiKey,
    );
    expect(read.status).toBe(200);
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/withdraw-doc`,
      { content: "back to drafting" },
      reviewer.apiKey,
    );
    expect(edit.status).toBe(200);
  });

  it("a reviewer may still cancel a pending review", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Reviewer Cancel Doc", content: "body" },
      dev.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/reviewer-cancel-doc/submit-review`,
      {},
      dev.apiKey,
    );
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/reviewer-cancel-doc/cancel-review`,
      {},
      reviewer.apiKey,
    );
    expect(status).toBe(200);
  });
});
