/**
 * Agent team stream, S3 (PO-1181): artifact cards, agent wake-up on mention,
 * promote a thread to a node.
 *
 *   - Cards: `[[wikilinks]]`, document links and hosted-artifact URLs in a
 *     message resolve, per viewer, to {title, type, stage, version}; a link
 *     the viewer can't read (or that names nothing) is an unresolved marker
 *     that never carries the title. Batch endpoint POST /nests/:id/cards,
 *     and `cards` on every channel message (REST timeline + MCP
 *     context_channel_read).
 *   - Wake-up: an @mention of an agent handle with a webhook target sends ONE
 *     signed POST through the notify webhook path, idempotent per message and
 *     handle. Targets live in the admin-only `agent_webhooks` map.
 *   - Promote: POST /nests/:id/threads/:threadId/promote and MCP
 *     context_promote_thread create a decision or task node quoting the
 *     thread, with `source_thread` set, and reply in the thread with a link.
 *
 * Every acceptance criterion is a describe block named by its AC id; SEC-*
 * blocks pin the security review's findings, test-first.
 */
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type WakeModule = typeof import("../src/stream/agent-wake.js");
type MentionsModule = typeof import("../src/mentions/agent-mentions.js");
let wake: WakeModule;
let mentions: MentionsModule;

const OWNER_EMAIL = "owner@stream.test";
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const OPS = "nodes/channels/ops";
const RUNNER = "https://runner.example.com/wake";

type User = { apiKey: string; userId: string; email: string; cookie: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let alice: User; // write collaborator on Team and Side
let bob: User; // grant-only: a read share on the #ops channel, nothing else
let carol: User; // write collaborator on Team — promotes
let dave: User; // write collaborator on Team, NOT on Side
let reader: User; // read collaborator on Team
let outsider: User;
let nestId: string;
let sideNestId: string;
let secretId: string; // nodes/secret-plan in Team
let sideDocId: string; // a doc in Side

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

async function listToolNames(apiKey: string, nest = nestId): Promise<string[]> {
  const { body } = await rpc(`/nests/${nest}/mcp`, "tools/list", {}, apiKey);
  return (body?.result?.tools ?? []).map((t: { name: string }) => t.name);
}

async function open(u: { apiKey: string }, node: string, body: string, extra: Record<string, unknown> = {}, nest = nestId) {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations`, { body, ...extra }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.thread as { id: string; comments: Array<{ id: string; body: string; author: string }> };
}
async function reply(u: { apiKey: string }, node: string, threadId: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${node}/annotations/${threadId}/comments`, { body, ...extra }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r.data.thread as { id: string; comments: Array<{ id: string; body: string }> };
}
async function cards(u: { apiKey: string }, payload: Record<string, unknown>, nest = nestId) {
  return jsonRequest(app, "POST", `/nests/${nest}/cards`, payload, u.apiKey);
}
async function setWebhook(u: { apiKey: string }, handle: string, url: string) {
  return jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/${handle}`, { url }, u.apiKey);
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const waitForSent = (n: number) => vi.waitFor(() => expect(sent.length).toBe(n), { timeout: 2000, interval: 10 });

function sign(secret: string, t: string, body: string) {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

beforeAll(async () => {
  env = setupTestEnv();
  process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  wake = await import("../src/stream/agent-wake.js");
  mentions = await import("../src/mentions/agent-mentions.js");
  owner = await registerUser(app, OWNER_EMAIL, "Owner");
  alice = await registerUser(app, "alice@stream.test", "Alice Example");
  bob = await registerUser(app, "bob@stream.test", "Bob Builder");
  await resetAuthRateLimit();
  carol = await registerUser(app, "carol@stream.test", "Carol");
  dave = await registerUser(app, "dave@stream.test", "Dave");
  reader = await registerUser(app, "reader@stream.test", "Reader");
  await resetAuthRateLimit();
  outsider = await registerUser(app, "outsider@else.test", "Outsider");

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  sideNestId = (await jsonRequest(app, "POST", "/nests", { name: "Side" }, owner.apiKey)).data.nest.id;
  for (const [u, permission] of [
    [alice, "write"],
    [carol, "write"],
    [dave, "write"],
    [reader, "read"],
  ] as const) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  {
    const r = await jsonRequest(app, "POST", `/nests/${sideNestId}/collaborators`, { email: alice.email, permission: "write" }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  const ch = await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "ops" }, owner.apiKey);
  expect(ch.status, JSON.stringify(ch.data)).toBeLessThan(300);
  const secret = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Secret Plan", content: "# Secret" }, owner.apiKey);
  expect(secret.status, JSON.stringify(secret.data)).toBe(201);
  secretId = secret.data.node.id;
  const side = await jsonRequest(app, "POST", `/nests/${sideNestId}/nodes`, { title: "Side Roadmap", content: "x" }, owner.apiKey);
  expect(side.status, JSON.stringify(side.data)).toBe(201);
  sideDocId = side.data.node.id;
  // Bob reaches the nest only through a share on the channel itself.
  const g = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/grants`,
    { target_type: "document", target: OPS, email: bob.email, role: "read" },
    owner.apiKey,
  );
  expect(g.status, JSON.stringify(g.data)).toBe(201);
});

