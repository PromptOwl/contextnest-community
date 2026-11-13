/**
 * Agent team stream, S1: channels (PO-1179).
 *
 * A channel is an ordinary node under `nodes/channels/<name>` (engine type
 * `document`, tagged `#channel`), and its messages are that node's existing
 * comment threads: a top-level post is a thread, a reply is a comment in it.
 * So posting goes through the comment routes and MCP `context_comment` that
 * already exist, with their @mention fan-out. What is new is the channel list,
 * the timeline read (REST + MCP), the write tier on posts, the actor label and
 * the superadmin switch (EXPERIMENTAL_AGENT_STREAM, `experimental.agent_stream`
 * in /health).
 *
 * Every acceptance criterion is a describe block named by its AC id.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
  seedPeople,
} from "./helpers.js";
import { FREE_TIER_MAX_USERS } from "../src/auth/free-tier.js";

const OWNER_EMAIL = "owner@team.test";
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

type User = { apiKey: string; userId: string; email: string; cookie: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let writer: User; // write collaborator
let reader: User; // read collaborator
let stacey: User; // read collaborator, the @mention target
let stranger: User; // no access to the nest
let nestId: string;
let otherNestId: string; // the stranger's own nest
const OPS = "nodes/channels/ops";

async function rpc(path: string, method: string, params: Record<string, unknown>, apiKey?: string) {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return { status: res.status, body: await res.json() };
  const text = await res.text();
  const line = text.split("\n").find((l: string) => l.startsWith("data: "));
  return { status: res.status, body: line ? JSON.parse(line.slice("data: ".length)) : { raw: text } };
}

/** tools/call → { text, data, isError, rpcError } as an agent sees it. */
async function callTool(apiKey: string, name: string, args: Record<string, unknown>, nest = nestId) {
  const { status, body } = await rpc(`/nests/${nest}/mcp`, "tools/call", { name, arguments: args }, apiKey);
  return {
    status,
    rpcError: body?.error as { message: string } | undefined,
    text: String(body?.result?.content?.[0]?.text ?? ""),
    data: body?.result?.structuredContent,
    isError: body?.result?.isError === true,
  };
}

async function listToolNames(apiKey: string): Promise<string[]> {
  const { body } = await rpc(`/nests/${nestId}/mcp`, "tools/list", {}, apiKey);
  return (body?.result?.tools ?? []).map((t: { name: string }) => t.name);
}

const post = (u: { apiKey: string }, body: string, channel = OPS) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes/${channel}/annotations`, { body }, u.apiKey);
const reply = (u: { apiKey: string }, threadId: string, body: string, channel = OPS) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes/${channel}/annotations/${threadId}/comments`, { body }, u.apiKey);
const timeline = (u: { apiKey: string }, qs = "", name = "ops") =>
  jsonRequest(app, "GET", `/nests/${nestId}/channels/${name}${qs}`, undefined, u.apiKey);
const tick = () => new Promise((r) => setTimeout(r, 15));

