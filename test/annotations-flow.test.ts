/**
 * Covers the annotation/comment flow the new AnnotationsPanel drives:
 * create thread → list → reply → resolve → reopen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest, registerUser } from "./helpers";

describe("annotations: comment flow", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let user: { apiKey: string; userId: string };
  let nestId: string;
  let nodeId: string;
  let base: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    user = await registerUser(app, "owner@acme.com", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Registry" }, user.apiKey);
    nestId = nest.data.nest.id;
    const node = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Doc", content: "# Doc\n\nbody", tags: [] },
      user.apiKey,
    );
    nodeId = node.data.node.id;
    base = `/nests/${nestId}/nodes/${nodeId}/annotations`;
  });

  afterAll(() => env.cleanup());

  it("creates, lists, replies, resolves, reopens a thread", async () => {
    const created = await jsonRequest(app, "POST", base, { body: "First note" }, user.apiKey);
    expect(created.status).toBe(201);
    const threadId = created.data.thread.id;
    expect(created.data.thread.comments[0].body).toBe("First note");

    const listed = await jsonRequest(app, "GET", base, undefined, user.apiKey);
    expect(listed.data.threads).toHaveLength(1);

    const replied = await jsonRequest(
      app,
      "POST",
      `${base}/${threadId}/comments`,
      { body: "A reply" },
      user.apiKey,
    );
    expect(replied.data.thread.comments).toHaveLength(2);

    const resolved = await jsonRequest(app, "POST", `${base}/${threadId}/resolve`, {}, user.apiKey);
    expect(resolved.data.thread.status).toBe("resolved");

    const reopened = await jsonRequest(app, "POST", `${base}/${threadId}/reopen`, {}, user.apiKey);
    expect(reopened.data.thread.status).toBe("open");
  });
});
