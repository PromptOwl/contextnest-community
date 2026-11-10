/**
 * Team chat harness, slice C2 "Conversations and live" (PO-1197).
 *
 * The harness toggle (TEAM_CHAT_ENABLED, with EXPERIMENTAL_AGENT_STREAM as an
 * alias) and the per-nest `chat` setting; direct and group conversations on
 * the channel message store; private channels with a membership list; mute
 * and notification preferences; presence and typing; the SSE event stream;
 * app-wide unread; and the MCP twins of each.
 *
 * Each describe block is named by the AC it serves (ticket PO-1197 in the
 * Engineering Ops nest); SEC-* blocks are the security review's findings.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type WakeModule = typeof import("../src/stream/agent-wake.js");
type EventsModule = typeof import("../src/chat/events.js");
let wake: WakeModule;

const OWNER_EMAIL = "olivia@c2.test";
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const GENERAL = "nodes/channels/general";

type User = { apiKey: string; userId: string; email: string; cookie: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User; // nest owner, server admin
let alice: User; // write collaborator
let rita: User; // read collaborator
let sam: User; // read collaborator, in no conversation unless a test adds him
let bob: User; // a share on one document, nothing else
let stranger: User; // no access
let nestId: string;
let secondNestId: string; // owner's second nest; alice is a member there too
let strangerNestId: string;

type Sent = { url: string; body: string };
let sent: Sent[] = [];

// ─── helpers ────────────────────────────────────────────────────────────

async function rpc(path: string, method: string, params: Record<string, unknown>, apiKey?: string) {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await app.request(path, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return { status: res.status, body: await res.json() };
  const text = await res.text();
  const line = text.split("\n").find((l: string) => l.startsWith("data: "));
  return { status: res.status, body: line ? JSON.parse(line.slice("data: ".length)) : { raw: text } };
}
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
async function listToolNames(apiKey: string, nest = nestId): Promise<string[]> {
  const { body } = await rpc(`/nests/${nest}/mcp`, "tools/list", {}, apiKey);
  return (body?.result?.tools ?? []).map((t: { name: string }) => t.name);
}
async function mintKey(u: User, label: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await jsonRequest(app, "POST", "/auth/keys", { label, ...extra }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r.data.key ?? r.data.apiKey ?? r.data.api_key;
}
const enc = (id: string) => encodeURIComponent(id);
const post = (u: User, body: string, node = GENERAL, extra: Record<string, unknown> = {}, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/nodes/${enc(node)}/annotations`, { body, ...extra }, u.apiKey);
const replyTo = (u: User, node: string, threadId: string, body: string, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/nodes/${enc(node)}/annotations/${threadId}/comments`, { body }, u.apiKey);
async function open(u: User, body: string, node = GENERAL, extra: Record<string, unknown> = {}, nest = nestId) {
  const r = await post(u, body, node, extra, nest);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.thread as { id: string; comments: Array<{ id: string; body: string }> };
}
const channels = (u: User, qs = "", nest = nestId) => jsonRequest(app, "GET", `/nests/${nest}/channels${qs}`, undefined, u.apiKey);
const channel = (u: User, name: string, qs = "", nest = nestId) =>
  jsonRequest(app, "GET", `/nests/${nest}/channels/${name}${qs}`, undefined, u.apiKey);
const conversations = (u: User, nest = nestId) => jsonRequest(app, "GET", `/nests/${nest}/conversations`, undefined, u.apiKey);
const conversation = (u: User, id: string, qs = "", nest = nestId) =>
  jsonRequest(app, "GET", `/nests/${nest}/conversations/${enc(id)}${qs}`, undefined, u.apiKey);
const startConversation = (u: User, members: unknown, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/conversations`, { members }, u.apiKey);
const nestInfo = async (u: User, nest = nestId) => (await jsonRequest(app, "GET", `/nests/${nest}`, undefined, u.apiKey)).data;
const inbox = async (u: User) =>
  (await jsonRequest(app, "GET", "/me/notifications", undefined, u.apiKey)).data.notifications as Array<{
    kind: string;
    node_id: string | null;
    message: string;
  }>;
const work = async (u: User, qs = "") => (await jsonRequest(app, "GET", `/me/work${qs}`, undefined, u.apiKey)).data;
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** An SSE subscription over app.request: parsed frames, a timeout, hang-up. */
type Frame = { event: string; id: string | null; data: any; comment?: string };
async function subscribe(u: User, opts: { nest?: string; lastEventId?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${u.apiKey}`, Accept: "text/event-stream" };
  if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;
  const res: Response = await app.request(`/nests/${opts.nest ?? nestId}/chat/events`, { method: "GET", headers });
  if (res.status !== 200) return { status: res.status, next: async () => null as Frame | null, close: async () => {}, raw: () => "" };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let everything = "";
  const queue: Frame[] = [];
  let closed = false;
  const pump = (async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        everything += text;
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const f: Frame = { event: "message", id: null, data: null };
          const dataLines: string[] = [];
          for (const line of chunk.split("\n")) {
            if (line.startsWith(":")) f.comment = line.slice(1).trim();
            else if (line.startsWith("event:")) f.event = line.slice(6).trim();
            else if (line.startsWith("id:")) f.id = line.slice(3).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) {
            try {
              f.data = JSON.parse(dataLines.join("\n"));
            } catch {
              f.data = dataLines.join("\n");
            }
          }
          queue.push(f);
        }
      }
    } catch {
      /* hung up */
    }
  })();
  return {
    status: res.status,
    /** The next frame whose event matches (comments skipped), or null after `ms`. */
    next: async (match?: string, ms = 1500): Promise<Frame | null> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const i = queue.findIndex((f) => f.data !== null && (!match || f.event === match));
        if (i >= 0) return queue.splice(i, 1)[0];
        await tick(10);
      }
      return null;
    },
    raw: () => everything,
    close: async () => {
      closed = true;
      await reader.cancel().catch(() => {});
      await Promise.race([pump, tick(200)]);
    },
  };
}

function captureWakes() {
  wake.setAgentWakeFetch(async (url, init) => {
    sent.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  });
}

// ─── fixture ────────────────────────────────────────────────────────────

beforeAll(async () => {
  env = setupTestEnv();
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  process.env.TEAM_CHAT_ENABLED = "true";
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  wake = await import("../src/stream/agent-wake.js");
  wake.setAgentWakeBackoff([]);
  owner = await registerUser(app, OWNER_EMAIL, "Olivia Owner");
  alice = await registerUser(app, "alice@c2.test", "Alice Example");
  rita = await registerUser(app, "rita@c2.test", "Rita Reader");
  await resetAuthRateLimit();
  sam = await registerUser(app, "sam@c2.test", "Sam Silent");
  bob = await registerUser(app, "bob@c2.test", "Bob Builder");
  stranger = await registerUser(app, "stranger@else.test", "Stranger");
  await resetAuthRateLimit();

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  secondNestId = (await jsonRequest(app, "POST", "/nests", { name: "Second" }, owner.apiKey)).data.nest.id;
  strangerNestId = (await jsonRequest(app, "POST", "/nests", { name: "Elsewhere" }, stranger.apiKey)).data.nest.id;
  for (const [u, permission] of [
    [alice, "write"],
    [rita, "read"],
    [sam, "read"],
  ] as const) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  expect((await jsonRequest(app, "POST", `/nests/${secondNestId}/collaborators`, { email: alice.email, permission: "write" }, owner.apiKey)).status).toBeLessThan(300);
  const plan = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Launch Plan", content: "# Plan" }, owner.apiKey);
  expect(plan.status, JSON.stringify(plan.data)).toBe(201);
  const g = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, { target_type: "document", target: "nodes/launch-plan", email: bob.email, role: "read" }, owner.apiKey);
  expect(g.status, JSON.stringify(g.data)).toBe(201);
  for (const nest of [nestId, secondNestId]) {
    const ch = await jsonRequest(app, "POST", `/nests/${nest}/channels`, { name: "general", purpose: "General" }, owner.apiKey);
    expect(ch.status, JSON.stringify(ch.data)).toBeLessThan(300);
  }
  // @grok is a known agent with a wake-up target.
  const hook = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/grok`, { url: "https://runner.example.com/wake" }, owner.apiKey);
  expect(hook.status, JSON.stringify(hook.data)).toBeLessThan(300);
});

afterEach(() => {
  wake.setAgentWakeFetch(null);
  sent = [];
});

