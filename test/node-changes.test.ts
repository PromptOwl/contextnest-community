/** po-1400: who moved a document, who changed its tags, and when. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, jsonRequest, registerUser, setupTestEnv } from "./helpers.js";
import { moveDetail, tagChangeDetail } from "../src/nodes/node-changes.js";

describe("po-1400 details", () => {
  it("names a swap inside a group, and what was added or removed", () => {
    expect(tagChangeDetail(["#stage:backlog", "#keep"], ["#stage:done", "#keep"])).toBe("stage:backlog → stage:done");
    expect(tagChangeDetail(["#old"], ["#new"])).toBe("−old, +new");
    expect(tagChangeDetail(["#a"], ["A"])).toBeNull();
    expect(tagChangeDetail(["#a"], ["#a", "#ticket:cm-1"])).toBeNull();
  });
  it("names both folders of a move", () => {
    expect(moveDetail("nodes/a/b/doc", "nodes/doc")).toBe("a/b → (root)");
  });
});

describe("po-1400 history", () => {
  const env = setupTestEnv();
  let app: any;
  let alice: any;
  let bob: any;
  let nestId: string;
  let nodeId: string;

  beforeAll(async () => {
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@acme.com", "Alice");
    bob = await registerUser(app, "bob@acme.com", "Bob");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Hist" }, alice.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "bob@acme.com", permission: "write" }, alice.apiKey);
    const made = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Task", content: "x", type: "task", tags: ["#stage:backlog"], folder: "todo" }, alice.apiKey);
    nodeId = made.data.node.id;
  });
  afterAll(() => env.cleanup());

  it("records the tag change and the move, each by its own person, and keeps the history through the move", async () => {
    const tagged = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${nodeId}`, { tags: ["#stage:in-progress"] }, bob.apiKey);
    expect(tagged.status).toBe(200);
    // The same tags again are not a change.
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${nodeId}`, { tags: ["#stage:in-progress"], content: "y" }, bob.apiKey);
    const moved = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/move`, { folder: "doing" }, alice.apiKey);
    expect(moved.status).toBe(200);
    const newId = moved.data.node.id;

    const feed = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${newId}/activity`, undefined, bob.apiKey);
    const rows = feed.data.activity.filter((a: any) => ["moved", "tags_changed"].includes(a.type));
    expect(rows.map((r: any) => [r.type, r.actor, r.detail])).toEqual([
      ["moved", "alice@acme.com", "todo → doing"],
      ["tags_changed", "bob@acme.com", "stage:backlog → stage:in-progress"],
    ]);
    expect(rows.every((r: any) => !Number.isNaN(Date.parse(r.at)))).toBe(true);

    const log = await jsonRequest(app, "GET", `/nests/${nestId}/activity-log?type=moved,tags_changed`, undefined, alice.apiKey);
    expect(log.data.items.map((i: any) => i.type)).toEqual(["moved", "tags_changed"]);
  });
});
