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

  it("edit is locked with 423 while a review is pending", async () => {
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

    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/locked-doc`,
      { content: "sneaky edit" },
      dev.apiKey,
    );
    expect(edit.status).toBe(423);

    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/nodes/locked-doc`,
      undefined,
      dev.apiKey,
    );
    expect(del.status).toBe(423);
  });

  it("revert is locked with 423 while a review is pending", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/locked-doc/revert`,
      { targetVersion: 1 },
      dev.apiKey,
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
});