afterEach(() => {
  wake.setAgentWakeFetch(null);
  wake.setAgentWebhookResolver(null);
  mentions.setAgentMentionResolver(null);
  sent = [];
});

afterAll(async () => {
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  await env.cleanup();
});

function captureWakes(status = 200) {
  wake.setAgentWakeFetch(async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(url), headers, body: String(init?.body ?? "") });
    return new Response("ok", { status });
  });
}

// ─── AC-ST-01 ───────────────────────────────────────────────────────────

describe("AC-ST-01: artifact cards are resolved per viewer and never leak a title", () => {
  it("a reader of the node gets a card; a non-reader and a missing node get the same unresolved marker", async () => {
    const links = [`[[${secretId}]]`, "[[nodes/does-not-exist]]"];
    const a = await cards(alice, { links });
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    const [aliceCard, aliceMissing] = a.data.cards;
    expect(aliceCard).toMatchObject({ link: links[0], resolved: true, node_id: secretId, nest_id: nestId, title: "Secret Plan", type: "document" });
    expect(typeof aliceCard.version).toBe("number");
    expect(aliceCard).toHaveProperty("stage");
    expect(aliceMissing).toEqual({ link: links[1], resolved: false });

    // Bob can read the channel thread, but not the document it links.
    const thread = await open(alice, OPS, `Read [[${secretId}]] before standup`);
    const seen = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${OPS}/annotations`, undefined, bob.apiKey);
    expect(seen.status, JSON.stringify(seen.data)).toBe(200);
    const b = await cards(bob, { texts: [thread.comments[0].body] });
    expect(b.status, JSON.stringify(b.data)).toBe(200);
    expect(b.data.messages[0].cards).toEqual([{ link: `[[${secretId}]]`, resolved: false }]);
    expect(JSON.stringify(b.data)).not.toContain("Secret Plan");

    // The unresolved shape for "can't read" is byte-identical to "doesn't exist".
    const b2 = await cards(bob, { links: [`[[${secretId}]]`, "[[nodes/does-not-exist]]"] });
    expect(Object.keys(b2.data.cards[0]).sort()).toEqual(Object.keys(b2.data.cards[1]).sort());
  });

  it("resolves a title wikilink, a document link and a hosted-artifact URL", async () => {
    const r = await cards(alice, {
      links: [
        "[[Secret Plan]]",
        `https://nest.example.com/nest/${nestId}?doc=${encodeURIComponent(secretId)}`,
        `https://nest.example.com/nests/${nestId}/nodes/${secretId}/hosted`,
      ],
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.cards.map((c: any) => [c.resolved, c.node_id])).toEqual([
      [true, secretId],
      [true, secretId],
      [true, secretId],
    ]);
    expect(r.data.cards[2].kind).toBe("artifact");
  });

  it("extracts links from text: wikilinks with aliases and URLs, ignoring code spans", async () => {
    const r = await cards(alice, {
      texts: [`see [[${secretId}|the plan]] and \`[[nodes/hidden-in-code]]\` plus https://x.example/nest/${nestId}?doc=${encodeURIComponent(secretId)}.`],
    });
    const got = r.data.messages[0].cards;
    expect(got.map((c: any) => c.resolved)).toEqual([true, true]);
    expect(got.map((c: any) => c.link)).not.toContain("[[nodes/hidden-in-code]]");
  });

  it("channel timeline and thread carry per-viewer cards, cross-nest included (REST and MCP)", async () => {
    const link = `https://nest.example.com/nest/${sideNestId}?doc=${encodeURIComponent(sideDocId)}`;
    const t = await open(alice, OPS, `Cross-nest: ${link} and [[${secretId}]]`);

    const asAlice = await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops?thread=${t.id}`, undefined, alice.apiKey);
    expect(asAlice.status, JSON.stringify(asAlice.data)).toBe(200);
    const ac = asAlice.data.thread.post.cards;
    expect(ac.map((c: any) => [c.resolved, c.title ?? null])).toEqual([
      [true, "Side Roadmap"],
      [true, "Secret Plan"],
    ]);

    // Dave is on Team but not on Side: the Side link stays unresolved.
    const asDave = await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops?thread=${t.id}`, undefined, dave.apiKey);
    expect(asDave.data.thread.post.cards[0]).toEqual({ link, resolved: false });
    expect(JSON.stringify(asDave.data)).not.toContain("Side Roadmap");

    // The timeline (not just the thread) carries them too.
    const timeline = await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops`, undefined, alice.apiKey);
    const post = timeline.data.posts.find((p: any) => p.id === t.id);
    expect(post.cards).toHaveLength(2);

    // MCP context_channel_read returns the same object, cards and all.
    const mcp = await callTool(alice.apiKey, "context_channel_read", { channel: "ops", thread: t.id });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.thread.post.cards).toEqual(ac);
    expect(mcp.text).toContain("Side Roadmap");
  });
});

// ─── AC-ST-02 ───────────────────────────────────────────────────────────

describe("AC-ST-02: an @mention of an agent with a webhook sends exactly one signed POST", () => {
  let secret: string;

  beforeAll(async () => {
    const r = await setWebhook(owner, "grok", RUNNER);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.webhook.handle).toBe("grok");
    expect(r.data.secret).toMatch(/^whsec_/);
    secret = r.data.secret;
  });

  it("posts {nest, channel, thread, message, mentioned} once, signed with the target's secret", async () => {
    captureWakes();
    const t = await open(alice, OPS, "@grok can you draft the release notes?");
    await waitForSent(1);
    await settle();
    expect(sent).toHaveLength(1);
    const [s] = sent;
    expect(s.url).toBe(RUNNER);
    const payload = JSON.parse(s.body);
    expect(payload).toMatchObject({
      event: "agent.mention",
      nest: { id: nestId, name: "Team" },
      channel: "ops",
      node_id: OPS,
      thread_id: t.id,
      message_id: t.comments[0].id,
      mentioned: "grok",
    });
    // The message text is NOT sent: the agent reads it with its own key.
    expect(s.body).not.toContain("release notes");
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(s.headers["x-contextnest-signature"]);
    expect(m, s.headers["x-contextnest-signature"]).not.toBeNull();
    expect(m![2]).toBe(sign(secret, m![1], s.body));
    expect(s.headers["idempotency-key"]).toMatch(/^[0-9a-f]{32,}$/);
    expect(s.headers["x-contextnest-delivery"]).toBeTruthy();
    expect(wake.verifyAgentWakeSignature(secret, s.headers["x-contextnest-signature"], s.body)).toBe(true);
  });

  it("a retry of the same message never sends twice (idempotency key)", async () => {
    captureWakes();
    const t = await open(alice, OPS, "@grok one more");
    await waitForSent(1);
    const key = sent[0].headers["idempotency-key"];
    // Re-running the dispatch for the same message (a retry) is a no-op.
    await wake.wakeMentionedAgents({ nestId, nodeId: OPS, threadId: t.id, commentId: t.comments[0].id });
    await wake.wakeMentionedAgents({ nestId, nodeId: OPS, threadId: t.id, commentId: t.comments[0].id });
    await settle();
    expect(sent).toHaveLength(1);
    // A new message in the thread is a new delivery with its own key.
    await reply(alice, OPS, t.id, "@grok and this");
    await waitForSent(2);
    expect(sent[1].headers["idempotency-key"]).not.toBe(key);
    expect(JSON.parse(sent[1].body).thread_id).toBe(t.id);
  });

  it("mentions on a document thread wake too (channel is null)", async () => {
    captureWakes();
    const t = await open(alice, secretId, "@grok please review");
    await waitForSent(1);
    expect(JSON.parse(sent[0].body)).toMatchObject({ channel: null, node_id: secretId, thread_id: t.id });
  });

  it("MCP context_comment wakes like the REST route", async () => {
    captureWakes();
    const r = await callTool(alice.apiKey, "context_comment", { id: OPS, body: "@grok via MCP" });
    expect(r.isError, r.text).toBe(false);
    await waitForSent(1);
    expect(JSON.parse(sent[0].body).mentioned).toBe("grok");
  });
});

// ─── AC-ST-03 ───────────────────────────────────────────────────────────

describe("AC-ST-03: an agent with no webhook is not dispatched, and the mention still lands in My Work", () => {
  it("no POST for @muse, and the owner of muse sees the thread in My Work", async () => {
    captureWakes();
    mentions.setAgentMentionResolver(async (c) => (c.userId === owner.userId ? ["muse"] : []));
    const t = await open(alice, OPS, "@muse what do you think?");
    await settle();
    await settle();
    expect(sent).toHaveLength(0);
    const w = await jsonRequest(app, "GET", "/me/work", undefined, owner.apiKey);
    expect(w.status).toBe(200);
    const item = (w.data.mentions ?? []).find((m: any) => m.thread_id === t.id);
    expect(item, JSON.stringify(w.data.mentions)).toBeTruthy();
    expect(item.for_agent).toBe("muse");
  });
});

// ─── AC-ST-04 ───────────────────────────────────────────────────────────

describe("AC-ST-04: a writer promotes a thread to a decision", () => {
  it("creates a node quoting the thread with source_thread set, and replies in the thread with a link", async () => {
    const t = await open(alice, OPS, "Should we ship on Friday?");
    await reply(carol, OPS, t.id, "Yes, ship Friday — QA signed off.");
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision", title: "Ship on Friday" }, carol.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    const nodeId: string = r.data.node.id;
    expect(nodeId).toMatch(/^nodes\/decisions\//);
    expect(r.data.source_thread).toEqual({ node_id: OPS, thread_id: t.id });

    const got = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${nodeId}`, undefined, carol.apiKey);
    expect(got.status, JSON.stringify(got.data)).toBe(200);
    const node = got.data.node ?? got.data;
    expect(node.source_thread).toEqual({ node_id: OPS, thread_id: t.id });
    const body: string = node.content ?? node.body;
    expect(body).toContain("> Should we ship on Friday?");
    expect(body).toContain("> Yes, ship Friday — QA signed off.");
    expect((node.tags ?? []).map((x: string) => x.replace(/^#/, ""))).toContain("decision");

    const th = await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops?thread=${t.id}`, undefined, carol.apiKey);
    const last = th.data.thread.replies[th.data.thread.replies.length - 1];
    expect(last.body).toContain(`[[${nodeId}]]`);
    expect(last.author).toBe(carol.email);
  });

  it("kind task creates a task node", async () => {
    const t = await open(alice, OPS, "Someone needs to rotate the keys");
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "task" }, carol.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.node.type).toBe("task");
    expect(r.data.node.id).toMatch(/^nodes\/tasks\//);
  });

  it("a read collaborator cannot promote; an outsider and another nest's thread are not found", async () => {
    const t = await open(alice, OPS, "Promote me?");
    const ro = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision" }, reader.apiKey);
    expect(ro.status).toBe(403);
    const out = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision" }, outsider.apiKey);
    expect([403, 404]).toContain(out.status);
    const other = await jsonRequest(app, "POST", `/nests/${sideNestId}/threads/${t.id}/promote`, { kind: "decision" }, owner.apiKey);
    expect(other.status).toBe(404);
    const bad = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "essay" }, carol.apiKey);
    expect(bad.status).toBe(400);
  });
});

// ─── AC-ST-05 ───────────────────────────────────────────────────────────

describe("AC-ST-05: a webhook target on a private or link-local address is refused", () => {
  for (const url of [
    "https://127.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/hook",
    "https://192.168.1.10/hook",
    "https://[fe80::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://runner.internal/hook",
    "https://localhost/hook",
    "http://runner.example.com/hook",
    "not a url",
  ]) {
    it(`refuses ${url}`, async () => {
      const r = await setWebhook(owner, "grok-ssrf", url);
      expect(r.status, JSON.stringify(r.data)).toBe(400);
    });
  }

  it("a private target that reaches dispatch anyway (identity resolver) is not called", async () => {
    captureWakes();
    wake.setAgentWebhookResolver(async () => ({ url: "https://169.254.169.254/latest", secret: "whsec_x" }));
    await open(alice, OPS, "@sneaky hello");
    await settle();
    await settle();
    expect(sent).toHaveLength(0);
  });
});

// ─── AC-ST-06 ───────────────────────────────────────────────────────────

describe("AC-ST-06: MCP context_promote_thread matches REST", () => {
  it("is listed, write-tier, and returns the REST object", async () => {
    expect(await listToolNames(carol.apiKey)).toContain("context_promote_thread");
    const t1 = await open(alice, OPS, "Parity one");
    const t2 = await open(alice, OPS, "Parity two");
    const rest = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t1.id}/promote`, { kind: "decision", title: "Parity REST" }, carol.apiKey);
    expect(rest.status, JSON.stringify(rest.data)).toBe(201);
    const mcp = await callTool(carol.apiKey, "context_promote_thread", { thread: t2.id, kind: "decision", title: "Parity MCP" });
    expect(mcp.isError, mcp.text).toBe(false);
    const shape = (o: any): any =>
      o && typeof o === "object" && !Array.isArray(o)
        ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape(o[k])]))
        : typeof o;
    expect(shape(mcp.data)).toEqual(shape(rest.data));
    expect(mcp.data.source_thread).toEqual({ node_id: OPS, thread_id: t2.id });
    expect(mcp.data.node.type).toBe(rest.data.node.type);
    expect(mcp.text).toContain(mcp.data.node.id);
  });

  it("refuses a read collaborator the same way REST does", async () => {
    const t = await open(alice, OPS, "Parity refusal");
    const mcp = await callTool(reader.apiKey, "context_promote_thread", { thread: t.id, kind: "decision" });
    expect(mcp.isError).toBe(true);
  });
});

