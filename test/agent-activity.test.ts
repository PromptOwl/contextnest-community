/**
 * wdqcq0314v — agent activity stream with undo.
 *
 * "I should be able to have a place to see a stream of all the things my agent
 * did, and undo them if they are jacked." (Misha, 2026-09-25)
 *
 * The stream is every write whose recorded `client` names an agent (§9.4
 * attribution: the MCP handshake name, the API key's label, or a caller-sent
 * `client.agent`), plus deletions. Undo never rewrites history: it goes through
 * the same governed paths a person would use — restore the previous version as
 * a new one, discard a draft, or delete a document the agent created — and
 * refuses when anything changed since.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "./helpers";

const HOOTIE = { agent: "hootie" };

/** A write a person made in the web UI: nothing about it names an agent.
 *  (A session-cookie write derives no agent; with an API key the key label
 *  would be derived, so attribution is switched off for the call.) */
async function asHuman<T>(fn: () => Promise<T>): Promise<T> {
  process.env.CONTEXTNEST_NO_ATTRIBUTION = "1";
  try {
    return await fn();
  } finally {
    delete process.env.CONTEXTNEST_NO_ATTRIBUTION;
  }
}

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
let rpcId = 1;

async function callTool(
  app: any,
  nestId: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(apiKey) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json")
    ? (await res.json()).result
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice("data: ".length),
      ).result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ungoverned nest — every write publishes
// ═══════════════════════════════════════════════════════════════════════════

