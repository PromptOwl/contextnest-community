/**
 * Nest instructions (CU-wdqcq05mty): the vault's CONTEXT.md — what every agent
 * reads first via context_init — readable by members, editable by owners and
 * admins, with a history every write lands in (UI, API, ctx push, MCP).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: { apiKey: string; userId: string; email: string }; // superadmin
let owner: { apiKey: string; userId: string; email: string };
let editor: { apiKey: string; userId: string; email: string };
let reviewerKey: string; // a second key of `owner`, to confirm what owner's agent wrote

async function makeNest(name: string): Promise<string> {
  const { data } = await jsonRequest(app, "POST", "/nests", { name }, owner.apiKey);
  return data.nest.id as string;
}

async function callTool(
  apiKey: string,
  nestId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; data?: any }> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  if (payload.error) return { isError: true, text: payload.error.message };
  const result = payload.result;
  return {
    isError: !!result.isError,
    text: (result.content || []).map((c: any) => c.text).join(""),
    data: result.structuredContent ?? result.data,
  };
}

const get = (nestId: string, key = owner.apiKey) =>
  jsonRequest(app, "GET", `/nests/${nestId}/instructions`, undefined, key);
const put = (nestId: string, body: Record<string, unknown>, key = owner.apiKey) =>
  jsonRequest(app, "PUT", `/nests/${nestId}/instructions`, body, key);

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
  root = await registerUser(app, "root@acme.com", "Root");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  editor = await registerUser(app, "editor@acme.com", "Editor");
  const { data } = await jsonRequest(app, "POST", "/auth/keys", { label: "reviewer" }, owner.apiKey);
  reviewerKey = data.api_key as string;
});

afterAll(() => env.cleanup());

describe("read", () => {
  it("returns the CONTEXT.md agents are served, with no revision before any edit", async () => {
    const nestId = await makeNest("Read Nest");
    const { status, data } = await get(nestId);
    expect(status).toBe(200);
    expect(data.content).toContain("# Read Nest");
    expect(data.revision).toBeNull();
  });
});

describe("owner edits", () => {
  let nestId: string;

  beforeAll(async () => {
    nestId = await makeNest("Edit Nest");
  });

  it("saves, keeps what was there as revision 1, and context_init serves the new text", async () => {
    const { status, data } = await put(nestId, {
      content: "# Edit Nest\n\nAlways cite the source document.\n",
      note: "add citation rule",
      baseRevision: 0,
    });
    expect(status).toBe(200);
    expect(data.revision).toMatchObject({ seq: 2, note: "add citation rule", authorEmail: owner.email });

    const read = await get(nestId);
    expect(read.data.content).toContain("Always cite the source document.");
    expect(read.data.revision.seq).toBe(2);

    const init = await callTool(owner.apiKey, nestId, "context_init", {});
    expect(init.text).toContain("Always cite the source document.");

    const hist = await jsonRequest(app, "GET", `/nests/${nestId}/instructions/revisions`, undefined, owner.apiKey);
    expect(hist.data.revisions.map((r: any) => [r.seq, r.source])).toEqual([
      [2, "api"],
      [1, "initial"],
    ]);
  });

  it("refuses a save based on a stale revision (409) and leaves the text alone", async () => {
    const { status } = await put(nestId, { content: "# Overwrite\n", baseRevision: 1 });
    expect(status).toBe(409);
    expect((await get(nestId)).data.content).toContain("Always cite the source document.");
  });

  it("refuses empty instructions", async () => {
    const { status } = await put(nestId, { content: "   ", baseRevision: 2 });
    expect(status).toBe(400);
  });

  it("shows a revision with the text it replaced, and restores it as a new revision", async () => {
    const one = await jsonRequest(app, "GET", `/nests/${nestId}/instructions/revisions/2`, undefined, owner.apiKey);
    expect(one.status).toBe(200);
    expect(one.data.content).toContain("Always cite");
    expect(one.data.previousContent).toContain("# Edit Nest");
    expect(one.data.previousContent).not.toContain("Always cite the source document.");

    const restored = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/instructions/revisions/1/restore`,
      { baseRevision: 2 },
      owner.apiKey,
    );
    expect(restored.status).toBe(200);
    expect(restored.data.revision).toMatchObject({ seq: 3, source: "restore", note: "From revision 1" });
    expect(restored.data.content).not.toContain("Always cite the source document.");
  });
});

describe("non-owners", () => {
  it("a write collaborator reads but cannot save or restore", async () => {
    const nestId = await makeNest("Collab Nest");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: editor.email, permission: "write" },
      owner.apiKey,
    );
    expect((await get(nestId, editor.apiKey)).status).toBe(200);
    expect((await put(nestId, { content: "# Mine now\n", baseRevision: 0 }, editor.apiKey)).status).toBe(403);
    await put(nestId, { content: "# Collab Nest\n\nv2\n", baseRevision: 0 });
    const restore = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/instructions/revisions/1/restore`,
      {},
      editor.apiKey,
    );
    expect(restore.status).toBe(403);

    const mcp = await callTool(editor.apiKey, nestId, "context_instructions_update", { content: "# Mine\n" });
    expect(mcp.isError).toBe(true);
    expect((await get(nestId)).data.content).toContain("v2");
  });
});

describe("ctx push", () => {
  it("records a pushed CONTEXT.md as a revision attributed to the pusher", async () => {
    const nestId = await makeNest("Push Nest");
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      { context_md: "# Push Nest\n\nPushed rules.\n" },
      owner.apiKey,
    );
    expect([200, 201]).toContain(status);
    const { data } = await get(nestId);
    expect(data.content).toContain("Pushed rules.");
    expect(data.revision).toMatchObject({ source: "push", authorEmail: owner.email });
  });
});

describe("MCP", () => {
  it("an owner updates through context_instructions_update and sees it in the history tool", async () => {
    const nestId = await makeNest("Mcp Nest");
    const res = await callTool(owner.apiKey, nestId, "context_instructions_update", {
      content: "# Mcp Nest\n\nPrefer published documents.\n",
      note: "from an agent",
      base_revision: 0,
    });
    expect(res.isError).toBe(false);
    expect((await get(nestId)).data.revision).toMatchObject({ source: "mcp", note: "from an agent" });

    const hist = await callTool(owner.apiKey, nestId, "context_instructions_history", {});
    expect(hist.text).toContain("from an agent");
    const one = await callTool(owner.apiKey, nestId, "context_instructions_history", { revision: 2 });
    expect(one.text).toContain("Prefer published documents.");
  });

  it("on a nest that holds agent writes, the update waits for a reviewer, then lands", async () => {
    const nestId = await makeNest("Gated Nest");
    const gate = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { require_push_confirmation: true },
      root.apiKey,
    );
    expect(gate.status).toBe(200);

    const res = await callTool(owner.apiKey, nestId, "context_instructions_update", {
      content: "# Gated Nest\n\nHeld rule.\n",
    });
    expect(res.isError).toBe(true);
    expect(res.data?.code).toBe("PENDING_CONFIRMATION");
    expect((await get(nestId)).data.content).not.toContain("Held rule.");

    // The REST write from an API key is held the same way.
    const held = await put(nestId, { content: "# Gated Nest\n\nHeld via REST.\n" });
    expect(held.status).toBe(202);
    expect(held.data.message).toContain("CONTEXT.md");

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/pending-pushes?status=pending`, undefined, owner.apiKey);
    const first = list.data.pending_pushes.find((p: any) => p.status === "pending");
    expect(first).toBeTruthy();
    const ok = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pending-pushes/${first.id}/confirm`,
      {},
      reviewerKey,
    );
    expect(ok.status).toBe(200);
    const after = await get(nestId);
    expect(after.data.revision).toMatchObject({ source: "push", authorEmail: owner.email });
  });
});