// ─── Security review (SEC-*) ────────────────────────────────────────────

describe("SEC: card title leakage", () => {
  it("SEC-1 a nest-scoped key gets no cross-nest card, even for a node its person can read", async () => {
    const link = `https://nest.example.com/nest/${sideNestId}?doc=${encodeURIComponent(sideDocId)}`;
    const minted = await jsonRequest(app, "POST", "/auth/keys", { label: "scoped-cards", nest_id: nestId }, alice.apiKey);
    expect(minted.status, JSON.stringify(minted.data)).toBeLessThan(300);
    const scoped = minted.data.api_key as string;
    const r = await cards({ apiKey: scoped }, { links: [link, `[[${secretId}]]`] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.cards[0]).toEqual({ link, resolved: false });
    expect(r.data.cards[1].resolved).toBe(true);
    const t = await open(alice, OPS, `scoped look: ${link}`);
    const mcp = await callTool(scoped, "context_channel_read", { channel: "ops", thread: t.id });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.thread.post.cards).toEqual([{ link, resolved: false }]);
    expect(mcp.text).not.toContain("Side Roadmap");
    // The same person's unscoped key resolves it.
    const unscoped = await cards(alice, { links: [link] });
    expect(unscoped.data.cards[0].title).toBe("Side Roadmap");
  });

  it("SEC-2 a public reader never sees a draft's title, nor the unreviewed title of an approved node", async () => {
    const pub = (await jsonRequest(app, "POST", "/nests", { name: "Pub" }, owner.apiKey)).data.nest.id as string;
    await jsonRequest(app, "PATCH", `/nests/${pub}/settings`, { stewardship_enabled: true, allow_self_approve: true }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${pub}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    const approved = await jsonRequest(app, "POST", `/nests/${pub}/nodes`, { title: "Public Page", content: "v1" }, owner.apiKey);
    expect(approved.status, JSON.stringify(approved.data)).toBe(201);
    const stable = await jsonRequest(app, "POST", `/nests/${pub}/nodes`, { title: "Stable Page", content: "v1" }, owner.apiKey);
    expect(stable.status).toBe(201);
    await jsonRequest(app, "PATCH", `/nests/${pub}/settings`, { allow_self_approve: false }, owner.apiKey);
    const edited = await jsonRequest(app, "PATCH", `/nests/${pub}/nodes/nodes/public-page`, { title: "Renamed In Review" }, owner.apiKey);
    expect(edited.status, JSON.stringify(edited.data)).toBe(200);
    const draft = await jsonRequest(app, "POST", `/nests/${pub}/nodes`, { title: "Draft Secret", content: "x" }, owner.apiKey);
    expect(draft.status).toBe(201);

    const r = await cards(outsider, { links: ["[[nodes/draft-secret]]", "[[nodes/public-page]]", "[[nodes/stable-page]]"] }, pub);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.cards[0]).toEqual({ link: "[[nodes/draft-secret]]", resolved: false });
    expect(r.data.cards[1]).toEqual({ link: "[[nodes/public-page]]", resolved: false });
    expect(r.data.cards[2]).toMatchObject({ resolved: true, title: "Stable Page" });
    expect(JSON.stringify(r.data)).not.toMatch(/Draft Secret|Renamed In Review/);
    // A title wikilink can't find the draft either.
    const byTitle = await cards(outsider, { links: ["[[Draft Secret]]"] }, pub);
    expect(byTitle.data.cards[0]).toEqual({ link: "[[Draft Secret]]", resolved: false });
  });

  it("SEC-3 a title wikilink picks only among nodes the viewer can read", async () => {
    // Bob (channel grantee) asks for a title that exists but he can't read.
    const r = await cards(bob, { links: ["[[Secret Plan]]", "[[secret-plan]]"] });
    expect(r.data.cards.every((c: any) => c.resolved === false)).toBe(true);
    expect(JSON.stringify(r.data)).not.toContain(secretId);
  });

  it("SEC-4 oversized batches are refused", async () => {
    const links = Array.from({ length: 101 }, (_, i) => `[[nodes/x${i}]]`);
    expect((await cards(alice, { links })).status).toBe(400);
    expect((await cards(alice, { texts: Array.from({ length: 201 }, () => "x") })).status).toBe(400);
    expect((await cards(alice, { links: "nope" })).status).toBe(400);
  });
});

