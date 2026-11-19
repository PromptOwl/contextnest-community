/**
 * DM an agent (epic recipes-and-the-central-harness): a person's message in a
 * 1:1 conversation with an agent wakes that agent without an @mention.
 *
 *   - AC-DM-1 a person's message in a dm with @builder → ONE signed POST
 *     `agent.dm`, an Idempotency-Key, `conversation`, and the
 *     context_conversation_read call.
 *   - AC-DM-2 the same message dispatched again (or edited) sends nothing more;
 *     a failed POST is retried under the same key.
 *   - AC-DM-3 a group keeps the explicit-@mention rule: no wake and no mention
 *     row without "@builder"; with it, `agent.mention`.
 *   - AC-DM-4 an agent-authored message in the dm wakes nobody (loop guard).
 *   - AC-DM-5 the existing fences hold for `agent.dm` (sealed nest, rate fence).
 *   - AC-DM-6 an agent woken in a dm files its approve card in the dm; the
 *     decision wake reads the conversation back. A non-member can't.
 *
 * The agent here runs on a key its person hired (C10: a key agent is owned by
 * whoever hired it), so the person behind that key is the dm's person member.
 */
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type WakeModule = typeof import("../src/stream/agent-wake.js");
let wake: WakeModule;

const OWNER_EMAIL = "owner@dm.test";
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const RUNNER = "https://runner.example.com/wake";

type User = { apiKey: string; userId: string; email: string; cookie: string };
let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User; // owns the nest
let alice: User; // writer; DMs her agent @builder, whose key she hired
let sam: User; // writer; in the group
let carol: User; // writer; in no conversation here
let nestId: string;
let secret: string;
let builderKey: string; // alice's key labelled "builder" (the hired agent's key)

type Sent = { url: string; headers: Record<string, string>; body: string };
let sent: Sent[] = [];

const enc = (id: string) => encodeURIComponent(id);

async function callTool(apiKey: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const line = (await res.text()).split("\n").find((l: string) => l.startsWith("data: "));
    body = line ? JSON.parse(line.slice(6)) : {};
  }
  return {
    text: String(body?.result?.content?.[0]?.text ?? ""),
    data: body?.result?.structuredContent,
    isError: body?.result?.isError === true,
  };
}

async function startConversation(u: User, members: string[]): Promise<string> {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/conversations`, { members }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r.data.conversation.id as string;
}

async function say(apiKey: string, conversation: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${enc(conversation)}/annotations`, { body, ...extra }, apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.thread as { id: string; comments: Array<{ id: string; body: string }> };
}

function captureWakes(status = 200) {
  wake.setAgentWakeFetch(async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(url), headers, body: String(init?.body ?? "") });
    return new Response("ok", { status });
  });
}
const waitForSent = (n: number) => vi.waitFor(() => expect(sent.length).toBe(n), { timeout: 2000, interval: 10 });
const settle = () => new Promise((r) => setTimeout(r, 80));
const events = () => sent.map((s) => JSON.parse(s.body).event as string);

async function mentionRows(threadId: string, handle: string): Promise<number> {
  const { getDb } = await import("../src/db/client.js");
  const row = (await getDb().get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM comment_mentions WHERE thread_id = ? AND handle = ?", [threadId, handle])) as {
    n: number | string;
  };
  return Number(row.n);
}

