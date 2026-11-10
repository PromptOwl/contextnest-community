/**
 * Team chat harness, slice C1 "Messages" (PO-1196): what a person or an agent
 * can do to ONE channel message — react, edit, delete, pin, save, link to it,
 * search for it — and `@channel` / `@here`. Server + MCP only; the UI (C3) is
 * built on this contract (.notes/ui-contract-c1.md, API.md "Channel
 * messages").
 *
 * THE RULE (owner decision 2026-11-09, unchanged from S4b): people added to
 * the nest post, reply, resolve, react, pin and save — a read-only
 * collaborator included. The public and a document-share grantee never.
 * Create, archive and promote stay with writers. A read-only API key reads
 * only. With EXPERIMENTAL_AGENT_STREAM off, every route and tool here is not
 * found, exactly as the channel routes are.
 *
 * Every acceptance criterion is a describe block named by its AC id.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type WakeModule = typeof import("../src/stream/agent-wake.js");
let wake: WakeModule;

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const GENERAL = "nodes/channels/general";

type User = { apiKey: string; userId: string; email: string; cookie: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let ada: User; // admin collaborator (moderation)
let alice: User; // write collaborator
let rita: User; // READ collaborator
let bob: User; // a share on one document, nothing else
let carl: User; // a share on the #general channel node, nothing else
let stranger: User; // no access; owns another nest
let nestId: string;
let pubNestId: string; // public nest, stranger is not a member
let otherNestId: string; // stranger's own nest, with a #general of its own
let sent: Array<{ url: string; body: string }> = [];

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
async function mintKey(u: { apiKey: string }, label: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await jsonRequest(app, "POST", "/auth/keys", { label, ...extra }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r.data.key ?? r.data.apiKey ?? r.data.api_key;
}

const post = (u: { apiKey: string }, body: string, node = GENERAL, extra: Record<string, unknown> = {}, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations`, { body, ...extra }, u.apiKey);
const replyTo = (u: { apiKey: string }, threadId: string, body: string, node = GENERAL, extra: Record<string, unknown> = {}, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations/${threadId}/comments`, { body, ...extra }, u.apiKey);
/** Open a thread → { id: thread id, message_id: its opening message }. */
async function open(u: { apiKey: string }, body: string, node = GENERAL, extra: Record<string, unknown> = {}, nest = nestId) {
  const r = await post(u, body, node, extra, nest);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return { id: r.data.thread.id as string, message_id: r.data.comment_id as string, mentions: r.data.mentions as any[] };
}
async function reply(u: { apiKey: string }, threadId: string, body: string, node = GENERAL, extra: Record<string, unknown> = {}, nest = nestId) {
  const r = await replyTo(u, threadId, body, node, extra, nest);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return { id: r.data.comment_id as string, thread_id: threadId, mentions: r.data.mentions as any[] };
}
const timeline = (u: { apiKey: string }, name = "general", qs = "", nest = nestId) =>
  jsonRequest(app, "GET", `/nests/${nest}/channels/${name}${qs}`, undefined, u.apiKey);
const msgRoute = (name: string, id: string, rest = "", nest = nestId) => `/nests/${nest}/channels/${name}/messages/${id}${rest}`;
const react = (u: { apiKey: string }, id: string, emoji: string, extra: Record<string, unknown> = {}, name = "general", nest = nestId) =>
  jsonRequest(app, "POST", msgRoute(name, id, "/reactions", nest), { emoji, ...extra }, u.apiKey);
const unreact = (u: { apiKey: string }, id: string, emoji: string, name = "general", nest = nestId) =>
  jsonRequest(app, "DELETE", msgRoute(name, id, `/reactions/${encodeURIComponent(emoji)}`, nest), undefined, u.apiKey);
const edit = (u: { apiKey: string }, id: string, body: string, extra: Record<string, unknown> = {}, name = "general", nest = nestId) =>
  jsonRequest(app, "PATCH", msgRoute(name, id, "", nest), { body, ...extra }, u.apiKey);
const del = (u: { apiKey: string }, id: string, extra: Record<string, unknown> = {}, name = "general", nest = nestId) =>
  jsonRequest(app, "DELETE", msgRoute(name, id, "", nest), Object.keys(extra).length ? extra : undefined, u.apiKey);
const work = async (u: { apiKey: string }, qs = "") => (await jsonRequest(app, "GET", `/me/work${qs}`, undefined, u.apiKey)).data;
const mentionMessages = (w: any): string[] => (w?.mentions ?? []).map((m: any) => m.comment_id);
const inbox = async (u: { apiKey: string }) =>
  (await jsonRequest(app, "GET", "/me/notifications", undefined, u.apiKey)).data.notifications as Array<{ kind: string; node_id: string | null; message: string }>;
const tick = () => new Promise((r) => setTimeout(r, 6));
/** Every message of a thread as the thread read returns it, keyed by message id. */
async function threadMessages(u: { apiKey: string }, threadId: string, name = "general", nest = nestId): Promise<Map<string, any>> {
  const r = await timeline(u, name, `?thread=${threadId}`, nest);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  const out = new Map<string, any>();
  out.set(r.data.thread.post.message_id, r.data.thread.post);
  for (const m of r.data.thread.replies) out.set(m.id, m);
  return out;
}
async function newChannel(name: string, by: { apiKey: string } = owner, nest = nestId) {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/channels`, { name }, by.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return `nodes/channels/${name}`;
}

beforeAll(async () => {
  env = setupTestEnv();
  process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  app = await createTestApp("key", { ownerEmail: "olivia@c1.test" });
  wake = await import("../src/stream/agent-wake.js");
  wake.setAgentWakeBackoff([]);
  owner = await registerUser(app, "olivia@c1.test", "Olivia Owner");
  ada = await registerUser(app, "ada@c1.test", "Ada Admin");
  alice = await registerUser(app, "alice@c1.test", "Alice Example");
  await resetAuthRateLimit();
  rita = await registerUser(app, "rita@c1.test", "Rita Reader");
  bob = await registerUser(app, "bob@c1.test", "Bob Builder");
  carl = await registerUser(app, "carl@c1.test", "Carl Channel");
  await resetAuthRateLimit();
  stranger = await registerUser(app, "stranger@else.test", "Stranger");
  await resetAuthRateLimit();

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  pubNestId = (await jsonRequest(app, "POST", "/nests", { name: "Pub" }, owner.apiKey)).data.nest.id;
  otherNestId = (await jsonRequest(app, "POST", "/nests", { name: "Elsewhere" }, stranger.apiKey)).data.nest.id;
  for (const [u, permission] of [
    [ada, "admin"],
    [alice, "write"],
    [rita, "read"],
  ] as const) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  for (const [nest, by] of [
    [nestId, owner],
    [pubNestId, owner],
    [otherNestId, stranger],
  ] as const) {
    await newChannel("general", by, nest);
  }
  const plan = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Launch Plan", content: "# Plan" }, owner.apiKey);
  expect(plan.status, JSON.stringify(plan.data)).toBe(201);
  for (const [u, target] of [
    [bob, "nodes/launch-plan"],
    [carl, GENERAL],
  ] as const) {
    const g = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, { target_type: "document", target, email: u.email, role: "write" }, owner.apiKey);
    expect(g.status, JSON.stringify(g.data)).toBe(201);
  }
  const vis = await jsonRequest(app, "PATCH", `/nests/${pubNestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
  expect(vis.status, JSON.stringify(vis.data)).toBe(200);
});

