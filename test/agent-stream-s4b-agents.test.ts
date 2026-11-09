/**
 * Agent team stream, S4b (PO-1190): channels for agents over MCP. The red team
 * drove the stack as an agent and found it could read and promote, but not see
 * what was tagged to it, not post without guessing ids, and not learn who it
 * reached. This file pins the fixes.
 *
 * Every acceptance criterion is a describe block named by its AC id
 * (AC-AX-01..12); SEC-* blocks pin the security review's findings.
 *
 * The posting rule these tests assume (owner decision, 2026-11-09): people
 * added to the nest may post in a channel, read-only collaborators included;
 * the public, a document-share grantee and model-written text may not.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type WakeModule = typeof import("../src/stream/agent-wake.js");
type MentionsModule = typeof import("../src/mentions/agent-mentions.js");
let wake: WakeModule;
let mentions: MentionsModule;

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const GENERAL = "nodes/channels/general";
const RUNNER = "https://runner.example.com/wake";

type User = { apiKey: string; userId: string; email: string; cookie: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User; // owns Team, Side and Pub; runs the agent "grok"
let alice: User; // write collaborator on Team
let rita: User; // READ collaborator on Team
let bob: User; // reaches Team only through a share on one document
let nora: User; // write collaborator on Team with a noisy inbox and nothing waiting
let stranger: User; // signed in, on no nest here
let nestId: string;
let sideNestId: string; // owner's second nest; rita is not on it
let pubNestId: string; // world-readable nest with a channel
let grokKey: string; // owner's key, labelled "grok"

type Sent = { url: string; headers: Record<string, string>; body: string };
let sent: Sent[] = [];

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

async function listTools(apiKey: string, nest = nestId): Promise<Array<{ name: string; annotations?: Record<string, unknown>; inputSchema?: any }>> {
  const { body } = await rpc(`/nests/${nest}/mcp`, "tools/list", {}, apiKey);
  return body?.result?.tools ?? [];
}

async function mintKey(u: { apiKey: string }, label: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await jsonRequest(app, "POST", "/auth/keys", { label, ...extra }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r.data.key ?? r.data.apiKey ?? r.data.api_key;
}

async function open(u: { apiKey: string }, node: string, body: string, extra: Record<string, unknown> = {}, nest = nestId) {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations`, { body, ...extra }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.thread as { id: string; comments: Array<{ id: string; body: string; author: string; createdAt: string }> };
}
async function reply(u: { apiKey: string }, node: string, threadId: string, body: string, extra: Record<string, unknown> = {}, nest = nestId) {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations/${threadId}/comments`, { body, ...extra }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r.data.thread as { id: string; comments: Array<{ id: string; body: string; createdAt: string }> };
}
const work = async (key: string, qs = "") => (await jsonRequest(app, "GET", `/me/work${qs}`, undefined, key)).data;
const mentionThreads = (w: any): string[] => (w?.mentions ?? []).map((m: any) => m.thread_id);
const tick = () => new Promise((r) => setTimeout(r, 6));
const waitForSent = (n: number) => vi.waitFor(() => expect(sent.length).toBe(n), { timeout: 3000, interval: 10 });

function captureWakes(statuses: number[] = [200]) {
  let i = 0;
  wake.setAgentWakeFetch(async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(url), headers, body: String(init?.body ?? "") });
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return new Response("ok", { status });
  });
}

beforeAll(async () => {
  env = setupTestEnv();
  process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  app = await createTestApp("key", { ownerEmail: "olivia@s4b.test" });
  wake = await import("../src/stream/agent-wake.js");
  mentions = await import("../src/mentions/agent-mentions.js");
  owner = await registerUser(app, "olivia@s4b.test", "Olivia Owner");
  alice = await registerUser(app, "alice@s4b.test", "Alice Example");
  rita = await registerUser(app, "reader@s4b.test", "Rita Reader");
  await resetAuthRateLimit();
  bob = await registerUser(app, "bob@s4b.test", "Bob Builder");
  stranger = await registerUser(app, "stranger@else.test", "Stranger");
  await resetAuthRateLimit();
  nora = await registerUser(app, "nora@s4b.test", "Nora Noisy");
  await resetAuthRateLimit();

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  sideNestId = (await jsonRequest(app, "POST", "/nests", { name: "Side" }, owner.apiKey)).data.nest.id;
  pubNestId = (await jsonRequest(app, "POST", "/nests", { name: "Pub" }, owner.apiKey)).data.nest.id;
  for (const [u, permission] of [
    [alice, "write"],
    [nora, "write"],
    [rita, "read"],
  ] as const) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  for (const [nest, name] of [
    [nestId, "general"],
    [nestId, "ops"],
    [sideNestId, "general"],
    [pubNestId, "general"],
  ] as const) {
    const ch = await jsonRequest(app, "POST", `/nests/${nest}/channels`, { name, purpose: `Purpose of ${name}` }, owner.apiKey);
    expect(ch.status, JSON.stringify(ch.data)).toBeLessThan(300);
  }
  const plan = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Launch Plan", content: "# Plan" }, owner.apiKey);
  expect(plan.status, JSON.stringify(plan.data)).toBe(201);
  // Bob reaches Team only through a share on the Launch Plan document.
  const g = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/grants`,
    { target_type: "document", target: "nodes/launch-plan", email: bob.email, role: "write" },
    owner.apiKey,
  );
  expect(g.status, JSON.stringify(g.data)).toBe(201);
  const vis = await jsonRequest(app, "PATCH", `/nests/${pubNestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
  expect(vis.status, JSON.stringify(vis.data)).toBe(200);
  grokKey = await mintKey(owner, "grok");
});

afterEach(() => {
  wake.setAgentWakeFetch(null);
  wake.setAgentWebhookResolver(null);
  (wake as any).setAgentWakeBackoff?.(null);
  mentions.setAgentMentionResolver(null);
  sent = [];
});

afterAll(async () => {
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  await env.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-01 — an agent finds what is tagged to it, without a webhook
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-01: context_my_work lists threads that @mention the key's agent label", () => {
  it("AC-AX-01 a thread that tags @grok shows for the grok key, with for_agent", async () => {
    const t = await open(alice, GENERAL, "@grok can you summarise the open risks?");
    const mcp = await callTool(grokKey, "context_my_work", {});
    expect(mcp.isError, mcp.text).toBe(false);
    const item = mcp.data.mentions.find((m: any) => m.thread_id === t.id);
    expect(item, JSON.stringify(mcp.data.mentions)).toBeTruthy();
    expect(item).toMatchObject({ for_agent: "grok", kind: "channel", channel: "general", node_id: GENERAL, author: alice.email });
    expect(mcp.text).toContain("@grok");
    // REST with the same key answers the same.
    expect(mentionThreads(await work(grokKey))).toContain(t.id);
    // The person behind the key, on their own key, was not tagged.
    expect(mentionThreads(await work(owner.apiKey))).not.toContain(t.id);
  });

  it("AC-AX-01 the key owner tagging their own agent still lands in the agent's queue", async () => {
    const t = await open(owner, GENERAL, "@grok draft the release notes");
    expect(mentionThreads((await callTool(grokKey, "context_my_work", {})).data)).toContain(t.id);
  });

  it("AC-AX-01 replying in the thread as that agent clears it", async () => {
    const t = await open(alice, GENERAL, "@grok status?");
    expect(mentionThreads((await callTool(grokKey, "context_my_work", {})).data)).toContain(t.id);
    await tick();
    const r = await callTool(grokKey, "context_comment", { id: GENERAL, thread: t.id, body: "On it." });
    expect(r.isError, r.text).toBe(false);
    expect(mentionThreads((await callTool(grokKey, "context_my_work", {})).data)).not.toContain(t.id);
    // A later mention in the same thread brings it back.
    await tick();
    await reply(alice, GENERAL, t.id, "@grok and the pricing page?");
    expect(mentionThreads((await callTool(grokKey, "context_my_work", {})).data)).toContain(t.id);
  });

  it("AC-AX-01 resolving the thread clears it", async () => {
    const t = await open(alice, GENERAL, "@grok close this out");
    const r = await callTool(grokKey, "context_resolve_comment", { id: GENERAL, thread: t.id });
    expect(r.isError, r.text).toBe(false);
    expect(mentionThreads((await callTool(grokKey, "context_my_work", {})).data)).not.toContain(t.id);
  });

  it("AC-AX-01 a document thread counts too, and a nest-scoped key sees its own nest only", async () => {
    const doc = await open(alice, "nodes/launch-plan", "@grok check section 2");
    const side = await open(owner, GENERAL, "@grok side nest ping", {}, sideNestId);
    const all = mentionThreads((await callTool(grokKey, "context_my_work", {})).data);
    expect(all).toContain(doc.id);
    expect(all).toContain(side.id);
    // (One person can't hold two keys with the same label, so this one
    // declares the agent instead.)
    const scoped = await mintKey(owner, "grok-team-only", { nest_id: nestId });
    const mine = mentionThreads((await callTool(scoped, "context_my_work", { client: { agent: "grok" } })).data);
    expect(mine).toContain(doc.id);
    expect(mine).not.toContain(side.id);
  });
});

describe("SEC-AX-01: an agent label never reveals a thread the key could not open", () => {
  it("SEC-AX-01 a key labelled grok held by someone outside the nest sees nothing", async () => {
    const t = await open(alice, GENERAL, "@grok private to Team");
    const fake = await mintKey(stranger, "grok");
    const w = await work(fake);
    expect(mentionThreads(w)).not.toContain(t.id);
    expect(JSON.stringify(w)).not.toContain("private to Team");
    // Their own nest's MCP endpoint, same label: still nothing from Team.
    const theirs = (await jsonRequest(app, "POST", "/nests", { name: "Elsewhere" }, stranger.apiKey)).data.nest.id;
    const mcp = await callTool(fake, "context_my_work", {}, theirs);
    expect(JSON.stringify(mcp.data)).not.toContain("private to Team");
  });

  it("SEC-AX-01 a caller-declared client.agent widens nothing past the caller's own access", async () => {
    const team = await open(alice, GENERAL, "@grok visible to Team members");
    const side = await open(owner, GENERAL, "@grok only on Side", {}, sideNestId);
    // Rita is on Team, not on Side. Claiming to be grok shows her Team's thread only.
    const mcp = await callTool(rita.apiKey, "context_my_work", { client: { agent: "grok" } });
    expect(mcp.isError, mcp.text).toBe(false);
    const ids = mentionThreads(mcp.data);
    expect(ids).toContain(team.id);
    expect(ids).not.toContain(side.id);
    expect(JSON.stringify(mcp.data)).not.toContain("only on Side");
    // Bob holds a share on one document: a channel thread is not his to see.
    const bobView = await work(await mintKey(bob, "grok"));
    expect(mentionThreads(bobView)).not.toContain(team.id);
    expect(JSON.stringify(bobView)).not.toContain("visible to Team members");
  });

  it("SEC-AX-01 someone else claiming the label can't clear the real agent's queue", async () => {
    const t = await open(alice, GENERAL, "@grok do not let rita hide this");
    await tick();
    const spoof = await callTool(rita.apiKey, "context_comment", { id: GENERAL, thread: t.id, body: "handled!", client: { agent: "grok" } });
    expect(spoof.isError, spoof.text).toBe(false);
    expect(mentionThreads((await callTool(grokKey, "context_my_work", {})).data)).toContain(t.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-02 — limit, sections, and a small default
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-02: context_my_work respects limit and sections, and leads with mentions", () => {
  beforeAll(async () => {
    // Two more @grok threads, and unread "replied to your thread" rows for
    // the owner and for Nora (document threads keep those).
    await open(alice, GENERAL, "@grok one");
    await open(alice, GENERAL, "@grok two");
    const mine = await open(owner, "nodes/launch-plan", "owner's question on the plan");
    for (let i = 0; i < 2; i++) await reply(alice, "nodes/launch-plan", mine.id, `answer ${i}`);
    const hers = await open(nora, "nodes/launch-plan", "nora's question on the plan");
    for (let i = 0; i < 12; i++) await reply(alice, "nodes/launch-plan", hers.id, `a fairly long answer number ${i} that takes up room in an inbox`);
  });

  it("AC-AX-02 limit: 1 caps every section", async () => {
    const mcp = await callTool(grokKey, "context_my_work", { limit: 1, sections: ["mentions", "items", "waiting", "assigned", "notifications"] });
    expect(mcp.isError, mcp.text).toBe(false);
    for (const k of ["mentions", "items", "waiting", "assigned", "notifications"]) {
      expect(Array.isArray(mcp.data[k]), k).toBe(true);
      expect(mcp.data[k].length, k).toBeLessThanOrEqual(1);
    }
    expect(mcp.data.mentions.length).toBe(1);
    expect(mcp.data.mentions_pagination.total).toBeGreaterThan(1);
    expect(mcp.data.notifications.length).toBe(1);
    const five = await callTool(grokKey, "context_my_work", { limit: 5, sections: ["notifications"] });
    expect(five.data.notifications.length).toBeGreaterThanOrEqual(2);
    // REST caps the same way.
    const rest = await work(grokKey, "?limit=1");
    for (const k of ["mentions", "items", "waiting", "assigned", "notifications"]) expect(rest[k].length, k).toBeLessThanOrEqual(1);
  });

  it("AC-AX-02 sections: only the asked sections come back (MCP and REST)", async () => {
    const mcp = await callTool(grokKey, "context_my_work", { sections: ["mentions"] });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(Object.keys(mcp.data).sort()).toEqual(["mentions", "mentions_pagination"]);
    expect(mcp.text).not.toContain("Unread notifications");
    const rest = await work(grokKey, "?sections=mentions");
    expect(Object.keys(rest).sort()).toEqual(["mentions", "mentions_pagination"]);
    expect(rest.mentions).toEqual(mcp.data.mentions);
    const bad = await callTool(grokKey, "context_my_work", { sections: ["everything"] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("mentions");
  });

  it("AC-AX-02 the default leads with mentions and leaves the notification list out", async () => {
    const mcp = await callTool(grokKey, "context_my_work", {});
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.notifications).toBeUndefined();
    expect(mcp.text.indexOf("## Mentions")).toBeGreaterThan(-1);
    expect(mcp.text.indexOf("## Mentions")).toBeLessThan(mcp.text.indexOf("## Waiting on you"));
    // Asking for notifications still works.
    const withN = await callTool(owner.apiKey, "context_my_work", { sections: ["notifications"] });
    expect(Array.isArray(withN.data.notifications)).toBe(true);
  });

  it("AC-AX-02 stays under about 1k tokens when nothing is waiting, however full the inbox", async () => {
    const quiet = await mintKey(nora, "quietbot");
    expect((await work(nora.apiKey)).notifications.length).toBeGreaterThanOrEqual(12);
    const def = await callTool(quiet, "context_my_work", {});
    expect(def.isError, def.text).toBe(false);
    expect(def.data.mentions).toEqual([]);
    // ~4 characters per token.
    expect(def.text.length + JSON.stringify(def.data).length).toBeLessThan(4000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-03 — no-guess addressing
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-03: one way to name a channel, for reading and for posting", () => {
  it("AC-AX-03 context_channel_read takes the name, #name or the node id", async () => {
    for (const channel of ["general", "#general", GENERAL]) {
      const r = await callTool(alice.apiKey, "context_channel_read", { channel, limit: 1 });
      expect(r.isError, `${channel}: ${r.text}`).toBe(false);
      expect(r.data.channel.name).toBe("general");
    }
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/channels/${encodeURIComponent(GENERAL)}?limit=1`, undefined, alice.apiKey);
    expect(rest.status, JSON.stringify(rest.data)).toBe(200);
  });

  it("AC-AX-03 context_comment posts with channel: name, #name or node id", async () => {
    for (const channel of ["general", "#general", GENERAL]) {
      const body = `posted with channel=${channel}`;
      const r = await callTool(alice.apiKey, "context_comment", { channel, body });
      expect(r.isError, `${channel}: ${r.text}`).toBe(false);
      const tl = await jsonRequest(app, "GET", `/nests/${nestId}/channels/general?limit=5`, undefined, alice.apiKey);
      expect(tl.data.posts.map((p: any) => p.body)).toContain(body);
    }
    // The id argument is forgiving in the same way.
    const viaId = await callTool(alice.apiKey, "context_comment", { id: "#general", body: "posted with id=#general" });
    expect(viaId.isError, viaId.text).toBe(false);
  });

  it("AC-AX-03 with thread and no id, the node is inferred from the thread", async () => {
    const t = await open(alice, GENERAL, "thread to reply into");
    const r = await callTool(alice.apiKey, "context_comment", { thread: t.id, body: "reply without an id" });
    expect(r.isError, r.text).toBe(false);
    const th = await jsonRequest(app, "GET", `/nests/${nestId}/channels/general?thread=${t.id}`, undefined, alice.apiKey);
    expect(th.data.thread.replies.map((x: any) => x.body)).toContain("reply without an id");
    // A document thread is inferred the same way.
    const d = await open(alice, "nodes/launch-plan", "doc thread");
    const r2 = await callTool(alice.apiKey, "context_comment", { thread: d.id, body: "doc reply without an id" });
    expect(r2.isError, r2.text).toBe(false);
    // …and a thread the caller can't open is not found, whatever it is.
    const hidden = await open(owner, GENERAL, "side thread", {}, sideNestId);
    const r3 = await callTool(rita.apiKey, "context_comment", { thread: hidden.id, body: "guess" });
    expect(r3.isError).toBe(true);
    expect(r3.text).not.toContain("side thread");
  });

  it("AC-AX-03 a wrong channel answers with the channels that exist", async () => {
    const r = await callTool(alice.apiKey, "context_comment", { channel: "nope", body: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("#general");
    expect(r.text).toContain("#ops");
    const read = await callTool(alice.apiKey, "context_channel_read", { channel: "nope" });
    expect(read.isError).toBe(true);
    expect(read.text).toContain("#general");
    const none = await callTool(alice.apiKey, "context_comment", { body: "no target at all" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("#general");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-04 — the result says what was written and who it reached
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-04: context_comment returns ids and what each @name reached", () => {
  it("AC-AX-04 a post returns thread_id, comment_id and per-name outcomes", async () => {
    captureWakes();
    const set = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/wakebot`, { url: RUNNER }, owner.apiKey);
    expect(set.status, JSON.stringify(set.data)).toBe(200);
    // "muse" has posted here as a declared agent, but has no webhook.
    const seen = await callTool(owner.apiKey, "context_comment", { channel: "general", body: "muse checking in", client: { agent: "muse" } });
    expect(seen.isError, seen.text).toBe(false);

    const r = await callTool(alice.apiKey, "context_comment", {
      channel: "general",
      body: "@reader and @(Olivia Owner) and @Rita and @wakebot and @muse and @nobody-here: summary posted",
    });
    expect(r.isError, r.text).toBe(false);
    expect(typeof r.data.thread_id).toBe("string");
    expect(typeof r.data.comment_id).toBe("string");
    expect(r.data.node_id).toBe(GENERAL);
    const by = Object.fromEntries(r.data.mentions.map((m: any) => [m.name, m]));
    expect(by["reader"]).toMatchObject({ kind: "person", display_name: "Rita Reader", notified: true });
    expect(by["Olivia Owner"]).toMatchObject({ kind: "person", notified: true });
    // A first name alone matches nobody: say so, instead of a silent miss.
    expect(by["Rita"]).toMatchObject({ kind: "nobody" });
    expect(by["wakebot"]).toMatchObject({ kind: "agent", wake: "sent" });
    expect(by["muse"]).toMatchObject({ kind: "agent", wake: "no_webhook" });
    expect(by["nobody-here"]).toMatchObject({ kind: "nobody" });
    // The text says the same in one line.
    const line = r.text.split("\n").find((l) => l.includes("@nobody-here"));
    expect(line, r.text).toBeTruthy();
    expect(line).toContain("@reader");
    expect(line).toContain("@wakebot");
    await waitForSent(1);
    // The ids are real: the thread reads back with that message.
    const th = await jsonRequest(app, "GET", `/nests/${nestId}/channels/general?thread=${r.data.thread_id}`, undefined, alice.apiKey);
    expect(th.data.thread.post.id).toBe(r.data.thread_id);
  });

  it("AC-AX-04 a reply returns the same shape, and the REST routes return it too", async () => {
    const t = await open(alice, GENERAL, "parent");
    const r = await callTool(alice.apiKey, "context_comment", { channel: "general", thread: t.id, body: "@reader fyi" });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.thread_id).toBe(t.id);
    expect(r.data.comment_id).not.toBe(t.comments[0].id);
    expect(r.data.mentions).toHaveLength(1);
    const rest = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${GENERAL}/annotations`, { body: "@reader and @ghost" }, alice.apiKey);
    expect(rest.status).toBe(201);
    expect(rest.data.comment_id).toBe(rest.data.thread.comments[0].id);
    expect(rest.data.mentions.map((m: any) => m.kind)).toEqual(["person", "nobody"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-05 — what is new since
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-05: context_channel_read { since } returns only what is new, oldest first", () => {
  it("AC-AX-05 since a message id, then since next_since", async () => {
    const first = await open(alice, "nodes/channels/ops", "ops one");
    await tick();
    const tl = await callTool(alice.apiKey, "context_channel_read", { channel: "ops" });
    expect(typeof tl.data.next_since).toBe("string");
    const cursor = tl.data.next_since;
    await tick();
    const second = await open(alice, "nodes/channels/ops", "ops two");
    await tick();
    await reply(rita, "nodes/channels/ops", first.id, "reply on one");
    const r = await callTool(alice.apiKey, "context_channel_read", { channel: "ops", since: cursor });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.messages.map((m: any) => m.body)).toEqual(["ops two", "reply on one"]);
    expect(r.data.messages[0]).toMatchObject({ thread_id: second.id, reply: false });
    expect(r.data.messages[1]).toMatchObject({ thread_id: first.id, reply: true });
    expect(r.data.posts).toBeUndefined();
    // Nothing new after that.
    const again = await callTool(alice.apiKey, "context_channel_read", { channel: "ops", since: r.data.next_since });
    expect(again.data.messages).toEqual([]);
    expect(again.data.next_since).toBe(r.data.next_since);
    // REST is the same object.
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops?since=${encodeURIComponent(cursor)}`, undefined, alice.apiKey);
    expect(rest.status).toBe(200);
    expect(rest.data.messages.map((m: any) => m.id)).toEqual(r.data.messages.map((m: any) => m.id));
    expect(rest.data.next_since).toBe(r.data.next_since);
  });

  it("AC-AX-05 since a timestamp, and a bad value is refused plainly", async () => {
    const before = new Date(Date.now() - 1).toISOString();
    await tick();
    await open(alice, "nodes/channels/ops", "after the timestamp");
    const r = await callTool(alice.apiKey, "context_channel_read", { channel: "ops", since: before });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.messages.map((m: any) => m.body)).toEqual(["after the timestamp"]);
    const far = await callTool(alice.apiKey, "context_channel_read", { channel: "ops", since: "2099-01-01T00:00:00Z" });
    expect(far.data.messages).toEqual([]);
    const bad = await callTool(alice.apiKey, "context_channel_read", { channel: "ops", since: "yesterday-ish" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("since");
    // A message id from another channel is not a cursor here.
    const other = await open(alice, GENERAL, "elsewhere");
    const cross = await callTool(alice.apiKey, "context_channel_read", { channel: "ops", since: other.comments[0].id });
    expect(cross.isError).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-06 — a read-only key
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-06: a read-only key lists channels and is told plainly it can't write", () => {
  let roKey: string;
  beforeAll(async () => {
    roKey = await mintKey(alice, "ro", { nest_id: nestId, capability: "read" });
  });

  it("AC-AX-06 context_channels is offered, list only, with read-only hints", async () => {
    const tools = await listTools(roKey);
    const t = tools.find((x) => x.name === "context_channels");
    expect(t, tools.map((x) => x.name).join(",")).toBeTruthy();
    expect(t!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(Object.keys(t!.inputSchema?.properties ?? {})).not.toContain("purpose");
    const list = await callTool(roKey, "context_channels", {});
    expect(list.isError, list.text).toBe(false);
    expect(list.data.channels.map((c: any) => c.name)).toContain("general");
    // A writer's key still gets the full tool.
    const full = (await listTools(alice.apiKey)).find((x) => x.name === "context_channels");
    expect(Object.keys(full!.inputSchema?.properties ?? {})).toContain("purpose");
  });

  it("AC-AX-06 a write call says the key is read-only, not 'Tool not found'", async () => {
    for (const [name, args] of [
      ["context_comment", { channel: "general", body: "ro key tries to post" }],
      ["context_channels", { action: "create", name: "ro-made" }],
      ["context_promote_thread", { thread: "x" }],
    ] as const) {
      const r = await callTool(roKey, name, args);
      const said = `${r.text} ${r.rpcError?.message ?? ""}`;
      expect(said, name).toContain("This key is read-only; use a read-write key to post");
      expect(said.toLowerCase(), name).not.toContain("not found");
    }
    const tl = await jsonRequest(app, "GET", `/nests/${nestId}/channels/general?limit=5`, undefined, alice.apiKey);
    expect(JSON.stringify(tl.data)).not.toContain("ro key tries to post");
    // A name that is no tool at all is still unknown.
    const unknown = await callTool(roKey, "context_not_a_tool", {});
    expect(`${unknown.text} ${unknown.rpcError?.message ?? ""}`).not.toContain("read-write key");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-07 — the wake-up says enough to act
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-07: the wake-up payload carries author, excerpt and the read call", () => {
  beforeAll(async () => {
    const set = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/scout`, { url: RUNNER }, owner.apiKey);
    expect(set.status, JSON.stringify(set.data)).toBe(200);
  });

  it("AC-AX-07 a channel mention: author label, a 280-char excerpt, context_channel_read", async () => {
    captureWakes();
    const long = `@scout ${"risk ".repeat(100)}`;
    const t = await open(alice, GENERAL, long);
    await waitForSent(1);
    const p = JSON.parse(sent[0].body);
    expect(p.author).toBe("Alice Example");
    expect(typeof p.excerpt).toBe("string");
    expect(p.excerpt.length).toBeLessThanOrEqual(281);
    expect(p.excerpt.startsWith("@scout risk")).toBe(true);
    expect(p.read).toEqual({ tool: "context_channel_read", arguments: { channel: "general", thread: t.id } });
    // The read call works as given.
    const r = await callTool(grokKey, p.read.tool, p.read.arguments);
    expect(r.isError, r.text).toBe(false);
    expect(r.data.thread.post.id).toBe(t.id);
  });

  it("AC-AX-07 a document mention: context_comments { id, thread } returns that one thread", async () => {
    captureWakes();
    await open(alice, "nodes/launch-plan", "an unrelated thread on the plan");
    const t = await open(alice, "nodes/launch-plan", "@scout review the plan");
    await waitForSent(1);
    const p = JSON.parse(sent[0].body);
    expect(p.channel).toBeNull();
    expect(p.read).toEqual({ tool: "context_comments", arguments: { id: "nodes/launch-plan", thread: t.id } });
    const r = await callTool(grokKey, p.read.tool, p.read.arguments);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("review the plan");
    expect(r.text).not.toContain("an unrelated thread");
    expect(r.data.thread.id).toBe(t.id);
    const miss = await callTool(grokKey, "context_comments", { id: "nodes/launch-plan", thread: "no-such-thread" });
    expect(miss.isError).toBe(true);
  });

  it("SEC-AX-07 the excerpt is left out when the target is not this nest's own", async () => {
    captureWakes();
    // An identity-layer resolver answering from somewhere else.
    wake.setAgentWebhookResolver(async (_nest, handle) => (handle === "elsewhere" ? { url: "https://other.example.com/hook", secret: "whsec_x" } : null));
    await open(alice, GENERAL, "@elsewhere the launch date is a secret");
    await waitForSent(1);
    const p = JSON.parse(sent[0].body);
    expect(p.excerpt).toBeUndefined();
    expect(sent[0].body).not.toContain("launch date");
    expect(p.read.tool).toBe("context_channel_read");
  });

  it("SEC-AX-07 the excerpt never carries code-fenced secrets past 280 characters or another thread's text", async () => {
    captureWakes();
    const t = await open(alice, GENERAL, "first message, not for the agent: token=abc123");
    await tick();
    await reply(alice, GENERAL, t.id, "@scout only this line");
    await waitForSent(1);
    const p = JSON.parse(sent[0].body);
    expect(p.excerpt).toBe("@scout only this line");
    expect(sent[0].body).not.toContain("abc123");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-08 — retries
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-08: a failed wake-up is retried with the same idempotency key, and the result is kept", () => {
  beforeAll(async () => {
    const set = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/flaky`, { url: RUNNER }, owner.apiKey);
    expect(set.status, JSON.stringify(set.data)).toBe(200);
  });
  const lastDelivery = async (handle: string) => {
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    return r.data.webhooks.find((w: any) => w.handle === handle)?.last_delivery;
  };

  it("AC-AX-08 two failures then success: three POSTs, one key, stored as ok", async () => {
    (wake as any).setAgentWakeBackoff([5, 5, 5]);
    captureWakes([500, 503, 200]);
    await open(alice, GENERAL, "@flaky wake up");
    await waitForSent(3);
    expect(new Set(sent.map((s) => s.headers["idempotency-key"])).size).toBe(1);
    expect(new Set(sent.map((s) => s.body)).size).toBe(1);
    await vi.waitFor(async () => expect((await lastDelivery("flaky"))?.status).toBe("ok"), { timeout: 3000, interval: 20 });
    const d = await lastDelivery("flaky");
    expect(d).toMatchObject({ status: "ok", attempts: 3, reason: null, event: "agent.mention" });
    expect(typeof d.at).toBe("string");
  });

  it("AC-AX-08 it gives up after three retries and stores the failure and why", async () => {
    (wake as any).setAgentWakeBackoff([5, 5, 5]);
    captureWakes([500]);
    await open(alice, GENERAL, "@flaky wake up again");
    await waitForSent(4);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.length).toBe(4);
    await vi.waitFor(async () => expect((await lastDelivery("flaky"))?.status).toBe("failed"), { timeout: 3000, interval: 20 });
    expect(await lastDelivery("flaky")).toMatchObject({ status: "failed", attempts: 4, reason: "HTTP 500" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-09 — the connect message
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-09: initialize says how to use channels, in two lines", () => {
  const init = (key: string) =>
    rpc(`/nests/${nestId}/mcp`, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }, key);

  it("AC-AX-09 with the switch on", async () => {
    const { body } = await init(grokKey);
    const text = String(body?.result?.instructions ?? "");
    for (const tool of ["context_channels", "context_channel_read", "context_comment", "context_my_work"]) expect(text, tool).toContain(tool);
    const lines = text.split("\n").filter((l) => /context_channels|context_my_work/.test(l));
    expect(lines.length).toBe(2);
    expect(lines.join("\n").length).toBeLessThan(700);
  });

  it("AC-AX-09 not with the switch off", async () => {
    delete process.env.EXPERIMENTAL_AGENT_STREAM;
    try {
      const { body } = await init(grokKey);
      expect(String(body?.result?.instructions ?? "")).not.toContain("context_channels");
    } finally {
      process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-10 — channels are members-only
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-10: channels and their messages are members-only, even in a public nest", () => {
  let threadId: string;
  beforeAll(async () => {
    threadId = (await open(owner, GENERAL, "members-only chatter in a public nest", {}, pubNestId)).id;
  });

  it("AC-AX-10 a signed-in non-member gets nothing by REST", async () => {
    const list = await jsonRequest(app, "GET", `/nests/${pubNestId}/channels`, undefined, stranger.apiKey);
    expect(list.status === 404 || (list.status === 200 && list.data.channels.length === 0), JSON.stringify(list.data)).toBe(true);
    expect((await jsonRequest(app, "GET", `/nests/${pubNestId}/channels/general`, undefined, stranger.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${pubNestId}/channels/general?thread=${threadId}`, undefined, stranger.apiKey)).status).toBe(404);
    const threads = await jsonRequest(app, "GET", `/nests/${pubNestId}/nodes/${GENERAL}/annotations`, undefined, stranger.apiKey);
    expect([403, 404]).toContain(threads.status);
    expect(JSON.stringify(threads.data)).not.toContain("members-only chatter");
    const node = await jsonRequest(app, "GET", `/nests/${pubNestId}/nodes/${GENERAL}`, undefined, stranger.apiKey);
    expect([403, 404]).toContain(node.status);
    const nodes = await jsonRequest(app, "GET", `/nests/${pubNestId}/nodes`, undefined, stranger.apiKey);
    expect(JSON.stringify(nodes.data)).not.toContain("channels/general");
    const handles = await jsonRequest(app, "GET", `/nests/${pubNestId}/agent-handles`, undefined, stranger.apiKey);
    expect([403, 404]).toContain(handles.status);
  });

  it("AC-AX-10 an anonymous visitor gets nothing", async () => {
    for (const path of [`/nests/${pubNestId}/channels`, `/nests/${pubNestId}/channels/general`, `/nests/${pubNestId}/nodes/${GENERAL}/annotations`, `/nests/${pubNestId}/nodes/${GENERAL}`]) {
      const res = await app.request(path);
      const text = await res.text();
      expect(text, path).not.toContain("members-only chatter");
      expect(text, path).not.toContain("Purpose of general");
    }
  });

  it("AC-AX-10 a non-member gets nothing by MCP", async () => {
    const list = await callTool(stranger.apiKey, "context_channels", {}, pubNestId);
    expect(JSON.stringify(list)).not.toContain("general");
    const read = await callTool(stranger.apiKey, "context_channel_read", { channel: "general" }, pubNestId);
    expect(read.isError || !!read.rpcError).toBe(true);
    const threads = await callTool(stranger.apiKey, "context_comments", { id: GENERAL }, pubNestId);
    expect(JSON.stringify(threads)).not.toContain("members-only chatter");
    const got = await callTool(stranger.apiKey, "context_get", { id: GENERAL }, pubNestId);
    expect(JSON.stringify(got)).not.toContain("Purpose of general");
    const post = await callTool(stranger.apiKey, "context_comment", { channel: "general", body: "hello from the world" }, pubNestId);
    expect(post.isError || !!post.rpcError).toBe(true);
  });

  it("AC-AX-10 the nest's members still read it, a read-only member included", async () => {
    const add = await jsonRequest(app, "POST", `/nests/${pubNestId}/collaborators`, { email: rita.email, permission: "read" }, owner.apiKey);
    expect(add.status, JSON.stringify(add.data)).toBeLessThan(300);
    const tl = await jsonRequest(app, "GET", `/nests/${pubNestId}/channels/general`, undefined, rita.apiKey);
    expect(tl.status).toBe(200);
    expect(tl.data.posts.map((p: any) => p.body)).toContain("members-only chatter in a public nest");
    expect(tl.data.channel.purpose).toBe("Purpose of general");
  });

  it("AC-AX-10 GET /nests/:id says whether the caller is a person added to the nest", async () => {
    // What a client gates the Channels entry on: no request to /channels needed.
    const member = async (key: string, nest: string) => (await jsonRequest(app, "GET", `/nests/${nest}`, undefined, key)).data.member;
    expect(await member(owner.apiKey, pubNestId)).toBe(true);
    expect(await member(rita.apiKey, nestId)).toBe(true);
    expect(await member(stranger.apiKey, pubNestId)).toBe(false);
    expect(await member(bob.apiKey, nestId)).toBe(false);
  });

  it("AC-AX-10 a document-share grantee does not reach channels", async () => {
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, bob.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/general`, undefined, bob.apiKey)).status).toBe(404);
    const threads = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${GENERAL}/annotations`, undefined, bob.apiKey);
    expect([403, 404]).toContain(threads.status);
  });

  it("AC-AX-10 a channel node is left out of the published docs site", async () => {
    await jsonRequest(app, "POST", `/nests/${pubNestId}/nodes`, { title: "Welcome", content: "# Welcome\n\nPublic text." }, owner.apiKey);
    const rm = await jsonRequest(app, "PATCH", `/nests/${pubNestId}/reader-mode`, { enabled: true }, owner.apiKey);
    expect(rm.status, JSON.stringify(rm.data)).toBe(200);
    const get = (path: string) => app.request(`http://localhost${path}`, { headers: { Accept: "text/html" } });
    const home = await get("/d/pub/");
    expect(home.status).toBe(200);
    for (const path of ["/d/pub/sitemap.xml", "/d/pub/llms.txt", "/d/pub/llms-full.txt", "/d/pub/"]) {
      const text = await (await get(path)).text();
      expect(text, path).not.toContain("channels/general");
      expect(text, path).not.toContain("Purpose of general");
    }
    expect((await get("/d/pub/channels/general")).status).toBe(404);
    expect(await (await get("/d/pub/llms-full.txt")).text()).toContain("Public text.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-11 — a channel is retired by archiving, not by editing its document
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-11: removing the #channel tag, moving or deleting a channel node is refused", () => {
  beforeAll(async () => {
    const ch = await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "keepme" }, owner.apiKey);
    expect(ch.status, JSON.stringify(ch.data)).toBeLessThan(300);
    await open(alice, "nodes/channels/keepme", "history worth keeping");
  });
  const stillThere = async () => {
    const tl = await jsonRequest(app, "GET", `/nests/${nestId}/channels/keepme`, undefined, alice.apiKey);
    expect(tl.status, JSON.stringify(tl.data)).toBe(200);
    expect(tl.data.posts.map((p: any) => p.body)).toContain("history worth keeping");
  };

  it("AC-AX-11 REST: untag, move and delete are refused, pointing to archive", async () => {
    const untag = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/channels/keepme`, { tags: ["#notes"] }, owner.apiKey);
    expect(untag.status, JSON.stringify(untag.data)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(untag.data).toLowerCase()).toContain("archive");
    const move = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/nodes/channels/keepme/move`, { folder: "attic" }, owner.apiKey);
    expect(move.status, JSON.stringify(move.data)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(move.data).toLowerCase()).toContain("archive");
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/nodes/channels/keepme`, undefined, owner.apiKey);
    expect(del.status, JSON.stringify(del.data)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(del.data).toLowerCase()).toContain("archive");
    await stillThere();
  });

  it("AC-AX-11 MCP: context_update tags, context_move and context_delete are refused", async () => {
    const untag = await callTool(owner.apiKey, "context_update", { id: "nodes/channels/keepme", tags: ["#notes"] });
    expect(`${untag.text}`.toLowerCase()).toContain("archive");
    const move = await callTool(owner.apiKey, "context_move", { id: "nodes/channels/keepme", folder: "attic" });
    expect(`${move.text}`.toLowerCase()).toContain("archive");
    const del = await callTool(owner.apiKey, "context_delete", { id: "nodes/channels/keepme" });
    expect(`${del.text}`.toLowerCase()).toContain("archive");
    await stillThere();
  });

  it("AC-AX-11 editing the purpose, adding a tag, archive and unarchive still work", async () => {
    const edit = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/channels/keepme`, { content: "A new purpose.", tags: ["#channel", "#team"] }, owner.apiKey);
    expect(edit.status, JSON.stringify(edit.data)).toBeLessThan(300);
    const arch = await jsonRequest(app, "POST", `/nests/${nestId}/channels/keepme/archive`, {}, owner.apiKey);
    expect(arch.status, JSON.stringify(arch.data)).toBe(200);
    expect(arch.data.channel.archived).toBe(true);
    const back = await jsonRequest(app, "POST", `/nests/${nestId}/channels/keepme/archive`, { archived: false }, owner.apiKey);
    expect(back.data.channel.archived).toBe(false);
    await stillThere();
    // An ordinary document in the channels folder is still an ordinary document.
    const plain = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Notes", content: "x", folder: "channels" }, owner.apiKey);
    expect(plain.status).toBe(201);
    expect((await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/${plain.data.node.id}`, undefined, owner.apiKey)).status).toBeLessThan(300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AX-12 — a key label is not an agent
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-AX-12: '<agent>, on behalf of <person>' only for a caller-declared agent", () => {
  const latest = async () => (await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops?limit=1`, undefined, alice.apiKey)).data.posts[0];

  it("AC-AX-12 a labelled key that declares nothing shows the person alone (REST and MCP)", async () => {
    const laptop = await mintKey(alice, "laptop");
    await tick();
    await open({ apiKey: laptop }, "nodes/channels/ops", "typed through a personal key");
    let p = await latest();
    expect(p.body).toBe("typed through a personal key");
    expect(p.actor).toEqual({ human: "Alice Example", agent: null, label: "Alice Example" });
    expect(p.author).toBe(alice.email);
    await tick();
    const r = await callTool(laptop, "context_comment", { channel: "ops", body: "typed through MCP with a personal key" });
    expect(r.isError, r.text).toBe(false);
    p = await latest();
    expect(p.actor).toEqual({ human: "Alice Example", agent: null, label: "Alice Example" });
  });

  it("AC-AX-12 a caller-declared client.agent shows the agent, on behalf of the person", async () => {
    await tick();
    const r = await callTool(grokKey, "context_comment", { channel: "ops", body: "grok reporting", client: { agent: "grok" } });
    expect(r.isError, r.text).toBe(false);
    let p = await latest();
    expect(p.actor).toEqual({ human: "Olivia Owner", agent: "grok", label: "grok, on behalf of Olivia Owner" });
    await tick();
    await open(alice, "nodes/channels/ops", "rest with a declared agent", { client: { agent: "muse" } });
    p = await latest();
    expect(p.actor).toMatchObject({ agent: "muse", label: "muse, on behalf of Alice Example" });
  });

  it("AC-AX-12 an undeclared key label still does not wake itself, and still answers as itself", async () => {
    captureWakes();
    const set = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/grok`, { url: RUNNER }, owner.apiKey);
    expect(set.status, JSON.stringify(set.data)).toBe(200);
    try {
      await callTool(grokKey, "context_comment", { channel: "ops", body: "note to self: @grok remember this" });
      await new Promise((r) => setTimeout(r, 60));
      expect(sent.length).toBe(0);
    } finally {
      await jsonRequest(app, "DELETE", `/nests/${nestId}/agent-webhooks/grok`, undefined, owner.apiKey);
    }
  });
});
