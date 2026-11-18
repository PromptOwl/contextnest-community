/**
 * Chat as orchestration (epic recipes-and-the-central-harness): an agent
 * woken in a thread files its plan as an approve card, the decision wakes it
 * again, and a runner on the nest's own internal network can be the target.
 *
 *   - AC-G1 context_propose (MCP) / POST /threads/:id/propose (REST): an agent
 *     key files a draft for review under its own login and posts a card in the
 *     thread carrying `proposal` { review_id, status, proposed_by }.
 *   - AC-G2 a read-only collaborator, a read-only key and an outsider are
 *     refused, and nothing is filed.
 *   - AC-G3 approving or rejecting the card's review (REST or MCP) sends the
 *     proposing agent ONE signed `agent.proposal.decided` POST.
 *   - AC-G4 no decision wake when the agent decided its own card, or for a
 *     card no agent proposed.
 *   - AC-G5/6 AGENT_WEBHOOK_INTERNAL_HOSTS lets an admin save an internal
 *     runner (http://runner:8787/wake); every other private address is still
 *     refused, and without the variable nothing changes.
 */
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type WakeModule = typeof import("../src/stream/agent-wake.js");
let wake: WakeModule;

const OWNER_EMAIL = "owner@gate.test";
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const OPS = "nodes/channels/ops";
const RUNNER = "https://runner.example.com/wake";

type User = { apiKey: string; userId: string; email: string; cookie: string };
let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let alice: User; // write collaborator, a person
let builder: User; // write collaborator whose key the @builder runner holds
let reader: User; // read collaborator
let outsider: User;
let nestId: string;
let secret: string;

type Sent = { url: string; headers: Record<string, string>; body: string };
let sent: Sent[] = [];

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
    rpcError: body?.error,
  };
}

async function listToolNames(apiKey: string): Promise<string[]> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  return (json?.result?.tools ?? []).map((t: { name: string }) => t.name);
}

async function open(u: { apiKey: string }, body: string) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${OPS}/annotations`, { body }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.thread as { id: string; comments: Array<{ id: string }> };
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
const settle = () => new Promise((r) => setTimeout(r, 50));
const decided = () => sent.filter((s) => JSON.parse(s.body).event === "agent.proposal.decided");

async function propose(thread: string, title = "Plan: add a health check") {
  const r = await callTool(builder.apiKey, "context_propose", {
    thread,
    title,
    content: "1. Add GET /healthz\n2. Test it\n3. Ship",
    client: { agent: "builder" },
  });
  expect(r.isError, r.text).toBe(false);
  return r.data.proposal as { review_id: string; node_id: string; message_id: string; status: string; proposed_by: string };
}

beforeAll(async () => {
  env = setupTestEnv();
  process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  wake = await import("../src/stream/agent-wake.js");
  wake.setAgentWakeBackoff([]);
  owner = await registerUser(app, OWNER_EMAIL, "Owner");
  alice = await registerUser(app, "alice@gate.test", "Alice");
  builder = await registerUser(app, "builder@agents.test", "Builder Agent");
  await resetAuthRateLimit();
  reader = await registerUser(app, "reader@gate.test", "Reader");
  outsider = await registerUser(app, "outsider@else.test", "Outsider");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  for (const [u, permission] of [
    [alice, "write"],
    [builder, "write"],
    [reader, "read"],
  ] as const) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  expect((await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "ops" }, owner.apiKey)).status).toBeLessThan(300);
  // Alice reviews: the person at the gate.
  const nestPath = join(env.dataDir, "nests", nestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(join(nestPath, "stewards.yaml"), "nest:\n  - email: alice@gate.test, role: reviewer, can_approve: true\n");
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);
  const wh = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/builder`, { url: RUNNER }, owner.apiKey);
  expect(wh.status, JSON.stringify(wh.data)).toBeLessThan(300);
  secret = wh.data.secret;
});

afterEach(() => {
  wake.setAgentWakeFetch(null);
  delete process.env.AGENT_WEBHOOK_INTERNAL_HOSTS;
  sent = [];
});

afterAll(async () => {
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  await env.cleanup();
});