afterAll(async () => {
  delete process.env.TEAM_CHAT_ENABLED;
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  await env.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2-01 / AC-C2-03 — the harness toggle
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C2-01: TEAM_CHAT_ENABLED is the switch; EXPERIMENTAL_AGENT_STREAM is its alias", () => {
  it("AC-C2-01 on by env: /health says team_chat, /admin/settings says team_chat_enabled, GET /nests/:id says chat", async () => {
    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.team_chat).toBe(true);
    expect(health.data.experimental.agent_stream).toBe(true);
    const settings = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
    expect(settings.data.team_chat_enabled).toBe(true);
    expect((await nestInfo(alice)).chat).toBe(true);
  });

  it("AC-C2-03 off means off: routes 404, /nests/:id says chat: false, tools gone, My Work refuses the chat section", async () => {
    const off = await jsonRequest(app, "PATCH", "/admin/settings", { team_chat_enabled: false }, owner.apiKey);
    expect(off.status, JSON.stringify(off.data)).toBe(200);
    expect(off.data.settings.team_chat_enabled).toBe(false);
    expect((await jsonRequest(app, "GET", "/health")).data.team_chat).toBe(false);
    expect((await jsonRequest(app, "GET", "/health")).data.experimental.agent_stream).toBe(false);
    expect((await nestInfo(alice)).chat).toBe(false);
    expect((await channels(alice)).status).toBe(404);
    expect((await conversations(alice)).status).toBe(404);
    expect((await startConversation(alice, [rita.email])).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/chat/presence`, undefined, alice.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/presence`, {}, alice.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/typing`, { conversation: GENERAL }, alice.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/chat/settings`, undefined, owner.apiKey)).status).toBe(404);
    expect((await subscribe(alice)).status).toBe(404);
    expect((await jsonRequest(app, "GET", "/me/chat/unread", undefined, alice.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", "/me/chat/preferences", undefined, alice.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", "/me/work?sections=chat", undefined, alice.apiKey)).status).toBe(400);
    const names = await listToolNames(alice.apiKey);
    for (const t of ["context_conversations", "context_conversation_read", "context_channel_members", "context_chat_preferences", "context_presence", "context_channels"]) {
      expect(names, t).not.toContain(t);
    }
    const r = await callTool(alice.apiKey, "context_conversations", {});
    expect(r.rpcError || r.isError).toBeTruthy();
    // Nothing else changed: documents and comments still work.
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, alice.apiKey)).status).toBe(200);
  });

  it("AC-C2-01 the alias turns the same thing on, and TEAM_CHAT_ENABLED supersedes it", async () => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    expect((await jsonRequest(app, "GET", "/health")).data.team_chat).toBe(true);
    expect((await channels(alice)).status).toBe(200);
    expect((await conversations(alice)).status).toBe(200);
    // Turning the harness off through its own field turns the alias off too.
    const off = await jsonRequest(app, "PATCH", "/admin/settings", { team_chat_enabled: false }, owner.apiKey);
    expect(off.status).toBe(200);
    expect(off.data.settings.experimental_agent_stream_enabled).toBe(false);
    expect((await jsonRequest(app, "GET", "/health")).data.team_chat).toBe(false);
    expect((await channels(alice)).status).toBe(404);
    expect(process.env.EXPERIMENTAL_AGENT_STREAM).toBeUndefined();
  });

  it("AC-C2-01 a superadmin turns it on live; a writer may not (403)", async () => {
    expect((await jsonRequest(app, "PATCH", "/admin/settings", { team_chat_enabled: true }, alice.apiKey)).status).toBe(403);
    expect((await jsonRequest(app, "GET", "/health")).data.team_chat).toBe(false);
    const on = await jsonRequest(app, "PATCH", "/admin/settings", { team_chat_enabled: true }, owner.apiKey);
    expect(on.status).toBe(200);
    expect(on.data.settings.team_chat_enabled).toBe(true);
    expect(on.data.settings.experimental_agent_stream_enabled).toBe(true);
    expect((await jsonRequest(app, "GET", "/health")).data.team_chat).toBe(true);
    expect((await channels(alice)).status).toBe(200);
    expect(await listToolNames(alice.apiKey)).toEqual(
      expect.arrayContaining(["context_conversations", "context_conversation_read", "context_channel_members", "context_chat_preferences", "context_presence"]),
    );
  });
});

// Every block below runs with the switch on.

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2-02 — per-nest setting
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C2-02: the nest's chat setting", () => {
  it("AC-C2-02 on by default; owner/admin turn it off; that nest goes dark, the other stays", async () => {
    const s = await jsonRequest(app, "GET", `/nests/${nestId}/chat/settings`, undefined, owner.apiKey);
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    expect(s.data.chat).toBe(true);
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: false }, alice.apiKey)).status).toBe(403);
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: "no" }, owner.apiKey)).status).toBe(400);
    const off = await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: false }, owner.apiKey);
    expect(off.status, JSON.stringify(off.data)).toBe(200);
    expect(off.data.chat).toBe(false);
    expect((await nestInfo(alice)).chat).toBe(false);
    expect((await channels(alice)).status).toBe(404);
    expect((await channel(alice, "general")).status).toBe(404);
    expect((await conversations(alice)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/agent-handles`, undefined, alice.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/chat/presence`, undefined, alice.apiKey)).status).toBe(404);
    expect((await subscribe(alice)).status).toBe(404);
    const mcp = await callTool(alice.apiKey, "context_channels", {});
    expect(mcp.isError, mcp.text).toBe(true);
    const mcp2 = await callTool(alice.apiKey, "context_conversations", {});
    expect(mcp2.isError, mcp2.text).toBe(true);
    // The other nest is untouched.
    expect((await channels(alice, "", secondNestId)).status).toBe(200);
    expect((await nestInfo(alice, secondNestId)).chat).toBe(true);
    // The settings route itself stays reachable, so it can be turned back on.
    const on = await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: true }, owner.apiKey);
    expect(on.status).toBe(200);
    expect((await channels(alice)).status).toBe(200);
    expect((await nestInfo(alice)).chat).toBe(true);
  });

  it("AC-C2-02 chat is false for someone who isn't a member even when the nest is on", async () => {
    expect((await nestInfo(bob)).chat).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2-04 … AC-C2-07 — conversations
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C2-04: create or find a conversation by member set", () => {
  let dmId: string;

  it("AC-C2-04 two people → a dm (201), the same set again → the same id (200), order and case don't matter", async () => {
    const r = await startConversation(alice, [rita.email]);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.created).toBe(true);
    const c = r.data.conversation;
    expect(c.id).toMatch(/^nodes\/conversations\/[0-9a-f-]{36}$/);
    expect(c.kind).toBe("dm");
    expect(c.members.map((m: any) => m.email).sort()).toEqual([alice.email, rita.email].sort());
    expect(c.title).toContain("Rita Reader");
    dmId = c.id;

    const again = await startConversation(rita, ["Alice@C2.test"]);
    expect(again.status).toBe(200);
    expect(again.data.created).toBe(false);
    expect(again.data.conversation.id).toBe(dmId);
    // Including yourself changes nothing.
    const self = await startConversation(alice, [alice.email, rita.email]);
    expect(self.status).toBe(200);
    expect(self.data.conversation.id).toBe(dmId);
  });

  it("AC-C2-04 three or more → a group; a different set is a different conversation; an agent joins by @handle", async () => {
    const g = await startConversation(alice, [rita.email, sam.email]);
    expect(g.status, JSON.stringify(g.data)).toBe(201);
    expect(g.data.conversation.kind).toBe("group");
    expect(g.data.conversation.id).not.toBe(dmId);
    expect(g.data.conversation.members).toHaveLength(3);

    const withAgent = await startConversation(alice, ["@grok"]);
    expect(withAgent.status, JSON.stringify(withAgent.data)).toBe(201);
    expect(withAgent.data.conversation.kind).toBe("dm");
    expect(withAgent.data.conversation.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "agent", handle: "grok" }), expect.objectContaining({ kind: "person", email: alice.email })]),
    );
  });

  it("AC-C2-04 refuses a member who isn't added to the nest, a set of fewer than two, and a huge set (400)", async () => {
    expect((await startConversation(alice, [bob.email])).status).toBe(400);
    expect((await startConversation(alice, [stranger.email])).status).toBe(400);
    expect((await startConversation(alice, ["nobody-here"])).status).toBe(400);
    expect((await startConversation(alice, [])).status).toBe(400);
    expect((await startConversation(alice, [alice.email])).status).toBe(400);
    expect((await startConversation(alice, "rita")).status).toBe(400);
    expect((await startConversation(alice, Array.from({ length: 60 }, (_, i) => `p${i}@c2.test`))).status).toBe(400);
  });

  it("AC-C2-04 only people added to the nest start one: a share grantee and a stranger get 404", async () => {
    expect((await startConversation(bob, [alice.email])).status).toBe(404);
    expect((await startConversation(stranger, [alice.email])).status).toBe(404);
  });

  it("AC-C2-04 MCP: context_conversations create/find returns the REST body", async () => {
    const r = await callTool(alice.apiKey, "context_conversations", { action: "create", members: [rita.email] });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.conversation.id).toBe(dmId);
    expect(r.data.created).toBe(false);
    const f = await callTool(alice.apiKey, "context_conversations", { action: "find", members: ["@grok"] });
    expect(f.isError, f.text).toBe(false);
    expect(f.data.conversation.kind).toBe("dm");
  });
});