describe("SEC: webhook targets, SSRF and signatures", () => {
  for (const url of [
    "https://2130706433/hook", // 127.0.0.1 as one number
    "https://0x7f.1/hook",
    "https://[::1]/hook",
    "https://100.64.0.1/hook", // carrier-grade NAT
    "https://[64:ff9b::a9fe:a9fe]/hook", // NAT64-wrapped metadata address
  ]) {
    it(`SEC-5 refuses ${url}`, async () => {
      const r = await setWebhook(owner, "grok-ssrf2", url);
      expect(r.status, JSON.stringify(r.data)).toBe(400);
    });
  }

  it("SEC-6 only the nest owner/admin can list or set targets; the list never shows the URL or secret", async () => {
    expect((await setWebhook(alice, "grok", RUNNER)).status).toBe(403);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, alice.apiKey)).status).toBe(403);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, reader.apiKey)).status).toBe(403);
    expect([403, 404]).toContain((await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, outsider.apiKey)).status);
    expect([403, 404]).toContain((await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, bob.apiKey)).status);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    expect(list.status).toBe(200);
    const grok = list.data.webhooks.find((w: any) => w.handle === "grok");
    expect(grok.target).toMatch(/^runner\.example\.com#[0-9a-f]{12}$/);
    expect(JSON.stringify(list.data)).not.toMatch(/\/wake|whsec_/);
  });

  it("SEC-7 the URL and secret are encrypted at rest; re-saving keeps the secret unless rotated", async () => {
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get("SELECT url_enc, secret_enc FROM agent_webhooks WHERE nest_id = ? AND handle = 'grok'", [nestId])) as any;
    expect(row.url_enc.startsWith("enc.v1.")).toBe(true);
    expect(row.secret_enc.startsWith("enc.v1.")).toBe(true);
    const again = await setWebhook(owner, "grok", RUNNER);
    expect(again.status).toBe(200);
    expect(again.data.secret).toBeUndefined();
  });

  it("SEC-8 a signature with a stale timestamp, a tampered body or the wrong secret fails verification", () => {
    const body = JSON.stringify({ event: "agent.mention" });
    const now = Date.now();
    const header = wake.signAgentWake("whsec_k", body, now);
    expect(wake.verifyAgentWakeSignature("whsec_k", header, body, { nowMs: now })).toBe(true);
    expect(wake.verifyAgentWakeSignature("whsec_k", header, body, { nowMs: now + 301_000 })).toBe(false);
    expect(wake.verifyAgentWakeSignature("whsec_k", header, body + " ", { nowMs: now })).toBe(false);
    expect(wake.verifyAgentWakeSignature("whsec_other", header, body, { nowMs: now })).toBe(false);
    expect(wake.verifyAgentWakeSignature("whsec_k", "v1=abc", body, { nowMs: now })).toBe(false);
  });
});

