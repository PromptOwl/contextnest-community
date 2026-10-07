/**
 * Board follow-ups (CU-wdqcq03xn2): "done" columns stamp completed_at,
 * assignment notifies the assignee and lands in My Work, and board configs
 * accept the assignee/priority groupings and swimlanes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: any, ann: any;
let nestId: string;

const create = (u: any, body: Record<string, unknown>) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, u.apiKey);
const patch = (u: any, slug: string, body: Record<string, unknown>) =>
  jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/${slug}`, body, u.apiKey);
const get = async (slug: string) =>
  (await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/${slug}`, undefined, owner.apiKey)).data.node;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  ann = await registerUser(app, "ann@acme.com", "Ann");
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Launch" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: ann.email, permission: "write" }, owner.apiKey);
});

afterAll(() => env.cleanup());

describe("done columns", () => {
  it("default done tag is 'done'", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/settings`, undefined, owner.apiKey);
    expect(data.done_tags).toEqual(["done"]);
  });

  it("moving a task into a done column stamps completed_at; out of it clears it", async () => {
    await create(owner, { title: "ship", content: "x", type: "task", tags: ["doing"] });
    expect((await get("ship")).completed_at).toBeUndefined();
    await patch(owner, "ship", { tags: ["done"] });
    const done = await get("ship");
    expect(Date.parse(done.completed_at)).not.toBeNaN();
    await patch(owner, "ship", { tags: ["doing"] });
    expect((await get("ship")).completed_at).toBeUndefined();
  });

  it("a task created straight into a done column is completed", async () => {
    await create(owner, { title: "already", content: "x", type: "task", tags: ["done"] });
    expect(Date.parse((await get("already")).completed_at)).not.toBeNaN();
  });

  it("an admin can choose the done tags", async () => {
    const r = await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { done_tags: ["shipped", "#Wontfix"] }, owner.apiKey);
    expect(r.data.done_tags).toEqual(["shipped", "wontfix"]);
    await create(owner, { title: "won", content: "x", type: "task", tags: ["doing"] });
    await patch(owner, "won", { tags: ["shipped"] });
    expect(Date.parse((await get("won")).completed_at)).not.toBeNaN();
    // A writer can't change nest settings.
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { done_tags: ["x"] }, ann.apiKey)).status).toBe(403);
  });
});

describe("assignment → inbox + My Work", () => {
  it("assigning Ann notifies her, links the card, and lists it under assigned", async () => {
    await create(owner, { title: "write-copy", content: "x", type: "task", tags: ["doing"], due: "2026-10-31" });
    await patch(owner, "write-copy", { assignee: ann.email });
    const { data } = await jsonRequest(app, "GET", "/me/work", undefined, ann.apiKey);
    const n = data.notifications.find((x: any) => x.kind === "assigned");
    expect(n.message).toMatch(/assigned you "write-copy"/);
    expect(n.node_id).toBe("nodes/write-copy");
    const a = data.assigned.find((x: any) => x.node_id === "nodes/write-copy");
    expect(a).toMatchObject({ nest_id: nestId, title: "write-copy", due: "2026-10-31", type: "task" });
  });

  it("self-assignment is silent; completed cards drop out of assigned", async () => {
    await create(ann, { title: "mine", content: "x", type: "task", tags: ["doing"], assignee: ann.email });
    let { data } = await jsonRequest(app, "GET", "/me/work", undefined, ann.apiKey);
    expect(data.notifications.filter((x: any) => x.node_id === "nodes/mine")).toHaveLength(0);
    expect(data.assigned.some((x: any) => x.node_id === "nodes/mine")).toBe(true);
    await patch(ann, "mine", { tags: ["shipped"] });
    ({ data } = await jsonRequest(app, "GET", "/me/work", undefined, ann.apiKey));
    expect(data.assigned.some((x: any) => x.node_id === "nodes/mine")).toBe(false);
  });

  it("someone else's assignments don't show up", async () => {
    const { data } = await jsonRequest(app, "GET", "/me/work", undefined, owner.apiKey);
    expect(data.assigned.some((x: any) => x.node_id === "nodes/write-copy")).toBe(false);
  });
});

describe("board config: groupings and swimlanes", () => {
  it("accepts assignee/priority columns, swimlanes and hide-done; rejects junk", async () => {
    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/boards`, {
      name: "By person",
      config: { dimension: "assignee", swimlane: "priority", hideDoneAfterDays: 14 },
    }, owner.apiKey);
    expect(ok.status).toBe(201);
    expect(ok.data.board.config).toMatchObject({ dimension: "assignee", swimlane: "priority", hideDoneAfterDays: 14 });
    const bad = await jsonRequest(app, "POST", `/nests/${nestId}/boards`, {
      name: "Bad", config: { dimension: "tag", swimlane: "mood" },
    }, owner.apiKey);
    expect(bad.status).toBe(400);
  });
});

describe("assignment on a governed document", () => {
  it("doesn't notify while the assignment is only a draft", async () => {
    const { mkdirSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const ed = await registerUser(app, "ed@acme.com", "Ed");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Policies" }, owner.apiKey);
    const gid = data.nest.id;
    for (const u of [ann, ed]) {
      await jsonRequest(app, "POST", `/nests/${gid}/collaborators`, { email: u.email, permission: "write" }, owner.apiKey);
    }
    await jsonRequest(app, "PATCH", `/nests/${gid}/settings`, { stewardship_enabled: true, allow_self_approve: false }, owner.apiKey);
    mkdirSync(join(env.dataDir, "nests", gid), { recursive: true });
    writeFileSync(join(env.dataDir, "nests", gid, "stewards.yaml"), `version: 1\nnest:\n  - email: ${ed.email}, role: editor\n`);
    await jsonRequest(app, "POST", `/nests/${gid}/stewards/sync`, {}, owner.apiKey);

    // Assigned on create and on edit — both land as drafts for review.
    await jsonRequest(app, "POST", `/nests/${gid}/nodes`, { title: "policy", content: "x", assignee: ann.email }, ed.apiKey);
    await jsonRequest(app, "POST", `/nests/${gid}/nodes`, { title: "rules", content: "y" }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${gid}/nodes/nodes/rules`, { assignee: ann.email }, ed.apiKey);

    const work = (await jsonRequest(app, "GET", "/me/work", undefined, ann.apiKey)).data;
    expect(work.notifications.filter((x: any) => x.kind === "assigned" && x.nest_id === gid)).toHaveLength(0);
  });
});