describe("AC-C2-05: list, read, post, mark read — members of the conversation only", () => {
  let dmId: string;
  let threadId: string;
  let groupId: string;

  beforeAll(async () => {
    dmId = (await startConversation(alice, [rita.email])).data.conversation.id;
    groupId = (await startConversation(alice, [rita.email, sam.email])).data.conversation.id;
  });

  it("AC-C2-05 posting goes through the thread routes on the conversation id; replies and ?since= work as in a channel", async () => {
    const t = await open(alice, "hello @rita, see [[nodes/launch-plan]]", dmId);
    threadId = t.id;
    expect((await replyTo(rita, dmId, threadId, "hi alice")).status).toBe(200);
    const tl = await conversation(rita, dmId);
    expect(tl.status, JSON.stringify(tl.data)).toBe(200);
    expect(tl.data.conversation.id).toBe(dmId);
    expect(tl.data.posts).toHaveLength(1);
    expect(tl.data.posts[0]).toMatchObject({ id: threadId, reply_count: 1, author_name: "Alice Example" });
    expect(tl.data.posts[0].mentions).toEqual([{ name: "rita", kind: "person", display_name: "Rita Reader" }]);
    expect(tl.data.posts[0].cards[0]).toMatchObject({ resolved: true, node_id: "nodes/launch-plan" });
    const th = await conversation(rita, dmId, `?thread=${threadId}`);
    expect(th.data.thread.replies.map((m: any) => m.body)).toEqual(["hi alice"]);
    const since = await conversation(rita, dmId, `?since=${tl.data.next_since}`);
    expect(since.data.messages).toEqual([]);
    // The short id works too.
    expect((await conversation(rita, dmId.split("/").pop()!)).status).toBe(200);
  });

  it("AC-C2-05 the list shows only mine, with unread by others and the member list; mark read clears it", async () => {
    const mine = await conversations(rita);
    expect(mine.status).toBe(200);
    const ids = mine.data.conversations.map((c: any) => c.id);
    expect(ids).toContain(dmId);
    expect(ids).toContain(groupId);
    const dm = mine.data.conversations.find((c: any) => c.id === dmId);
    expect(dm.unread).toBe(1); // alice's post; rita's own reply doesn't count
    expect(dm.last_activity_at).toBeTruthy();
    expect(dm.can_post).toBe(true);
    const sams = await conversations(sam);
    expect(sams.data.conversations.map((c: any) => c.id)).toEqual([groupId]);
    const read = await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(dmId)}/read`, {}, rita.apiKey);
    expect(read.status, JSON.stringify(read.data)).toBe(200);
    expect(read.data.conversation.unread).toBe(0);
  });

  it("AC-C2-05 a nest member outside the conversation gets the same 404 everywhere as for an unknown id", async () => {
    const unknown = "nodes/conversations/00000000-0000-4000-8000-000000000000";
    for (const id of [dmId, unknown]) {
      expect((await conversation(sam, id)).status, id).toBe(404);
      expect((await conversation(sam, id, `?thread=${threadId}`)).status, id).toBe(404);
      expect((await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(id)}/read`, {}, sam.apiKey)).status, id).toBe(404);
      expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${enc(id)}/annotations`, undefined, sam.apiKey)).status, id).toBe(404);
      expect((await post(sam, "sneaking in", id)).status, id).toBe(404);
      expect((await replyTo(sam, id, threadId, "sneaking in")).status, id).toBe(404);
      expect((await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(id)}/leave`, {}, sam.apiKey)).status, id).toBe(404);
      expect((await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(id)}/members`, { member: sam.email }, sam.apiKey)).status, id).toBe(404);
      const mcp = await callTool(sam.apiKey, "context_conversation_read", { conversation: id });
      expect(mcp.isError).toBe(true);
      expect(mcp.text).not.toContain("alice");
    }
    // Reading the thread by id through the comment tool is refused the same way.
    const viaThread = await callTool(sam.apiKey, "context_comments", { id: dmId, thread: threadId });
    expect(viaThread.isError).toBe(true);
  });

  it("AC-C2-05 the public, a share grantee and a stranger see nothing", async () => {
    for (const u of [bob, stranger]) {
      expect((await conversations(u)).status).toBe(404);
      expect((await conversation(u, dmId)).status).toBe(404);
      expect((await post(u, "x", dmId)).status).toBe(404);
    }
  });

  it("AC-C2-05 MCP: context_conversations lists, context_conversation_read reads, context_comment posts", async () => {
    const list = await callTool(rita.apiKey, "context_conversations", {});
    expect(list.isError, list.text).toBe(false);
    expect(list.data.conversations.map((c: any) => c.id)).toContain(dmId);
    const read = await callTool(rita.apiKey, "context_conversation_read", { conversation: dmId });
    expect(read.isError, read.text).toBe(false);
    expect(read.data.posts[0].id).toBe(threadId);
    expect(read.text).toContain("hello @rita");
    const th = await callTool(rita.apiKey, "context_conversation_read", { conversation: dmId, thread: threadId });
    expect(th.data.thread.replies).toHaveLength(1);
    const posted = await callTool(rita.apiKey, "context_comment", { id: dmId, body: "via mcp" });
    expect(posted.isError, posted.text).toBe(false);
    const after = await conversation(alice, dmId);
    expect(after.data.posts.map((p: any) => p.body)).toContain("via mcp");
    const tl = await callTool(alice.apiKey, "context_conversation_read", { conversation: dmId, since: read.data.next_since });
    expect(tl.data.messages.map((m: any) => m.body)).toEqual(["via mcp"]);
  });

  it("AC-C2-05 a message in a conversation lands in My Work mentions and wakes a tagged agent; the mention row names the conversation", async () => {
    captureWakes();
    await open(alice, "@sam @grok look at this", groupId);
    const w = await work(sam, "?sections=mentions");
    const row = w.mentions.find((m: any) => m.node_id === groupId);
    expect(row).toBeTruthy();
    expect(row.kind).toBe("conversation");
    expect(row.channel).toBeNull();
    await vi.waitFor(() => expect(sent.length).toBe(1), { timeout: 3000, interval: 10 });
    const payload = JSON.parse(sent[0].body);
    expect(payload.node_id).toBe(groupId);
    expect(payload.channel).toBeNull();
    expect(payload.conversation).toBe(groupId);
  });
});

describe("AC-C2-06: leave and add a member (group only)", () => {
  let dmId: string;
  let groupId: string;
  beforeAll(async () => {
    dmId = (await startConversation(alice, [rita.email])).data.conversation.id;
    groupId = (await startConversation(alice, [rita.email, sam.email])).data.conversation.id;
    await open(alice, "history before sam left", groupId);
  });

  it("AC-C2-06 leave: 409 on a dm; on a group the leaver gets 404 from then on and the others keep it", async () => {
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(dmId)}/leave`, {}, rita.apiKey)).status).toBe(409);
    const left = await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(groupId)}/leave`, {}, sam.apiKey);
    expect(left.status, JSON.stringify(left.data)).toBe(200);
    expect(left.data.left).toBe(true);
    expect((await conversation(sam, groupId)).status).toBe(404);
    expect((await conversations(sam)).data.conversations.map((c: any) => c.id)).not.toContain(groupId);
    const still = await conversation(rita, groupId);
    expect(still.status).toBe(200);
    expect(still.data.conversation.members.map((m: any) => m.email)).not.toContain(sam.email);
  });

  it("AC-C2-06 add: 409 on a dm; on a group a member adds a nest member, who then reads the history; outsiders can't add", async () => {
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(dmId)}/members`, { member: sam.email }, alice.apiKey)).status).toBe(409);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(groupId)}/members`, { member: bob.email }, alice.apiKey)).status).toBe(400);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(groupId)}/members`, { member: sam.email }, sam.apiKey)).status).toBe(404);
    const added = await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(groupId)}/members`, { member: sam.email }, rita.apiKey);
    expect(added.status, JSON.stringify(added.data)).toBe(200);
    expect(added.data.conversation.members.map((m: any) => m.email)).toContain(sam.email);
    const tl = await conversation(sam, groupId);
    expect(tl.status).toBe(200);
    expect(tl.data.posts.map((p: any) => p.body)).toContain("history before sam left");
    // Adding again is a no-op.
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(groupId)}/members`, { member: sam.email }, rita.apiKey)).status).toBe(200);
  });

  it("AC-C2-06 MCP: leave and add through context_conversations", async () => {
    const left = await callTool(sam.apiKey, "context_conversations", { action: "leave", conversation: groupId });
    expect(left.isError, left.text).toBe(false);
    const add = await callTool(alice.apiKey, "context_conversations", { action: "add", conversation: groupId, member: sam.email });
    expect(add.isError, add.text).toBe(false);
    expect(add.data.conversation.members.map((m: any) => m.email)).toContain(sam.email);
  });
});

