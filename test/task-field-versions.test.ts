/**
 * Every board / custom-field edit is a tracked change: a task's due date,
 * priority and custom fields each seal a new published version.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@fieldver.test", "Owner");
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Field Versions" }, owner.apiKey);
  nestId = data.nest.id;
});
afterAll(() => env?.cleanup?.());

async function versionsOf(id: string) {
  const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}/versions`, undefined, owner.apiKey);
  return data.versions.map((v: any) => v.version) as number[];
}

describe("task field edits create versions", () => {
  it("due date, priority and assignee-less edits each add a version", async () => {
    const created = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes`,
      { title: "Watch the intro video", content: "Watch it.", type: "task" },
      owner.apiKey,
    );
    expect(created.status).toBeLessThan(300);
    const id = created.data.node.id as string;
    const v0 = (await versionsOf(id)).length;

    const due = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { due: "2026-11-27" }, owner.apiKey);
    expect(due.status).toBe(200);
    const v1 = (await versionsOf(id)).length;
    expect(v1).toBe(v0 + 1);

    const moved = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { due: "2026-11-28" }, owner.apiKey);
    expect(moved.status).toBe(200);
    expect((await versionsOf(id)).length).toBe(v1 + 1);

    const prio = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { priority: "high" }, owner.apiKey);
    expect(prio.status).toBe(200);
    expect((await versionsOf(id)).length).toBe(v1 + 2);
  });
});