describe("SEC: dispatch loops and amplification", () => {
  it("SEC-9 an agent's own message mentioning itself doesn't wake it; another agent's does", async () => {
    captureWakes();
    await open(alice, OPS, "@grok note to self", { client: { agent: "grok" } });
    await settle();
    await settle();
    expect(sent).toHaveLength(0);
    await open(alice, OPS, "@grok over to you", { client: { agent: "muse" } });
    await waitForSent(1);
  });

  it("SEC-10 one thread wakes a handle at most WAKE_PER_THREAD_LIMIT times per window", async () => {
    captureWakes();
    const t = await open(alice, OPS, "@grok ping 0");
    for (let i = 1; i <= wake.WAKE_PER_THREAD_LIMIT + 2; i++) await reply(alice, OPS, t.id, `@grok ping ${i}`);
    await settle();
    await settle();
    await vi.waitFor(() => expect(sent.length).toBe(wake.WAKE_PER_THREAD_LIMIT), { timeout: 2000 });
    await settle();
    expect(sent).toHaveLength(wake.WAKE_PER_THREAD_LIMIT);
  });

  it("SEC-11 promoting a thread that tags an agent wakes nobody again", async () => {
    captureWakes();
    const t = await open(alice, OPS, "@grok decide this");
    await waitForSent(1);
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision", title: "Decided With Grok" }, carol.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    await settle();
    await settle();
    expect(sent).toHaveLength(1);
  });
});

