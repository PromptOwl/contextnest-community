/**
 * MCP comments (CU-wdqcq01uqn) — an agent can read feedback AND answer it.
 *
 * Two gaps this covers. `context_comments` was read-only, so an agent handed a
 * comment thread had no way to reply, open one, or mark it done. And the
 * server-level (cross-nest) endpoint didn't declare `context_comments` at all,
 * so a desktop client asking for comments got `Tool not found` — for every
 * node type, which is what "MCP can't read them" actually was.
 *
 * Writes go to the annotation store the UI's comments panel uses, and carry
 * the same side effects the REST routes do: the @mention fan-out, and the
 * derived `— Annotations` projection for artifacts.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/** JSON-RPC against an MCP endpoint, optionally as a specific caller. */
async function rpc(
  app: any,
  path: string,
  method: string,
  params: Record<string, unknown>,
  apiKey?: string,
): Promise<any> {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`Unexpected MCP response: ${text}`);
  return JSON.parse(line.slice("data: ".length));
}

/** A tool's text output (or its error message), which is what an agent sees. */
async function callTool(
  app: any,
  path: string,
  name: string,
  args: Record<string, unknown>,
  apiKey?: string,
): Promise<string> {
  const body = await rpc(app, path, "tools/call", { name, arguments: args }, apiKey);
  if (body?.error) return `ERROR ${body.error.code}: ${body.error.message}`;
  return String(body?.result?.content?.[0]?.text ?? JSON.stringify(body));
}