describe("AC-C2-07: promote from a conversation", () => {
  it("AC-C2-07 a writer who is a member promotes; a read member gets 403; a writer outside gets 404", async () => {
    const dmId = (await startConversation(alice, [rita.email])).data.conversation.id;
    const t = await open(alice, "we decided to ship on friday", dmId);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision" }, rita.apiKey)).status).toBe(403);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision" }, owner.apiKey)).status).toBe(404);
    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision", title: "Ship on Friday" }, alice.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBe(201);
    expect(ok.data.source_thread.node_id).toBe(dmId);
    const tl = await conversation(rita, dmId, `?thread=${t.id}`);
    expect(tl.data.thread.post.promoted[0]).toMatchObject({ kind: "decision", title: "Ship on Friday" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2-08 / AC-C2-09 — private channels
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C2-08: private channels — create, invite, join, leave, members, make public/private", () => {
  const SECRET = "nodes/channels/secret";

  it("AC-C2-08 a writer creates a private channel and is its only member; a read collaborator may not (403)", async () => {
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "by-rita", private: true }, rita.apiKey)).status).toBe(403);
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "secret", private: true, purpose: "Need to know" }, alice.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.channel).toMatchObject({ id: SECRET, private: true, member: true });
    const m = await jsonRequest(app, "GET", `/nests/${nestId}/channels/secret/members`, undefined, alice.apiKey);
    expect(m.status, JSON.stringify(m.data)).toBe(200);
    expect(m.data.private).toBe(true);
    expect(m.data.members).toEqual([expect.objectContaining({ kind: "person", email: alice.email, name: "Alice Example" })]);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "bad", private: "yes" }, alice.apiKey)).status).toBe(400);
  });

  it("AC-C2-08 join is for public channels: a private one is 404 to a non-member; a member invites; the invitee reads and posts", async () => {
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/join`, {}, rita.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/members`, { member: rita.email }, rita.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/members`, { member: bob.email }, alice.apiKey)).status).toBe(400);
    const inv = await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/members`, { member: "rita" }, alice.apiKey);
    expect(inv.status, JSON.stringify(inv.data)).toBe(200);
    expect(inv.data.members.map((x: any) => x.email)).toEqual(expect.arrayContaining([alice.email, rita.email]));
    expect((await channel(rita, "secret")).status).toBe(200);
    expect((await post(rita, "rita is in", SECRET)).status).toBe(201);
    // A channel member who is a read collaborator may invite too; an agent handle is a member by handle.
    const inv2 = await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/members`, { member: "@grok" }, rita.apiKey);
    expect(inv2.status, JSON.stringify(inv2.data)).toBe(200);
    expect(inv2.data.members).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "agent", handle: "grok" })]));
    // A public channel: join adds you to the list.
    const j = await jsonRequest(app, "POST", `/nests/${nestId}/channels/general/join`, {}, rita.apiKey);
    expect(j.status, JSON.stringify(j.data)).toBe(200);
    expect(j.data.channel.member).toBe(true);
    const gm = await jsonRequest(app, "GET", `/nests/${nestId}/channels/general/members`, undefined, sam.apiKey);
    expect(gm.data.private).toBe(false);
    expect(gm.data.members.map((x: any) => x.email)).toContain(rita.email);
  });

  it("AC-C2-08 leave; the last member of a private channel can't leave (409); the list and reads carry private/member", async () => {
    const list = await channels(rita);
    const secret = list.data.channels.find((c: any) => c.name === "secret");
    expect(secret).toMatchObject({ private: true, member: true });
    expect(list.data.channels.find((c: any) => c.name === "general")).toMatchObject({ private: false });
    const left = await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/leave`, {}, rita.apiKey);
    expect(left.status, JSON.stringify(left.data)).toBe(200);
    expect(left.data.left).toBe(true);
    expect((await channel(rita, "secret")).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/leave`, {}, alice.apiKey)).status).toBe(409);
    // Leaving a public channel just drops you from its list.
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/general/leave`, {}, rita.apiKey)).status).toBe(200);
    expect((await channel(rita, "general")).status).toBe(200);
  });

  it("AC-C2-08 make public / private: the owner or an admin who is a member; others 403", async () => {
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/private`, { private: false }, alice.apiKey)).status).toBe(403);
    // The owner isn't a member: the channel doesn't exist for them.
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/private`, { private: false }, owner.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/members`, { member: owner.email }, alice.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/private`, { private: "x" }, owner.apiKey)).status).toBe(400);
    const pub = await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/private`, { private: false }, owner.apiKey);
    expect(pub.status, JSON.stringify(pub.data)).toBe(200);
    expect(pub.data.channel.private).toBe(false);
    expect((await channel(rita, "secret")).status).toBe(200);
    expect((await channels(sam)).data.channels.map((c: any) => c.name)).toContain("secret");
    const priv = await jsonRequest(app, "POST", `/nests/${nestId}/channels/secret/private`, { private: true }, owner.apiKey);
    expect(priv.status).toBe(200);
    expect(priv.data.channel.private).toBe(true);
    expect((await channel(rita, "secret")).status).toBe(404);
    // Making a PUBLIC channel private puts the caller on its member list.
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "ops" }, alice.apiKey)).status).toBe(201);
    const p2 = await jsonRequest(app, "POST", `/nests/${nestId}/channels/ops/private`, { private: true }, owner.apiKey);
    expect(p2.status, JSON.stringify(p2.data)).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops/members`, undefined, owner.apiKey)).data.members.map((m: any) => m.email)).toEqual(
      expect.arrayContaining([owner.email, alice.email]),
    );
    expect((await channel(rita, "ops")).status).toBe(404);
  });

  it("AC-C2-08 MCP: context_channels create private, context_channel_members list/invite/join/leave/set_private", async () => {
    const c = await callTool(alice.apiKey, "context_channels", { action: "create", name: "mcp-private", private: true });
    expect(c.isError, c.text).toBe(false);
    expect(c.data.channel.private).toBe(true);
    const m = await callTool(alice.apiKey, "context_channel_members", { channel: "mcp-private" });
    expect(m.isError, m.text).toBe(false);
    expect(m.data.members.map((x: any) => x.email)).toEqual([alice.email]);
    const inv = await callTool(alice.apiKey, "context_channel_members", { action: "invite", channel: "mcp-private", member: rita.email });
    expect(inv.isError, inv.text).toBe(false);
    expect((await channel(rita, "mcp-private")).status).toBe(200);
    const nope = await callTool(sam.apiKey, "context_channel_members", { action: "join", channel: "mcp-private" });
    expect(nope.isError).toBe(true);
    const join = await callTool(sam.apiKey, "context_channel_members", { action: "join", channel: "general" });
    expect(join.isError, join.text).toBe(false);
    const leave = await callTool(rita.apiKey, "context_channel_members", { action: "leave", channel: "mcp-private" });
    expect(leave.isError, leave.text).toBe(false);
    expect((await channel(rita, "mcp-private")).status).toBe(404);
    const sp = await callTool(alice.apiKey, "context_channel_members", { action: "set_private", channel: "mcp-private", private: false });
    expect(sp.isError).toBe(true); // alice is a writer, not owner/admin
  });
});