describe("SEC: promote write-authz", () => {
  it("SEC-12 a channel grantee, a read-only key and a stranger cannot promote", async () => {
    const t = await open(alice, OPS, "authz check");
    const asBob = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision" }, bob.apiKey);
    expect([403, 404]).toContain(asBob.status);
    const ro = await jsonRequest(app, "POST", "/auth/keys", { label: "ro-promote", nest_id: nestId, capability: "read" }, carol.apiKey);
    expect(ro.status, JSON.stringify(ro.data)).toBeLessThan(300);
    const viaRest = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision" }, ro.data.api_key);
    expect(viaRest.status).toBe(403);
    const viaMcp = await callTool(ro.data.api_key, "context_promote_thread", { thread: t.id });
    expect(viaMcp.isError || !!viaMcp.rpcError).toBe(true);
    const stranger = await callTool(outsider.apiKey, "context_promote_thread", { thread: t.id });
    expect(stranger.isError || !!stranger.rpcError || stranger.status >= 400).toBe(true);
  });

  it("SEC-13 a folder can't climb out of nodes/", async () => {
    const t = await open(alice, OPS, "folder check");
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision", title: "Folder Check", folder: "../../etc" }, carol.apiKey);
    if (r.status === 201) {
      expect(r.data.node.id.startsWith("nodes/")).toBe(true);
      expect(r.data.node.id).not.toContain("..");
    } else {
      expect(r.status).toBe(400);
    }
  });

  it("SEC-14 promoting a resolved thread leaves it resolved", async () => {
    const t = await open(alice, OPS, "settled already");
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${OPS}/annotations/${t.id}/resolve`, {}, alice.apiKey);
    expect(res.status).toBeLessThan(300);
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "task", title: "Settled Task" }, carol.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    const th = await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops?thread=${t.id}`, undefined, carol.apiKey);
    expect(th.data.thread.post.status).toBe("resolved");
  });
});