beforeAll(async () => {
  env = setupTestEnv();
  process.env.TEAM_CHAT_ENABLED = "true";
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  wake = await import("../src/stream/agent-wake.js");
  wake.setAgentWakeBackoff([]);
  owner = await registerUser(app, OWNER_EMAIL, "Owner");
  alice = await registerUser(app, "alice@dm.test", "Alice");
  sam = await registerUser(app, "sam@dm.test", "Sam");
  await resetAuthRateLimit();
  carol = await registerUser(app, "carol@dm.test", "Carol");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  for (const u of [alice, sam, carol]) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission: "write" }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  // The owner reviews: the person at the gate (alice files under her own login).
  const nestPath = join(env.dataDir, "nests", nestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(join(nestPath, "stewards.yaml"), `nest:\n  - email: ${OWNER_EMAIL}, role: reviewer, can_approve: true\n`);
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);
  const wh = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/builder`, { url: RUNNER }, owner.apiKey);
  expect(wh.status, JSON.stringify(wh.data)).toBeLessThan(300);
  secret = wh.data.secret;
  const k = await jsonRequest(app, "POST", "/auth/keys", { label: "builder" }, alice.apiKey);
  expect(k.status, JSON.stringify(k.data)).toBeLessThan(300);
  builderKey = k.data.key ?? k.data.apiKey ?? k.data.api_key;
  expect(builderKey).toBeTruthy();
});

afterEach(() => {
  wake.setAgentWakeFetch(null);
  sent = [];
});

afterAll(async () => {
  delete process.env.TEAM_CHAT_ENABLED;
  await env.cleanup();
});

describe("AC-DM-1: a person's message in a dm with an agent wakes it without an @mention", () => {
  it("sends ONE signed agent.dm with the conversation read call", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    captureWakes();
    const t = await say(alice.apiKey, dm, "FYI, pricing moved to $49");
    await waitForSent(1);
    await settle();
    expect(sent).toHaveLength(1);
    const s = sent[0];
    expect(s.url).toBe(RUNNER);
    expect(s.headers["x-contextnest-event"]).toBe("agent.dm");
    expect(s.headers["idempotency-key"]).toMatch(/^[0-9a-f]{40}$/);
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(s.headers["x-contextnest-signature"]);
    expect(m).toBeTruthy();
    expect(createHmac("sha256", secret).update(`${m![1]}.${s.body}`).digest("hex")).toBe(m![2]);
    expect(wake.verifyAgentWakeSignature(secret, s.headers["x-contextnest-signature"], s.body)).toBe(true);
    const p = JSON.parse(s.body);
    expect(p).toMatchObject({
      event: "agent.dm",
      nest: { id: nestId },
      channel: null,
      conversation: dm,
      node_id: dm,
      thread_id: t.id,
      message_id: t.comments[0].id,
      mentioned: "builder",
      read: { tool: "context_conversation_read", arguments: { conversation: dm, thread: t.id } },
    });
    // This nest's own target: the text rides along, as for a mention.
    expect(p.excerpt).toBe("FYI, pricing moved to $49");
    expect(p.author_email).toBe(alice.email);
  });

  it("a reply in the dm thread wakes it too, and an explicit @builder in a dm stays a mention", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    captureWakes();
    const t = await say(alice.apiKey, dm, "first");
    await waitForSent(1);
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${enc(dm)}/annotations/${t.id}/comments`, { body: "and another thing" }, alice.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    await waitForSent(2);
    expect(events()).toEqual(["agent.dm", "agent.dm"]);
    await say(alice.apiKey, dm, "@builder please look");
    await waitForSent(3);
    expect(events()[2]).toBe("agent.mention");
  });
});

describe("AC-DM-2: idempotent, retried under one key", () => {
  it("dispatching the same message again sends nothing more", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    captureWakes();
    const t = await say(alice.apiKey, dm, "remember the launch is Friday");
    await waitForSent(1);
    const again = await wake.wakeMentionedAgents({ nestId, nodeId: dm, threadId: t.id, commentId: t.comments[0].id });
    await settle();
    expect(again.get("builder")).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  it("a failed POST is retried with the same body and Idempotency-Key", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    wake.setAgentWakeBackoff([1, 1]);
    try {
      captureWakes(503);
      await say(alice.apiKey, dm, "ping");
      await waitForSent(3);
      expect(new Set(sent.map((s) => s.headers["idempotency-key"])).size).toBe(1);
      expect(new Set(sent.map((s) => s.body)).size).toBe(1);
      expect(events()).toEqual(["agent.dm", "agent.dm", "agent.dm"]);
    } finally {
      wake.setAgentWakeBackoff([]);
    }
  });
});