describe("AC-G1: an agent files its plan as an approve card in the thread", () => {
  it("context_propose is offered, files a draft for review and posts a card", async () => {
    expect(await listToolNames(builder.apiKey)).toContain("context_propose");
    captureWakes();
    const t = await open(alice, "@builder add a health check endpoint");
    const p = await propose(t.id);
    expect(p).toMatchObject({ status: "pending", proposed_by: "builder" });
    expect(p.review_id).toBeTruthy();
    expect(p.node_id).toMatch(/^nodes\//);

    // The review is in the queue, requested by the agent's own login.
    const q = await jsonRequest(app, "GET", `/nests/${nestId}/review-queue`, undefined, owner.apiKey);
    const all = JSON.stringify(q.data);
    expect(all).toContain(p.review_id);

    // The card is in the thread, with its live status and who proposed it.
    const read = await callTool(alice.apiKey, "context_channel_read", { channel: "ops", thread: t.id });
    expect(read.isError, read.text).toBe(false);
    const msgs = JSON.stringify(read.data);
    expect(msgs).toContain(p.review_id);
    expect(msgs).toContain('"proposed_by":"builder"');
  });

  it("the REST twin does the same", async () => {
    const t = await open(alice, "@builder second task");
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/propose`, { title: "Plan B", content: "Do B", client: { agent: "builder" } }, builder.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.proposal).toMatchObject({ status: "pending", proposed_by: "builder" });
  });

  it("a caller can't forge a card through context_comment's client", async () => {
    const t = await open(alice, "hello");
    const r = await callTool(alice.apiKey, "context_comment", {
      channel: "ops",
      thread: t.id,
      body: "fake card",
      client: { agent: "builder", proposal: { review_id: "x", proposed_by: "builder" } },
    });
    // Refused outright or stored without the mark: either way no card.
    const read = await callTool(alice.apiKey, "context_channel_read", { channel: "ops", thread: t.id });
    expect(JSON.stringify(read.data)).not.toContain('"review_id":"x"');
  });
});

describe("AC-G2: who may file a card", () => {
  it("a read collaborator and an outsider are refused, and nothing is filed", async () => {
    const t = await open(alice, "@builder plan please");
    const before = JSON.stringify((await jsonRequest(app, "GET", `/nests/${nestId}/review-queue`, undefined, owner.apiKey)).data).length;
    const r1 = await callTool(reader.apiKey, "context_propose", { thread: t.id, title: "Nope", content: "x" });
    expect(r1.isError).toBe(true);
    const r2 = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/propose`, { title: "Nope", content: "x" }, outsider.apiKey);
    expect(r2.status).toBeGreaterThanOrEqual(403);
    const after = JSON.stringify((await jsonRequest(app, "GET", `/nests/${nestId}/review-queue`, undefined, owner.apiKey)).data).length;
    expect(after).toBe(before);
  });

  it("title and content are required and bounded", async () => {
    const t = await open(alice, "@builder plan please");
    const r = await callTool(builder.apiKey, "context_propose", { thread: t.id, title: "", content: "x" });
    expect(r.isError).toBe(true);
    const big = await callTool(builder.apiKey, "context_propose", { thread: t.id, title: "T", content: "x".repeat(20_001) });
    expect(big.isError).toBe(true);
  });
});