afterEach(() => {
  wake.setAgentWakeFetch(null);
  wake.setAgentWebhookResolver(null);
  sent = [];
});

afterAll(async () => {
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  await env.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-01 / AC-C1-02 — reactions
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-01: react and unreact; counts, me and who, on every read", () => {
  it("AC-C1-01 a read-only collaborator reacts; the reaction shows on the timeline, the thread and ?since=; the same reaction twice is one", async () => {
    const t = await open(alice, "ship it?");
    let r = await react(rita, t.message_id, "👍");
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.message_id).toBe(t.message_id);
    expect(r.data.reactions).toEqual([{ emoji: "👍", count: 1, me: true, by: ["Rita Reader"] }]);
    // Again: still one.
    r = await react(rita, t.message_id, "👍");
    expect(r.status).toBe(200);
    expect(r.data.reactions[0].count).toBe(1);
    // Alice sees it as not hers.
    const tl = await timeline(alice);
    const postRow = tl.data.posts.find((p: any) => p.id === t.id);
    expect(postRow.reactions).toEqual([{ emoji: "👍", count: 1, me: false, by: ["Rita Reader"] }]);
    const byThread = await threadMessages(rita, t.id);
    expect(byThread.get(t.message_id).reactions[0]).toMatchObject({ emoji: "👍", count: 1, me: true });
    // A second person, a second emoji: ordered by first reaction.
    await react(alice, t.message_id, "🎉");
    await react(alice, t.message_id, "👍");
    const again = await timeline(rita);
    const p = again.data.posts.find((x: any) => x.id === t.id);
    expect(p.reactions.map((x: any) => [x.emoji, x.count])).toEqual([["👍", 2], ["🎉", 1]]);
    expect(p.reactions[0].by).toEqual(["Rita Reader", "Alice Example"]);
    // ?since= carries it on a reply too.
    const re = await reply(alice, t.id, "a reply to react to");
    await react(rita, re.id, "👀");
    const since = await timeline(alice, "general", `?since=${t.message_id}`);
    const row = since.data.messages.find((m: any) => m.id === re.id);
    expect(row.reactions).toEqual([{ emoji: "👀", count: 1, me: false, by: ["Rita Reader"] }]);
    // Unreact: Rita's is gone, Alice's stays; the order follows the earliest
    // reaction still standing.
    const u = await unreact(rita, t.message_id, "👍");
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    expect(u.data.reactions.map((x: any) => [x.emoji, x.count, x.me])).toEqual([["🎉", 1, false], ["👍", 1, false]]);
    // Unreacting what you never reacted with is a no-op, not an error.
    expect((await unreact(rita, t.message_id, "🚀")).status).toBe(200);
    // A thread id reaches the post's opening message too.
    const viaThread = await react(rita, t.id, "🚀");
    expect(viaThread.status).toBe(200);
    expect(viaThread.data.message_id).toBe(t.message_id);
  });

  it("AC-C1-01 a reaction made as an agent is listed under the agent", async () => {
    const t = await open(alice, "agents can react");
    const r = await react(owner, t.message_id, "👍", { client: { agent: "grok" } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.reactions).toEqual([{ emoji: "👍", count: 1, me: true, by: ["grok, on behalf of Olivia Owner"] }]);
  });

  it("AC-C1-01 `by` names at most 10 people; count is the whole number", async () => {
    const t = await open(alice, "popular");
    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    for (let i = 0; i < 12; i++) {
      await db.run("INSERT INTO message_reactions (nest_id, node_id, thread_id, comment_id, emoji, user_id, author, client_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)", [
        nestId, GENERAL, t.id, t.message_id, "🔥", `fake-user-${i}`, `fan${i}@c1.test`, `2026-01-01 00:00:${String(i).padStart(2, "0")}.000`,
      ]);
    }
    const tl = await timeline(alice);
    const p = tl.data.posts.find((x: any) => x.id === t.id);
    expect(p.reactions[0].count).toBe(12);
    expect(p.reactions[0].by).toHaveLength(10);
  });

  it("AC-C1-01 MCP: context_message { action: react | unreact } returns the REST body", async () => {
    const t = await open(alice, "mcp react");
    const r = await callTool(rita.apiKey, "context_message", { action: "react", message: t.message_id, emoji: ":+1:" });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.reactions).toEqual([{ emoji: "👍", count: 1, me: true, by: ["Rita Reader"] }]);
    expect(r.text).toContain("👍");
    const u = await callTool(rita.apiKey, "context_message", { action: "unreact", message: t.message_id, emoji: "👍" });
    expect(u.isError, u.text).toBe(false);
    expect(u.data.reactions).toEqual([]);
  });
});