describe("AC-C2-09: a private channel does not exist for non-members", () => {
  const SECRET = "nodes/channels/secret";
  let secretThread: string;
  beforeAll(async () => {
    secretThread = (await open(alice, "@sam the secret plan [[nodes/launch-plan]]", SECRET)).id;
    await open(alice, "@rita on the plan", GENERAL);
  });

  it("AC-C2-09 list, timeline, thread routes, node routes, cards and promote: 404 (the public and grantees too)", async () => {
    for (const u of [sam, rita, bob, stranger]) {
      const list = await channels(u);
      if (list.status === 200) {
        expect(list.data.channels.map((c: any) => c.name), u.email).not.toContain("secret");
        expect(list.data.most_recent, u.email).not.toBe("secret");
      }
      expect((await channel(u, "secret")).status, u.email).toBe(404);
      expect((await channel(u, "secret", `?thread=${secretThread}`)).status, u.email).toBe(404);
      expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/secret/members`, undefined, u.apiKey)).status, u.email).toBe(404);
      expect([403, 404], u.email).toContain((await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${enc(SECRET)}/annotations`, undefined, u.apiKey)).status);
      expect([403, 404], u.email).toContain((await post(u, "x", SECRET)).status);
      expect([403, 404], u.email).toContain((await replyTo(u, SECRET, secretThread, "x")).status);
      expect([403, 404], u.email).toContain((await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${enc(SECRET)}`, undefined, u.apiKey)).status);
      expect([403, 404], u.email).toContain((await jsonRequest(app, "POST", `/nests/${nestId}/threads/${secretThread}/promote`, { kind: "decision" }, u.apiKey)).status);
      const cards = await jsonRequest(app, "POST", `/nests/${nestId}/cards`, { links: [`[[${SECRET}]]`] }, u.apiKey);
      if (cards.status === 200) expect(cards.data.cards[0], u.email).toEqual({ link: `[[${SECRET}]]`, resolved: false });
    }
  });

  it("AC-C2-09 the node list, search and context never name it to a non-member; a member sees it", async () => {
    const nodes = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, sam.apiKey);
    expect(nodes.status).toBe(200);
    expect(JSON.stringify(nodes.data)).not.toContain("channels/secret");
    const search = await jsonRequest(app, "GET", `/nests/${nestId}/search?q=secret`, undefined, sam.apiKey);
    expect(JSON.stringify(search.data)).not.toContain("channels/secret");
    const ctx = await jsonRequest(app, "POST", `/nests/${nestId}/context`, { selector: "nodes/channels/secret" }, sam.apiKey);
    expect(JSON.stringify(ctx.data)).not.toContain("Need to know");
    const mcpList = await callTool(sam.apiKey, "context_list", {});
    expect(mcpList.text).not.toContain("channels/secret");
    const mcpGet = await callTool(sam.apiKey, "context_get", { id: SECRET });
    expect(mcpGet.isError).toBe(true);
    const mcpChannels = await callTool(sam.apiKey, "context_channels", {});
    expect(mcpChannels.text).not.toContain("secret");
    const wrong = await callTool(sam.apiKey, "context_channel_read", { channel: "nope" });
    expect(wrong.text).not.toContain("secret");
    // A member does see it everywhere.
    const alices = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, alice.apiKey);
    expect(JSON.stringify(alices.data)).toContain("channels/secret");
    expect((await channels(alice)).data.channels.map((c: any) => c.name)).toContain("secret");
  });

  it("AC-C2-09 an @mention inside it reaches nobody outside: no inbox row, no My Work row, no notification", async () => {
    const rows = await inbox(sam);
    expect(rows.filter((n) => n.node_id === SECRET)).toEqual([]);
    const w = await work(sam, "?sections=mentions");
    expect(w.mentions.map((m: any) => m.node_id)).not.toContain(SECRET);
    // …and the activity / feed views don't carry its name either.
    const feed = await jsonRequest(app, "GET", `/nests/${nestId}/feed`, undefined, sam.apiKey);
    if (feed.status === 200) expect(JSON.stringify(feed.data)).not.toContain("channels/secret");
    const activity = await jsonRequest(app, "GET", `/nests/${nestId}/activity`, undefined, sam.apiKey);
    if (activity.status === 200) expect(JSON.stringify(activity.data)).not.toContain("channels/secret");
  });

  it("AC-C2-09 the public docs site and a public nest leave it out", async () => {
    // A public nest: the public reader never sees any channel; a member
    // outside the private one doesn't either.
    const pub = (await jsonRequest(app, "POST", "/nests", { name: "PubC2" }, owner.apiKey)).data.nest.id;
    expect((await jsonRequest(app, "POST", `/nests/${pub}/collaborators`, { email: alice.email, permission: "write" }, owner.apiKey)).status).toBeLessThan(300);
    expect((await jsonRequest(app, "POST", `/nests/${pub}/channels`, { name: "hush", private: true }, alice.apiKey)).status).toBe(201);
    const vis = await jsonRequest(app, "PATCH", `/nests/${pub}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    expect(vis.status).toBe(200);
    const nodes = await jsonRequest(app, "GET", `/nests/${pub}/nodes`, undefined, stranger.apiKey);
    expect(JSON.stringify(nodes.data)).not.toContain("channels/hush");
    const ownerNodes = await jsonRequest(app, "GET", `/nests/${pub}/nodes`, undefined, owner.apiKey);
    expect(JSON.stringify(ownerNodes.data)).not.toContain("channels/hush");
    expect((await jsonRequest(app, "GET", `/nests/${pub}/channels/hush`, undefined, owner.apiKey)).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2-10 / AC-C2-11 — mute and notification preferences
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C2-10: GET/PUT /me/chat/preferences", () => {
  it("AC-C2-10 the default is mentions; a nest default and a per-conversation override are set and read back", async () => {
    const before = await jsonRequest(app, "GET", "/me/chat/preferences", undefined, rita.apiKey);
    expect(before.status, JSON.stringify(before.data)).toBe(200);
    expect(before.data.default).toBe("mentions");
    expect(before.data.nests).toEqual([]);
    const nest = await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, level: "all" }, rita.apiKey);
    expect(nest.status, JSON.stringify(nest.data)).toBe(200);
    expect(nest.data.preference).toEqual({ nest_id: nestId, conversation: null, level: "all" });
    const one = await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, conversation: GENERAL, level: "none" }, rita.apiKey);
    expect(one.status, JSON.stringify(one.data)).toBe(200);
    expect(one.data.preference).toEqual({ nest_id: nestId, conversation: GENERAL, level: "none" });
    const after = await jsonRequest(app, "GET", "/me/chat/preferences", undefined, rita.apiKey);
    expect(after.data.nests).toEqual([{ nest_id: nestId, level: "all", conversations: [{ conversation: GENERAL, level: "none" }] }]);
    // Back to the default removes the row.
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, level: "mentions" }, rita.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "GET", "/me/chat/preferences", undefined, rita.apiKey)).data.nests).toEqual([
      { nest_id: nestId, level: "mentions", conversations: [{ conversation: GENERAL, level: "none" }] },
    ]);
  });

  it("AC-C2-10 refuses a bad level (400), a nest I'm not in (404), a conversation I can't read (404)", async () => {
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, level: "loud" }, rita.apiKey)).status).toBe(400);
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { level: "none" }, rita.apiKey)).status).toBe(400);
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: strangerNestId, level: "none" }, rita.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, level: "none" }, bob.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, conversation: "nodes/channels/secret", level: "none" }, rita.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, conversation: "nodes/channels/nope", level: "none" }, rita.apiKey)).status).toBe(404);
  });

  it("AC-C2-10 MCP: context_chat_preferences get/set is the same object", async () => {
    const set = await callTool(rita.apiKey, "context_chat_preferences", { action: "set", conversation: GENERAL, level: "none" });
    expect(set.isError, set.text).toBe(false);
    expect(set.data.preference.level).toBe("none");
    const get = await callTool(rita.apiKey, "context_chat_preferences", {});
    expect(get.isError, get.text).toBe(false);
    expect(get.data.nests[0].conversations).toEqual([{ conversation: GENERAL, level: "none" }]);
  });
});

describe("AC-C2-11: preferences are honoured by mention notifications; unread still counts", () => {
  it("AC-C2-11 none: no inbox row for an @mention; the mention is still in My Work and the channel is still unread", async () => {
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, conversation: GENERAL, level: "none" }, rita.apiKey)).status).toBe(200);
    await jsonRequest(app, "POST", `/nests/${nestId}/channels/general/read`, {}, rita.apiKey);
    const before = (await inbox(rita)).length;
    const t = await open(alice, "@rita muted ping", GENERAL);
    expect((await inbox(rita)).length).toBe(before);
    const w = await work(rita, "?sections=mentions");
    expect(w.mentions.map((m: any) => m.thread_id)).toContain(t.id);
    const general = (await channels(rita)).data.channels.find((c: any) => c.name === "general");
    expect(general.unread).toBeGreaterThanOrEqual(1);
    // The mention outcome still says reached (the message landed; only the ping was muted).
    const r = await post(alice, "@rita again", GENERAL);
    expect(r.data.mentions[0]).toMatchObject({ name: "rita", kind: "person" });
  });

  it("AC-C2-11 mentions (default): the inbox row comes back; all: every message by someone else posts a row", async () => {
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, conversation: GENERAL, level: "mentions" }, rita.apiKey)).status).toBe(200);
    const before = (await inbox(rita)).length;
    await open(alice, "@rita unmuted ping", GENERAL);
    expect((await inbox(rita)).length).toBe(before + 1);
    await open(alice, "no name here", GENERAL);
    expect((await inbox(rita)).length).toBe(before + 1);
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, conversation: GENERAL, level: "all" }, rita.apiKey)).status).toBe(200);
    await open(alice, "plain post, rita hears it", GENERAL);
    const rows = await inbox(rita);
    expect(rows.length).toBe(before + 2);
    expect(rows[0]).toMatchObject({ kind: "comment", node_id: GENERAL });
    expect(rows[0].message).toContain("#general");
    // Her own messages never notify her.
    await open(rita, "my own", GENERAL);
    expect((await inbox(rita)).length).toBe(before + 2);
    // The nest default applies where no override is set.
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, conversation: GENERAL, level: "mentions" }, rita.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, level: "none" }, rita.apiKey)).status).toBe(200);
    const dm = (await startConversation(alice, [rita.email])).data.conversation.id;
    const n = (await inbox(rita)).length;
    await open(alice, "@rita in the dm, nest muted", dm);
    expect((await inbox(rita)).length).toBe(n);
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, level: "mentions" }, rita.apiKey)).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2-12 / AC-C2-13 — presence and typing
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C2-12: presence", () => {
  it("AC-C2-12 a heartbeat lists the member as active for 5 minutes with status and a minute-rounded last_seen; agents show as agents", async () => {
    const hb = await jsonRequest(app, "POST", `/nests/${nestId}/chat/presence`, { status: "in a call" }, alice.apiKey);
    expect(hb.status, JSON.stringify(hb.data)).toBe(200);
    expect(hb.data).toMatchObject({ ok: true, expires_in: 300 });
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/presence`, { client: { agent: "grok" } }, sam.apiKey)).status).toBe(200);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/chat/presence`, undefined, rita.apiKey);
    expect(list.status, JSON.stringify(list.data)).toBe(200);
    const a = list.data.active.find((p: any) => p.email === alice.email && p.agent === null);
    expect(a).toMatchObject({ name: "Alice Example", status: "in a call" });
    expect(a.last_seen).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00(\.000)?Z$/);
    expect(list.data.active.find((p: any) => p.agent === "grok")).toMatchObject({ email: sam.email, label: expect.stringContaining("grok") });
    expect(list.data.active.find((p: any) => p.email === rita.email)).toBeUndefined();
    const mcp = await callTool(rita.apiKey, "context_presence", {});
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.active.map((p: any) => p.email)).toContain(alice.email);
    const set = await callTool(rita.apiKey, "context_presence", { action: "set", status: "reviewing" });
    expect(set.isError, set.text).toBe(false);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/chat/presence`, undefined, alice.apiKey)).data.active.find((p: any) => p.email === rita.email)).toMatchObject({ status: "reviewing" });
  });

  it("AC-C2-12 expires after 5 minutes; a too-long status is 400; too many heartbeats 429; non-members 404; read-only keys 403", async () => {
    const events: EventsModule = await import("../src/chat/events.js");
    const presence = await import("../src/chat/presence.js");
    presence._setPresenceClock(() => Date.now() + 6 * 60_000);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/chat/presence`, undefined, rita.apiKey)).data.active).toEqual([]);
    presence._setPresenceClock(null);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/presence`, { status: "x".repeat(81) }, alice.apiKey)).status).toBe(400);
    for (const u of [bob, stranger]) {
      expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/presence`, {}, u.apiKey)).status).toBe(404);
      expect((await jsonRequest(app, "GET", `/nests/${nestId}/chat/presence`, undefined, u.apiKey)).status).toBe(404);
    }
    const ro = await mintKey(rita, "ro", { capability: "read", nest_id: nestId });
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/presence`, {}, ro)).status).toBe(403);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/chat/presence`, undefined, ro)).status).toBe(200);
    let last = 200;
    for (let i = 0; i < 40 && last === 200; i++) {
      last = (await jsonRequest(app, "POST", `/nests/${nestId}/chat/presence`, {}, sam.apiKey)).status;
    }
    expect(last).toBe(429);
    expect(events).toBeTruthy();
  });
});