describe("AC-DM-3: a group keeps the explicit-@mention rule", () => {
  it("no wake and no mention row without @builder; agent.mention with it", async () => {
    const group = await startConversation(alice, [sam.email, "@builder"]);
    captureWakes();
    const t = await say(alice.apiKey, group, "morning all, pricing moved to $49");
    await settle();
    expect(sent).toHaveLength(0);
    expect(await mentionRows(t.id, "builder")).toBe(0);
    await say(sam.apiKey, group, "@builder can you take the healthz work?");
    await waitForSent(1);
    expect(events()).toEqual(["agent.mention"]);
  });
});

describe("AC-DM-4: agent-authored messages never wake agents", () => {
  it("a message the agent declares (client.agent) wakes nobody", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    captureWakes();
    const r = await callTool(builderKey, "context_comment", { id: dm, body: "Got it.", client: { agent: "builder" } });
    expect(r.isError, r.text).toBe(false);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("another agent's declared message in the dm wakes nobody either", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    captureWakes();
    const r = await callTool(alice.apiKey, "context_comment", { id: dm, body: "Summary from the scout agent", client: { agent: "scout" } });
    expect(r.isError, r.text).toBe(false);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("the agent's key without a declaration (label = its handle) wakes nobody", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    captureWakes();
    await say(builderKey, dm, "Done.");
    await settle();
    expect(sent).toHaveLength(0);
  });
});

describe("AC-DM-5: the existing fences hold for agent.dm", () => {
  it("the per-thread rate fence counts dm wakes", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    captureWakes();
    const t = await say(alice.apiKey, dm, "one");
    for (let i = 0; i < wake.WAKE_PER_THREAD_LIMIT + 2; i++) {
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${enc(dm)}/annotations/${t.id}/comments`, { body: `more ${i}` }, alice.apiKey);
      expect(r.status).toBeLessThan(300);
    }
    await settle();
    expect(sent.length).toBe(wake.WAKE_PER_THREAD_LIMIT);
  });
});

describe("AC-DM-6: an approve card in a dm, and its decision wake", () => {
  it("the agent files its card in the dm; approving it wakes the agent with the conversation read", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    captureWakes();
    const t = await say(alice.apiKey, dm, "add a /healthz endpoint");
    await waitForSent(1);
    const card = await callTool(builderKey, "context_propose", {
      thread: t.id,
      title: "Plan: add /healthz",
      content: "1. Add GET /healthz\n2. Test it",
      client: { agent: "builder" },
    });
    expect(card.isError, card.text).toBe(false);
    const p = card.data.proposal;
    expect(p).toMatchObject({ status: "pending", proposed_by: "builder", channel: null, conversation: dm, thread_id: t.id });
    expect(card.text).not.toContain("#null");

    const read = await callTool(alice.apiKey, "context_conversation_read", { conversation: dm, thread: t.id });
    expect(read.isError, read.text).toBe(false);
    expect(JSON.stringify(read.data)).toContain(p.review_id);

    const ap = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${p.node_id}/approve`, { note: "go" }, owner.apiKey);
    expect(ap.status, JSON.stringify(ap.data)).toBeLessThan(300);
    await waitForSent(2);
    const d = JSON.parse(sent[1].body);
    expect(d).toMatchObject({
      event: "agent.proposal.decided",
      mentioned: "builder",
      channel: null,
      conversation: dm,
      node_id: dm,
      thread_id: t.id,
      proposal: { review_id: p.review_id, status: "approved", decided_by: OWNER_EMAIL },
      read: { tool: "context_conversation_read", arguments: { conversation: dm, thread: t.id } },
    });
  });

  it("a nest member outside the dm can't file a card on its thread", async () => {
    const dm = await startConversation(alice, ["@builder"]);
    const t = await say(alice.apiKey, dm, "secret plan");
    const r = await callTool(carol.apiKey, "context_propose", { thread: t.id, title: "Nope", content: "x", client: { agent: "builder" } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/i);
  });
});