describe("agent activity: stream + undo (ungoverned nest)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let editor: { apiKey: string; userId: string };
  let nestId: string;

  const activity = (query = "", key = owner.apiKey) =>
    jsonRequest(app, "GET", `/nests/${nestId}/agent-activity${query}`, undefined, key);
  const undo = (nodeId: string, version: number, key = owner.apiKey) =>
    jsonRequest(app, "POST", `/nests/${nestId}/agent-activity/undo`, { nodeId, version }, key);
  const readNode = (nodeId: string) =>
    jsonRequest(app, "GET", `/nests/${nestId}/nodes/${nodeId}`, undefined, owner.apiKey);
  const create = (title: string, content: string, client?: unknown) =>
    jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title, content, ...(client ? { client } : {}) },
      owner.apiKey,
    );
  const edit = (nodeId: string, content: string, client?: unknown) =>
    jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content, ...(client ? { client } : {}) },
      owner.apiKey,
    );

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    editor = await registerUser(app, "editor@acme.com", "Editor");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Agent Activity" }, owner.apiKey);
    nestId = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "editor@acme.com", permission: "write" },
      owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("lists what an agent did — create and update — with the agent, document and version", async () => {
    const made = await create("Pricing", "# Pricing\n\nhuman-approved v1", HOOTIE);
    const id = made.data.node.id;
    await edit(id, "# Pricing\n\nagent rewrite v2", HOOTIE);

    const { status, data } = await activity();
    expect(status).toBe(200);
    const mine = data.items.filter((i: any) => i.nodeId === id);
    expect(mine.map((i: any) => i.kind)).toEqual(["update", "create"]);
    expect(mine[0]).toEqual(
      expect.objectContaining({
        agent: "hootie",
        actor: "owner@acme.com",
        title: "Pricing",
        version: 2,
      }),
    );
    // Only the newest change on a document can be undone as-is.
    expect(mine[0].undo).toEqual(expect.objectContaining({ available: true, effect: "restore" }));
    expect(mine[1].undo.available).toBe(false);
    expect(mine[1].undo.reason).toMatch(/changed since/i);
  });

  it("leaves a person's own edits out of the agent view, and shows them under scope=all", async () => {
    const made = await asHuman(() => create("Human Notes", "typed by a person"));
    const id = made.data.node.id;

    const agents = await activity();
    expect(agents.data.items.some((i: any) => i.nodeId === id)).toBe(false);

    const all = await activity("?scope=all");
    const row = all.data.items.find((i: any) => i.nodeId === id);
    expect(row).toBeDefined();
    expect(row.agent).toBeUndefined();
  });

  it("filters to one agent", async () => {
    await create("By Claude Code", "from another agent", { agent: "claude-code" });
    const { data } = await activity("?agent=claude-code");
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((i: any) => i.agent === "claude-code")).toBe(true);
  });

  it("undoes an agent's published update by restoring the previous version as a new one", async () => {
    const made = await create("Roadmap", "# Roadmap\n\nthe real plan", HOOTIE);
    const id = made.data.node.id;
    await edit(id, "# Roadmap\n\nJACKED by the agent", HOOTIE);

    const { status, data } = await undo(id, 2);
    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({ ok: true, effect: "restore", restoredVersion: 1 }));
    expect(data.version).toBeGreaterThan(2);

    const node = await readNode(id);
    expect(node.data.node.content).toContain("the real plan");
    expect(node.data.node.content).not.toContain("JACKED");

    // History is append-only: the agent's version is still there, and the undo
    // is itself an entry in the stream.
    const versions = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}/versions`, undefined, owner.apiKey);
    expect(versions.data.versions.some((v: any) => v.version === 2)).toBe(true);
    const all = await activity("?scope=all");
    const undoRow = all.data.items.find((i: any) => i.nodeId === id && i.version === data.version);
    expect(undoRow.changeNote).toMatch(/undo of v2/i);
  });

  it("undoes an agent's create by removing the document", async () => {
    const made = await create("Spam Doc", "the agent should not have made this", HOOTIE);
    const id = made.data.node.id;

    const { status, data } = await undo(id, 1);
    expect(status).toBe(200);
    expect(data.effect).toBe("delete");
    expect((await readNode(id)).status).toBe(404);
  });

  it("refuses to undo when the document changed since, naming who changed it — nothing is overwritten", async () => {
    const made = await create("Contract", "# Contract\n\nv1", HOOTIE);
    const id = made.data.node.id;
    await edit(id, "# Contract\n\nagent v2", HOOTIE);
    await asHuman(() => edit(id, "# Contract\n\nhuman fixed it v3"));

    const { status, data } = await undo(id, 2);
    expect(status).toBe(409);
    expect(data.error).toMatch(/changed since/i);
    expect(data.error).toMatch(/owner@acme\.com/);
    expect((await readNode(id)).data.node.content).toContain("human fixed it v3");
  });

  it("refuses an undo for a version that isn't there", async () => {
    const made = await create("Lonely", "only one version", HOOTIE);
    const { status } = await undo(made.data.node.id, 7);
    expect(status).toBe(409);
    const missing = await undo("nodes/never-existed", 1);
    expect(missing.status).toBe(404);
  });

  it("shows an agent's deletion, attributed, but not undoable", async () => {
    const made = await create("Doomed", "to be deleted");
    const id = made.data.node.id;
    await callTool(app, nestId, owner.apiKey, "context_delete", { id, client: HOOTIE });

    const { data } = await activity();
    const row = data.items.find((i: any) => i.nodeId === id && i.kind === "delete");
    expect(row).toEqual(expect.objectContaining({ agent: "hootie", actor: "owner@acme.com" }));
    expect(row.undo.available).toBe(false);
    expect(row.undo.reason).toMatch(/can't be undone/i);
  });

  it("gives an editor (not an owner or steward) no stream and no undo", async () => {
    const made = await create("Editor Can See", "but not undo", HOOTIE);
    const id = made.data.node.id;

    const list = await activity("", editor.apiKey);
    expect(list.status).toBe(200);
    expect(list.data.items).toEqual([]);

    const res = await undo(id, 1, editor.apiKey);
    expect(res.status).toBe(403);
    expect((await readNode(id)).status).toBe(200);
  });

  it("rejects a malformed undo request", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/agent-activity/undo`, { nodeId: "x" }, owner.apiKey);
    expect(res.status).toBe(400);
  });

  it("leaves the plain /revert path unchanged (regression)", async () => {
    const made = await asHuman(() => create("Revert Still Works", "# R\n\nv1"));
    const id = made.data.node.id;
    await asHuman(() => edit(id, "# R\n\nv2"));
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${id}/revert`,
      { targetVersion: 1 },
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.version).toBeGreaterThan(2);
    expect((await readNode(id)).data.node.content).toContain("v1");
  });

  it("leaves a plain delete working and tombstoned without an agent (regression)", async () => {
    const made = await asHuman(() => create("Plain Delete", "bye"));
    const id = made.data.node.id;
    const del = await asHuman(() => jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey));
    expect(del.status).toBe(200);
    const all = await activity("?scope=all");
    const row = all.data.items.find((i: any) => i.nodeId === id && i.kind === "delete");
    expect(row).toBeDefined();
    expect(row.agent).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Governed nest — reviews and drafts
// ═══════════════════════════════════════════════════════════════════════════

describe("agent activity: undo respects review rules (governed nest)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let writer: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@gov.com", "Owner");
    writer = await registerUser(app, "writer@gov.com", "Writer");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Governed Activity" }, owner.apiKey);
    nestId = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "writer@gov.com", permission: "write" },
      owner.apiKey,
    );
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:
  - email: owner@gov.com, role: reviewer, can_approve: true
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);
  });

  afterAll(() => env.cleanup());

  it("discards an agent's unreviewed draft, putting the published version back", async () => {
    // The owner publishes v1 (self-approve on for seeding), the agent drafts over it.
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { allow_self_approve: true }, owner.apiKey);
    const made = await asHuman(() =>
      jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Policy", content: "# Policy\n\npublished" }, owner.apiKey),
    );
    const id = made.data.node.id;
    const draft = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${id}`,
      { content: "# Policy\n\nagent draft", client: HOOTIE },
      writer.apiKey,
    );
    expect(draft.status).toBe(200);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/agent-activity`, undefined, owner.apiKey);
    const row = list.data.items.find((i: any) => i.nodeId === id);
    expect(row).toEqual(expect.objectContaining({ status: "draft", agent: "hootie" }));
    expect(row.undo).toEqual(expect.objectContaining({ available: true, effect: "discard" }));

    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/agent-activity/undo`,
      { nodeId: id, version: row.version },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.effect).toBe("discard");
    const node = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    expect(node.data.node.content).toContain("published");
    expect(node.data.node.content).not.toContain("agent draft");
  });

  it("won't undo a change that's under review — it points at the review queue", async () => {
    const made = await asHuman(() =>
      jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "In Review", content: "v1" }, owner.apiKey),
    );
    const id = made.data.node.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "agent v2", client: HOOTIE }, writer.apiKey);
    const submitted = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/submit-review`, {}, writer.apiKey);
    expect(submitted.status).toBeLessThan(300);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/agent-activity`, undefined, owner.apiKey);
    const row = list.data.items.find((i: any) => i.nodeId === id && i.agent === "hootie");
    expect(row.undo.available).toBe(false);
    expect(row.undo.reason).toMatch(/review/i);

    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/agent-activity/undo`,
      { nodeId: id, version: row.version },
      owner.apiKey,
    );
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/review queue/i);
  });

  it("doesn't let a non-steward writer undo, even their own agent's change", async () => {
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/agent-activity`, undefined, writer.apiKey);
    expect(list.data.items).toEqual([]);
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/agent-activity/undo`,
      { nodeId: "nodes/policy", version: 1 },
      writer.apiKey,
    );
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// License gate — governance surface, locked like /feed
// ═══════════════════════════════════════════════════════════════════════════

describe("agent activity: license gate", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.AUTH_MODE = "open";
    vi.resetModules();
    vi.doUnmock("../src/auth/license.js");
    const dbClient = await import("../src/db/client.js");
    await dbClient.resetDb();
    await dbClient.initDb();
    const { createApp } = await import("../src/app.js");
    app = createApp();
  });

  afterAll(() => env.cleanup());

  it("503s the stream without a license", async () => {
    const res = await app.request("/nests/some-nest/agent-activity");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("License required");
  });

  it("does NOT trip the gate for a node whose slug is 'agent-activity'", async () => {
    const res = await app.request("/nests/some-nest/nodes/nodes%2Fagent-activity");
    expect(res.status).not.toBe(503);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Review round 1 (PR #342): paging for document-scoped stewards, the race
// between the check and the write, and a rejected draft.
// ═══════════════════════════════════════════════════════════════════════════

describe("agent activity: a document-scoped reviewer still gets full pages", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let rev: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@scope.com", "Owner");
    rev = await registerUser(app, "rev@scope.com", "Rev");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Scoped" }, owner.apiKey);
    nestId = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "rev@scope.com", permission: "read" },
      owner.apiKey,
    );
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:
  - email: owner@scope.com, role: reviewer, can_approve: true
documents:
  nodes/covered:
    - email: rev@scope.com, role: reviewer, can_approve: true
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);

    // The one document rev stewards is the OLDEST agent change; eight newer
    // agent changes land on documents rev can't undo.
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Covered", content: "c", client: HOOTIE }, owner.apiKey);
    for (let i = 0; i < 8; i++) {
      await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: `Other ${i}`, content: "o", client: HOOTIE }, owner.apiKey);
    }
  });

  afterAll(() => env.cleanup());

  it("fills the page past rows the reviewer can't see, and reports hasMore honestly", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/agent-activity?limit=1`,
      undefined,
      rev.apiKey,
    );
    expect(status).toBe(200);
    expect(data.items.map((i: any) => i.nodeId)).toEqual(["nodes/covered"]);
    expect(data.hasMore).toBe(false);
  });
});

