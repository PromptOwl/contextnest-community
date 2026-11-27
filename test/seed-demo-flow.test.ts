/**
 * The REST sequence scripts/seed-demo.mjs relies on: an agent files changes
 * with caller attribution on a governed nest, and the owner sees them waiting
 * with the agent, session and extra keys the review pane shows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
});
afterAll(() => env.cleanup());

describe("demo seed sequence", () => {
  it("an agent's attributed task and doc edit reach the owner's queue with their provenance", async () => {
    const owner = await registerUser(app, "owner@demo.test", "Owner");
    const agent = await registerUser(app, "agent@demo.test", "Agent");
    const nestId = (await jsonRequest(app, "POST", "/nests", { name: "Demo" }, owner.apiKey)).data.nest.id;
    const N = `/nests/${nestId}`;
    const playbook = (await jsonRequest(app, "POST", `${N}/nodes`, { title: "Playbook", folder: "governed", type: "document", content: "# P\n\nv1\n" }, owner.apiKey)).data.node;
    await jsonRequest(app, "POST", `${N}/collaborators`, { email: agent.email, permission: "write" }, owner.apiKey);
    await jsonRequest(app, "PATCH", `${N}/settings`, { stewardship_enabled: true }, owner.apiKey);

    const client = { agent: "grok", session_id: "s-4c1e", listener: "Support workspace" };
    const task = await jsonRequest(
      app, "POST", `${N}/nodes`,
      { title: "Quarterly check", folder: "projects/tasks", type: "task", tags: ["#task", "#stage:backlog"], assignee: owner.email, due: "2026-12-01", priority: "high", content: "Recurring check.", client },
      agent.apiKey,
    );
    expect(task.status, JSON.stringify(task.data)).toBe(201);
    const sub = await jsonRequest(app, "POST", `${N}/nodes/${task.data.node.id}/submit-review`, { note: "from standup", priority: "high" }, agent.apiKey);
    expect(sub.status, JSON.stringify(sub.data)).toBe(201);

    const edit = await jsonRequest(app, "PATCH", `${N}/nodes/${playbook.id}`, { content: "# P\n\nv2\n", client }, agent.apiKey);
    expect(edit.status, JSON.stringify(edit.data)).toBe(200);
    expect((await jsonRequest(app, "POST", `${N}/nodes/${playbook.id}/submit-review`, { note: "adds a section" }, agent.apiKey)).status).toBe(201);

    const q = await jsonRequest(app, "GET", `${N}/review-queue`, undefined, owner.apiKey);
    expect(q.data.requests.map((r: any) => r.nodeId).sort()).toEqual([task.data.node.id, playbook.id].sort());

    const node = (await jsonRequest(app, "GET", `${N}/nodes/${task.data.node.id}`, undefined, owner.apiKey)).data.node;
    expect(node.assignee).toBe(owner.email);
    expect(node.priority).toBe("high");
    expect(node.last_edit.client).toMatchObject(client);
  });
});