// ═══════════════════════════════════════════════════════════════════════════
// Reading + writing on the per-nest endpoint
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP comment writes", () => {
  let app: any;
  let nestId: string;
  let mcp: string;

  const threads = async (nodeId: string) => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/annotations`,
    );
    return data.threads as Array<{
      id: string;
      status: string;
      resolvedBy: string | null;
      comments: Array<{ author: string; body: string }>;
    }>;
  };

  beforeAll(async () => {
    setupTestEnv();
    app = await createTestApp("open");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Agent Nest" });
    nestId = nest.data.nest.id;
    mcp = `/nests/${nestId}/mcp`;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Launch Plan",
      content: "# Launch\n\nthe plan",
    });
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "The Deck",
      content: "<h1>slide one</h1>",
      type: "artifact",
    });
  });

  it("opens a new thread when no thread id is given", async () => {
    const text = await callTool(app, mcp, "context_comment", {
      id: "nodes/launch-plan",
      body: "The rollout date is missing.",
    });
    expect(text.toLowerCase()).toContain("launch plan");

    const list = await threads("nodes/launch-plan");
    expect(list).toHaveLength(1);
    expect(list[0].comments[0].body).toBe("The rollout date is missing.");
    expect(list[0].status).toBe("open");
  });

  it("replies into an existing thread instead of starting another", async () => {
    const [thread] = await threads("nodes/launch-plan");
    await callTool(app, mcp, "context_comment", {
      id: "nodes/launch-plan",
      thread: thread.id,
      body: "Added it — 14 March.",
    });

    const list = await threads("nodes/launch-plan");
    expect(list).toHaveLength(1); // still one thread, not two
    expect(list[0].comments).toHaveLength(2);
    expect(list[0].comments[1].body).toBe("Added it — 14 March.");
  });

  it("resolves a thread, recording who resolved it, and reopens it", async () => {
    const [thread] = await threads("nodes/launch-plan");
    const resolved = await callTool(app, mcp, "context_resolve_comment", {
      id: "nodes/launch-plan",
      thread: thread.id,
    });
    expect(resolved.toLowerCase()).toContain("resolved");

    let list = await threads("nodes/launch-plan");
    expect(list[0].status).toBe("resolved");
    expect(list[0].resolvedBy).toBeTruthy();

    const reopened = await callTool(app, mcp, "context_resolve_comment", {
      id: "nodes/launch-plan",
      thread: thread.id,
      reopen: true,
    });
    expect(reopened.toLowerCase()).toContain("reopen");
    list = await threads("nodes/launch-plan");
    expect(list[0].status).toBe("open");
  });

  it("reads back what it wrote through context_comments", async () => {
    const text = await callTool(app, mcp, "context_comments", {
      id: "nodes/launch-plan",
    });
    expect(text).toContain("The rollout date is missing.");
    expect(text).toContain("Added it — 14 March.");
  });

  it("resolves the node by title, like the other tools", async () => {
    const text = await callTool(app, mcp, "context_comment", {
      title: "The Deck",
      body: "Slide one needs a date.",
    });
    expect(text.toLowerCase()).toContain("the deck");
    expect(await threads("nodes/the-deck")).toHaveLength(1);
  });

  it("keeps an artifact's derived projection current", async () => {
    // An artifact's threads are re-materialized into a `— Annotations`
    // document so the feedback flows into the context/MCP path. An agent
    // commenting must not leave that projection stale.
    const text = await callTool(app, mcp, "context_get", {
      title: "The Deck — Annotations",
    });
    expect(text).toContain("Slide one needs a date.");
  });

  it("refuses a body that is empty, and a thread that isn't on the node", async () => {
    const empty = await callTool(app, mcp, "context_comment", {
      id: "nodes/launch-plan",
      body: "   ",
    });
    expect(empty.toLowerCase()).toMatch(/body|empty|required/);

    const wrong = await callTool(app, mcp, "context_comment", {
      id: "nodes/launch-plan",
      thread: "00000000-0000-0000-0000-000000000000",
      body: "into the void",
    });
    expect(wrong.toLowerCase()).toMatch(/thread|not found/);
  });

  it("says so plainly when the document doesn't resolve", async () => {
    const text = await callTool(app, mcp, "context_comment", {
      title: "No Such Doc",
      body: "hello",
    });
    // Names what didn't resolve, so this can't pass on a "tool not found".
    expect(text).toContain("No Such Doc");
    expect(text.toLowerCase()).toContain("not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The cross-nest endpoint — the gap that read as "MCP can't read comments"
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP comments on the server-level endpoint", () => {
  let app: any;
  let nestId: string;

  beforeAll(async () => {
    setupTestEnv();
    app = await createTestApp("open");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Cross Nest" });
    nestId = nest.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Runbook",
      content: "# Runbook\n\nsteps",
    });
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/runbook/annotations`,
      { body: "Step 3 is out of date.", anchor: { quote: "steps", before: "", after: "" } },
    );
  });

  it("declares context_comments alongside the other cross-nest tools", async () => {
    const body = await rpc(app, "/mcp", "tools/list", {});
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("context_comments");
  });

  it("returns a document's threads for the named nest", async () => {
    const text = await callTool(app, "/mcp", "context_comments", {
      nest: nestId,
      id: "nodes/runbook",
    });
    expect(text).toContain("Step 3 is out of date.");
    expect(text).toContain("steps"); // the anchored quote
  });

  it("stays read-only: no comment writing on the cross-nest surface", async () => {
    // Write tools live on the per-nest endpoint by design; a cross-nest write
    // would need a nest-scoped permission check this endpoint doesn't make.
    const text = await callTool(app, "/mcp", "context_comment", {
      nest: nestId,
      id: "nodes/runbook",
      body: "trying to write",
    });
    expect(text).toContain("not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Permission + the unchanged approval gate
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP comment permissions", () => {
  let app: any;
  let owner: { apiKey: string; email: string };
  let viewer: { apiKey: string; email: string };
  let stranger: { apiKey: string; email: string };
  let nestId: string;
  let mcp: string;

  beforeAll(async () => {
    setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    viewer = await registerUser(app, "viewer@acme.com", "Viewer");
    await resetAuthRateLimit();
    stranger = await registerUser(app, "stranger@acme.com", "Stranger");
    await resetAuthRateLimit();

    const nest = await jsonRequest(app, "POST", "/nests", { name: "Gated" }, owner.apiKey);
    nestId = nest.data.nest.id;
    mcp = `/nests/${nestId}/mcp`;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: viewer.email, permission: "read" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Spec", content: "# Spec\n\nbody" },
      owner.apiKey,
    );
  });

  it("lets a read-only collaborator comment — commenting is read-tier", async () => {
    const text = await callTool(
      app,
      mcp,
      "context_comment",
      { id: "nodes/spec", body: "Reviewed, one question." },
      viewer.apiKey,
    );
    expect(text.toLowerCase()).toContain("spec");
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/spec/annotations`,
      undefined,
      owner.apiKey,
    );
    expect(data.threads[0].comments[0].author).toBe(viewer.email);
  });

  it("notifies a human the agent tagged, like a comment left over REST", async () => {
    await callTool(
      app,
      mcp,
      "context_comment",
      { id: "nodes/spec", body: `done — over to you @${owner.email}` },
      viewer.apiKey,
    );
    const { data } = await jsonRequest(
      app,
      "GET",
      "/me/notifications",
      undefined,
      owner.apiKey,
    );
    const mentions = (data.notifications as Array<{ kind: string; message: string }>).filter(
      (n) => n.kind === "mention",
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].message).toContain(viewer.email);
  });

  it("refuses a caller with no access, without confirming the document", async () => {
    const text = await callTool(
      app,
      mcp,
      "context_comment",
      { id: "nodes/spec", body: "let me in" },
      stranger.apiKey,
    );
    expect(text).not.toContain("Spec");
    expect(text.toLowerCase()).toMatch(/not found|permission|access/);

    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/spec/annotations`,
      undefined,
      owner.apiKey,
    );
    // Nothing the stranger sent was stored.
    expect(
      data.threads.some((t: any) =>
        t.comments.some((c: any) => c.body === "let me in"),
      ),
    ).toBe(false);
  });

  it("lets collaborators read comments on an unapproved node; public still blocked elsewhere", async () => {
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { stewardship_enabled: true },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Draft Only", content: "# Draft\n\nunapproved" },
      owner.apiKey,
    );
    // Owner (collaborator) can read comments via MCP even though unapproved
    const text = await callTool(
      app,
      mcp,
      "context_comments",
      { id: "nodes/draft-only" },
      owner.apiKey,
    );
    // Newly created draft has no comments yet, so MCP should say so (not deny)
    expect(text.toLowerCase()).toContain("no comments on");
  });
});