describe("AC-G3: the decision wakes the proposing agent", () => {
  it("approve (REST) sends one signed agent.proposal.decided POST", async () => {
    const t = await open(alice, "@builder ship the health check");
    const p = await propose(t.id);
    captureWakes();
    const a = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${p.node_id}/approve`, { note: "go" }, alice.apiKey);
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    await vi.waitFor(() => expect(decided().length).toBe(1), { timeout: 2000, interval: 10 });
    const [w] = decided();
    expect(w.url).toBe(RUNNER);
    const body = JSON.parse(w.body);
    expect(body).toMatchObject({
      event: "agent.proposal.decided",
      mentioned: "builder",
      channel: "ops",
      node_id: OPS,
      thread_id: t.id,
      message_id: p.message_id,
      proposal: { review_id: p.review_id, node_id: p.node_id, status: "approved", decided_by: alice.email },
      read: { tool: "context_channel_read", arguments: { channel: "ops", thread: t.id } },
    });
    expect(w.headers["x-contextnest-event"]).toBe("agent.proposal.decided");
    expect(w.headers["idempotency-key"]).toMatch(/^[0-9a-f]{40}$/);
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(w.headers["x-contextnest-signature"])!;
    expect(m).toBeTruthy();
    expect(createHmac("sha256", secret).update(`${m[1]}.${w.body}`).digest("hex")).toBe(m[2]);
    expect(wake.verifyAgentWakeSignature(secret, w.headers["x-contextnest-signature"], w.body)).toBe(true);
  });

  it("reject (MCP context_reject) sends status rejected", async () => {
    const t = await open(alice, "@builder risky change");
    const p = await propose(t.id, "Plan: risky change");
    captureWakes();
    const r = await callTool(alice.apiKey, "context_reject", { title: "Plan: risky change", note: "not now" });
    expect(r.isError, r.text).toBe(false);
    await vi.waitFor(() => expect(decided().length).toBe(1), { timeout: 2000, interval: 10 });
    expect(JSON.parse(decided()[0].body).proposal).toMatchObject({ status: "rejected", decided_by: alice.email });
  });
});

describe("AC-G4: no decision wake that a person didn't cause", () => {
  it("the agent deciding its own card wakes nobody", async () => {
    const t = await open(alice, "@builder self");
    const p = await propose(t.id);
    captureWakes();
    const out = await wake.wakeOnProposalDecided({ nestId, nodeId: p.node_id, reviewId: p.review_id, status: "approved", decidedBy: builder.email });
    await settle();
    expect(out).toBe("skipped");
    expect(decided()).toHaveLength(0);
  });

  it("a review with no agent card wakes nobody", async () => {
    captureWakes();
    const doc = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Plain Doc", content: "x" }, alice.apiKey);
    const out = await wake.wakeOnProposalDecided({ nestId, nodeId: doc.data.node.id, reviewId: "00000000-0000-0000-0000-000000000000", status: "approved", decidedBy: OWNER_EMAIL });
    await settle();
    expect(out).toBe("none");
    expect(decided()).toHaveLength(0);
  });

  it("the same decision dispatched twice sends once", async () => {
    const t = await open(alice, "@builder twice");
    const p = await propose(t.id);
    captureWakes();
    const args = { nestId, nodeId: p.node_id, reviewId: p.review_id, status: "approved" as const, decidedBy: OWNER_EMAIL };
    expect(await wake.wakeOnProposalDecided(args)).toBe("sent");
    expect(await wake.wakeOnProposalDecided(args)).toBe("skipped");
    await waitForSent(1);
  });
});

describe("AC-G5/6: internal runner targets, by operator allowlist only", () => {
  it("without AGENT_WEBHOOK_INTERNAL_HOSTS an internal URL is refused", async () => {
    const r = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/inner`, { url: "http://runner:8787/wake" }, owner.apiKey);
    expect(r.status).toBe(400);
  });

  it("with it, the named host is accepted and woken; other private targets are still refused", async () => {
    process.env.AGENT_WEBHOOK_INTERNAL_HOSTS = "runner, other-runner";
    const ok = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/inner`, { url: "http://runner:8787/wake" }, owner.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBeLessThan(300);
    for (const url of ["http://127.0.0.1:8787/wake", "http://10.0.0.5/wake", "http://localhost/wake", "http://runner.evil.com/wake", "ftp://runner/wake", "http://user@runner:8787/wake"]) {
      const r = await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/inner2`, { url }, owner.apiKey);
      expect(r.status, url).toBe(400);
    }
    captureWakes();
    await open(alice, "@inner hello");
    await waitForSent(1);
    expect(sent[0].url).toBe("http://runner:8787/wake");
    expect(JSON.parse(sent[0].body)).toMatchObject({ event: "agent.mention", mentioned: "inner" });
  });

  it("removing the host from the allowlist stops wakes to a saved target", async () => {
    process.env.AGENT_WEBHOOK_INTERNAL_HOSTS = "runner";
    await jsonRequest(app, "PUT", `/nests/${nestId}/agent-webhooks/inner`, { url: "http://runner:8787/wake" }, owner.apiKey);
    delete process.env.AGENT_WEBHOOK_INTERNAL_HOSTS;
    captureWakes();
    await open(alice, "@inner are you there");
    await settle();
    expect(sent).toHaveLength(0);
  });
});