describe("AC-C1-02: only an emoji is a reaction, and not too many of them", () => {
  it("AC-C1-02 a shortcode is stored as its emoji; anything else is refused with 400 and nothing stored", async () => {
    const t = await open(alice, "validate");
    for (const [input, stored] of [
      [":+1:", "👍"],
      ["thumbsup", "👍"],
      [":tada:", "🎉"],
      ["❤️", "❤️"],
      ["👍🏽", "👍🏽"],
      ["🇫🇷", "🇫🇷"],
    ] as const) {
      const r = await react(alice, t.message_id, input);
      expect(r.status, `${input}: ${JSON.stringify(r.data)}`).toBe(200);
      expect(r.data.reactions.some((x: any) => x.emoji === stored), `${input} → ${stored}`).toBe(true);
    }
    for (const bad of ["", "hello", "<script>", "👍👍", ":not_a_code:", "a".repeat(100), "😀 and text", "1"]) {
      const r = await react(alice, t.message_id, bad);
      expect(r.status, `${JSON.stringify(bad)}: ${JSON.stringify(r.data)}`).toBe(400);
      expect(String(r.data.error)).toMatch(/emoji/i);
    }
    expect((await react(alice, t.message_id, 42 as unknown as string)).status).toBe(400);
    const tl = await timeline(alice);
    const p = tl.data.posts.find((x: any) => x.id === t.id);
    expect(p.reactions.map((x: any) => x.emoji).sort()).toEqual(["❤️", "🇫🇷", "👍", "👍🏽", "🎉"].sort());
  });

  it("AC-C1-02 past 60 reaction writes a minute, a person is told to wait (429, Retry-After)", async () => {
    const t = await open(alice, "rate");
    await resetAuthRateLimit();
    let last: { status: number; data: any } = { status: 0, data: null };
    for (let i = 0; i < 60; i++) {
      last = i % 2 === 0 ? await react(rita, t.message_id, "👍") : await unreact(rita, t.message_id, "👍");
      expect(last.status, `write ${i}: ${JSON.stringify(last.data)}`).toBe(200);
    }
    const res = await app.request(msgRoute("general", t.message_id, "/reactions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rita.apiKey}` },
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // Someone else is not affected.
    expect((await react(alice, t.message_id, "👍")).status).toBe(200);
    await resetAuthRateLimit();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-03 / AC-C1-04 — edit
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-03: the author edits their own message; the history is kept", () => {
  it("AC-C1-03 edit changes the body, sets edited_at, keeps the previous bodies for members; others get 403; empty is 400", async () => {
    const t = await open(alice, "first draft");
    await tick();
    const r = await edit(alice, t.message_id, "second draft");
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.message).toMatchObject({ id: t.message_id, thread_id: t.id, reply: false, body: "second draft", deleted: false });
    expect(r.data.message.edited_at).toBeTruthy();
    const r2 = await edit(alice, t.message_id, "third draft");
    expect(r2.status).toBe(200);
    // On the timeline, the thread and the post's opening message alike.
    const tl = await timeline(rita);
    const p = tl.data.posts.find((x: any) => x.id === t.id);
    expect(p.body).toBe("third draft");
    expect(p.edited_at).toBeTruthy();
    const h = await jsonRequest(app, "GET", msgRoute("general", t.message_id, "/history"), undefined, rita.apiKey);
    expect(h.status, JSON.stringify(h.data)).toBe(200);
    expect(h.data.message_id).toBe(t.message_id);
    expect(h.data.edits.map((e: any) => e.body)).toEqual(["second draft", "first draft"]);
    expect(h.data.edits[0].by).toMatchObject({ human: "Alice Example", agent: null });
    expect(h.data.edits[0].replaced_at).toBeTruthy();
    // Not the author: 403 (a member), and nothing changed.
    expect((await edit(rita, t.message_id, "rita rewrites")).status).toBe(403);
    expect((await edit(owner, t.message_id, "even the owner can't")).status).toBe(403);
    expect((await edit(alice, t.message_id, "   ")).status).toBe(400);
    expect((await timeline(alice)).data.posts.find((x: any) => x.id === t.id).body).toBe("third draft");
    // A reply edits the same way, and the history route is members-only.
    const re = await reply(rita, t.id, "my reply");
    expect((await edit(rita, re.id, "my reply, fixed")).status).toBe(200);
    expect((await threadMessages(alice, t.id)).get(re.id).body).toBe("my reply, fixed");
    expect((await jsonRequest(app, "GET", msgRoute("general", re.id, "/history"), undefined, stranger.apiKey)).status).toBe(404);
  });

  it("AC-C1-03 an agent edits only what it wrote; the person behind it may edit either", async () => {
    const t = await open(alice, "written as grok", GENERAL, { client: { agent: "grok" } });
    const plain = await reply(alice, t.id, "written as alice");
    // Another agent under the same login: no.
    expect((await edit(alice, t.message_id, "muse rewrites", { client: { agent: "muse" } })).status).toBe(403);
    // Acting as an agent on a message the person wrote themselves: no.
    expect((await edit(alice, plain.id, "grok rewrites alice", { client: { agent: "grok" } })).status).toBe(403);
    // The same agent: yes; the edit is attributed to it.
    const ok = await edit(alice, t.message_id, "grok fixes grok", { client: { agent: "grok" } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.message.actor.label).toBe("grok, on behalf of Alice Example");
    // The person, acting as nobody: yes, on both.
    expect((await edit(alice, t.message_id, "alice fixes grok")).status).toBe(200);
    expect((await edit(alice, plain.id, "alice fixes alice")).status).toBe(200);
    // The history names who made each edit, newest first.
    const h = await jsonRequest(app, "GET", msgRoute("general", t.message_id, "/history"), undefined, alice.apiKey);
    expect(h.data.edits.map((e: any) => e.by.label)).toEqual(["Alice Example", "grok, on behalf of Alice Example"]);
  });

  it("AC-C1-03 MCP: context_message { action: edit } and context_message_read { history: true } return the REST bodies", async () => {
    const t = await open(alice, "mcp edit");
    const r = await callTool(alice.apiKey, "context_message", { action: "edit", message: t.message_id, body: "mcp edited" });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.message.body).toBe("mcp edited");
    const h = await callTool(rita.apiKey, "context_message_read", { message: t.message_id, history: true });
    expect(h.isError, h.text).toBe(false);
    expect(h.data.message.body).toBe("mcp edited");
    expect(h.data.edits.map((e: any) => e.body)).toEqual(["mcp edit"]);
    expect(h.text).toContain("mcp edit");
    const refused = await callTool(rita.apiKey, "context_message", { action: "edit", message: t.message_id, body: "not mine" });
    expect(refused.isError).toBe(true);
  });
});

describe("AC-C1-04: an edit re-indexes mentions", () => {
  it("AC-C1-04 a name added by the edit is notified and lands in My Work; a name removed leaves it; a name kept is not notified again", async () => {
    const t = await open(alice, "@olivia please look");
    expect(mentionMessages(await work(owner, "?sections=mentions"))).toContain(t.message_id);
    expect(mentionMessages(await work(rita, "?sections=mentions"))).not.toContain(t.message_id);
    const ownerInboxBefore = (await inbox(owner)).filter((n) => n.kind === "mention" && n.message.includes("Alice")).length;
    const ritaInboxBefore = (await inbox(rita)).filter((n) => n.kind === "mention").length;

    const r = await edit(alice, t.message_id, "@rita please look instead");
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.mentions).toEqual([{ name: "rita", kind: "person", display_name: "Rita Reader", notified: true }]);
    expect(mentionMessages(await work(rita, "?sections=mentions"))).toContain(t.message_id);
    expect(mentionMessages(await work(owner, "?sections=mentions"))).not.toContain(t.message_id);
    expect((await inbox(rita)).filter((n) => n.kind === "mention").length).toBe(ritaInboxBefore + 1);

    // Editing again, keeping @rita: no second inbox row for her.
    expect((await edit(alice, t.message_id, "@rita please look, and soon")).status).toBe(200);
    expect((await inbox(rita)).filter((n) => n.kind === "mention").length).toBe(ritaInboxBefore + 1);
    expect((await inbox(owner)).filter((n) => n.kind === "mention" && n.message.includes("Alice")).length).toBe(ownerInboxBefore);
    expect(mentionMessages(await work(rita, "?sections=mentions"))).toContain(t.message_id);
  });

  it("AC-C1-04 an agent newly tagged by an edit is woken; one already tagged is not woken again", async () => {
    wake.setAgentWakeFetch(async (url, init) => {
      sent.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    });
    const hook = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/grok`, { url: "https://runner.example.com/wake" }, owner.apiKey);
    expect(hook.status, JSON.stringify(hook.data)).toBe(200);
    const t = await open(alice, "@grok draft the notes");
    await vi.waitFor(() => expect(sent.length).toBe(1), { timeout: 3000, interval: 10 });
    expect((await edit(alice, t.message_id, "@grok draft the notes, please")).status).toBe(200);
    await tick();
    expect(sent.length).toBe(1);
    const t2 = await open(alice, "nothing for anyone");
    expect((await edit(alice, t2.message_id, "@grok now it is for you")).status).toBe(200);
    await vi.waitFor(() => expect(sent.length).toBe(2), { timeout: 3000, interval: 10 });
    expect(JSON.parse(sent[1].body).message_id).toBe(t2.message_id);
    await jsonRequest(app, "DELETE", `/nests/${nestId}/agent-webhooks/grok`, undefined, owner.apiKey);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-05 — delete
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-05: delete leaves a tombstone; replies stay; owners and admins moderate", () => {
  it("AC-C1-05 the author deletes a post: tombstone on every read, replies kept, gone from My Work and search, pins and saves dropped", async () => {
    const t = await open(alice, "@rita a secret-word-xyzzy post to delete");
    // Alice replies (Rita replying would answer her mention).
    const re = await reply(alice, t.id, "a reply that stays");
    expect((await jsonRequest(app, "POST", msgRoute("general", t.message_id, "/pin"), {}, alice.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "POST", msgRoute("general", t.message_id, "/save"), {}, rita.apiKey)).status).toBe(200);
    expect(mentionMessages(await work(rita, "?sections=mentions"))).toContain(t.message_id);
    expect((await react(rita, t.message_id, "👍")).status).toBe(200);

    const r = await del(alice, t.message_id);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.message).toMatchObject({ id: t.message_id, deleted: true, deleted_by: "author", body: "", reactions: [], pinned: false, saved: false });
    expect(r.data.message.deleted_at).toBeTruthy();

    const tl = await timeline(rita);
    const p = tl.data.posts.find((x: any) => x.id === t.id);
    expect(p).toMatchObject({ deleted: true, deleted_by: "author", body: "", reply_count: 1, reactions: [] });
    expect(p.mentions).toEqual([]);
    const byThread = await threadMessages(rita, t.id);
    expect(byThread.get(t.message_id)).toMatchObject({ deleted: true, body: "" });
    expect(byThread.get(re.id)).toMatchObject({ deleted: false, body: "a reply that stays" });
    const since = await timeline(rita, "general", `?since=2020-01-01T00:00:00Z`);
    expect(since.data.messages.find((m: any) => m.id === t.message_id)).toMatchObject({ deleted: true, body: "" });

    expect(mentionMessages(await work(rita, "?sections=mentions"))).not.toContain(t.message_id);
    const s = await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=xyzzy`, undefined, rita.apiKey);
    expect(s.status).toBe(200);
    expect(s.data.results).toEqual([]);
    const pins = await jsonRequest(app, "GET", `/nests/${nestId}/channels/general/pins`, undefined, rita.apiKey);
    expect(pins.data.pins.map((x: any) => x.message.id)).not.toContain(t.message_id);
    const saved = await jsonRequest(app, "GET", "/me/saved", undefined, rita.apiKey);
    expect(saved.data.saved.map((x: any) => x.message.id)).not.toContain(t.message_id);
    // Deleted is final: no edit, no reaction, no second delete, no pin.
    expect((await edit(alice, t.message_id, "undo?")).status).toBe(409);
    expect((await react(alice, t.message_id, "👍")).status).toBe(409);
    expect((await del(alice, t.message_id)).status).toBe(409);
    expect((await jsonRequest(app, "POST", msgRoute("general", t.message_id, "/pin"), {}, alice.apiKey)).status).toBe(409);
    // The history of a deleted message is not served.
    expect((await jsonRequest(app, "GET", msgRoute("general", t.message_id, "/history"), undefined, rita.apiKey)).status).toBe(404);
  });

  it("AC-C1-05 a reply is deleted the same way; a member can't delete another's; owner and admin can, recorded as moderation", async () => {
    const t = await open(alice, "moderation thread");
    const r1 = await reply(rita, t.id, "rita's reply");
    const r2 = await reply(rita, t.id, "rita's other reply");
    const r3 = await reply(alice, t.id, "alice's reply");
    expect((await del(alice, r1.id)).status).toBe(403);
    expect((await del(rita, r3.id)).status).toBe(403);
    const byOwner = await del(owner, r1.id);
    expect(byOwner.status, JSON.stringify(byOwner.data)).toBe(200);
    expect(byOwner.data.message).toMatchObject({ deleted: true, deleted_by: "moderator" });
    const byAdmin = await del(ada, r2.id);
    expect(byAdmin.status, JSON.stringify(byAdmin.data)).toBe(200);
    expect(byAdmin.data.message).toMatchObject({ deleted: true, deleted_by: "moderator" });
    const own = await del(rita, r3.id);
    expect(own.status).toBe(403);
    const mine = await del(alice, r3.id);
    expect(mine.data.message).toMatchObject({ deleted: true, deleted_by: "author" });
    const byThread = await threadMessages(alice, t.id);
    expect([...byThread.values()].filter((m) => m.deleted).length).toBe(3);
    expect(byThread.get(t.message_id).deleted).toBe(false);
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get("SELECT deleted_by, deleted_reason FROM annotation_comments WHERE id = ?", [r1.id])) as any;
    expect(row).toMatchObject({ deleted_by: owner.email, deleted_reason: "moderation" });
  });

  it("AC-C1-05 an agent deletes only what it wrote", async () => {
    const t = await open(alice, "grok's post", GENERAL, { client: { agent: "grok" } });
    const plain = await reply(alice, t.id, "alice's own");
    expect((await del(alice, plain.id, { client: { agent: "grok" } })).status).toBe(403);
    expect((await del(alice, t.message_id, { client: { agent: "muse" } })).status).toBe(403);
    const ok = await del(alice, t.message_id, { client: { agent: "grok" } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.message.deleted_by).toBe("author");
  });

  it("AC-C1-05 MCP: context_message { action: delete } returns the REST body; the tool text says it is gone", async () => {
    const t = await open(alice, "mcp delete");
    const r = await callTool(alice.apiKey, "context_message", { action: "delete", message: t.message_id });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.message).toMatchObject({ deleted: true, deleted_by: "author" });
    const read = await callTool(rita.apiKey, "context_channel_read", { channel: "general", thread: t.id });
    expect(read.data.thread.post.deleted).toBe(true);
    expect(read.text).toMatch(/deleted/i);
    expect(read.text).not.toContain("mcp delete");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-06 — pins
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-06: pin and unpin; the channel's pins", () => {
  it("AC-C1-06 a member pins and unpins; GET /pins lists newest first with who and when; `pinned` on reads", async () => {
    const node = await newChannel("pinned");
    const a = await open(alice, "pin me first", node);
    const b = await reply(rita, a.id, "pin me second", node);
    const p1 = await jsonRequest(app, "POST", msgRoute("pinned", a.message_id, "/pin"), {}, rita.apiKey);
    expect(p1.status, JSON.stringify(p1.data)).toBe(200);
    expect(p1.data.message).toMatchObject({ id: a.message_id, pinned: true });
    await tick();
    expect((await jsonRequest(app, "POST", msgRoute("pinned", b.id, "/pin"), {}, alice.apiKey)).status).toBe(200);
    // Pinning again changes nothing.
    expect((await jsonRequest(app, "POST", msgRoute("pinned", b.id, "/pin"), {}, rita.apiKey)).status).toBe(200);
    const pins = await jsonRequest(app, "GET", `/nests/${nestId}/channels/pinned/pins`, undefined, rita.apiKey);
    expect(pins.status, JSON.stringify(pins.data)).toBe(200);
    expect(pins.data.channel.name).toBe("pinned");
    expect(pins.data.pins.map((x: any) => x.message.id)).toEqual([b.id, a.message_id]);
    expect(pins.data.pins[1]).toMatchObject({ pinned_by: rita.email, pinned_by_name: "Rita Reader" });
    expect(pins.data.pins[0]).toMatchObject({ pinned_by: alice.email, pinned_by_name: "Alice Example" });
    expect(pins.data.pins[0].pinned_at).toBeTruthy();
    expect(pins.data.pins[0].message).toMatchObject({ thread_id: a.id, reply: true, body: "pin me second", pinned: true });
    const tl = await timeline(alice, "pinned");
    expect(tl.data.posts[0].pinned).toBe(true);
    const un = await jsonRequest(app, "DELETE", msgRoute("pinned", a.message_id, "/pin"), undefined, alice.apiKey);
    expect(un.status).toBe(200);
    expect(un.data.message.pinned).toBe(false);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/pinned/pins`, undefined, rita.apiKey)).data.pins.map((x: any) => x.message.id)).toEqual([b.id]);
    expect((await timeline(alice, "pinned")).data.posts[0].pinned).toBe(false);
    // The pin list is members-only; the other nest's #general has no such pin.
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/pinned/pins`, undefined, stranger.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", msgRoute("general", b.id, "/pin", otherNestId), {}, stranger.apiKey)).status).toBe(404);
  });

  it("AC-C1-06 MCP: context_message { action: pin | unpin } and context_channels { action: pins } return the REST bodies", async () => {
    const node = await newChannel("mcp-pins");
    const a = await open(alice, "pin over mcp", node);
    const r = await callTool(rita.apiKey, "context_message", { action: "pin", message: a.message_id });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.message.pinned).toBe(true);
    const list = await callTool(rita.apiKey, "context_channels", { action: "pins", name: "mcp-pins" });
    expect(list.isError, list.text).toBe(false);
    expect(list.data.pins.map((x: any) => x.message.id)).toEqual([a.message_id]);
    expect(list.text).toContain("pin over mcp");
    const u = await callTool(rita.apiKey, "context_message", { action: "unpin", message: a.message_id });
    expect(u.data.message.pinned).toBe(false);
    // A read-only key is offered the list, not the pin.
    const ro = await mintKey(rita, "ro", { nest_id: nestId, capability: "read" });
    expect((await callTool(ro, "context_channels", { action: "pins", name: "mcp-pins" })).isError).toBe(false);
    const refused = await callTool(ro, "context_message", { action: "pin", message: a.message_id });
    expect(refused.isError || refused.rpcError).toBeTruthy();
    expect(`${refused.text}${refused.rpcError?.message ?? ""}`).toMatch(/read-only/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-07 — saved items
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-07: save for later, across nests", () => {
  it("AC-C1-07 save and unsave; GET /me/saved is paged, newest first, across nests, and private to the saver", async () => {
    const a = await open(alice, "save me (team)");
    const b = await reply(rita, a.id, "save me too (team)");
    const pubGeneral = "nodes/channels/general";
    const c = await open(owner, "save me (pub)", pubGeneral, {}, pubNestId);
    const s1 = await jsonRequest(app, "POST", msgRoute("general", a.message_id, "/save"), {}, owner.apiKey);
    expect(s1.status, JSON.stringify(s1.data)).toBe(200);
    expect(s1.data.message).toMatchObject({ id: a.message_id, saved: true });
    await tick();
    expect((await jsonRequest(app, "POST", msgRoute("general", b.id, "/save"), {}, owner.apiKey)).status).toBe(200);
    await tick();
    expect((await jsonRequest(app, "POST", msgRoute("general", c.message_id, "/save", pubNestId), {}, owner.apiKey)).status).toBe(200);
    // Saving twice is one.
    expect((await jsonRequest(app, "POST", msgRoute("general", c.message_id, "/save", pubNestId), {}, owner.apiKey)).status).toBe(200);

    const all = await jsonRequest(app, "GET", "/me/saved", undefined, owner.apiKey);
    expect(all.status, JSON.stringify(all.data)).toBe(200);
    expect(all.data.saved.map((x: any) => x.message.id)).toEqual([c.message_id, b.id, a.message_id]);
    expect(all.data.saved[0]).toMatchObject({ nest_id: pubNestId, nest_name: "Pub", channel: "general", thread_id: c.id });
    expect(all.data.saved[0].saved_at).toBeTruthy();
    expect(all.data.saved[0].message.url).toBe(`/nest/${pubNestId}/channels?channel=general&thread=${c.id}&message=${c.message_id}`);
    expect(all.data.saved[1].message).toMatchObject({ thread_id: a.id, reply: true, body: "save me too (team)", saved: true });
    expect(all.data.pagination).toMatchObject({ total: 3, limit: 50, offset: 0, has_more: false });
    const page = await jsonRequest(app, "GET", "/me/saved?limit=1&offset=1", undefined, owner.apiKey);
    expect(page.data.saved.map((x: any) => x.message.id)).toEqual([b.id]);
    expect(page.data.pagination).toMatchObject({ total: 3, limit: 1, offset: 1, has_more: true });
    // Only the saver sees `saved: true`, and only the saver's list has it.
    expect((await timeline(owner)).data.posts.find((p: any) => p.id === a.id).saved).toBe(true);
    expect((await timeline(rita)).data.posts.find((p: any) => p.id === a.id).saved).toBe(false);
    expect((await jsonRequest(app, "GET", "/me/saved", undefined, rita.apiKey)).data.saved).toEqual([]);
    // Unsave.
    const u = await jsonRequest(app, "DELETE", msgRoute("general", b.id, "/save"), undefined, owner.apiKey);
    expect(u.status).toBe(200);
    expect(u.data.message.saved).toBe(false);
    expect((await jsonRequest(app, "GET", "/me/saved", undefined, owner.apiKey)).data.saved.map((x: any) => x.message.id)).toEqual([c.message_id, a.message_id]);
  });

  it("AC-C1-07 `saved` is a section of My Work, on REST and over MCP; a nest the person lost leaves the list", async () => {
    const node = await newChannel("saved-work");
    const a = await open(alice, "in my work", node);
    expect((await jsonRequest(app, "POST", msgRoute("saved-work", a.message_id, "/save"), {}, rita.apiKey)).status).toBe(200);
    const w = await work(rita, "?sections=saved");
    expect(Object.keys(w).sort()).toEqual(["saved", "saved_pagination"]);
    expect(w.saved.map((x: any) => x.message.id)).toEqual([a.message_id]);
    expect(w.saved[0]).toMatchObject({ nest_id: nestId, nest_name: "Team", channel: "saved-work", thread_id: a.id });
    const full = await work(rita);
    expect(full.saved.map((x: any) => x.message.id)).toEqual([a.message_id]);
    const mcp = await callTool(rita.apiKey, "context_my_work", { sections: ["saved"] });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.saved.map((x: any) => x.message.id)).toEqual([a.message_id]);
    expect(mcp.text).toContain("in my work");
    // A saved message in a nest the saver can no longer read is left out, and out of the count.
    const tmpNest = (await jsonRequest(app, "POST", "/nests", { name: "Temporary" }, owner.apiKey)).data.nest.id;
    await newChannel("general", owner, tmpNest);
    const added = await jsonRequest(app, "POST", `/nests/${tmpNest}/collaborators`, { email: rita.email, permission: "read" }, owner.apiKey);
    expect(added.status, JSON.stringify(added.data)).toBe(201);
    const t = await open(owner, "you will lose this", "nodes/channels/general", {}, tmpNest);
    expect((await jsonRequest(app, "POST", msgRoute("general", t.message_id, "/save", tmpNest), {}, rita.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "GET", "/me/saved", undefined, rita.apiKey)).data.saved.map((x: any) => x.message.id)).toContain(t.message_id);
    const rm = await jsonRequest(app, "DELETE", `/nests/${tmpNest}/collaborators/${added.data.collaborator.id}`, undefined, owner.apiKey);
    expect(rm.status, JSON.stringify(rm.data)).toBeLessThan(300);
    const after = await jsonRequest(app, "GET", "/me/saved", undefined, rita.apiKey);
    expect(after.data.saved.map((x: any) => x.message.id)).not.toContain(t.message_id);
    expect(after.data.pagination.total).toBe(after.data.saved.length);
  });

  it("AC-C1-07 MCP: context_message { action: save | unsave } returns the REST body", async () => {
    const a = await open(alice, "save over mcp");
    const r = await callTool(rita.apiKey, "context_message", { action: "save", message: a.message_id });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.message.saved).toBe(true);
    const u = await callTool(rita.apiKey, "context_message", { action: "unsave", message: a.message_id });
    expect(u.data.message.saved).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-08 — permalinks
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-08: every message has a url, and a message id can be looked up", () => {
  it("AC-C1-08 url and message_id on the timeline, thread and ?since=; the lookup route answers the channel, thread and message", async () => {
    const a = await open(alice, "find me by id");
    const re = await reply(rita, a.id, "and me");
    const tl = await timeline(rita);
    const p = tl.data.posts.find((x: any) => x.id === a.id);
    expect(p.message_id).toBe(a.message_id);
    expect(p.url).toBe(`/nest/${nestId}/channels?channel=general&thread=${a.id}&message=${a.message_id}`);
    const byThread = await threadMessages(rita, a.id);
    expect(byThread.get(re.id).url).toBe(`/nest/${nestId}/channels?channel=general&thread=${a.id}&message=${re.id}`);
    const since = await timeline(rita, "general", `?since=${a.message_id}`);
    expect(since.data.messages.find((m: any) => m.id === re.id).url).toBe(byThread.get(re.id).url);

    const look = await jsonRequest(app, "GET", `/nests/${nestId}/messages/${re.id}`, undefined, rita.apiKey);
    expect(look.status, JSON.stringify(look.data)).toBe(200);
    expect(look.data.channel).toMatchObject({ id: GENERAL, name: "general", type: "channel" });
    expect(look.data).toMatchObject({ thread_id: a.id, reply: true });
    expect(look.data.message).toMatchObject({ id: re.id, body: "and me", author: rita.email, url: byThread.get(re.id).url });
    expect(look.data.message.reactions).toEqual([]);
    // A thread id looks up its opening message.
    const viaThread = await jsonRequest(app, "GET", `/nests/${nestId}/messages/${a.id}`, undefined, rita.apiKey);
    expect(viaThread.status).toBe(200);
    expect(viaThread.data).toMatchObject({ thread_id: a.id, reply: false });
    expect(viaThread.data.message.id).toBe(a.message_id);
    // MCP twin.
    const mcp = await callTool(rita.apiKey, "context_message_read", { message: re.id });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data).toMatchObject({ thread_id: a.id, reply: true });
    expect(mcp.data.message.id).toBe(re.id);
    expect(mcp.data.edits).toBeUndefined();
    expect(mcp.text).toContain("and me");
  });

  it("AC-C1-08 unknown, unreadable and other-nest ids get the same 404", async () => {
    const a = await open(alice, "mine, not yours");
    const elsewhere = await open(stranger, "theirs, not mine", "nodes/channels/general", {}, otherNestId);
    const unknown = await jsonRequest(app, "GET", `/nests/${nestId}/messages/00000000-0000-4000-8000-000000000000`, undefined, rita.apiKey);
    // A real message, but in a nest this caller is not asking through: the
    // same body as an unknown id.
    const wrongNest = await jsonRequest(app, "GET", `/nests/${nestId}/messages/${elsewhere.message_id}`, undefined, rita.apiKey);
    const strangerRead = await jsonRequest(app, "GET", `/nests/${nestId}/messages/${a.message_id}`, undefined, stranger.apiKey);
    const viaOwnNest = await jsonRequest(app, "GET", `/nests/${otherNestId}/messages/${a.message_id}`, undefined, stranger.apiKey);
    const shareOnly = await jsonRequest(app, "GET", `/nests/${nestId}/messages/${a.message_id}`, undefined, bob.apiKey);
    expect(unknown.status).toBe(404);
    expect(wrongNest.status).toBe(404);
    expect(wrongNest.data).toEqual(unknown.data);
    expect(viaOwnNest.status).toBe(404);
    expect(viaOwnNest.data).toEqual(unknown.data);
    for (const r of [strangerRead, shareOnly]) {
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.data)).not.toContain("mine, not yours");
    }
    const mcp = await callTool(stranger.apiKey, "context_message_read", { message: a.message_id }, otherNestId);
    expect(mcp.isError).toBe(true);
    expect(mcp.text).not.toContain("mine, not yours");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-09 / AC-C1-10 — search
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-09: search a nest's channels", () => {
  let searchNode: string;
  let hits: { a: ReturnType<typeof open> extends Promise<infer T> ? T : never; b: { id: string }; c: { id: string } };
  beforeAll(async () => {
    searchNode = await newChannel("findable");
    const a = await open(alice, "The Quokka release plan is ready", searchNode);
    await tick();
    const b = await reply(rita, a.id, "quokka plan looks fine, ship on friday", searchNode);
    await tick();
    const c = await reply(alice, a.id, "nothing to see here", searchNode);
    await open(alice, "quokka in #general too", GENERAL);
    hits = { a, b, c };
  });

  it("AC-C1-09 matches newest first, every term must match (case-insensitive), with excerpt, highlights, channel, ids and url; non-members 404", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka%20plan`, undefined, rita.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.results.map((x: any) => x.message_id)).toEqual([hits.b.id, hits.a.message_id]);
    const top = r.data.results[0];
    expect(top).toMatchObject({ nest_id: nestId, channel: "findable", thread_id: hits.a.id, reply: true, author: rita.email, author_name: "Rita Reader" });
    expect(top.url).toBe(`/nest/${nestId}/channels?channel=findable&thread=${hits.a.id}&message=${hits.b.id}`);
    expect(top.excerpt).toContain("quokka plan");
    expect(top.highlights.length).toBeGreaterThan(0);
    for (const h of top.highlights) expect(top.excerpt.slice(h.start, h.end).toLowerCase()).toMatch(/^(quokka|plan)$/);
    expect(r.data.pagination).toMatchObject({ limit: 20, offset: 0, has_more: false });
    expect(r.data.ceiling).toBe(1000);
    // Filters: channel, from, before / after.
    const inGeneral = await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka&channel=general`, undefined, rita.apiKey);
    expect(inGeneral.data.results.every((x: any) => x.channel === "general")).toBe(true);
    expect(inGeneral.data.results.length).toBe(1);
    const fromRita = await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka&from=${encodeURIComponent(rita.email)}`, undefined, alice.apiKey);
    expect(fromRita.data.results.map((x: any) => x.message_id)).toEqual([hits.b.id]);
    const fromMe = await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka&from=me`, undefined, rita.apiKey);
    expect(fromMe.data.results.map((x: any) => x.message_id)).toEqual([hits.b.id]);
    const before = await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka&before=${encodeURIComponent(top.created_at)}`, undefined, rita.apiKey);
    expect(before.data.results.map((x: any) => x.message_id)).toEqual([hits.a.message_id]);
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka&after=${encodeURIComponent(hits.a.message_id)}`, undefined, rita.apiKey);
    expect(after.data.results.map((x: any) => x.message_id)).not.toContain(hits.a.message_id);
    expect(after.data.results.map((x: any) => x.message_id)).toContain(hits.b.id);
    // Paging.
    const page = await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka&limit=1&offset=1`, undefined, rita.apiKey);
    expect(page.data.results.length).toBe(1);
    expect(page.data.pagination).toMatchObject({ limit: 1, offset: 1, has_more: true });
    // Bad input.
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=q`, undefined, rita.apiKey)).status).toBe(400);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/search`, undefined, rita.apiKey)).status).toBe(400);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka&before=yesterday`, undefined, rita.apiKey)).status).toBe(400);
    // Non-members: the same not found as any channel read.
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka`, undefined, stranger.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/search?q=quokka`, undefined, bob.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${pubNestId}/channels/search?q=quokka`, undefined, stranger.apiKey)).status).toBe(404);
  });

  it("AC-C1-09 MCP: context_channel_search returns the REST body, and a read-only key may call it", async () => {
    const r = await callTool(rita.apiKey, "context_channel_search", { q: "quokka plan" });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.results.map((x: any) => x.message_id)).toEqual([hits.b.id, hits.a.message_id]);
    expect(r.text).toContain("#findable");
    const ro = await mintKey(rita, "ro-search", { nest_id: nestId, capability: "read" });
    expect(await listToolNames(ro)).toContain("context_channel_search");
    const roCall = await callTool(ro, "context_channel_search", { q: "quokka", channel: "findable" });
    expect(roCall.isError, roCall.text).toBe(false);
    expect(roCall.data.results.length).toBe(2);
  });
});

describe("AC-C1-10: search across the nests I am a member of", () => {
  it("AC-C1-10 GET /me/chat/search spans member nests only; a nest-scoped key gets its nest", async () => {
    const pubGeneral = "nodes/channels/general";
    const p = await open(owner, "wombat (pub)", pubGeneral, {}, pubNestId);
    const t = await open(alice, "wombat (team)");
    await open(stranger, "wombat (elsewhere)", "nodes/channels/general", {}, otherNestId);
    const r = await jsonRequest(app, "GET", "/me/chat/search?q=wombat", undefined, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.results.map((x: any) => x.message_id).sort()).toEqual([p.message_id, t.message_id].sort());
    expect(r.data.results.find((x: any) => x.message_id === p.message_id)).toMatchObject({ nest_id: pubNestId, nest_name: "Pub", channel: "general" });
    // Rita is a member of Team only; the public nest she merely can read is not hers to search.
    const rr = await jsonRequest(app, "GET", "/me/chat/search?q=wombat", undefined, rita.apiKey);
    expect(rr.data.results.map((x: any) => x.message_id)).toEqual([t.message_id]);
    // The stranger sees only their own nest.
    const sr = await jsonRequest(app, "GET", "/me/chat/search?q=wombat", undefined, stranger.apiKey);
    expect(sr.data.results.map((x: any) => x.nest_id)).toEqual([otherNestId]);
    // MCP: all_nests on a personal key spans nests; on a nest-scoped key it is this nest only.
    const mcp = await callTool(owner.apiKey, "context_channel_search", { q: "wombat", all_nests: true });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.results.map((x: any) => x.nest_id).sort()).toEqual([nestId, pubNestId].sort());
    const scoped = await mintKey(owner, "scoped", { nest_id: nestId });
    const scopedCall = await callTool(scoped, "context_channel_search", { q: "wombat", all_nests: true });
    expect(scopedCall.isError, scopedCall.text).toBe(false);
    expect(scopedCall.data.results.map((x: any) => x.nest_id)).toEqual([nestId]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-11 — @channel / @here
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-11: @channel and @here reach every member", () => {
  it("AC-C1-11 every other member gets a My Work row; the post-time mentions say so; agents are not woken; a document comment reaches nobody", async () => {
    wake.setAgentWakeFetch(async (url, init) => {
      sent.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    });
    // A broadcast name can't be a wake-up target, so nothing can be woken by one.
    const hook = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/channel`, { url: "https://runner.example.com/wake" }, owner.apiKey);
    expect(hook.status, JSON.stringify(hook.data)).toBe(400);
    expect((await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/here`, { url: "https://runner.example.com/wake" }, owner.apiKey)).status).toBe(400);
    const t = await open(alice, "@channel standup in five");
    expect(t.mentions).toEqual([{ name: "channel", kind: "everyone", reached: 3 }]);
    for (const u of [owner, ada, rita]) expect(mentionMessages(await work(u, "?sections=mentions"))).toContain(t.message_id);
    expect(mentionMessages(await work(alice, "?sections=mentions"))).not.toContain(t.message_id);
    const row = (await work(rita, "?sections=mentions")).mentions.find((m: any) => m.comment_id === t.message_id);
    expect(row).toMatchObject({ kind: "channel", channel: "general", thread_id: t.id, author: alice.email });
    await tick();
    expect(sent.length).toBe(0);
    // Read-time mentions name it as everyone.
    const tl = await timeline(rita);
    expect(tl.data.posts.find((p: any) => p.id === t.id).mentions).toEqual([{ name: "channel", kind: "everyone" }]);
    // @here reaches the same people (no presence signal on this branch).
    const h = await reply(rita, t.id, "@here now");
    expect(h.mentions).toEqual([{ name: "here", kind: "everyone", reached: 3 }]);
    expect(mentionMessages(await work(alice, "?sections=mentions"))).toContain(h.id);
    // A document comment thread: nobody.
    const doc = await post(owner, "@channel on a document", "nodes/launch-plan");
    expect(doc.status, JSON.stringify(doc.data)).toBe(201);
    expect(doc.data.mentions).toEqual([{ name: "channel", kind: "nobody" }]);
    expect(mentionMessages(await work(rita, "?sections=mentions"))).not.toContain(doc.data.comment_id);
  });

  it("AC-C1-11 a nest with more than 200 members is refused before anything is written", async () => {
    const big = (await jsonRequest(app, "POST", "/nests", { name: "Big" }, owner.apiKey)).data.nest.id;
    await newChannel("general", owner, big);
    const { getDb } = await import("../src/db/client.js");
    const { randomUUID } = await import("node:crypto");
    const db = getDb();
    for (let i = 0; i < 201; i++) {
      const id = randomUUID();
      await db.run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)", [id, `member-${i}-${id.slice(0, 8)}@big.test`, null, "x"]);
      await db.run("INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, 'read', ?)", [randomUUID(), big, id, owner.userId]);
    }
    const r = await post(owner, "@channel hello everyone", "nodes/channels/general", {}, big);
    expect(r.status, JSON.stringify(r.data)).toBe(400);
    expect(String(r.data.error)).toMatch(/200/);
    expect((await timeline(owner, "general", "", big)).data.posts).toEqual([]);
    const mcp = await callTool(owner.apiKey, "context_comment", { channel: "general", body: "@here hello everyone" }, big);
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toMatch(/200/);
    expect((await timeline(owner, "general", "", big)).data.posts).toEqual([]);
    // Without the broadcast the same post is fine.
    expect((await post(owner, "hello everyone", "nodes/channels/general", {}, big)).status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-13 — the switch
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-13: with the switch off, none of this exists", () => {
  it("AC-C1-13 every new route is 404, `saved` is not a section, the tools are gone", async () => {
    const t = await open(alice, "before the switch flips");
    delete process.env.EXPERIMENTAL_AGENT_STREAM;
    try {
      const calls: Array<[string, string, any?]> = [
        ["POST", msgRoute("general", t.message_id, "/reactions"), { emoji: "👍" }],
        ["DELETE", msgRoute("general", t.message_id, "/reactions/%F0%9F%91%8D")],
        ["PATCH", msgRoute("general", t.message_id), { body: "x" }],
        ["DELETE", msgRoute("general", t.message_id)],
        ["GET", msgRoute("general", t.message_id, "/history")],
        ["POST", msgRoute("general", t.message_id, "/pin"), {}],
        ["POST", msgRoute("general", t.message_id, "/save"), {}],
        ["GET", `/nests/${nestId}/channels/general/pins`],
        ["GET", `/nests/${nestId}/channels/search?q=before`],
        ["GET", `/nests/${nestId}/messages/${t.message_id}`],
        ["GET", "/me/saved"],
        ["GET", "/me/chat/search?q=before"],
      ];
      for (const [method, path, body] of calls) {
        const r = await jsonRequest(app, method, path, body, owner.apiKey);
        expect(r.status, `${method} ${path}`).toBe(404);
      }
      expect((await jsonRequest(app, "GET", "/me/work?sections=saved", undefined, owner.apiKey)).status).toBe(400);
      expect((await work(owner)).saved).toBeUndefined();
      const names = await listToolNames(owner.apiKey);
      for (const n of ["context_message", "context_message_read", "context_channel_search"]) expect(names).not.toContain(n);
      const r = await callTool(owner.apiKey, "context_message", { action: "react", message: t.message_id, emoji: "👍" });
      expect(r.rpcError || r.isError).toBeTruthy();
      const w = await callTool(owner.apiKey, "context_my_work", { sections: ["saved"] });
      expect(w.isError).toBe(true);
    } finally {
      process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-14 — who may
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-14: members act on messages; nobody else does; read-only keys read", () => {
  it("AC-C1-14 a share-only grantee, a public reader and a stranger get 404 on every message route; a read-only key gets 403 on writes and reads fine", async () => {
    const t = await open(alice, "guarded");
    const pub = await open(owner, "public nest post", "nodes/channels/general", {}, pubNestId);
    const writes: Array<[string, (nest: string, id: string) => string, any?]> = [
      ["POST", (n, id) => msgRoute("general", id, "/reactions", n), { emoji: "👍" }],
      ["PATCH", (n, id) => msgRoute("general", id, "", n), { body: "x" }],
      ["DELETE", (n, id) => msgRoute("general", id, "", n)],
      ["POST", (n, id) => msgRoute("general", id, "/pin", n), {}],
      ["POST", (n, id) => msgRoute("general", id, "/save", n), {}],
    ];
    const reads: Array<(nest: string, id: string) => string> = [
      (n, id) => msgRoute("general", id, "/history", n),
      (n) => `/nests/${n}/channels/general/pins`,
      (n) => `/nests/${n}/channels/search?q=guarded`,
      (n, id) => `/nests/${n}/messages/${id}`,
    ];
    for (const [who, u, nest, id] of [
      ["share-only grantee (document)", bob, nestId, t.message_id],
      ["share-only grantee (channel node)", carl, nestId, t.message_id],
      ["stranger", stranger, nestId, t.message_id],
      ["public reader", stranger, pubNestId, pub.message_id],
    ] as const) {
      for (const [method, path, body] of writes) {
        expect((await jsonRequest(app, method, path(nest, id), body, u.apiKey)).status, `${who}: ${method} ${path(nest, id)}`).toBe(404);
      }
      for (const path of reads) {
        expect((await jsonRequest(app, "GET", path(nest, id), undefined, u.apiKey)).status, `${who}: GET ${path(nest, id)}`).toBe(404);
      }
    }
    // A member's read-only key: every write is 403, every read works.
    const ro = await mintKey(rita, "ro-member", { nest_id: nestId, capability: "read" });
    for (const [method, path, body] of writes) {
      expect((await jsonRequest(app, method, path(nestId, t.message_id), body, ro)).status, `${method}`).toBe(403);
    }
    for (const path of reads) {
      expect((await jsonRequest(app, "GET", path(nestId, t.message_id), undefined, ro)).status, `GET ${path(nestId, t.message_id)}`).toBe(200);
    }
    // Nothing was changed by any of that.
    const p = (await timeline(alice)).data.posts.find((x: any) => x.id === t.id);
    expect(p).toMatchObject({ body: "guarded", reactions: [], pinned: false, deleted: false });
  });

  it("AC-C1-14 a read-only collaborator may react, pin, save, and edit or delete their own; an archived channel takes none of it", async () => {
    const node = await newChannel("members");
    const t = await open(alice, "members act", node);
    const mine = await reply(rita, t.id, "rita's own", node);
    expect((await react(rita, t.message_id, "👍", {}, "members")).status).toBe(200);
    expect((await jsonRequest(app, "POST", msgRoute("members", t.message_id, "/pin"), {}, rita.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "POST", msgRoute("members", t.message_id, "/save"), {}, rita.apiKey)).status).toBe(200);
    expect((await edit(rita, mine.id, "rita's own, edited", {}, "members")).status).toBe(200);
    expect((await edit(rita, t.message_id, "not rita's", {}, "members")).status).toBe(403);
    expect((await del(rita, t.message_id, {}, "members")).status).toBe(403);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/members/archive`, {}, owner.apiKey)).status).toBe(200);
    expect((await react(rita, t.message_id, "🎉", {}, "members")).status).toBe(409);
    expect((await edit(rita, mine.id, "after archive", {}, "members")).status).toBe(409);
    expect((await jsonRequest(app, "POST", msgRoute("members", mine.id, "/pin"), {}, rita.apiKey)).status).toBe(409);
    expect((await del(rita, mine.id, {}, "members")).status).toBe(409);
    // Reading, saving and unsaving still work on an archived channel.
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/members/pins`, undefined, rita.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "DELETE", msgRoute("members", t.message_id, "/save"), undefined, rita.apiKey)).status).toBe(200);
    // Restored, her own message is hers to delete again.
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels/members/archive`, { archived: false }, owner.apiKey)).status).toBe(200);
    expect((await del(rita, mine.id, {}, "members")).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1-15 — the fields are on every read
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C1-15: every message read carries the new fields", () => {
  it("AC-C1-15 timeline, thread, ?since= and context_channel_read", async () => {
    const node = await newChannel("fields");
    const t = await open(alice, "all the fields", node);
    const re = await reply(rita, t.id, "on replies too", node);
    const keys = ["reactions", "pinned", "saved", "url", "edited_at", "deleted", "deleted_by"];
    const tl = await timeline(rita, "fields");
    for (const k of [...keys, "message_id"]) expect(tl.data.posts[0], k).toHaveProperty(k);
    expect(tl.data.posts[0]).toMatchObject({ reactions: [], pinned: false, saved: false, edited_at: null, deleted: false, deleted_by: null });
    const th = await timeline(rita, "fields", `?thread=${t.id}`);
    for (const k of [...keys, "message_id"]) expect(th.data.thread.post, k).toHaveProperty(k);
    for (const k of keys) expect(th.data.thread.replies[0], k).toHaveProperty(k);
    const since = await timeline(rita, "fields", `?since=${t.message_id}`);
    expect(since.data.messages.map((m: any) => m.id)).toEqual([re.id]);
    for (const k of keys) expect(since.data.messages[0], k).toHaveProperty(k);
    const mcp = await callTool(rita.apiKey, "context_channel_read", { channel: "fields", thread: t.id });
    for (const k of [...keys, "message_id"]) expect(mcp.data.thread.post, k).toHaveProperty(k);
    for (const k of keys) expect(mcp.data.thread.replies[0], k).toHaveProperty(k);
  });
});