// ─── MCP parity for agent webhooks (follow-up, PO-1181) ─────────────────

describe("AC-ST-07: MCP context_agent_webhooks matches REST /agent-webhooks", () => {
  it("set returns the secret once, list matches REST and never shows URL or secret, delete removes it", async () => {
    expect(await listToolNames(owner.apiKey)).toContain("context_agent_webhooks");
    const set = await callTool(owner.apiKey, "context_agent_webhooks", { action: "set", handle: "duet", url: "https://duet.example.com/hook" });
    expect(set.isError, set.text).toBe(false);
    expect(set.data.webhook).toMatchObject({ handle: "duet", target: expect.stringMatching(/^duet\.example\.com#[0-9a-f]{12}$/) });
    expect(set.data.secret).toMatch(/^whsec_/);
    // Same shape as the REST PUT.
    const restSet = await setWebhook(owner, "duet-rest", "https://duet.example.com/hook2");
    const keys = (o: any) => Object.keys(o).sort();
    expect(keys(set.data)).toEqual(keys(restSet.data));
    expect(keys(set.data.webhook)).toEqual(keys(restSet.data.webhook));

    // Re-set without rotate keeps the secret (not returned again); rotate mints one.
    const again = await callTool(owner.apiKey, "context_agent_webhooks", { action: "set", handle: "duet", url: "https://duet.example.com/hook" });
    expect(again.data.secret).toBeUndefined();
    const rotated = await callTool(owner.apiKey, "context_agent_webhooks", { action: "set", handle: "duet", url: "https://duet.example.com/hook", rotate: true });
    expect(rotated.data.secret).toMatch(/^whsec_/);
    expect(rotated.data.secret).not.toBe(set.data.secret);

    const list = await callTool(owner.apiKey, "context_agent_webhooks", { action: "list" });
    expect(list.isError, list.text).toBe(false);
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    expect(list.data).toEqual(rest.data);
    expect(JSON.stringify(list.data) + list.text).not.toMatch(/whsec_|\/hook/);

    const del = await callTool(owner.apiKey, "context_agent_webhooks", { action: "delete", handle: "duet" });
    expect(del.isError, del.text).toBe(false);
    expect(del.data).toEqual({ deleted: true });
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    expect(after.data.webhooks.map((w: any) => w.handle)).not.toContain("duet");
    const missing = await callTool(owner.apiKey, "context_agent_webhooks", { action: "delete", handle: "duet" });
    expect(missing.isError).toBe(true);
  });

  it("refuses private targets with the same SSRF fence as REST", async () => {
    for (const url of ["https://127.0.0.1/x", "https://169.254.169.254/latest", "https://100.64.0.1/x", "http://duet.example.com/x"]) {
      const r = await callTool(owner.apiKey, "context_agent_webhooks", { action: "set", handle: "duet-ssrf", url });
      expect(r.isError, `${url}: ${r.text}`).toBe(true);
    }
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    expect(rest.data.webhooks.map((w: any) => w.handle)).not.toContain("duet-ssrf");
  });

  it("is owner/admin only on every action, and a read-only key can't call it", async () => {
    for (const u of [alice, reader]) {
      for (const args of [{ action: "list" }, { action: "set", handle: "x1", url: "https://x.example.com/h" }, { action: "delete", handle: "grok" }]) {
        const r = await callTool(u.apiKey, "context_agent_webhooks", args);
        expect(r.isError || !!r.rpcError, `${u.email} ${args.action}`).toBe(true);
        expect(r.text).not.toMatch(/whsec_|runner\.example\.com/);
      }
    }
    const ro = await jsonRequest(app, "POST", "/auth/keys", { label: "ro-hooks", nest_id: nestId, capability: "read" }, owner.apiKey);
    const r = await callTool(ro.data.api_key, "context_agent_webhooks", { action: "list" });
    expect(r.isError || !!r.rpcError).toBe(true);
    // grok's target survives all of the above.
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    expect(rest.data.webhooks.map((w: any) => w.handle)).toContain("grok");
  });
});
