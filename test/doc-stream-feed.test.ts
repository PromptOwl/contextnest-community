/**
 * Stream as a real feed (po-1214) — what GET /me/stream adds so the UI can
 * render a dense, Twitter-like post and act on it in place, and the MCP twin
 * that gives agents the same feed.
 *
 *   AC-ST-02 identity: display name, `client.agent` ("via <agent>")
 *   AC-ST-03 what changed: the change note; no title repeated in the excerpt
 *   AC-ST-04 one "from agents / from people" toggle: `source=agent|human`
 *   AC-ST-05 review in place: `review.canReview` on an in-review post
 *   AC-ST-06 live pill: `facets=0` makes the `since` poll cheap
 *   AC-ST-08 MCP parity: `context_stream` (per-nest and server-level)
 *   AC-ST-09 access: nothing for a document the viewer can't open
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed, resetAuthRateLimit } from "./helpers.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
let rpcId = 1;

async function mcp(app: any, path: string, apiKey: string, method: string, params: Record<string, unknown>) {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(apiKey) },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
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
const callTool = (app: any, path: string, apiKey: string, name: string, args: Record<string, unknown>) =>
  mcp(app, path, apiKey, "tools/call", { name, arguments: args });
const toolNames = async (app: any, path: string, apiKey: string) =>
  ((await mcp(app, path, apiKey, "tools/list", {}))?.tools ?? []).map((t: { name: string }) => t.name);

async function db() {
  return (await import("../src/db/client.js")).getDb();
}

describe("doc stream as a feed (po-1214)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string; email: string };
  let dana: { apiKey: string; userId: string; email: string };
  let rory: { apiKey: string; userId: string; email: string };
  let stranger: { apiKey: string; userId: string; email: string };
  let nest: string;
  let agentDoc: string;
  let humanDoc: string;
  let reviewDoc: string;

  const stream = (qs: string, who: { apiKey: string } = alice) =>
    jsonRequest(app, "GET", `/me/stream${qs}`, undefined, who.apiKey);

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@acme.com", "Alice Admin");
    dana = await registerUser(app, "dana@acme.com", "Dana Okafor");
    rory = await registerUser(app, "rory@acme.com", "Rory Reader");
    await resetAuthRateLimit();
    stranger = await registerUser(app, "eve@acme.com", "Eve Outsider");

    nest = (await jsonRequest(app, "POST", "/nests", { name: "Revenue" }, alice.apiKey)).data.nest.id;
    for (const [who, permission] of [[dana, "write"], [rory, "read"]] as const) {
      const r = await jsonRequest(app, "POST", `/nests/${nest}/collaborators`, { user_id: who.userId, permission }, alice.apiKey);
      expect(r.status).toBe(201);
    }

    agentDoc = (await jsonRequest(app, "POST", `/nests/${nest}/nodes`, {
      title: "Renewal checklist",
      content: "# Renewal checklist\n\nConfirm the decision maker before the call ends.",
      client: { agent: "mkt-amplifier", session_id: "s1" },
    }, dana.apiKey)).data.node.id;
    const edit = await jsonRequest(app, "PATCH", `/nests/${nest}/nodes/${agentDoc}`, {
      content: "# Renewal checklist\n\nConfirm the decision maker. Log the call the same day.",
      changeNote: "Log the call the same day",
      client: { agent: "mkt-amplifier" },
    }, dana.apiKey);
    expect(edit.status).toBe(200);
    humanDoc = (await jsonRequest(app, "POST", `/nests/${nest}/nodes`, {
      title: "Q4 discount ceiling",
      content: "# Q4 discount ceiling\n\nStays at 18%.",
    }, alice.apiKey)).data.node.id;

    // Governed from here: Dana's next document goes to review.
    await jsonRequest(app, "PATCH", `/nests/${nest}/settings`, { stewardship_enabled: true }, alice.apiKey);
    reviewDoc = (await jsonRequest(app, "POST", `/nests/${nest}/nodes`, {
      title: "Globex sponsor", content: "# Globex sponsor\n\nTheir VP left.",
    }, dana.apiKey)).data.node.id;
    const submit = await jsonRequest(app, "POST", `/nests/${nest}/nodes/${reviewDoc}/submit-review`, { note: "ready" }, dana.apiKey);
    expect(submit.status).toBeLessThan(300);

    const d = await db();
    const rows = (await d.all("SELECT id FROM node_versions ORDER BY id ASC")) as Array<{ id: number }>;
    let minute = 0;
    for (const r of rows) {
      minute++;
      await d.run("UPDATE node_versions SET created_at = ? WHERE id = ?", [
        `2026-11-01 09:${String(minute).padStart(2, "0")}:00`, r.id,
      ]);
    }
  });

  afterAll(async () => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    await env.cleanup();
  });

  // ── AC-ST-02 ──────────────────────────────────────────────────────────────
  it("AC-ST-02: Given a version written with client.agent, When a member reads the stream, Then the post names the person and the agent", async () => {
    const { status, data } = await stream("");
    expect(status).toBe(200);
    const v2 = data.items.find((i: any) => i.nodeId === agentDoc && i.version === 2);
    expect(v2.author).toBe("dana@acme.com");
    expect(v2.authorName).toBe("Dana Okafor");
    expect(v2.client).toMatchObject({ agent: "mkt-amplifier" });
    const human = data.items.find((i: any) => i.nodeId === humanDoc);
    expect(human.authorName).toBe("Alice Admin");
    expect(human.client ?? null).toBeNull();
  });

  // ── AC-ST-03 ──────────────────────────────────────────────────────────────
  it("AC-ST-03: Given an edit with a change note, Then the post carries the note and the excerpt does not repeat the title", async () => {
    const { data } = await stream("");
    const v2 = data.items.find((i: any) => i.nodeId === agentDoc && i.version === 2);
    expect(v2.changeNote).toBe("Log the call the same day");
    expect(v2.summary.startsWith("Renewal checklist")).toBe(false);
    expect(v2.summary).toContain("Confirm the decision maker");
    const v1 = data.items.find((i: any) => i.nodeId === agentDoc && i.version === 1);
    expect(v1.changeNote ?? null).toBeNull();
  });

  // ── AC-ST-04 ──────────────────────────────────────────────────────────────
  it("AC-ST-04: Given source=agent or source=human, Then only agent or only human posts come back", async () => {
    const agents = await stream("?source=agent");
    expect(agents.status).toBe(200);
    expect(agents.data.items.length).toBe(2);
    expect(agents.data.items.every((i: any) => i.client?.agent === "mkt-amplifier")).toBe(true);
    expect(agents.data.total).toBe(2);
    const people = await stream("?source=human");
    expect(people.data.items.length).toBeGreaterThan(0);
    expect(people.data.items.every((i: any) => !i.client?.agent)).toBe(true);
    const all = await stream("");
    expect(people.data.total + agents.data.total).toBe(all.data.total);
    expect((await stream("?source=robots")).status).toBe(400);
  });

  // ── AC-ST-05 ──────────────────────────────────────────────────────────────
  it("AC-ST-05: Given an in-review post, Then a reader who may approve gets review.canReview true and the others false", async () => {
    const forAlice = (await stream("")).data.items.find((i: any) => i.nodeId === reviewDoc);
    expect(forAlice.status).toBe("pending_review");
    expect(forAlice.review).toEqual({ canReview: true });
    const forRory = (await stream("", rory)).data.items.find((i: any) => i.nodeId === reviewDoc);
    expect(forRory.review).toEqual({ canReview: false });
    // The submitter does not approve their own work (separation of duties).
    const forDana = (await stream("", dana)).data.items.find((i: any) => i.nodeId === reviewDoc);
    expect(forDana.review).toEqual({ canReview: false });
    // A post that is not in review carries no review block.
    const live = (await stream("")).data.items.find((i: any) => i.nodeId === humanDoc);
    expect(live.review ?? null).toBeNull();
  });

  // ── AC-ST-06 ──────────────────────────────────────────────────────────────
  it("AC-ST-06: Given facets=0 and since, Then the poll returns the count of newer posts without facet counts", async () => {
    const page = await stream("?since=2026-11-01T09:03:00Z&limit=1&facets=0");
    expect(page.status).toBe(200);
    expect(page.data.counts).toBeNull();
    const all = await stream("");
    const newer = all.data.items.filter((i: any) => i.at >= "2026-11-01 09:03:00").length;
    expect(page.data.total).toBe(newer);
    expect(page.data.items).toHaveLength(1);
    // Without facets=0 the first page still has its counts.
    expect((await stream("?limit=1")).data.counts).not.toBeNull();
  });

  // ── AC-ST-09 ──────────────────────────────────────────────────────────────
  it("AC-ST-09: Given a stranger, Then the feed holds nothing of the nest, not even a name", async () => {
    const { data } = await stream("", stranger);
    expect(data.items).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("Dana Okafor");
    expect(JSON.stringify(data)).not.toContain("mkt-amplifier");
    expect((await stream("?source=agent", stranger)).data.total).toBe(0);
  });

  // ── AC-ST-08 ──────────────────────────────────────────────────────────────
  it("AC-ST-08: Given an agent over per-nest MCP, When it calls context_stream, Then it reads the same feed with attribution", async () => {
    const path = `/nests/${nest}/mcp`;
    expect(await toolNames(app, path, alice.apiKey)).toContain("context_stream");
    const res = await callTool(app, path, alice.apiKey, "context_stream", {});
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c: any) => c.text).join("\n");
    expect(text).toContain("Dana Okafor via mkt-amplifier");
    expect(text).toContain("Renewal checklist");
    expect(text).toContain("Log the call the same day");
    expect(text).toContain("in review");
    const data = res.structuredContent;
    expect(data.items.length).toBe((await stream("")).data.items.length);
    expect(data.items[0]).toHaveProperty("client");

    const agentsOnly = await callTool(app, path, alice.apiKey, "context_stream", { source: "agent" });
    expect(agentsOnly.structuredContent.items.every((i: any) => i.client?.agent)).toBe(true);
  });

  it("AC-ST-08: Given the server-level MCP and no nest, Then context_stream spans every readable nest; a stranger sees none of it", async () => {
    const res = await callTool(app, "/mcp", alice.apiKey, "context_stream", {});
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.items.some((i: any) => i.nodeId === agentDoc)).toBe(true);
    const eve = await callTool(app, "/mcp", stranger.apiKey, "context_stream", {});
    expect(eve.structuredContent?.items ?? []).toEqual([]);
  });

  it("AC-ST-08: Given the switch is off, Then context_stream is not advertised and refuses a call", async () => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    try {
      const path = `/nests/${nest}/mcp`;
      expect(await toolNames(app, path, alice.apiKey)).not.toContain("context_stream");
      expect(await toolNames(app, "/mcp", alice.apiKey)).not.toContain("context_stream");
    } finally {
      process.env.EXPERIMENTAL_DOC_STREAM = "true";
    }
  });
});