async function mintKey(u: User, label: string): Promise<string> {
  const r = await jsonRequest(app, "POST", "/auth/keys", { label }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  const key = r.data.key ?? r.data.apiKey ?? r.data.api_key;
  expect(key).toBeTruthy();
  return key;
}

beforeAll(async () => {
  env = setupTestEnv();
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  owner = await registerUser(app, OWNER_EMAIL, "Owner");
  writer = await registerUser(app, "writer@team.test", "Writer");
  reader = await registerUser(app, "reader@team.test", "Reader");
  await resetAuthRateLimit();
  stacey = await registerUser(app, "stacey@team.test", "Stacey");
  stranger = await registerUser(app, "stranger@else.test", "Stranger");

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  otherNestId = (await jsonRequest(app, "POST", "/nests", { name: "Elsewhere" }, stranger.apiKey)).data.nest.id;
  for (const [u, permission] of [
    [writer, "write"],
    [reader, "read"],
    [stacey, "read"],
  ] as const) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
});

afterAll(async () => {
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  delete process.env.EXPERIMENTAL_DOC_STREAM;
  await env.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CH-01 — the switch
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-01: switch off → every channel route and MCP tool 404s", () => {
  it("AC-CH-01 is off by default: routes 404, /health and /admin/settings say false", async () => {
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, owner.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "ops" }, owner.apiKey)).status).toBe(404);
    expect((await timeline(owner)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/ops/archive`, {}, owner.apiKey)).status).toBe(404);
    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.experimental.agent_stream).toBe(false);
    const settings = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
    expect(settings.data.experimental_agent_stream_enabled).toBe(false);
  });

  it("AC-CH-01 hides the MCP channel tools and refuses a call to them", async () => {
    const names = await listToolNames(owner.apiKey);
    expect(names).not.toContain("context_channels");
    expect(names).not.toContain("context_channel_read");
    const r = await callTool(owner.apiKey, "context_channel_read", { channel: "ops" });
    expect(r.rpcError || r.isError).toBeTruthy();
  });

  it("AC-CH-01 refuses a non-superadmin PATCH (403) and persists nothing", async () => {
    const res = await jsonRequest(app, "PATCH", "/admin/settings", { experimental_agent_stream_enabled: true }, writer.apiKey);
    expect(res.status).toBe(403);
    expect((await jsonRequest(app, "GET", "/health")).data.experimental.agent_stream).toBe(false);
  });

  it("AC-CH-01 a superadmin flips it on live, and off again (off → 404 again)", async () => {
    const on = await jsonRequest(app, "PATCH", "/admin/settings", { experimental_agent_stream_enabled: true }, owner.apiKey);
    expect(on.status).toBe(200);
    expect(on.data.settings.experimental_agent_stream_enabled).toBe(true);
    expect((await jsonRequest(app, "GET", "/health")).data.experimental.agent_stream).toBe(true);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, owner.apiKey)).status).toBe(200);
    expect(await listToolNames(owner.apiKey)).toEqual(expect.arrayContaining(["context_channels", "context_channel_read"]));

    const off = await jsonRequest(app, "PATCH", "/admin/settings", { experimental_agent_stream_enabled: false }, owner.apiKey);
    expect(off.status).toBe(200);
    expect((await jsonRequest(app, "GET", "/health")).data.experimental.agent_stream).toBe(false);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, owner.apiKey)).status).toBe(404);
  });

  it("AC-CH-01 the env var turns it on too", async () => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    expect((await jsonRequest(app, "GET", "/health")).data.experimental.agent_stream).toBe(true);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, owner.apiKey)).status).toBe(200);
  });
});

// Every block below runs with the switch on.

// ═══════════════════════════════════════════════════════════════════════════
// AC-CH-02 — create + list (+ archive)
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-02: a writer creates a channel and the list shows it", () => {
  beforeAll(() => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  });

  it("AC-CH-02 creates nodes/channels/ops and GET /channels lists it", async () => {
    const r = await jsonRequest(
      app, "POST", `/nests/${nestId}/channels`,
      { name: "ops", purpose: "Where the agents coordinate releases." },
      writer.apiKey,
    );
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.channel).toMatchObject({ id: OPS, name: "ops", type: "channel", archived: false });

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, reader.apiKey);
    expect(list.status).toBe(200);
    const ops = list.data.channels.find((c: any) => c.id === OPS);
    expect(ops).toMatchObject({ name: "ops", type: "channel", purpose: "Where the agents coordinate releases.", post_count: 0 });
  });

  it("AC-CH-02 refuses a duplicate (409), a bad name (400) and a reader (403)", async () => {
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "ops" }, writer.apiKey)).status).toBe(409);
    for (const name of ["", "../x", "a/b", "x".repeat(70), "<script>"]) {
      expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name }, writer.apiKey)).status, name).toBe(400);
    }
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "lurkers" }, reader.apiKey)).status).toBe(403);
  });

  it("AC-CH-02 refuses names the vault reserves for derived files (agents, index, claude…)", async () => {
    // nodes/channels/agents.md would be an AGENTS.md: the engine regenerates
    // it and discovery hides it, so the channel would vanish.
    for (const name of ["agents", "INDEX", "claude", "context", "readme", "gemini", "qwen"]) {
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name }, writer.apiKey);
      expect(r.status, name).toBe(400);
    }
  });

  it("AC-CH-02 normalizes the name (leading #, case) to the slug", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "#Design" }, writer.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.channel.id).toBe("nodes/channels/design");
  });

  it("AC-CH-02 an ordinary document in channels/ without the channel tag is not a channel", async () => {
    const d = await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes`,
      { title: "Not a channel", folder: "channels", content: "plain doc" },
      writer.apiKey,
    );
    expect(d.status, JSON.stringify(d.data)).toBe(201);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, writer.apiKey);
    expect(list.data.channels.map((c: any) => c.id)).not.toContain(d.data.node.id);
    expect((await timeline(writer, "", "not-a-channel")).status).toBe(404);
  });

  it("AC-CH-02 archives: hidden from the list, posting refused (409), ?archived=1 shows it", async () => {
    const mk = await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "old" }, writer.apiKey);
    expect(mk.status).toBe(201);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/old/archive`, {}, reader.apiKey)).status).toBe(403);
    const a = await jsonRequest(app, "POST", `/nests/${nestId}/channels/old/archive`, {}, writer.apiKey);
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    expect(a.data.channel.archived).toBe(true);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, writer.apiKey);
    expect(list.data.channels.map((c: any) => c.name)).not.toContain("old");
    const all = await jsonRequest(app, "GET", `/nests/${nestId}/channels?archived=1`, undefined, writer.apiKey);
    expect(all.data.channels.find((c: any) => c.name === "old")?.archived).toBe(true);
    expect((await post(writer, "anyone here?", "nodes/channels/old")).status).toBe(409);
    const back = await jsonRequest(app, "POST", `/nests/${nestId}/channels/old/archive`, { archived: false }, writer.apiKey);
    expect(back.data.channel.archived).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CH-03 — timeline + thread
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-03: timeline newest-first with reply counts; ?thread= gives parent + replies", () => {
  const ids: string[] = [];

  beforeAll(async () => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "timeline" }, writer.apiKey);
    for (const body of ["first post", "second post", "third post"]) {
      const r = await post(writer, body, "nodes/channels/timeline");
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      ids.push(r.data.thread.id);
      await tick();
    }
    expect((await reply(owner, ids[1], "reply one", "nodes/channels/timeline")).status).toBe(200);
    await tick();
    expect((await reply(writer, ids[1], "reply two", "nodes/channels/timeline")).status).toBe(200);
  });

  it("AC-CH-03 returns the 3 posts newest-first, each with reply_count", async () => {
    const r = await timeline(reader, "", "timeline");
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.channel).toMatchObject({ id: "nodes/channels/timeline", name: "timeline" });
    expect(r.data.posts.map((p: any) => p.body)).toEqual(["third post", "second post", "first post"]);
    expect(r.data.posts.map((p: any) => p.reply_count)).toEqual([0, 2, 0]);
    expect(r.data.posts[1].id).toBe(ids[1]);
    expect(r.data.pagination).toMatchObject({ total: 3, has_more: false });
  });

  it("AC-CH-03 ?thread=<id> returns the parent and its 2 replies in order", async () => {
    const r = await timeline(reader, `?thread=${ids[1]}`, "timeline");
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.thread.post).toMatchObject({ id: ids[1], body: "second post", reply_count: 2 });
    expect(r.data.thread.replies.map((c: any) => c.body)).toEqual(["reply one", "reply two"]);
    expect(r.data.thread.replies.map((c: any) => c.author)).toEqual([owner.email, writer.email]);
  });

  it("AC-CH-03 pages with limit/offset", async () => {
    const r = await timeline(reader, "?limit=2&offset=1", "timeline");
    expect(r.data.posts.map((p: any) => p.body)).toEqual(["second post", "first post"]);
    expect(r.data.pagination).toMatchObject({ total: 3, limit: 2, offset: 1, has_more: false });
  });

  it("AC-CH-03 the channel list carries the post count and last activity", async () => {
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, reader.apiKey);
    const ch = list.data.channels.find((c: any) => c.name === "timeline");
    expect(ch.post_count).toBe(3);
    expect(typeof ch.last_post_at).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CH-04 — write tier on posts, invisibility without read
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-04: readers can't post (403); non-members can't see (404)", () => {
  let threadId: string;

  beforeAll(async () => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    const r = await post(writer, "status: green");
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    threadId = r.data.thread.id;
  });

  it("AC-CH-04 a reader can read the timeline but not post, reply or resolve (REST)", async () => {
    expect((await timeline(reader)).status).toBe(200);
    expect((await post(reader, "can I talk?")).status).toBe(403);
    expect((await reply(reader, threadId, "me too")).status).toBe(403);
    expect(
      (await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${OPS}/annotations/${threadId}/resolve`, {}, reader.apiKey)).status,
    ).toBe(403);
    // The standalone comment store is closed to readers on a channel as well.
    expect(
      (await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${OPS}/comments`, { body: "sneaky" }, reader.apiKey)).status,
    ).toBe(403);
    // Ordinary documents keep read-tier commenting.
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Plain Doc", content: "x" }, writer.apiKey);
    expect((await post(reader, "fine on a doc", "nodes/plain-doc")).status).toBe(201);
  });

  it("AC-CH-04 a reader can't post through MCP context_comment either", async () => {
    const r = await callTool(reader.apiKey, "context_comment", { id: OPS, body: "via mcp" });
    expect(r.isError, r.text).toBe(true);
    expect(r.text.toLowerCase()).toContain("write");
    const r2 = await callTool(reader.apiKey, "context_comment", { id: OPS, body: "via mcp", thread: threadId });
    expect(r2.isError).toBe(true);
    const r3 = await callTool(reader.apiKey, "context_resolve_comment", { id: OPS, thread: threadId });
    expect(r3.isError).toBe(true);
    const tl = await timeline(writer);
    expect(JSON.stringify(tl.data)).not.toContain("via mcp");
  });

  it("AC-CH-04 a writer can post through MCP context_comment", async () => {
    const r = await callTool(writer.apiKey, "context_comment", { id: OPS, body: "posted by mcp" });
    expect(r.isError, r.text).toBe(false);
    const tl = await timeline(writer);
    expect(tl.data.posts[0].body).toBe("posted by mcp");
  });

  it("AC-CH-04 a non-member gets 404 from the list, the timeline and the thread", async () => {
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, stranger.apiKey)).status).toBe(404);
    expect((await timeline(stranger)).status).toBe(404);
    expect((await timeline(stranger, `?thread=${threadId}`)).status).toBe(404);
    expect((await post(stranger, "hello?")).status).toBe(404);
  });

  it("AC-CH-04 a non-member gets nothing over MCP", async () => {
    const r = await callTool(stranger.apiKey, "context_channel_read", { channel: "ops" });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r)).not.toContain("status: green");
  });

  it("AC-CH-04 a non-member's cross-nest doc stream never carries the channel", async () => {
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    try {
      const mine = await jsonRequest(app, "GET", "/me/stream", undefined, writer.apiKey);
      expect(mine.status).toBe(200);
      expect(mine.data.items.map((i: any) => i.nodeId)).toContain(OPS);
      const theirs = await jsonRequest(app, "GET", "/me/stream", undefined, stranger.apiKey);
      expect(theirs.status).toBe(200);
      expect(theirs.data.items.map((i: any) => i.nodeId)).not.toContain(OPS);
      expect(JSON.stringify(theirs.data)).not.toContain(nestId);
    } finally {
      delete process.env.EXPERIMENTAL_DOC_STREAM;
    }
  });

  it("AC-CH-04 a thread id from another channel or nest is not found here", async () => {
    // A thread on an ordinary doc in the same nest.
    const doc = await post(writer, "doc thread", "nodes/plain-doc");
    expect((await timeline(writer, `?thread=${doc.data.thread.id}`)).status).toBe(404);
    // A thread in the stranger's own nest.
    await jsonRequest(app, "POST", `/nests/${otherNestId}/nodes`, { title: "Theirs", content: "x" }, stranger.apiKey);
    const theirs = await jsonRequest(
      app, "POST", `/nests/${otherNestId}/nodes/nodes/theirs/annotations`, { body: "their secret" }, stranger.apiKey,
    );
    expect(theirs.status).toBe(201);
    const r = await timeline(writer, `?thread=${theirs.data.thread.id}`);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.data)).not.toContain("their secret");
    // And a reply aimed at it through this channel's URL doesn't land.
    expect((await reply(writer, theirs.data.thread.id, "crossing over")).status).toBe(404);
  });

  it("AC-CH-04 a read-only API key can read a channel but can't post", async () => {
    const ro = await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: nestId, capability: "read" }, writer.apiKey);
    const roKey = ro.data.key ?? ro.data.apiKey ?? ro.data.api_key;
    expect((await timeline({ apiKey: roKey })).status).toBe(200);
    expect((await post({ apiKey: roKey }, "ro post")).status).toBe(403);
    const mcp = await callTool(roKey, "context_channel_read", { channel: "ops" });
    expect(mcp.isError, mcp.text).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CH-05 — @mention notify, the existing path
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-05: @stacey in a channel post notifies exactly like a doc comment", () => {
  beforeAll(() => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  });

  const mentions = async (u: User) => {
    const { data } = await jsonRequest(app, "GET", "/me/notifications", undefined, u.apiKey);
    return (data.notifications as Array<{ kind: string; node_id: string | null; message: string }>).filter(
      (n) => n.kind === "mention",
    );
  };

  it("AC-CH-05 a post and a reply each land one mention row for stacey on the channel node", async () => {
    const before = (await mentions(stacey)).length;
    const p = await post(writer, "@stacey can you check the release notes?");
    expect(p.status).toBe(201);
    let rows = await mentions(stacey);
    expect(rows.length).toBe(before + 1);
    expect(rows[0].node_id).toBe(OPS);
    expect(rows[0].message).toContain("Writer");

    await reply(owner, p.data.thread.id, "@stacey also the changelog");
    rows = await mentions(stacey);
    expect(rows.length).toBe(before + 2);
  });

  it("AC-CH-05 matches the document-comment path row for row", async () => {
    const before = (await mentions(stacey)).length;
    await post(writer, "@stacey look here", "nodes/plain-doc");
    const docRow = (await mentions(stacey))[0];
    await post(writer, "@stacey look here");
    const chRow = (await mentions(stacey))[0];
    expect((await mentions(stacey)).length).toBe(before + 2);
    expect(chRow.kind).toBe(docRow.kind);
    expect(chRow.node_id).toBe(OPS);
    expect(docRow.node_id).toBe("nodes/plain-doc");
    // Same sentence, only the document named differs.
    for (const row of [docRow, chRow]) expect(row.message).toContain("Writer mentioned you in a comment on");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CH-06 — "grok, on behalf of <human>"
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-06: an agent's message shows '<agent>, on behalf of <human>'", () => {
  let grokKey: string;

  beforeAll(async () => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "agent-room" }, writer.apiKey);
    grokKey = await mintKey(writer, "grok");
  });

  const latest = async () => (await timeline(writer, "", "agent-room")).data.posts[0];

  it("AC-CH-06 REST with an API key labelled grok", async () => {
    expect((await post({ apiKey: grokKey }, "grok reporting in", "nodes/channels/agent-room")).status).toBe(201);
    const p = await latest();
    expect(p.body).toBe("grok reporting in");
    expect(p.author).toBe(writer.email);
    expect(p.actor).toEqual({ human: writer.email, agent: "grok", label: `grok, on behalf of ${writer.email}` });
  });

  it("AC-CH-06 MCP context_comment with the grok key", async () => {
    const r = await callTool(grokKey, "context_comment", { id: "nodes/channels/agent-room", body: "grok via mcp" });
    expect(r.isError, r.text).toBe(false);
    const p = await latest();
    expect(p.body).toBe("grok via mcp");
    expect(p.actor.label).toBe(`grok, on behalf of ${writer.email}`);
  });

  it("AC-CH-06 MCP client.agent (what clientInfo.name feeds) names the agent", async () => {
    const plain = await mintKey(writer, "laptop");
    await tick();
    const r = await callTool(plain, "context_comment", {
      id: "nodes/channels/agent-room",
      body: "muse here",
      client: { agent: "grok" },
    });
    expect(r.isError, r.text).toBe(false);
    expect((await latest()).actor).toMatchObject({ agent: "grok", human: writer.email });
  });

  it("AC-CH-06 a reply carries its own attribution", async () => {
    const p = await latest();
    await tick();
    expect((await reply({ apiKey: grokKey }, p.id, "grok replying", "nodes/channels/agent-room")).status).toBe(200);
    const t = await timeline(writer, `?thread=${p.id}`, "agent-room");
    expect(t.data.thread.replies.at(-1).actor.label).toBe(`grok, on behalf of ${writer.email}`);
  });

  it("AC-CH-06 a person in the browser shows as themselves only", async () => {
    await tick();
    const res = await app.request(`/nests/${nestId}/nodes/nodes/channels/agent-room/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: writer.cookie },
      body: JSON.stringify({ body: "typed by a human" }),
    });
    expect(res.status).toBe(201);
    const p = await latest();
    expect(p.body).toBe("typed by a human");
    expect(p.actor).toEqual({ human: writer.email, agent: null, label: writer.email });
  });

  it("AC-CH-06 resolveActorLabel is the one seam (identity work swaps it)", async () => {
    const { resolveActorLabel } = await import("../src/channels/actor-label.js");
    expect(await resolveActorLabel({ email: "a@x.test", client: { agent: "grok" } })).toEqual({
      human: "a@x.test",
      agent: "grok",
      label: "grok, on behalf of a@x.test",
    });
    expect(await resolveActorLabel({ email: "a@x.test" })).toEqual({ human: "a@x.test", agent: null, label: "a@x.test" });
    expect((await resolveActorLabel({ email: "a@x.test", client: { agent: "   " } })).agent).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CH-07 — MCP ↔ REST parity
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-07: context_channel_read matches the REST response", () => {
  let threadId: string;

  beforeAll(async () => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "parity" }, writer.apiKey);
    const p = await post(writer, "parity post", "nodes/channels/parity");
    threadId = p.data.thread.id;
    await reply(owner, threadId, "parity reply", "nodes/channels/parity");
    await post(writer, "another post", "nodes/channels/parity");
  });

  it("AC-CH-07 timeline: structuredContent equals the REST body", async () => {
    const rest = await timeline(reader, "", "parity");
    const mcp = await callTool(reader.apiKey, "context_channel_read", { channel: "parity" });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data).toEqual(rest.data);
    expect(mcp.text).toContain("parity post");
  });

  it("AC-CH-07 one thread: structuredContent equals the REST body", async () => {
    const rest = await timeline(reader, `?thread=${threadId}`, "parity");
    const mcp = await callTool(reader.apiKey, "context_channel_read", { channel: "parity", thread: threadId });
    expect(mcp.data).toEqual(rest.data);
    expect(mcp.text).toContain("parity reply");
  });

  it("AC-CH-07 paging matches too", async () => {
    const rest = await timeline(reader, "?limit=1&offset=1", "parity");
    const mcp = await callTool(reader.apiKey, "context_channel_read", { channel: "parity", limit: 1, offset: 1 });
    expect(mcp.data).toEqual(rest.data);
  });

  it("AC-CH-07 context_channels lists and creates like REST", async () => {
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, reader.apiKey);
    const mcp = await callTool(reader.apiKey, "context_channels", {});
    expect(mcp.data).toEqual(rest.data);
    const made = await callTool(writer.apiKey, "context_channels", { action: "create", name: "from-mcp", purpose: "made by an agent" });
    expect(made.isError, made.text).toBe(false);
    expect(made.data.channel).toMatchObject({ id: "nodes/channels/from-mcp", type: "channel" });
    const refused = await callTool(reader.apiKey, "context_channels", { action: "create", name: "nope" });
    expect(refused.isError).toBe(true);
    const missing = await callTool(reader.apiKey, "context_channel_read", { channel: "no-such-channel" });
    expect(missing.isError).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CH-08 — a channel is an ordinary node
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-08: a channel is an ordinary node whose body is its purpose", () => {
  beforeAll(() => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  });

  it("AC-CH-08 REST node list + read show it as a node; body holds the purpose", async () => {
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, writer.apiKey);
    expect(list.status).toBe(200);
    const nodes = (list.data.nodes ?? list.data.documents ?? list.data) as Array<{ id: string; tags?: string[] }>;
    const ch = nodes.find((n) => n.id === OPS);
    expect(ch, JSON.stringify(nodes.map((n) => n.id))).toBeTruthy();
    const one = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${OPS}`, undefined, writer.apiKey);
    expect(one.status).toBe(200);
    const body = one.data.node?.content ?? one.data.content ?? one.data.node?.body;
    expect(String(body)).toContain("Where the agents coordinate releases.");
  });

  it("AC-CH-08 MCP context_list shows it, with the switch on or off", async () => {
    // context_list names nodes by title; the channel is "#ops", a document.
    const on = await callTool(writer.apiKey, "context_list", {});
    expect(on.text).toContain("**#ops** [document]");
    delete process.env.EXPERIMENTAL_AGENT_STREAM;
    try {
      const off = await callTool(writer.apiKey, "context_list", {});
      expect(off.text).toContain("**#ops** [document]");
    } finally {
      process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Security review: side doors that open comment threads without the routes
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-04 security: no side door posts into a channel", () => {
  beforeAll(() => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  });

  it("AC-CH-04 a public docs-site comment on a published channel is refused", async () => {
    const created = await jsonRequest(
      app, "POST", `/nests/${nestId}/publications`,
      { node_id: OPS, access_mode: "public", comments_enabled: true },
      owner.apiKey,
    );
    expect(created.status, JSON.stringify(created.data)).toBeLessThan(300);
    const slug = created.data.publish.slug;
    const sent = await app.request(`/p/${slug}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "outsider@else.test", body: "hi from the web" }),
    });
    expect(sent.status).toBe(404);
    const tl = await timeline(writer);
    expect(JSON.stringify(tl.data)).not.toContain("hi from the web");
  });

  it("AC-CH-04 the shared guard refuses a persona/agent identity with no write access", async () => {
    const { channelPostRefusal, isChannelNode } = await import("../src/channels/channel-service.js");
    expect(await isChannelNode(nestId, OPS)).toBe(true);
    expect(await isChannelNode(nestId, "nodes/plain-doc")).toBe(false);
    const r = await channelPostRefusal(nestId, OPS, reader.userId, reader.email);
    expect(r?.status).toBe(403);
    expect(await channelPostRefusal(nestId, OPS, writer.userId, writer.email)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// License gate — channel reads are a governance-adjacent view (real license)
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-CH-04 license gate: unlicensed past the Free tier → 503 (license module NOT mocked)", () => {
  let lenv: ReturnType<typeof setupTestEnv>;
  let lapp: any;

  beforeAll(async () => {
    lenv = setupTestEnv();
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    process.env.AUTH_MODE = "open";
    vi.resetModules();
    vi.doUnmock("../src/auth/license.js");
    const dbClient = await import("../src/db/client.js");
    await dbClient.resetDb();
    await dbClient.initDb();
    await seedPeople(FREE_TIER_MAX_USERS + 1);
    const { createApp } = await import("../src/app.js");
    lapp = createApp();
  });

  afterAll(async () => {
    delete process.env.EXPERIMENTAL_AGENT_STREAM;
    await lenv.cleanup();
  });

  it("AC-CH-04 GET /channels and the timeline answer the same 503 /feed does", async () => {
    const feed = await lapp.request("/nests/some-nest/feed");
    expect(feed.status).toBe(503);
    const feedBody = await feed.json();
    const list = await lapp.request("/nests/some-nest/channels");
    expect(list.status).toBe(503);
    expect(await list.json()).toEqual(feedBody);
    const tl = await lapp.request("/nests/some-nest/channels/ops");
    expect(tl.status).toBe(503);
  });

  it("AC-CH-01 still 404s when the switch is off, licensed or not", async () => {
    delete process.env.EXPERIMENTAL_AGENT_STREAM;
    expect((await lapp.request("/nests/some-nest/channels")).status).toBe(404);
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  });
});
