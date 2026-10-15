/**
 * Task fields + the task activity log over MCP (and the REST mirror).
 *
 * Locked here:
 *   1. context_create / context_update set assignee, due, priority and parent
 *      with REST's validation (roster, date format, priority set, parent in
 *      nest, no cycles); null clears. context_get / list / query return them.
 *   2. context_list filters by assignee / priority / due_before.
 *   3. A read-only collaborator's key writes none of it — fields or log.
 *   4. context_task_log records an interaction attributed to the caller, plus
 *      the API key (label, prefix, scoped or not) and the §9.4 client, and the
 *      node's activity timeline shows it. `claim` assigns only when unassigned.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";
import { ACCEPTED_NODE_TYPES } from "../src/nodes/service.js";
import { describeTaskActivity } from "../src/nodes/task-activity.js";

const describeTask = describe.runIf(ACCEPTED_NODE_TYPES.has("task"));

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let editor: { apiKey: string; userId: string; email: string };
let viewer: { apiKey: string; userId: string; email: string };
const outsider = { email: "outsider@tasks.test" };
let scopedKey: string;
let nestId: string;
let rpc = 1;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function mcp(
  apiKey: string,
  name: string,
  args: Record<string, unknown> = {},
  path = `/nests/${nestId}/mcp`,
): Promise<{ text: string; data: any; isError: boolean }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpc++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6),
      );
  expect(body.error).toBeUndefined();
  const r = body.result;
  return {
    text: r.content.map((c: any) => c.text).join(""),
    data: r.structuredContent,
    isError: r.isError === true,
  };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@tasks.test", "Owner");
  editor = await registerUser(app, "editor@tasks.test", "Editor");
  viewer = await registerUser(app, "viewer@tasks.test", "Viewer");
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Agent Tasks" }, owner.apiKey);
  nestId = data.nest.id;
  for (const [u, permission] of [
    [editor, "write"],
    [viewer, "read"],
  ] as const) {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: u.email, permission },
      owner.apiKey,
    );
    expect(r.status).toBeLessThan(300);
  }
  // A key scoped to this one nest — what `ctx` gets when you connect a nest.
  const k = await jsonRequest(
    app,
    "POST",
    "/auth/keys",
    { label: "ctx CLI (laptop)", nest_id: nestId },
    owner.apiKey,
  );
  expect(k.status).toBe(201);
  scopedKey = k.data.api_key;
});

afterAll(() => env.cleanup());

describeTask("task fields over MCP", () => {
  it("context_create sets every field and context_get / list / query read them back", async () => {
    const parent = await mcp(owner.apiKey, "context_create", {
      title: "Launch",
      content: "the launch",
      type: "task",
      tags: ["todo"],
    });
    expect(parent.isError).toBe(false);

    const created = await mcp(owner.apiKey, "context_create", {
      title: "Write copy",
      content: "landing page copy",
      type: "task",
      tags: ["todo", "copy"],
      assignee: "Editor@Tasks.test",
      due: "2026-10-31",
      priority: "high",
      parent: parent.data.id,
    });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({
      assignee: "editor@tasks.test",
      due: "2026-10-31",
      priority: "high",
      parent: parent.data.id,
    });

    const got = await mcp(owner.apiKey, "context_get", { id: created.data.id });
    expect(got.data).toMatchObject({
      assignee: "editor@tasks.test",
      due: "2026-10-31",
      priority: "high",
      parent: parent.data.id,
    });
    expect(got.text).toContain("**Assignee:** editor@tasks.test");
    expect(got.text).toContain("**Due:** 2026-10-31");

    const listed = await mcp(owner.apiKey, "context_list", { type: "task" });
    const row = listed.data.documents.find((d: any) => d.id === created.data.id);
    expect(row).toMatchObject({ assignee: "editor@tasks.test", due: "2026-10-31", priority: "high" });
    // A task with nothing set carries no empty keys.
    const bare = listed.data.documents.find((d: any) => d.id === parent.data.id);
    expect(bare.assignee).toBeUndefined();

    const queried = await mcp(owner.apiKey, "context_query", { query: "#copy", hops: 0 });
    const hit = queried.data.documents.find((d: any) => d.id === created.data.id);
    expect(hit).toMatchObject({ assignee: "editor@tasks.test", priority: "high" });
  });

  it("context_update sets each field on its own and null clears it", async () => {
    const id = "nodes/write-copy";
    let r = await mcp(editor.apiKey, "context_update", { id, assignee: "owner@tasks.test" });
    expect(r.isError).toBe(false);
    expect(r.data.assignee).toBe("owner@tasks.test");
    r = await mcp(editor.apiKey, "context_update", { id, due: "2026-11-15" });
    expect(r.data.due).toBe("2026-11-15");
    r = await mcp(editor.apiKey, "context_update", { id, priority: "urgent" });
    expect(r.data.priority).toBe("urgent");
    r = await mcp(editor.apiKey, "context_update", { id, parent: null });
    expect(r.data.parent).toBeUndefined();
    r = await mcp(editor.apiKey, "context_update", { id, due: "" });
    expect(r.data.due).toBeUndefined();
    // Untouched fields survive a partial update.
    expect(r.data.assignee).toBe("owner@tasks.test");
    expect(r.data.priority).toBe("urgent");
    // REST sees what MCP wrote — one store, frontmatter metadata.
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    expect(rest.data.node).toMatchObject({ assignee: "owner@tasks.test", priority: "urgent" });
    expect(rest.data.node.due).toBeUndefined();
  });

  it("validates like REST: roster, date, priority, parent, and shape", async () => {
    const id = "nodes/write-copy";
    const bad = async (args: Record<string, unknown>, match: RegExp) => {
      const r = await mcp(owner.apiKey, "context_update", { id, ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.data.code).toBe("VALIDATION_FAILED");
      expect(r.text).toMatch(match);
    };
    await bad({ assignee: outsider.email }, /isn't on this nest/);
    await bad({ assignee: "not-an-email" }, /must be an email/);
    await bad({ due: "10/31/2026" }, /due must be a date/);
    await bad({ due: 20261031 }, /due must be a string or null/);
    await bad({ priority: "p1" }, /priority must be one of/);
    await bad({ parent: "nodes/nope" }, /doesn't exist/);
    await bad({ parent: id }, /own parent/);
    // And on create — nothing is written when a field is refused.
    const r = await mcp(owner.apiKey, "context_create", {
      title: "Refused",
      content: "x",
      type: "task",
      assignee: outsider.email,
    });
    expect(r.isError).toBe(true);
    const gone = await mcp(owner.apiKey, "context_get", { title: "Refused" });
    expect(gone.isError).toBe(true);
  });

  it("context_list filters by assignee, priority and due_before", async () => {
    await mcp(owner.apiKey, "context_create", {
      title: "Book venue",
      content: "x",
      type: "task",
      assignee: editor.email,
      due: "2026-10-20",
      priority: "low",
    });
    const ids = async (args: Record<string, unknown>) =>
      (await mcp(owner.apiKey, "context_list", { type: "task", ...args })).data.documents
        .map((d: any) => d.id)
        .sort();
    expect(await ids({ assignee: "EDITOR@tasks.test" })).toEqual(["nodes/book-venue"]);
    expect(await ids({ assignee: "owner@tasks.test" })).toEqual(["nodes/write-copy"]);
    expect(await ids({ assignee: "none" })).toEqual(["nodes/launch"]);
    expect(await ids({ priority: "urgent" })).toEqual(["nodes/write-copy"]);
    expect(await ids({ due_before: "2026-10-25" })).toEqual(["nodes/book-venue"]);
    const r = await mcp(owner.apiKey, "context_list", { due_before: "soon" });
    expect(r.isError).toBe(true);
    // REST takes the same filters.
    const rest = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes?assignee=${encodeURIComponent(editor.email)}`,
      undefined,
      owner.apiKey,
    );
    expect(rest.data.nodes.map((n: any) => n.id)).toEqual(["nodes/book-venue"]);
  });

  it("a read-only collaborator's key can read the fields but not write them", async () => {
    const got = await mcp(viewer.apiKey, "context_get", { id: "nodes/book-venue" });
    expect(got.data.assignee).toBe(editor.email);
    const upd = await mcp(viewer.apiKey, "context_update", {
      id: "nodes/book-venue",
      assignee: viewer.email,
    });
    expect(upd.isError).toBe(true);
    expect(upd.data.code).toBe("UNAUTHORIZED_ACTION");
    const created = await mcp(viewer.apiKey, "context_create", {
      title: "Sneaky",
      content: "x",
      type: "task",
      priority: "high",
    });
    expect(created.isError).toBe(true);
    const after = await mcp(owner.apiKey, "context_get", { id: "nodes/book-venue" });
    expect(after.data.assignee).toBe(editor.email);
  });
});

describeTask("context_task_log", () => {
  it("records the caller, the user key and the client agent", async () => {
    const r = await mcp(owner.apiKey, "context_task_log", {
      id: "nodes/write-copy",
      note: "drafted the hero section",
      status: "working",
      client: { agent: "Claude Code" },
    });
    expect(r.isError).toBe(false);
    expect(r.data.entry).toMatchObject({
      nodeId: "nodes/write-copy",
      actor: owner.email,
      status: "working",
      note: "drafted the hero section",
      surface: "mcp",
      key: { label: "test", scoped: false },
      client: { agent: "Claude Code" },
    });
    expect(r.data.entry.key.prefix).toMatch(/^cnst_/);
    expect(r.text).toContain("Claude Code (key test) on behalf of owner@tasks.test · working");
  });

  it("a scoped key is recorded as scoped, with its label and prefix", async () => {
    const r = await mcp(scopedKey, "context_task_log", {
      id: "nodes/write-copy",
      note: "copy is done",
      status: "done",
      client: { agent: "Claude Code" },
    });
    expect(r.isError).toBe(false);
    expect(r.data.entry.actor).toBe(owner.email);
    expect(r.data.entry.key).toMatchObject({ label: "ctx CLI (laptop)", scoped: true });
    expect(r.data.entry.key.prefix).toBe(`${scopedKey.slice(0, 12)}...`);

    // Shows up in the task's activity timeline, newest first, described.
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/write-copy/activity`,
      undefined,
      owner.apiKey,
    );
    const logged = data.activity.filter((a: any) => a.type === "task_activity");
    expect(logged.length).toBe(2);
    expect(logged[0]).toMatchObject({
      actor: owner.email,
      status: "done",
      agent: "Claude Code",
      key: { label: "ctx CLI (laptop)", scoped: true },
      summary: "Claude Code (key ctx CLI (laptop)) on behalf of owner@tasks.test · done · copy is done",
    });
  });

  it("REST POST /task-log is the same operation; a cookie-less user key with no agent names just the key", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/book-venue/task-log`,
      { note: "called three venues", status: "blocked" },
      editor.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.entry).toMatchObject({
      actor: editor.email,
      surface: "api",
      status: "blocked",
      key: { label: "test", scoped: false },
    });
    // The key label is the derived agent when the caller names none.
    expect(describeTaskActivity(res.data.entry)).toBe(
      "test on behalf of editor@tasks.test · blocked · called three venues",
    );
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/book-venue/task-log`,
      undefined,
      viewer.apiKey,
    );
    expect(list.status).toBe(200);
    expect(list.data.entries[0].note).toBe("called three venues");
  });

  it("refuses a read-only key, a bad status and an empty note", async () => {
    const r = await mcp(viewer.apiKey, "context_task_log", {
      id: "nodes/book-venue",
      note: "I was here",
    });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("UNAUTHORIZED_ACTION");
    const rest = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/book-venue/task-log`,
      { note: "I was here" },
      viewer.apiKey,
    );
    expect(rest.status).toBe(403);

    const badStatus = await mcp(owner.apiKey, "context_task_log", {
      id: "nodes/book-venue",
      note: "x",
      status: "finished",
    });
    expect(badStatus.isError).toBe(true);
    expect(badStatus.text).toMatch(/status must be one of working, done, blocked/);
    const noNote = await mcp(owner.apiKey, "context_task_log", { id: "nodes/book-venue", note: " " });
    expect(noNote.isError).toBe(true);
    const missing = await mcp(owner.apiKey, "context_task_log", { id: "nodes/nope", note: "x" });
    expect(missing.data.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("claim assigns the caller only when the task is unassigned", async () => {
    const r = await mcp(editor.apiKey, "context_task_log", {
      id: "nodes/launch",
      note: "taking this",
      status: "working",
      claim: true,
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ claim: "assigned", assignee: editor.email });
    expect((await mcp(owner.apiKey, "context_get", { id: "nodes/launch" })).data.assignee).toBe(
      editor.email,
    );
    // Someone else's task is never taken.
    const other = await mcp(owner.apiKey, "context_task_log", {
      id: "nodes/launch",
      note: "me too",
      claim: true,
    });
    expect(other.data).toMatchObject({ claim: "assigned_to_other", assignee: editor.email });
    expect(other.text).toContain(`Not claimed — it is assigned to ${editor.email}`);
  });

  it("two simultaneous claims: exactly one wins, the other is told who has it", async () => {
    const made = await mcp(owner.apiKey, "context_create", {
      title: "Race task",
      content: "Up for grabs.",
      type: "task",
    });
    expect(made.isError).toBe(false);
    const claim = (key: string) =>
      jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes/${made.data.id}/task-log`,
        { note: "mine", claim: true },
        key,
      );
    const results = await Promise.all([claim(owner.apiKey), claim(editor.apiKey)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const outcomes = results.map((r) => r.data.claim).sort();
    expect(outcomes).toEqual(["assigned", "assigned_to_other"]);
    const winner = results.find((r) => r.data.claim === "assigned")!.data.assignee;
    // Both callers are told the same assignee, and that is what was stored.
    expect(results.every((r) => r.data.assignee === winner)).toBe(true);
    expect((await mcp(owner.apiKey, "context_get", { id: made.data.id })).data.assignee).toBe(winner);
  });

  it("is on the server-level /mcp endpoint too, with a nest argument", async () => {
    const r = await mcp(
      owner.apiKey,
      "context_task_log",
      { nest: nestId, id: "nodes/launch", note: "checked in from the server endpoint" },
      "/mcp",
    );
    expect(r.isError).toBe(false);
    expect(r.data.entry.note).toBe("checked in from the server endpoint");
  });
});