describe("agent activity: a change that lands between the check and the write is never overwritten", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;
  let svc: typeof import("../src/governance/agent-activity-service.js");

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    // Same module graph as the app (createTestApp reset it).
    svc = await import("../src/governance/agent-activity-service.js");
    owner = await registerUser(app, "owner@race.com", "Owner");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Race" }, owner.apiKey);
    nestId = data.nest.id;
  });

  afterAll(() => env.cleanup());

  const readNode = (id: string) =>
    jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);

  it("refuses a restore when a person edited after the undo was planned", async () => {
    const made = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Race Doc", content: "v1", client: HOOTIE }, owner.apiKey);
    const id = made.data.node.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "agent v2", client: HOOTIE }, owner.apiKey);

    const plan = await svc.planUndo({ nestId, nodeId: id, version: 2, userEmail: "owner@race.com" });
    expect(plan.effect).toBe("restore");
    await asHuman(() => jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "human v3" }, owner.apiKey));

    await expect(
      svc.applyUndo({ nestId, nodeId: id, userEmail: "owner@race.com", plan }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await readNode(id)).data.node.content).toContain("human v3");
  });

  it("refuses to delete a created document that a person edited after the undo was planned", async () => {
    const made = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Race Create", content: "agent made", client: HOOTIE }, owner.apiKey);
    const id = made.data.node.id;

    const plan = await svc.planUndo({ nestId, nodeId: id, version: 1, userEmail: "owner@race.com" });
    expect(plan.effect).toBe("delete");
    await asHuman(() => jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "a person kept it" }, owner.apiKey));

    await expect(
      svc.applyUndo({ nestId, nodeId: id, userEmail: "owner@race.com", plan }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const node = await readNode(id);
    expect(node.status).toBe(200);
    expect(node.data.node.content).toContain("a person kept it");
  });
});

