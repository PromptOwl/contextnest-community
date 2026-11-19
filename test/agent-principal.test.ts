/**
 * Agent principal (epic recipes-and-the-central-harness): a hired agent is its
 * own identity in the nest, so ANY member can DM it or @mention it and the
 * agent reads that conversation with its own key.
 *
 *   - AP-1 hiring a key agent creates an agent principal: a no-login service
 *     identity owned by the hirer, an editor on this nest only, holding the
 *     one nest-scoped key; not a seat, not a person.
 *   - AP-2 one hire is key AND wake webhook (config.url; owner/admin, the
 *     webhook's own gate); the two kinds pair on one handle.
 *   - AP-3 Bob, who holds no key of the agent, DMs it; the agent's key reads
 *     the dm and replies there; its own message wakes nobody.
 *   - AP-4 members-only is unchanged: a conversation without the agent is
 *     NotFound to its key; it lists only its own.
 *   - AP-5 fences: never admin/owner, never another nest, no sign-in, no key
 *     minting, no hiring, never added as a collaborator.
 *   - AP-6 the person who asked approves the agent's card (the filer is the
 *     principal); the principal never approves or rejects anything.
 *   - AP-7 the principal reads the full body of its own pending memory, and
 *     nothing else pending; one remember posts one message.
 *   - AP-8 legacy key agents (a person's key labelled with the handle) keep
 *     working, marked legacy.
 *   - AP-9 who am I / who owns me (MCP context_agent_identity, REST GET /hire/me).
 *   - AP-10 let go revokes the key and the access; hiring again reuses the identity.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type WakeModule = typeof import("../src/stream/agent-wake.js");
let wake: WakeModule;
let db: any;

const OWNER_EMAIL = "olivia@ap.test";
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const RUNNER = "https://runner.example.com/wake";

type User = { apiKey: string; userId: string; email: string; cookie: string };
let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User; // Olivia: owns the nest, hires @builder (key + webhook)
let alice: User; // writer
let bob: User; // writer + nest reviewer; holds NO key of the agent
let carol: User; // writer; in no conversation with the agent
let nestId: string;
let sideNestId: string;
let builderKey: string;
let builder: { id: string; email: string; name: string };

type Sent = { url: string; headers: Record<string, string>; body: string };
let sent: Sent[] = [];

const enc = (id: string) => encodeURIComponent(id);
const hire = (u: User | string, body: Record<string, unknown>, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/hire`, body, typeof u === "string" ? u : u.apiKey);
const hired = (u: User, nest = nestId) => jsonRequest(app, "GET", `/nests/${nest}/hire`, undefined, u.apiKey);
const letGo = (u: User, kind: string, handle: string, nest = nestId) => jsonRequest(app, "DELETE", `/nests/${nest}/hire/${kind}/${handle}`, undefined, u.apiKey);

async function callTool(apiKey: string, name: string, args: Record<string, unknown>, nest = nestId) {
  const res = await app.request(`/nests/${nest}/mcp`, {
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
    status: res.status,
    text: String(body?.result?.content?.[0]?.text ?? body?.error?.message ?? ""),
    data: body?.result?.structuredContent,
    isError: body?.result?.isError === true || !!body?.error,
  };
}

async function startConversation(apiKey: string, members: string[]): Promise<string> {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/conversations`, { members }, apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r.data.conversation.id as string;
}

async function say(apiKey: string, container: string, body: string) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${enc(container)}/annotations`, { body }, apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.thread as { id: string; comments: Array<{ id: string; body: string }> };
}

function captureWakes() {
  wake.setAgentWakeFetch(async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(url), headers, body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  });
}
const waitForSent = (n: number) => vi.waitFor(() => expect(sent.length).toBe(n), { timeout: 2000, interval: 10 });
const settle = () => new Promise((r) => setTimeout(r, 80));

beforeAll(async () => {
  env = setupTestEnv();
  process.env.TEAM_CHAT_ENABLED = "true";
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  db = (await import("../src/db/client.js")).getDb();
  wake = await import("../src/stream/agent-wake.js");
  wake.setAgentWakeBackoff([]);
  owner = await registerUser(app, OWNER_EMAIL, "Olivia Owner");
  alice = await registerUser(app, "alice@ap.test", "Alice");
  bob = await registerUser(app, "bob@ap.test", "Bob");
  await resetAuthRateLimit();
  carol = await registerUser(app, "carol@ap.test", "Carol");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  sideNestId = (await jsonRequest(app, "POST", "/nests", { name: "Side" }, owner.apiKey)).data.nest.id;
  for (const u of [alice, bob, carol]) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission: "write" }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  // Bob is the nest's reviewer: the person who asks the agent is the person at the gate.
  const nestPath = join(env.dataDir, "nests", nestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(join(nestPath, "stewards.yaml"), `nest:\n  - email: ${bob.email}, role: reviewer, can_approve: true\n`);
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);
});

afterEach(() => {
  wake.setAgentWakeFetch(null);
  sent = [];
});

afterAll(async () => {
  delete process.env.TEAM_CHAT_ENABLED;
  await env.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════

describe("AP-1/AP-2: hiring a key agent creates its principal; one hire is key and webhook", () => {
  it("AP-2 a writer can't attach a webhook (owner/admin gate) and nothing is half-hired", async () => {
    const r = await hire(alice, { kind: "key", handle: "builder", config: { url: RUNNER } });
    expect(r.status, JSON.stringify(r.data)).toBe(403);
    expect((await hired(owner)).data.hired.map((h: any) => h.handle)).not.toContain("builder");
  });

  it("AP-1/AP-2 the owner hires @builder with a webhook: one principal, its key, the secret, both kinds listed", async () => {
    const r = await hire(owner, { kind: "key", handle: "builder", config: { url: RUNNER, name: "Builder" } });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.api_key).toMatch(/^cnst_/);
    expect(r.data.secret).toBeTruthy();
    builderKey = r.data.api_key;
    expect(r.data.hired).toMatchObject({ kind: "key", handle: "builder", legacy: false, status: "active" });
    builder = r.data.hired.principal;
    expect(builder).toMatchObject({ name: "Builder", owner: OWNER_EMAIL, nest_id: nestId });
    expect(builder.email).toMatch(/@agent\.contextnest\.invalid$/);

    const u = (await db.get("SELECT is_service, password_hash FROM users WHERE id = ?", [builder.id])) as any;
    expect(Number(u.is_service)).toBe(1);
    const collab = (await db.all("SELECT nest_id, permission FROM nest_collaborators WHERE user_id = ?", [builder.id])) as any[];
    expect(collab).toEqual([{ nest_id: nestId, permission: "write" }]);
    const keys = (await db.all("SELECT user_id, nest_id, label, capability FROM api_keys WHERE user_id = ?", [builder.id])) as any[];
    expect(keys).toEqual([{ user_id: builder.id, nest_id: nestId, label: "builder", capability: "write" }]);
    // The key is the agent's, not the hirer's.
    const mine = await jsonRequest(app, "GET", "/auth/keys", undefined, owner.apiKey);
    expect((mine.data.keys ?? mine.data).map((k: any) => k.label)).not.toContain("builder");

    const list = (await hired(owner)).data.hired.filter((h: any) => h.handle === "builder").map((h: any) => h.kind).sort();
    expect(list).toEqual(["key", "webhook"]);
    // A webhook for a key agent's handle (and the reverse) pairs: no 409.
    const k2 = await hire(owner, { kind: "webhook", handle: "scout2", config: { url: RUNNER } });
    expect(k2.status).toBe(201);
    const k3 = await hire(owner, { kind: "key", handle: "scout2" });
    expect(k3.status, JSON.stringify(k3.data)).toBe(201);
  });

  it("AP-1 the principal is not a seat, not a person, reaches this nest only", async () => {
    const { billingClasses } = await import("../src/auth/seats.js");
    expect((await billingClasses()).has(builder.id)).toBe(false);
    const { listNestPeople } = await import("../src/nests/people-service.js");
    expect((await listNestPeople(nestId)).map((p: any) => p.email)).not.toContain(builder.email);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, builderKey)).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${sideNestId}`, undefined, builderKey)).status).toBe(403);
  });

  it("AP-1 a writer hires a key-only agent; any member can then DM it", async () => {
    const r = await hire(alice, { kind: "key", handle: "scout" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.hired.principal.owner).toBe(alice.email);
    const dm = await startConversation(bob.apiKey, ["@scout"]);
    const t = await say(bob.apiKey, dm, "hello scout");
    const read = await callTool(r.data.api_key, "context_conversation_read", { conversation: dm, thread: t.id });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain("hello scout");
  });
});

describe("AP-3/AP-4: any member DMs the agent; its key reads only its own conversations", () => {
  it("AP-3 Bob DMs @builder; the agent's key reads it and replies; its reply wakes nobody", async () => {
    captureWakes();
    const dm = await startConversation(bob.apiKey, ["@builder"]);
    const t = await say(bob.apiKey, dm, "FYI, pricing moved to $49");
    await waitForSent(1);
    const p = JSON.parse(sent[0].body);
    expect(p).toMatchObject({ event: "agent.dm", mentioned: "builder", conversation: dm, author_email: bob.email });

    const read = await callTool(builderKey, "context_conversation_read", { conversation: dm, thread: t.id });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain("pricing moved to $49");
    const reply = await callTool(builderKey, "context_comment", { id: dm, thread: t.id, body: "Noted." });
    expect(reply.isError, reply.text).toBe(false);
    await settle();
    expect(sent).toHaveLength(1); // the agent's own message: no agent.dm back to itself

    const bobsView = await jsonRequest(app, "GET", `/nests/${nestId}/conversations/${enc(dm)}?thread=${t.id}`, undefined, bob.apiKey);
    const replies = bobsView.data.thread.replies as any[];
    expect(replies.at(-1)).toMatchObject({ body: "Noted.", author: builder.email });

    const mine = await callTool(builderKey, "context_conversations", {});
    expect(mine.isError, mine.text).toBe(false);
    expect(JSON.stringify(mine.data)).toContain(dm);
  });

  it("AP-3 an @mention of the handle in a channel is in the agent's own My Work", async () => {
    const ch = await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "general", purpose: "General" }, owner.apiKey);
    expect(ch.status, JSON.stringify(ch.data)).toBeLessThan(300);
    const t = await say(carol.apiKey, "nodes/channels/general", "@builder can you check the release notes?");
    const work = await callTool(builderKey, "context_my_work", {}); // no declared agent: the identity owns the handle
    expect(work.isError, work.text).toBe(false);
    expect(JSON.stringify(work.data)).toContain(t.id);
    // …and the channel is readable to it (a member of the nest).
    const read = await callTool(builderKey, "context_channel_read", { channel: "general", thread: t.id });
    expect(read.isError, read.text).toBe(false);
  });

  it("AP-4 a conversation without the agent is NotFound to its key, and it can't post there", async () => {
    const dm = await startConversation(alice.apiKey, [bob.email]);
    const t = await say(alice.apiKey, dm, "private between people");
    const read = await callTool(builderKey, "context_conversation_read", { conversation: dm });
    expect(read.isError).toBe(true);
    expect(read.text).toMatch(/not found/i);
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${enc(dm)}`, undefined, builderKey);
    expect([403, 404]).toContain(rest.status);
    const post = await callTool(builderKey, "context_comment", { id: dm, thread: t.id, body: "sneaking in" });
    expect(post.isError).toBe(true);
    const list = await callTool(builderKey, "context_conversations", {});
    expect(JSON.stringify(list.data ?? {})).not.toContain(dm);
  });
});

describe("AP-5: an agent principal can't escalate", () => {
  it("can't sign in, mint keys or hire", async () => {
    const login = await jsonRequest(app, "POST", "/auth/login", { email: builder.email, password: "anything-at-all-1A!" });
    expect(login.status).toBeGreaterThanOrEqual(400);
    const { createSession } = await import("../src/auth/sessions.js");
    await expect(createSession(builder.id)).rejects.toThrow();
    expect((await jsonRequest(app, "POST", "/auth/keys", { label: "more" }, builderKey)).status).toBe(403);
    expect((await hire(builderKey, { kind: "key", handle: "minion" })).status).toBe(403);
    expect((await hire(builderKey, { kind: "webhook", handle: "minion", config: { url: RUNNER } })).status).toBe(403);
  });

  it("can't be added as a collaborator or promoted to admin", async () => {
    const add = await jsonRequest(app, "POST", `/nests/${sideNestId}/collaborators`, { email: builder.email, permission: "admin" }, owner.apiKey);
    expect(add.status).toBe(400);
    const row = (await db.get("SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?", [nestId, builder.id])) as { id: string };
    const patch = await jsonRequest(app, "PATCH", `/nests/${nestId}/collaborators/${row.id}`, { permission: "admin" }, owner.apiKey);
    expect(patch.status).toBe(400);
  });

  it("never resolves above write, nor on another nest, whatever rows say", async () => {
    const { resolveNestAccess } = await import("../src/shared/access.js");
    await db.run("UPDATE nest_collaborators SET permission = 'admin' WHERE nest_id = ? AND user_id = ?", [nestId, builder.id]);
    await db.run("INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, 'admin', ?)", [
      "ap-side-row",
      sideNestId,
      builder.id,
      owner.userId,
    ]);
    try {
      expect((await resolveNestAccess(nestId, builder.id)).permission).toBe("write");
      expect((await resolveNestAccess(sideNestId, builder.id)).permission).toBe("none");
    } finally {
      await db.run("UPDATE nest_collaborators SET permission = 'write' WHERE nest_id = ? AND user_id = ?", [nestId, builder.id]);
      await db.run("DELETE FROM nest_collaborators WHERE id = 'ap-side-row'");
    }
  });

  it("is not a headless reader: it can write drafts in its nest", async () => {
    const r = await callTool(builderKey, "context_create", { title: "Builder scratch", content: "a note", folder: "agents/builder/scratch" });
    expect(r.isError, r.text).toBe(false);
  });
});

describe("AP-6: the person who asked approves the agent's card; the agent approves nothing", () => {
  it("Bob approves @builder's card filed in Bob's dm; the agent is woken", async () => {
    const dm = await startConversation(bob.apiKey, ["@builder"]);
    captureWakes();
    const t = await say(bob.apiKey, dm, "add a /healthz endpoint");
    await waitForSent(1);
    // A declared label can't redirect the decision wake to another handle.
    const card = await callTool(builderKey, "context_propose", { thread: t.id, title: "Plan: /healthz", content: "1. Add GET /healthz", client: { agent: "someone-else" } });
    expect(card.isError, card.text).toBe(false);
    const p = card.data.proposal;
    expect(p.proposed_by).toBe("builder");

    // The agent itself can't decide it, nor any other review.
    const self = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${p.node_id}/approve`, { note: "me" }, builderKey);
    expect(self.status).toBeGreaterThanOrEqual(400);
    const selfMcp = await callTool(builderKey, "context_reject", { title: "Plan: /healthz", reason: "nah" });
    expect(selfMcp.isError).toBe(true);

    const ap = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${p.node_id}/approve`, { note: "go" }, bob.apiKey);
    expect(ap.status, JSON.stringify(ap.data)).toBeLessThan(300);
    await waitForSent(2);
    expect(JSON.parse(sent[1].body)).toMatchObject({
      event: "agent.proposal.decided",
      mentioned: "builder",
      proposal: { status: "approved", decided_by: bob.email },
    });
  });

  it("a principal made a steward still can't approve", async () => {
    const { canUserApprove } = await import("../src/governance/stewardship-service.js");
    await db.run(
      "INSERT INTO stewards (id, nest_id, scope, user_email, role, is_active, assigned_by) VALUES (?, ?, 'nest', ?, 'reviewer', 1, ?)",
      ["ap-steward", nestId, builder.email, OWNER_EMAIL],
    ).catch(() => {});
    try {
      const v = await canUserApprove(nestId, "nodes/whatever", builder.email, { requestedBy: alice.email });
      expect(v.allowed).toBe(false);
    } finally {
      await db.run("DELETE FROM stewards WHERE id = 'ap-steward'");
    }
  });
});

describe("AP-7: the agent's pending memory is readable to it in full; nothing else pending is", () => {
  it("remember → one reply; the principal gets its own pending memory body; others stay withheld", async () => {
    const dm = await startConversation(bob.apiKey, ["@builder"]);
    const t = await say(bob.apiKey, dm, "FYI the launch moved to Friday the 13th");
    const r = await callTool(builderKey, "context_remember", {
      thread: t.id,
      message_id: t.comments[0].id,
      kind: "fact",
      folder: "agents/builder/memory",
      summary: "agent-memory-builder: kept in the memory of the agent builder.",
    });
    expect(r.isError, r.text).toBe(false);
    const node = r.data.node;
    expect(node.id.startsWith("nodes/agents/builder/memory/")).toBe(true);
    expect(node.status).toBe("pending_review");

    const th = await jsonRequest(app, "GET", `/nests/${nestId}/conversations/${enc(dm)}?thread=${t.id}`, undefined, bob.apiKey);
    expect(th.data.thread.replies).toHaveLength(1);

    const got = await callTool(builderKey, "context_get", { id: node.id });
    expect(got.isError, got.text).toBe(false);
    expect(got.text).toContain("launch moved to Friday");
    const found = await callTool(builderKey, "context_search", { query: "agent-memory-builder" });
    const hit = (found.data?.results ?? []).find((x: any) => x.id === node.id);
    expect(hit?.body ?? "").toContain("launch moved to Friday");

    // Someone else's pending draft, and another agent's memory: withheld.
    const other = await callTool(alice.apiKey, "context_create", { title: "Secret roadmap", content: "codename HALIBUT", folder: "plans" });
    expect(other.isError, other.text).toBe(false);
    const foreign = await callTool(alice.apiKey, "context_create", { title: "Scout memory", content: "codename TURBOT", folder: "agents/scout/memory" });
    expect(foreign.isError, foreign.text).toBe(false);
    for (const q of ["HALIBUT", "TURBOT"]) {
      const s = await callTool(builderKey, "context_search", { query: q });
      expect(JSON.stringify(s.data ?? {})).not.toContain(`codename ${q}`);
      expect(s.text).not.toContain(`codename ${q}`);
    }
  });
});

describe("AP-8: legacy key agents keep working", () => {
  it("a hired personal key labelled with the handle lists as legacy and still works", async () => {
    const k = await jsonRequest(app, "POST", "/auth/keys", { label: "grok", nest_id: nestId }, alice.apiKey);
    expect(k.status).toBe(201);
    await db.run("INSERT INTO hired_agents (nest_id, kind, handle, hired_by, created_at, ref) VALUES (?, 'key', 'grok', ?, ?, ?)", [
      nestId,
      alice.email,
      new Date().toISOString(),
      k.data.id,
    ]);
    const g = (await hired(owner)).data.hired.find((h: any) => h.handle === "grok");
    expect(g).toMatchObject({ kind: "key", legacy: true, principal: null });
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, k.data.api_key)).status).toBe(200);
    expect((await letGo(alice, "key", "grok")).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, k.data.api_key)).status).toBe(401);
  });
});

describe("AP-9: who am I, who owns me", () => {
  it("MCP context_agent_identity and REST GET /hire/me", async () => {
    const me = await callTool(builderKey, "context_agent_identity", {});
    expect(me.isError, me.text).toBe(false);
    expect(me.data).toMatchObject({ agent: true, handle: "builder", name: "Builder", nest: { id: nestId }, owner: { email: OWNER_EMAIL }, legacy: false, webhook: true });
    expect(me.text).toContain("@builder");
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/hire/me`, undefined, builderKey);
    expect(rest.status).toBe(200);
    expect(rest.data).toMatchObject({ agent: true, handle: "builder", owner: { email: OWNER_EMAIL } });
    const person = await callTool(bob.apiKey, "context_agent_identity", {});
    expect(person.isError, person.text).toBe(false);
    expect(person.data).toMatchObject({ agent: false });
  });
});

describe("AP-10: let go revokes; hiring again reuses the identity", () => {
  it("only the owner or an admin lets it go; the key and access end; a re-hire reuses the principal", async () => {
    expect((await letGo(carol, "key", "builder")).status).toBe(403);
    expect((await letGo(owner, "key", "builder")).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, builderKey)).status).toBe(401);
    const { resolveNestAccess } = await import("../src/shared/access.js");
    expect((await resolveNestAccess(nestId, builder.id)).permission).toBe("none");
    const again = await hire(owner, { kind: "key", handle: "builder" });
    expect(again.status, JSON.stringify(again.data)).toBe(201);
    expect(again.data.hired.principal.id).toBe(builder.id);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, again.data.api_key)).status).toBe(200);
  });

  it("a person who registered the principal's address first blocks nothing and gains nothing", async () => {
    const { agentPrincipalEmail } = await import("../src/agents/principals.js");
    await resetAuthRateLimit();
    const squat = await registerUser(app, agentPrincipalEmail(nestId, "squatter"), "Squatter");
    const r = await hire(owner, { kind: "key", handle: "squatter" });
    expect(r.status).toBe(409);
    const { resolveNestAccess } = await import("../src/shared/access.js");
    expect((await resolveNestAccess(nestId, squat.userId)).permission).toBe("none");
    // Added as an ordinary collaborator, the person is visible like any person.
    const add = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: squat.email, permission: "read" }, owner.apiKey);
    expect(add.status, JSON.stringify(add.data)).toBeLessThan(300);
    const { listNestPeople } = await import("../src/nests/people-service.js");
    expect((await listNestPeople(nestId)).map((p: any) => p.email.toLowerCase())).toContain(squat.email.toLowerCase());
  });

  it("an agent can't wear a person's name", async () => {
    const r = await hire(owner, { kind: "key", handle: "mimic", name: "Bob" });
    expect(r.status).toBe(400);
    const r2 = await hire(owner, { kind: "key", handle: "mimic", name: bob.email });
    expect(r2.status).toBe(400);
  });
});
