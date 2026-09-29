/**
 * wdqcq03aw2 — activity log per document, folder and nest, admins only.
 *
 * "in the doc of a nest, or the folder of a nest, or the nest itself, I should
 * be able to see activities (if I click in the 3 dots, see an activities
 * thing) - only admins - that can see like a log but filtered to that specific
 * document, so they can see who / which user changed, used, pulled etc..."
 * (Misha, 2026-09-29)
 *
 * GET /nests/:nestId/activity-log?node=<id> | ?folder=<path> | (nest)
 * merges what the server already records (versions, reviews, comments,
 * deletions) with document access — reads, retrievals and exports — which
 * seal no version and so were never recorded per document before.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "./helpers";
import { flushAccessLog, resetAccessThrottle } from "../src/governance/access-log.js";

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

describe("scoped activity log (document / folder / nest)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let editor: { apiKey: string; userId: string };
  let nestAdmin: { apiKey: string; userId: string };
  let nestId: string;
  let pricingId: string;
  let runbookId: string;

  const log = (query = "", key = owner.apiKey) =>
    jsonRequest(app, "GET", `/nests/${nestId}/activity-log${query}`, undefined, key);
  const nodeLog = async (nodeId: string, extra = "", key = owner.apiKey) => {
    await flushAccessLog();
    return log(`?node=${encodeURIComponent(nodeId)}${extra}`, key);
  };

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    editor = await registerUser(app, "editor@acme.com", "Editor");
    nestAdmin = await registerUser(app, "admin@acme.com", "Admin");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Scoped Log" }, owner.apiKey);
    nestId = data.nest.id;
    for (const [email, permission] of [
      ["editor@acme.com", "write"],
      ["admin@acme.com", "admin"],
    ]) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email, permission },
        owner.apiKey,
      );
    }
    const pricing = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Pricing", content: "# Pricing\n\nfalcon tier is 40 dollars", folder: "sales" },
      owner.apiKey,
    );
    pricingId = pricing.data.node.id;
    const runbook = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Runbook", content: "# Runbook\n\nrestart the heron service", folder: "ops" },
      owner.apiKey,
    );
    runbookId = runbook.data.node.id;
  });

  afterAll(() => env.cleanup());

  it("shows who created a document and who read it, newest first", async () => {
    resetAccessThrottle();
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pricingId}`, undefined, editor.apiKey);
    expect(read.status).toBe(200);

    const { status, data } = await nodeLog(pricingId);
    expect(status).toBe(200);
    const types = data.items.map((i: any) => `${i.type}:${i.actor}`);
    expect(types).toContain("read:editor@acme.com");
    expect(types).toContain("created:owner@acme.com");
    expect(types.indexOf("read:editor@acme.com")).toBeLessThan(types.indexOf("created:owner@acme.com"));
    const readRow = data.items.find((i: any) => i.type === "read");
    expect(readRow).toEqual(expect.objectContaining({ nodeId: pricingId, surface: "api", title: "Pricing" }));
  });

  it("records a read through MCP (ctx / agents), with the agent that made it", async () => {
    resetAccessThrottle();
    const res = await callTool(app, nestId, editor.apiKey, "context_get", {
      id: pricingId,
      client: { agent: "hootie" },
    });
    expect(res.isError).toBeFalsy();
    const { data } = await nodeLog(pricingId, "&type=read");
    const mcp = data.items.find((i: any) => i.surface === "mcp");
    expect(mcp).toEqual(expect.objectContaining({ type: "read", actor: "editor@acme.com", agent: "hootie" }));
  });

  it("records a document returned by a search as retrieved", async () => {
    resetAccessThrottle();
    const s = await jsonRequest(app, "GET", `/nests/${nestId}/search?q=falcon`, undefined, editor.apiKey);
    expect(s.status).toBe(200);
    const { data } = await nodeLog(pricingId, "&type=retrieved");
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items[0]).toEqual(expect.objectContaining({ type: "retrieved", actor: "editor@acme.com" }));
    // The runbook didn't match, so it wasn't pulled.
    const other = await nodeLog(runbookId, "&type=retrieved");
    expect(other.data.items).toEqual([]);
  });

  it("shows a whole-nest export in every document's log and the nest's", async () => {
    resetAccessThrottle();
    const ex = await app.request(`/nests/${nestId}/export?format=markdown`, {
      headers: authed(editor.apiKey),
    });
    expect(ex.status).toBe(200);
    const doc = await nodeLog(runbookId, "&type=exported");
    expect(doc.data.items[0]).toEqual(
      expect.objectContaining({ type: "exported", actor: "editor@acme.com", nodeId: null }),
    );
    const nest = await log("?type=exported");
    expect(nest.data.items.length).toBeGreaterThan(0);
  });

  it("doesn't flood the log when the same person re-reads a document", async () => {
    resetAccessThrottle();
    for (let i = 0; i < 3; i++) {
      await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${runbookId}`, undefined, owner.apiKey);
    }
    await flushAccessLog();
    const { data } = await log(`?node=${encodeURIComponent(runbookId)}&type=read&actor=owner@acme.com`);
    expect(data.items.length).toBe(1);
  });

  it("scopes a folder's log to the documents inside it", async () => {
    resetAccessThrottle();
    await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${runbookId}`, undefined, editor.apiKey);
    await flushAccessLog();
    const { status, data } = await log("?folder=sales");
    expect(status).toBe(200);
    const docRows = data.items.filter((i: any) => i.nodeId);
    expect(docRows.length).toBeGreaterThan(0);
    expect(docRows.every((i: any) => i.nodeId === pricingId)).toBe(true);
  });

  it("filters by actor and by event type", async () => {
    const { data } = await log(`?node=${encodeURIComponent(pricingId)}&actor=owner@acme.com`);
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((i: any) => i.actor === "owner@acme.com")).toBe(true);
    const created = await log(`?node=${encodeURIComponent(pricingId)}&type=created`);
    expect(created.data.items.map((i: any) => i.type)).toEqual(["created"]);
  });

  it("pages the log", async () => {
    const first = await log("?limit=2&offset=0");
    expect(first.data.items.length).toBe(2);
    expect(first.data.hasMore).toBe(true);
    const second = await log("?limit=2&offset=2");
    expect(second.data.items[0].id).not.toBe(first.data.items[0].id);
  });

  it("includes edits, and the deletion once a document is deleted", async () => {
    const made = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Scratch", content: "temp", folder: "ops" },
      owner.apiKey,
    );
    const id = made.data.node.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "temp v2" }, editor.apiKey);
    const before = await nodeLog(id, "&type=created,edited");
    expect(before.data.items.map((i: any) => `${i.type}:${i.actor}`)).toEqual([
      "edited:editor@acme.com",
      "created:owner@acme.com",
    ]);
    // Deleting purges a document's version history (see #342), so afterwards
    // the tombstone is what's left to show.
    await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    const after = await nodeLog(id);
    expect(after.data.items[0]).toEqual(expect.objectContaining({ type: "deleted", actor: "owner@acme.com" }));
  });

  it("keeps an agent's read separate from the same person's own read", async () => {
    resetAccessThrottle();
    await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${runbookId}`, undefined, nestAdmin.apiKey);
    await callTool(app, nestId, nestAdmin.apiKey, "context_get", { id: runbookId, client: { agent: "cursor" } });
    const { data } = await nodeLog(runbookId, "&type=read&actor=admin@acme.com");
    expect(data.items.map((i: any) => i.surface).sort()).toEqual(["api", "mcp"]);
  });

  it("is for admins only: a nest admin may see it, a write collaborator gets 403", async () => {
    const asAdmin = await log(`?node=${encodeURIComponent(pricingId)}`, nestAdmin.apiKey);
    expect(asAdmin.status).toBe(200);
    const asEditor = await log(`?node=${encodeURIComponent(pricingId)}`, editor.apiKey);
    expect(asEditor.status).toBe(403);
    const folderAsEditor = await log("?folder=sales", editor.apiKey);
    expect(folderAsEditor.status).toBe(403);
  });

  it("refuses node and folder together, and a traversal id", async () => {
    const both = await log(`?node=${encodeURIComponent(pricingId)}&folder=sales`);
    expect(both.status).toBe(400);
    const bad = await log(`?node=${encodeURIComponent("../other/nodes/x")}`);
    expect(bad.status).toBe(400);
  });

  it("regression: reads, version history and the existing per-node activity are unchanged", async () => {
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pricingId}`, undefined, editor.apiKey);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.data)).toContain("falcon tier is 40 dollars");
    const versions = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pricingId}/versions`, undefined, editor.apiKey);
    expect(versions.status).toBe(200);
    const old = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pricingId}/activity`, undefined, editor.apiKey);
    expect(old.status).toBe(200);
    expect(old.data.activity.map((a: any) => a.type)).toContain("edit");
    // Access rows never leak into the collaborator-facing feed.
    expect(old.data.activity.map((a: any) => a.type)).not.toContain("read");
  });
});