describe("agent activity: a rejected agent draft can be undone", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let writer: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@rej.com", "Owner");
    writer = await registerUser(app, "writer@rej.com", "Writer");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Rejected" }, owner.apiKey);
    nestId = data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "writer@rej.com", permission: "write" }, owner.apiKey);
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:
  - email: owner@rej.com, role: reviewer, can_approve: true
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { allow_self_approve: true }, owner.apiKey);
  });

  afterAll(() => env.cleanup());

  it("discards the rejected draft and puts the published version back", async () => {
    const made = await asHuman(() =>
      jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Handbook", content: "# Handbook\n\npublished" }, owner.apiKey),
    );
    const id = made.data.node.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "# Handbook\n\nagent draft", client: HOOTIE }, writer.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/submit-review`, {}, writer.apiKey);
    const rejected = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/reject`, { note: "no" }, owner.apiKey);
    expect(rejected.status).toBeLessThan(300);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/agent-activity`, undefined, owner.apiKey);
    const row = list.data.items.find((i: any) => i.nodeId === id && i.agent === "hootie");
    expect(row.status).toBe("rejected");
    expect(row.undo).toEqual(expect.objectContaining({ available: true, effect: "discard" }));

    const res = await jsonRequest(app, "POST", `/nests/${nestId}/agent-activity/undo`, { nodeId: id, version: row.version }, owner.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.effect).toBe("discard");
    const node = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    expect(node.data.node.content).toContain("published");
    expect(node.data.node.content).not.toContain("agent draft");
  });
});
