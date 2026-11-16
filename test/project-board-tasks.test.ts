/**
 * Project boards — the `task` node type and board fields (CU-wdqcq03xn2).
 *
 * Locked here:
 *   1. A task skips review in a governed nest, for an editor whose documents
 *      would otherwise land as drafts — on create AND on a board move (retag).
 *      Prime still wins: a task flagged prime queues like any prime doc.
 *   2. Board fields (assignee, due, priority, parent) round-trip on any node,
 *      validate, clear with null, and stamp assigned_at / moved_at.
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
import { ACCEPTED_NODE_TYPES } from "../src/nodes/service.js";

// Every case here creates a `task`; the type is off until the engine ships it.
const describeTask = describe.runIf(ACCEPTED_NODE_TYPES.has("task"));

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let editor: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let nestId: string;

const create = (caller: any, body: Record<string, unknown>) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, caller.apiKey);
const patch = (caller: any, slug: string, body: Record<string, unknown>) =>
  jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/${slug}`, body, caller.apiKey);
async function get(slug: string) {
  const { data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes/nodes/${slug}`,
    undefined,
    owner.apiKey,
  );
  return data.node;
}
async function listed(slug: string) {
  const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, owner.apiKey);
  return data.nodes.find((n: any) => n.id === `nodes/${slug}`);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  editor = await registerUser(app, "editor@acme.com", "Editor");
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Projects" }, owner.apiKey);
  nestId = data.nest.id;
  // These tests assert exact tag lists, so keep ticket numbers out of them.
  await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { task_rules: { ticket_numbering: false } }, owner.apiKey);
  // Governed, no self-approve: an editor's documents draft. The case a board
  // move would otherwise get stuck in.
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true, allow_self_approve: false },
    owner.apiKey,
  );
  const nestPath = join(env.dataDir, "nests", nestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(
    join(nestPath, "stewards.yaml"),
    `version: 1\nnest:\n  - email: ${editor.email}, role: editor\n`,
  );
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);
});

afterAll(() => env.cleanup());

describeTask("tasks skip review", () => {
  it("an editor's document drafts, but their task publishes", async () => {
    await create(editor, { title: "spec", content: "a spec" });
    expect((await listed("spec")).status).toBe("draft");

    const { status } = await create(editor, {
      title: "ship-email",
      content: "send it",
      type: "task",
      tags: ["todo"],
    });
    expect(status).toBe(201);
    const t = await listed("ship-email");
    expect(t.type).toBe("task");
    expect(t.status).toBe("published");
  });

  it("a board move (retag) on a task publishes and stamps moved_at", async () => {
    const before = await get("ship-email");
    expect(before.moved_at).toBeUndefined();
    const { status } = await patch(editor, "ship-email", { tags: ["doing"] });
    expect(status).toBe(200);
    const after = await get("ship-email");
    expect(after.status).toBe("published");
    expect(after.tags).toEqual(["#doing"]);
    expect(Date.parse(after.moved_at)).not.toBeNaN();
  });

  it("re-sending the same tags is not a move", async () => {
    const { moved_at } = await get("ship-email");
    await patch(editor, "ship-email", { tags: ["doing"], content: "send it today" });
    expect((await get("ship-email")).moved_at).toBe(moved_at);
  });

  it("prime still wins over the task bypass", async () => {
    await create(owner, {
      title: "launch-gate",
      content: "needs sign-off",
      type: "task",
      prime: true,
    });
    expect((await listed("launch-gate")).status).toBe("draft");
  });
});

// Board fields don't need the task type, so this runs on any engine.
describe("board fields on a plain document", () => {
  it("works on a plain document too", async () => {
    await create(owner, { title: "brief", content: "y", priority: "low" });
    expect((await get("brief")).priority).toBe("low");
  });
});

describeTask("board fields", () => {
  it("set on create and returned on read and list", async () => {
    await create(editor, {
      title: "write-copy",
      content: "x",
      type: "task",
      assignee: "Editor@Acme.com",
      due: "2026-10-31",
      priority: "high",
    });
    const n = await get("write-copy");
    expect(n.assignee).toBe("editor@acme.com");
    expect(Date.parse(n.assigned_at)).not.toBeNaN();
    expect(n.due).toBe("2026-10-31");
    expect(n.priority).toBe("high");
    const l = await listed("write-copy");
    expect(l.assignee).toBe("editor@acme.com");
    expect(l.priority).toBe("high");
  });

  it("reassigning restamps assigned_at; null clears both", async () => {
    const first = (await get("write-copy")).assigned_at;
    await new Promise((r) => setTimeout(r, 5));
    await patch(editor, "write-copy", { assignee: owner.email });
    const n = await get("write-copy");
    expect(n.assignee).toBe(owner.email);
    expect(n.assigned_at > first).toBe(true);

    await patch(editor, "write-copy", { assignee: null, priority: null, due: null });
    const cleared = await get("write-copy");
    expect(cleared.assignee).toBeUndefined();
    expect(cleared.assigned_at).toBeUndefined();
    expect(cleared.priority).toBeUndefined();
    expect(cleared.due).toBeUndefined();
  });

  it("refuses someone who isn't on the nest", async () => {
    const { status, data } = await patch(editor, "write-copy", { assignee: outsider.email });
    expect(status).toBe(400);
    expect(JSON.stringify(data)).toMatch(/isn't on this nest/);
  });

  it("refuses a bad due date and an unknown priority", async () => {
    expect((await patch(editor, "write-copy", { due: "next week" })).status).toBe(400);
    expect((await patch(editor, "write-copy", { priority: "p0" })).status).toBe(400);
    expect((await patch(editor, "write-copy", { due: 20261031 })).status).toBe(400);
  });

  it("parent makes a sub-item; refuses self, missing, and cycles", async () => {
    await create(editor, { title: "epic", content: "e", type: "task" });
    await create(editor, { title: "child", content: "c", type: "task", parent: "nodes/epic" });
    expect((await get("child")).parent).toBe("nodes/epic");

    expect((await patch(editor, "epic", { parent: "nodes/epic" })).status).toBe(400);
    expect((await patch(editor, "epic", { parent: "nodes/nope" })).status).toBe(400);
    const cyc = await patch(editor, "epic", { parent: "nodes/child" });
    expect(cyc.status).toBe(400);
    expect(JSON.stringify(cyc.data)).toMatch(/cycle/);
  });
});

describeTask("converting to a task is not a review bypass", () => {
  it("an editor converting a governed document into a task still drafts that edit", async () => {
    // Starts as a draft (no self-approve here). Were the gate reading the
    // post-patch type, this edit would publish the converted node outright.
    await create(owner, { title: "policy", content: "rules" });
    await patch(editor, "policy", { type: "task", content: "rules, rewritten" });
    const n = await listed("policy");
    expect(n.type).toBe("task");
    expect(n.status).toBe("draft");
  });

  it("converting a published task into a document drafts that edit", async () => {
    await create(editor, { title: "chore", content: "x", type: "task" });
    expect((await listed("chore")).status).toBe("published");
    await patch(editor, "chore", { type: "document", content: "now a policy" });
    const n = await listed("chore");
    expect(n.type).toBe("document");
    expect(n.status).toBe("draft");
  });
});

describeTask("board composer contract", () => {
  it("accepts the composer's empty-notes body and a column placement", async () => {
    const { status, data } = await create(editor, {
      title: "from-the-board",
      content: "\n",
      type: "task",
      tags: ["#doing"],
      folder: "projects/launch",
    });
    expect(status).toBe(201);
    expect(data.node.id).toBe("nodes/projects/launch/from-the-board");
    expect(data.node.status).toBe("published");
  });
});