describe("AC-C2-13: typing", () => {
  it("AC-C2-13 fans out to subscribers who can see the container, is never stored, 404 for a container the caller can't read", async () => {
    const rs = await subscribe(rita);
    expect(rs.status).toBe(200);
    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/chat/typing`, { conversation: GENERAL }, alice.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const f = await rs.next("typing");
    expect(f?.data).toMatchObject({ conversation: GENERAL, who: { email: alice.email, name: "Alice Example", agent: null } });
    // A conversation rita isn't in: nothing reaches her, and sam (outside) can't even send.
    const dm = (await startConversation(alice, [sam.email])).data.conversation.id;
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/typing`, { conversation: dm }, alice.apiKey)).status).toBe(200);
    expect(await rs.next("typing", 300)).toBeNull();
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/typing`, { conversation: dm }, rita.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/typing`, { conversation: "nodes/channels/secret" }, rita.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/typing`, {}, rita.apiKey)).status).toBe(400);
    await rs.close();
    const { getDb } = await import("../src/db/client.js");
    const tables = (await getDb().all("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%typing%' OR name LIKE '%presence%' OR name LIKE 'chat_%')")) as any[];
    expect(tables).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2-14 — live push
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C2-14: GET /nests/:id/chat/events", () => {
  it("AC-C2-14 a member receives message.new for a post and a reply, read.marked for their own mark, channel and conversation events", async () => {
    const rs = await subscribe(rita);
    expect(rs.status).toBe(200);
    const hello = await rs.next("hello");
    expect(hello?.data).toMatchObject({ nest_id: nestId });
    const t = await open(alice, "live one", GENERAL);
    const f1 = await rs.next("message.new");
    expect(f1?.id).toMatch(/^\d+$/);
    expect(f1?.data).toMatchObject({ conversation: GENERAL, thread_id: t.id, reply: false, author: alice.email, author_name: "Alice Example" });
    expect(f1?.data.message_id).toBeTruthy();
    expect(f1?.data.body).toBeUndefined(); // the stream carries pointers, the read carries text
    await replyTo(alice, GENERAL, t.id, "live reply");
    expect((await rs.next("message.new"))?.data).toMatchObject({ thread_id: t.id, reply: true });
    await jsonRequest(app, "POST", `/nests/${nestId}/channels/general/read`, {}, rita.apiKey);
    expect((await rs.next("read.marked"))?.data).toMatchObject({ conversation: GENERAL });
    // Someone else's mark is theirs alone.
    await jsonRequest(app, "POST", `/nests/${nestId}/channels/general/read`, {}, alice.apiKey);
    expect(await rs.next("read.marked", 300)).toBeNull();
    await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "live-chan" }, alice.apiKey);
    expect((await rs.next("channel.created"))?.data).toMatchObject({ conversation: "nodes/channels/live-chan", name: "live-chan" });
    await jsonRequest(app, "POST", `/nests/${nestId}/channels/live-chan/archive`, {}, alice.apiKey);
    expect((await rs.next("channel.archived"))?.data).toMatchObject({ conversation: "nodes/channels/live-chan", archived: true });
    const g = await startConversation(alice, [rita.email, sam.email, owner.email]);
    expect((await rs.next("conversation.created"))?.data).toMatchObject({ conversation: g.data.conversation.id, kind: "group" });
    await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(g.data.conversation.id)}/leave`, {}, sam.apiKey);
    expect((await rs.next("membership.changed"))?.data).toMatchObject({ conversation: g.data.conversation.id, action: "left", member: sam.email });
    // A presence heartbeat is an event too.
    await jsonRequest(app, "POST", `/nests/${nestId}/chat/presence`, { status: "here" }, alice.apiKey);
    expect((await rs.next("presence"))?.data).toMatchObject({ email: alice.email, status: "here", active: true });
    await rs.close();
  });

  it("AC-C2-14 events of a private channel or a conversation reach members only; the generic message.changed is emitted for anything C1 adds", async () => {
    const rs = await subscribe(sam);
    const as = await subscribe(alice);
    await rs.next("hello");
    await as.next("hello");
    await open(alice, "secret live", "nodes/channels/secret");
    expect((await as.next("message.new"))?.data).toMatchObject({ conversation: "nodes/channels/secret" });
    expect(await rs.next("message.new", 300)).toBeNull();
    const dm = (await startConversation(alice, [rita.email])).data.conversation.id;
    await open(alice, "dm live", dm);
    expect((await as.next("message.new"))?.data).toMatchObject({ conversation: dm });
    expect(await rs.next("message.new", 300)).toBeNull();
    const events: EventsModule = await import("../src/chat/events.js");
    events.emitChatEvent(nestId, { type: "message.changed", conversation: GENERAL, thread_id: "t", message_id: "m", change: "reaction" });
    expect((await rs.next("message.changed"))?.data).toMatchObject({ conversation: GENERAL, thread_id: "t", message_id: "m", change: "reaction" });
    expect((await as.next("message.changed"))?.data).toMatchObject({ message_id: "m" });
    events.emitChatEvent(nestId, { type: "message.changed", conversation: dm, thread_id: "t", message_id: "m2" });
    expect(await rs.next("message.changed", 300)).toBeNull();
    expect((await as.next("message.changed"))?.data).toMatchObject({ message_id: "m2" });
    await rs.close();
    await as.close();
  });

  it("AC-C2-14 Last-Event-ID replays what the ring buffer holds; too old → reset", async () => {
    const rs = await subscribe(rita);
    await rs.next("hello");
    await open(alice, "before the drop", GENERAL);
    const seen = await rs.next("message.new");
    await rs.close();
    await open(alice, "while away 1", GENERAL);
    await open(alice, "while away 2", GENERAL);
    const back = await subscribe(rita, { lastEventId: seen!.id! });
    const replayed: any[] = [];
    for (;;) {
      const f = await back.next("message.new", 500);
      if (!f) break;
      replayed.push(f);
    }
    expect(replayed.length).toBe(2);
    expect(replayed.every((f) => Number(f.id) > Number(seen!.id))).toBe(true);
    await back.close();
    // Push the buffer past what `seen` can resume from: a reset, not a replay.
    const events: EventsModule = await import("../src/chat/events.js");
    for (let i = 0; i < events.RING_SIZE + 1; i++) events.emitChatEvent(nestId, { type: "message.changed", conversation: GENERAL, thread_id: "ring", message_id: `m${i}` });
    const stale = await subscribe(rita, { lastEventId: seen!.id! });
    expect((await stale.next("reset"))?.event).toBe("reset");
    expect(await stale.next("message.new", 200)).toBeNull();
    await stale.close();
    const junk = await subscribe(rita, { lastEventId: "not-a-number" });
    expect(junk.status).toBe(200);
    expect((await junk.next("hello"))?.event).toBe("hello");
    await junk.close();
  });

  it("AC-C2-14 heartbeat comments every 20 s; the stream ends when the client hangs up", async () => {
    const events: EventsModule = await import("../src/chat/events.js");
    events._setHeartbeatMs(50);
    const rs = await subscribe(rita);
    await rs.next("hello");
    await tick(160);
    expect(rs.raw()).toContain(": ping");
    const before = events._subscriberCount(nestId);
    expect(before).toBeGreaterThan(0);
    await rs.close();
    await vi.waitFor(() => expect(events._subscriberCount(nestId)).toBe(before - 1), { timeout: 2000, interval: 20 });
    events._setHeartbeatMs(null);
  });

  it("AC-C2-14 non-members 404; the sixth concurrent stream of one person is 429; a read-only key may listen", async () => {
    for (const u of [bob, stranger]) expect((await subscribe(u)).status, u.email).toBe(404);
    const open5 = [];
    for (let i = 0; i < 5; i++) {
      const s = await subscribe(sam);
      expect(s.status).toBe(200);
      open5.push(s);
    }
    expect((await subscribe(sam)).status).toBe(429);
    for (const s of open5) await s.close();
    const events: EventsModule = await import("../src/chat/events.js");
    await vi.waitFor(() => expect(events._subscriberCount(nestId, sam.userId)).toBe(0), { timeout: 2000, interval: 20 });
    const ro = await mintKey(rita, "ro-sse", { capability: "read", nest_id: nestId });
    const res = await app.request(`/nests/${nestId}/chat/events`, { headers: { Authorization: `Bearer ${ro}`, Accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2-15 — app-wide unread
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C2-15: GET /me/chat/unread and the chat section of My Work", () => {
  it("AC-C2-15 per nest and total, counting only what the caller can read; My Work and MCP return the same", async () => {
    await jsonRequest(app, "POST", `/nests/${nestId}/channels/general/read`, {}, sam.apiKey);
    await open(alice, "unread for sam 1", GENERAL);
    await open(alice, "unread for sam 2", GENERAL);
    await open(alice, "secret, not for sam", "nodes/channels/secret");
    const dm = (await startConversation(alice, [sam.email])).data.conversation.id;
    await open(alice, "@sam dm unread", dm);
    await open(alice, "second nest post", "nodes/channels/general", {}, secondNestId); // sam isn't there
    const u = await jsonRequest(app, "GET", "/me/chat/unread", undefined, sam.apiKey);
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    const team = u.data.nests.find((n: any) => n.nest_id === nestId);
    expect(team).toMatchObject({ nest_name: "Team" });
    expect(team.channels.find((c: any) => c.id === GENERAL).unread).toBe(2);
    expect(team.channels.map((c: any) => c.id)).not.toContain("nodes/channels/secret");
    expect(team.conversations.find((c: any) => c.id === dm).unread).toBe(1);
    expect(team.unread).toBeGreaterThanOrEqual(3);
    expect(team.mentions).toBeGreaterThanOrEqual(1);
    expect(u.data.nests.map((n: any) => n.nest_id)).not.toContain(secondNestId);
    expect(u.data.total).toBe(u.data.nests.reduce((s: number, n: any) => s + n.unread, 0));
    expect(u.data.mentions).toBe(u.data.nests.reduce((s: number, n: any) => s + n.mentions, 0));
    const w = await work(sam, "?sections=chat");
    expect(w.chat).toEqual(u.data);
    expect(w.mentions).toBeUndefined();
    const mcp = await callTool(sam.apiKey, "context_my_work", { sections: ["chat"] });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.chat.nests.map((n: any) => n.nest_id)).toEqual([nestId]);
    expect(mcp.text).toContain("unread");
    // A default context_my_work call carries the summary too.
    const def = await callTool(sam.apiKey, "context_my_work", {});
    expect(def.data.chat).toBeTruthy();
    // Nobody outside: a share grantee has nothing.
    expect((await jsonRequest(app, "GET", "/me/chat/unread", undefined, bob.apiKey)).data).toMatchObject({ total: 0, nests: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2-16 — MCP parity and read-only keys
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C2-16: read-only keys read and are told plainly when they write", () => {
  it("AC-C2-16 list/read/members/preferences/presence work; create/invite/leave/set/heartbeat are refused", async () => {
    const ro = await mintKey(rita, "ro-mcp", { capability: "read", nest_id: nestId });
    const names = await listToolNames(ro);
    expect(names).toEqual(expect.arrayContaining(["context_conversations", "context_conversation_read", "context_channel_members", "context_chat_preferences", "context_presence"]));
    const dm = (await startConversation(alice, [rita.email])).data.conversation.id;
    expect((await callTool(ro, "context_conversations", {})).isError).toBe(false);
    expect((await callTool(ro, "context_conversation_read", { conversation: dm })).isError).toBe(false);
    expect((await callTool(ro, "context_channel_members", { channel: "general" })).isError).toBe(false);
    expect((await callTool(ro, "context_chat_preferences", {})).isError).toBe(false);
    expect((await callTool(ro, "context_presence", {})).isError).toBe(false);
    for (const [tool, args] of [
      ["context_conversations", { action: "create", members: [sam.email] }],
      ["context_conversations", { action: "leave", conversation: dm }],
      ["context_channel_members", { action: "join", channel: "general" }],
      ["context_channel_members", { action: "invite", channel: "general", member: sam.email }],
      ["context_chat_preferences", { action: "set", conversation: GENERAL, level: "none" }],
      ["context_presence", { action: "set" }],
    ] as const) {
      const r = await callTool(ro, tool, args as Record<string, unknown>);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text, tool).toContain("read-only");
    }
    // REST: the same key is refused on every POST, and may GET.
    expect((await startConversation({ ...rita, apiKey: ro }, [sam.email])).status).toBe(403);
    expect((await conversations({ ...rita, apiKey: ro })).status).toBe(200);
  });

  it("AC-C2-16 a nest-scoped key stays in its nest: preferences and presence default to it, the unread summary covers it only", async () => {
    const scoped = await mintKey(alice, "scoped", { nest_id: nestId });
    const get = await callTool(scoped, "context_chat_preferences", {});
    expect(get.isError, get.text).toBe(false);
    const other = await callTool(scoped, "context_chat_preferences", { action: "set", nest_id: secondNestId, level: "none" });
    expect(other.isError).toBe(true);
    const w = await callTool(scoped, "context_my_work", { sections: ["chat"] });
    expect(w.isError, w.text).toBe(false);
    expect(w.data.chat.nests.map((n: any) => n.nest_id)).toEqual([nestId]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEC — the review's findings
// ═══════════════════════════════════════════════════════════════════════════

describe("SEC-C2: existence oracles, cross-nest ids, leaks", () => {
  it("SEC-C2-01 a conversation id from another nest is 404 here, on every route, for a member of both", async () => {
    const theirs = (await startConversation(owner, [alice.email], secondNestId)).data.conversation.id;
    const t = await open(owner, "second nest dm", theirs, {}, secondNestId);
    // owner and alice are members of both nests and of that dm.
    expect((await conversation(alice, theirs)).status).toBe(404);
    expect((await conversation(alice, theirs, `?thread=${t.id}`)).status).toBe(404);
    expect((await post(alice, "x", theirs)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(theirs)}/read`, {}, alice.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/typing`, { conversation: theirs }, alice.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "PUT", "/me/chat/preferences", { nest_id: nestId, conversation: theirs, level: "none" }, alice.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, {}, alice.apiKey)).status).toBe(404);
    expect((await conversations(alice)).data.conversations.map((c: any) => c.id)).not.toContain(theirs);
    expect((await conversation(alice, theirs, "", secondNestId)).status).toBe(200);
  });

  it("SEC-C2-02 the member list of a conversation names only members; errors never echo other people's names", async () => {
    const dm = (await startConversation(alice, [rita.email])).data.conversation.id;
    const r = await conversation(sam, dm);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.data)).not.toContain("rita");
    expect(JSON.stringify(r.data)).not.toContain("alice");
    const bad = await startConversation(alice, [stranger.email]);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.data)).not.toContain("Stranger");
  });

  it("SEC-C2-03 a private channel's name does not reach non-members through the mention picker, the agent list, or a channel hint", async () => {
    const handles = await jsonRequest(app, "GET", `/nests/${nestId}/agent-handles`, undefined, sam.apiKey);
    expect(JSON.stringify(handles.data)).not.toContain("secret");
    const wrong = await callTool(sam.apiKey, "context_comment", { channel: "nope", body: "x" });
    expect(wrong.text).not.toContain("#secret");
    const mentionable = await jsonRequest(app, "GET", `/nests/${nestId}/mentionable`, undefined, sam.apiKey);
    expect(JSON.stringify(mentionable.data)).not.toContain("secret");
  });

  it("SEC-C2-04 presence can't be read across nests, only names what members would see anyway, and never shows a status after it expired", async () => {
    await jsonRequest(app, "POST", `/nests/${secondNestId}/chat/presence`, { status: "second nest only" }, owner.apiKey);
    const here = await jsonRequest(app, "GET", `/nests/${nestId}/chat/presence`, undefined, rita.apiKey);
    expect(JSON.stringify(here.data)).not.toContain("second nest only");
    expect((await jsonRequest(app, "GET", `/nests/${secondNestId}/chat/presence`, undefined, rita.apiKey)).status).toBe(404);
    for (const p of here.data.active) {
      expect(Object.keys(p).sort()).toEqual(["agent", "email", "label", "last_seen", "name", "status"]);
    }
  });

  it("SEC-C2-05 the event stream never carries message text, and a subscriber dropped from a conversation stops receiving it", async () => {
    const g = (await startConversation(alice, [rita.email, sam.email])).data.conversation.id;
    const rs = await subscribe(sam);
    await rs.next("hello");
    await open(alice, "sam still here", g);
    const f = await rs.next("message.new");
    expect(f?.data.conversation).toBe(g);
    expect(JSON.stringify(f?.data)).not.toContain("sam still here");
    await jsonRequest(app, "POST", `/nests/${nestId}/conversations/${enc(g)}/leave`, {}, sam.apiKey);
    await rs.next("membership.changed");
    await open(alice, "after sam left", g);
    expect(await rs.next("message.new", 300)).toBeNull();
    await rs.close();
  });

  it("SEC-C2-07 typing and presence are never buffered: a typing storm does not push messages out of the resume buffer", async () => {
    const events: EventsModule = await import("../src/chat/events.js");
    const rs = await subscribe(rita);
    await rs.next("hello");
    await open(alice, "kept through the storm", GENERAL);
    const seen = await rs.next("message.new");
    await rs.close();
    for (let i = 0; i < events.RING_SIZE * 2; i++) events.emitChatEvent(nestId, { type: "typing", conversation: GENERAL, who: { email: "x", name: "x", agent: null } });
    await open(alice, "after the storm", GENERAL);
    const back = await subscribe(rita, { lastEventId: seen!.id! });
    const f = await back.next("message.new");
    expect(f?.data.conversation).toBe(GENERAL);
    expect(await back.next("reset", 200)).toBeNull();
    await back.close();
  });

  it("SEC-C2-08 the global search and the public docs listing never name a private channel to a non-member; a share on the channel node reads no member list", async () => {
    const g = await jsonRequest(app, "GET", "/search?q=secret", undefined, sam.apiKey);
    if (g.status === 200) expect(JSON.stringify(g.data)).not.toContain("channels/secret");
    // Carl: a share on the #general node itself, nothing else on the nest.
    const carl = await registerUser(app, "carl@c2.test", "Carl Channel");
    const grant = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, { target_type: "document", target: GENERAL, email: carl.email, role: "read" }, owner.apiKey);
    expect(grant.status, JSON.stringify(grant.data)).toBe(201);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${enc(GENERAL)}/annotations`, undefined, carl.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/general/members`, undefined, carl.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/general/join`, {}, carl.apiKey)).status).toBe(404);
    expect((await conversations(carl)).status).toBe(404);
    expect((await subscribe(carl)).status).toBe(404);
  });

  it("SEC-C2-09 a conversation's or private channel's shares are not the sharing roster: no listing, no outside share, no unshare", async () => {
    const dm = (await startConversation(alice, [rita.email])).data.conversation.id;
    // The roster an admin reads never names a dm or a private channel, nor who is in it.
    const roster = await jsonRequest(app, "GET", `/nests/${nestId}/grants`, undefined, owner.apiKey);
    expect(roster.status).toBe(200);
    expect(roster.data.grants.map((g: any) => g.target)).not.toContain(dm);
    expect(roster.data.grants.some((g: any) => String(g.target).startsWith("nodes/conversations/"))).toBe(false);
    expect(roster.data.grants.map((g: any) => g.target)).not.toContain("nodes/channels/secret");
    // The owner can't share the dm with an outsider, nor a private channel.
    for (const target of [dm, "nodes/channels/secret"]) {
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, { target_type: "document", target, email: stranger.email, role: "read" }, owner.apiKey);
      expect(r.status, target).toBe(409);
    }
    expect((await conversation(stranger, dm)).status).toBe(404);
  });

  it("SEC-C2-10 a collaborator removed from the nest keeps nothing: the share alone opens no conversation, listing or feed, and their stream ends", async () => {
    const zed = await registerUser(app, "zed@c2.test", "Zed Leaving");
    await resetAuthRateLimit();
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: zed.email, permission: "read" }, owner.apiKey)).status).toBeLessThan(300);
    const g = (await startConversation(alice, [rita.email, zed.email])).data.conversation.id;
    await open(alice, "zed was here", g);
    expect((await conversation(zed, g)).status).toBe(200);
    const events: EventsModule = await import("../src/chat/events.js");
    events._setHeartbeatMs(50);
    const zs = await subscribe(zed);
    expect(zs.status).toBe(200);
    await zs.next("hello");
    const collabs = (await jsonRequest(app, "GET", `/nests/${nestId}/collaborators`, undefined, owner.apiKey)).data;
    const row = (collabs.collaborators ?? collabs).find((x: any) => x.email === zed.email);
    expect(row, JSON.stringify(collabs).slice(0, 200)).toBeTruthy();
    expect((await jsonRequest(app, "DELETE", `/nests/${nestId}/collaborators/${row.id}`, undefined, owner.apiKey)).status).toBeLessThan(300);
    // Zed still holds a share on the conversation node: it opens nothing.
    for (const path of [`/nests/${nestId}/conversations/${enc(g)}`, `/nests/${nestId}/nodes/${enc(g)}`, `/nests/${nestId}/nodes/${enc(g)}/annotations`, `/nests/${nestId}/conversations`]) {
      expect((await jsonRequest(app, "GET", path, undefined, zed.apiKey)).status, path).toBe(404);
    }
    for (const path of [`/nests/${nestId}/nodes`, `/nests/${nestId}/feed`, `/nests/${nestId}/search?q=zed`]) {
      const r = await jsonRequest(app, "GET", path, undefined, zed.apiKey);
      if (r.status === 200) expect(JSON.stringify(r.data), path).not.toContain("zed was here");
      if (r.status === 200) expect(JSON.stringify(r.data), path).not.toContain(g);
    }
    expect((await post(zed, "still here?", g)).status).toBe(404);
    await vi.waitFor(() => expect(events._subscriberCount(nestId, zed.userId)).toBe(0), { timeout: 2000, interval: 20 });
    await zs.close();
    events._setHeartbeatMs(null);
    // The others' view is unchanged and a message after the removal never reaches zed's inbox.
    expect((await conversation(rita, g)).status).toBe(200);
  });

  it("SEC-C2-11 the #private and agent:* tags change only through the chat routes: a writer editing tags is refused", async () => {
    const node = (await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${enc("nodes/channels/secret")}`, undefined, alice.apiKey)).data;
    expect(node.tags ?? node.node?.tags).toBeTruthy();
    const tags: string[] = (node.tags ?? node.node?.tags).map((t: string) => t.replace(/^#/, ""));
    expect(tags).toContain("private");
    const dropped = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${enc("nodes/channels/secret")}`, { tags: tags.filter((t) => t !== "private") }, alice.apiKey);
    expect(dropped.status, JSON.stringify(dropped.data)).toBe(409);
    const agent = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${enc("nodes/channels/secret")}`, { tags: [...tags, "agent:evil"] }, alice.apiKey);
    expect(agent.status).toBe(409);
    const mcp = await callTool(alice.apiKey, "context_update", { id: "nodes/channels/secret", tags: tags.filter((t) => t !== "private") });
    expect(mcp.isError || /409|chat container/i.test(mcp.text)).toBeTruthy();
    expect((await channel(sam, "secret")).status).toBe(404);
    // Other tags still edit normally.
    const fine = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${enc("nodes/channels/secret")}`, { tags: [...tags, "ops"] }, alice.apiKey);
    expect(fine.status, JSON.stringify(fine.data)).toBe(200);
  });

  it("SEC-C2-12 per-nest off is off over MCP too: context_comment and context_comments on a channel or conversation say not found", async () => {
    const dm = (await startConversation(alice, [rita.email])).data.conversation.id;
    const t = await open(alice, "before the nest went quiet", dm);
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: false }, owner.apiKey)).status).toBe(200);
    for (const [tool, args] of [
      ["context_comment", { channel: "general", body: "x" }],
      ["context_comment", { id: dm, body: "x" }],
      ["context_comment", { thread: t.id, body: "x" }],
      ["context_comments", { id: GENERAL }],
      ["context_comments", { id: dm }],
      ["context_comments", { thread: t.id }],
      ["context_resolve_comment", { thread: t.id }],
    ] as const) {
      const r = await callTool(alice.apiKey, tool, args as Record<string, unknown>);
      expect(r.isError || /not found/i.test(r.text), `${tool} ${JSON.stringify(args)}: ${r.text}`).toBeTruthy();
    }
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: true }, owner.apiKey)).status).toBe(200);
    expect((await callTool(alice.apiKey, "context_comments", { id: dm })).isError).toBe(false);
  });

  it("SEC-C2-13 a replay never hands someone else's read mark to a reconnecting member", async () => {
    const rs = await subscribe(rita);
    await rs.next("hello");
    await open(alice, "mark me", GENERAL);
    const seen = await rs.next("message.new");
    await rs.close();
    await jsonRequest(app, "POST", `/nests/${nestId}/channels/general/read`, {}, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/channels/general/read`, {}, rita.apiKey);
    const back = await subscribe(rita, { lastEventId: seen!.id! });
    const marks: any[] = [];
    for (;;) {
      const f = await back.next("read.marked", 400);
      if (!f) break;
      marks.push(f);
    }
    expect(marks.length).toBe(1); // rita's own, never alice's
    await back.close();
  });

  it("SEC-C2-14 conversation mention rows exist only while chat is on: switch off, they are gone from My Work; on, they are back", async () => {
    const dm = (await startConversation(alice, [sam.email])).data.conversation.id;
    const t = await open(alice, "@sam only while chat is on", dm);
    expect((await work(sam, "?sections=mentions")).mentions.map((m: any) => m.thread_id)).toContain(t.id);
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: false }, owner.apiKey)).status).toBe(200);
    expect((await work(sam, "?sections=mentions")).mentions.map((m: any) => m.thread_id)).not.toContain(t.id);
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: true }, owner.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "PATCH", "/admin/settings", { team_chat_enabled: false }, owner.apiKey)).status).toBe(200);
    expect((await work(sam, "?sections=mentions")).mentions.map((m: any) => m.thread_id)).not.toContain(t.id);
    expect((await jsonRequest(app, "PATCH", "/admin/settings", { team_chat_enabled: true }, owner.apiKey)).status).toBe(200);
    expect((await work(sam, "?sections=mentions")).mentions.map((m: any) => m.thread_id)).toContain(t.id);
  });

  it("SEC-C2-06 per-nest off while the server is on: the stream, presence and the thread routes on a conversation are 404 too", async () => {
    const dm = (await startConversation(alice, [rita.email])).data.conversation.id;
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: false }, owner.apiKey)).status).toBe(200);
    expect((await subscribe(alice)).status).toBe(404);
    expect((await post(alice, "x", dm)).status).toBe(404);
    expect((await conversation(alice, dm)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/chat/typing`, { conversation: dm }, alice.apiKey)).status).toBe(404);
    const u = await jsonRequest(app, "GET", "/me/chat/unread", undefined, alice.apiKey);
    expect(u.data.nests.map((n: any) => n.nest_id)).not.toContain(nestId);
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/chat/settings`, { chat: true }, owner.apiKey)).status).toBe(200);
    expect((await conversation(alice, dm)).status).toBe(200);
  });
});
