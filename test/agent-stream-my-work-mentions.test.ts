/**
 * Agent team stream, S2: Mentions in My Work (PO-1180).
 *
 * `GET /me/work` gains a `mentions` section: the open comment threads, in
 * channels AND on documents, that @mention the caller and that the caller
 * has not answered since (replied in after the mention, or the thread was
 * resolved). Scoped to nests the caller can read, paged on its own
 * (`mentions_pagination`), and counted once in the badge
 * (`waiting_on_me_total`), with the matching inbox notification no longer
 * counted a second time. MCP `context_my_work` returns the same sections.
 *
 * Every acceptance criterion is a describe block named by its AC id; SEC-*
 * blocks are the security review's findings, pinned test-first.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

// The seam, from the SAME module instance the app loaded (createTestApp
// resets the module registry), bound in beforeAll.
let setAgentMentionResolver: typeof import("../src/mentions/agent-mentions.js").setAgentMentionResolver;

const OWNER_EMAIL = "owner@team.test";
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

type User = { apiKey: string; userId: string; email: string; cookie: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let bob: User; // write collaborator — the one who tags
let alice: User; // write collaborator — the one tagged
let dana: User; // write collaborator — the 120-mention inbox
let outsider: User; // on no shared nest
let nestId: string; // "Team": has the #ops channel and a document
let sideNestId: string; // "Side": Alice is removed from it in AC-MW-03
let aliceCollabOnSide: string;
let docId: string;
let sideDocId: string;
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

/** Open a thread on a node (a channel post or a document comment). */
async function open(u: { apiKey: string }, node: string, body: string, nest = nestId): Promise<string> {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations`, { body }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.thread.id;
}
async function reply(u: { apiKey: string }, node: string, threadId: string, body: string, nest = nestId) {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations/${threadId}/comments`, { body }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r;
}
async function resolve(u: { apiKey: string }, node: string, threadId: string, nest = nestId) {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations/${threadId}/resolve`, {}, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
}
async function work(u: { apiKey: string }, qs = "") {
  const r = await jsonRequest(app, "GET", `/me/work${qs}`, undefined, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
}
const mentionThreads = (w: any): string[] => (w.mentions ?? []).map((m: any) => m.thread_id);
/** The badge exactly as the UI computes it (ui/src/lib/my-work-groups.ts). */
const badge = (w: any) =>
  (w.waiting_on_me_total ?? w.pagination?.total ?? 0) + (w.assigned?.length ?? 0) + (w.notifications?.length ?? 0);
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeAll(async () => {
  env = setupTestEnv();
  process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  ({ setAgentMentionResolver } = await import("../src/mentions/agent-mentions.js"));
  owner = await registerUser(app, OWNER_EMAIL, "Owner");
  bob = await registerUser(app, "bob@team.test", "Bob Builder");
  alice = await registerUser(app, "alice@team.test", "Alice Example");
  await resetAuthRateLimit();
  dana = await registerUser(app, "dana@team.test", "Dana");
  outsider = await registerUser(app, "outsider@else.test", "Outsider");

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  sideNestId = (await jsonRequest(app, "POST", "/nests", { name: "Side" }, owner.apiKey)).data.nest.id;
  for (const u of [bob, alice, dana]) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission: "write" }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  for (const u of [bob, alice]) {
    const r = await jsonRequest(app, "POST", `/nests/${sideNestId}/collaborators`, { email: u.email, permission: "write" }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    if (u === alice) aliceCollabOnSide = r.data.collaborator.id;
  }
  const ch = await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "ops" }, owner.apiKey);
  expect(ch.status, JSON.stringify(ch.data)).toBeLessThan(300);
  const doc = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Launch Plan", content: "# Plan" }, owner.apiKey);
  expect(doc.status, JSON.stringify(doc.data)).toBe(201);
  docId = doc.data.node.id;
  const side = await jsonRequest(app, "POST", `/nests/${sideNestId}/nodes`, { title: "Side Doc", content: "x" }, owner.apiKey);
  expect(side.status, JSON.stringify(side.data)).toBe(201);
  sideDocId = side.data.node.id;
});

afterEach(() => setAgentMentionResolver(null));

afterAll(async () => {
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  await env.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MW-01 — a mention lands in My Work
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-MW-01: a channel @mention shows in the mentioned person's My Work", () => {
  it("AC-MW-01 lists the channel thread with nest, channel, node, excerpt and author", async () => {
    const t = await open(bob, OPS, "@alice@team.test can you take the deploy tonight?");
    const w = await work(alice);
    const m = (w.mentions ?? []).find((x: any) => x.thread_id === t);
    expect(m, JSON.stringify(w.mentions)).toBeTruthy();
    expect(m).toMatchObject({
      type: "mention",
      kind: "channel",
      nest_id: nestId,
      nest_name: "Team",
      node_id: OPS,
      channel: "ops",
      thread_id: t,
      author: bob.email,
      for_agent: null,
    });
    expect(m.excerpt).toContain("can you take the deploy tonight?");
    expect(typeof m.comment_id).toBe("string");
    expect(Number.isNaN(Date.parse(m.mentioned_at))).toBe(false);
    expect(w.mentions_pagination).toMatchObject({ total: expect.any(Number), limit: 50, offset: 0 });
    // Bob tagged Alice, not himself: nothing waits on Bob.
    expect(mentionThreads(await work(bob))).not.toContain(t);
  });

  it("AC-MW-01 also lists document comment threads, as kind document with the doc's title", async () => {
    const t = await open(bob, docId, "@alice please review the budget section");
    const m = (await work(alice)).mentions.find((x: any) => x.thread_id === t);
    expect(m).toMatchObject({ kind: "document", node_id: docId, title: "Launch Plan", channel: null, author: bob.email });
  });

  it("AC-MW-01 resolves a mention by email, username or display name — the way mention-notify does", async () => {
    const byUser = await open(bob, OPS, "@alice ping by username");
    const byName = await open(bob, OPS, "@(Alice Example) ping by display name");
    const nobody = await open(bob, OPS, "@alicia nobody by that name");
    const ids = mentionThreads(await work(alice));
    expect(ids).toEqual(expect.arrayContaining([byUser, byName]));
    expect(ids).not.toContain(nobody);
  });

  it("AC-MW-01 counts a thread once however many times it tags you, at the latest mention", async () => {
    const t = await open(bob, OPS, "@alice first ask");
    await tick();
    await reply(bob, OPS, t, "@alice second ask, still waiting");
    const rows = (await work(alice)).mentions.filter((x: any) => x.thread_id === t);
    expect(rows).toHaveLength(1);
    expect(rows[0].excerpt).toContain("second ask");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MW-02 — answering clears it
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-MW-02: replying in the thread or resolving it clears the mention", () => {
  it("AC-MW-02 a reply by the mentioned person removes it", async () => {
    const t = await open(bob, OPS, "@alice are we shipping friday?");
    expect(mentionThreads(await work(alice))).toContain(t);
    await tick();
    await reply(alice, OPS, t, "yes, friday");
    expect(mentionThreads(await work(alice))).not.toContain(t);
  });

  it("AC-MW-02 resolving the thread removes it", async () => {
    const t = await open(bob, docId, "@alice typo in para 2");
    expect(mentionThreads(await work(alice))).toContain(t);
    await resolve(alice, docId, t);
    expect(mentionThreads(await work(alice))).not.toContain(t);
  });

  it("AC-MW-02 someone else's reply doesn't answer for you, and an earlier reply of yours doesn't either", async () => {
    const t = await open(alice, OPS, "thinking about the rollout");
    await tick();
    await reply(bob, OPS, t, "@alice what about the canary?");
    await tick();
    await reply(owner, OPS, t, "+1 on the canary");
    expect(mentionThreads(await work(alice))).toContain(t);
  });

  it("AC-MW-02 a new mention after your reply brings the thread back", async () => {
    const t = await open(bob, OPS, "@alice step one?");
    await tick();
    await reply(alice, OPS, t, "done");
    expect(mentionThreads(await work(alice))).not.toContain(t);
    await tick();
    await reply(bob, OPS, t, "@alice and step two?");
    expect(mentionThreads(await work(alice))).toContain(t);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MW-03 — only nests you can read
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-MW-03: after losing read on the nest the mention is absent and not counted", () => {
  it("AC-MW-03 drops the item and the counts when the person is removed from the nest", async () => {
    const t = await open(bob, sideDocId, "@alice side-project question", sideNestId);
    const before = await work(alice);
    expect(mentionThreads(before)).toContain(t);

    const del = await jsonRequest(app, "DELETE", `/nests/${sideNestId}/collaborators/${aliceCollabOnSide}`, undefined, owner.apiKey);
    expect(del.status, JSON.stringify(del.data)).toBe(200);

    const after = await work(alice);
    expect(mentionThreads(after)).not.toContain(t);
    expect(after.mentions.some((m: any) => m.nest_id === sideNestId)).toBe(false);
    expect(after.mentions_pagination.total).toBe(before.mentions_pagination.total - 1);
    expect(after.waiting_on_me_total).toBe(before.waiting_on_me_total - 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MW-04 — paging and the badge
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-MW-04: 120 open mentions page by 50 with total 120, and the badge matches", () => {
  it("AC-MW-04 pages the mentions and counts each once in the badge", async () => {
    for (let i = 0; i < 120; i++) await open(bob, docId, `@dana item ${i}`);
    const p1 = await work(dana, "?limit=50");
    expect(p1.mentions).toHaveLength(50);
    expect(p1.mentions_pagination).toEqual({ total: 120, limit: 50, offset: 0, has_more: true });
    const p3 = await work(dana, "?limit=50&mentions_offset=100");
    expect(p3.mentions).toHaveLength(20);
    expect(p3.mentions_pagination).toMatchObject({ total: 120, offset: 100, has_more: false });
    // No page overlaps another.
    const p2 = await work(dana, "?limit=50&mentions_offset=50");
    const all = new Set([...mentionThreads(p1), ...mentionThreads(p2), ...mentionThreads(p3)]);
    expect(all.size).toBe(120);

    // Dana has nothing else waiting: the badge is exactly the 120 mentions —
    // the "mentioned you" inbox rows for the same threads aren't counted again.
    const b = await work(dana, "?limit=1");
    expect(b.waiting_on_me_total).toBe(120);
    expect(badge(b)).toBe(120);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MW-05 — MCP parity
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-MW-05: MCP context_my_work matches REST /me/work", () => {
  it("AC-MW-05 is offered (read tier) without the channels switch", async () => {
    expect(await listToolNames(alice.apiKey)).toContain("context_my_work");
    delete process.env.EXPERIMENTAL_AGENT_STREAM;
    try {
      expect(await listToolNames(alice.apiKey)).toContain("context_my_work");
    } finally {
      process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    }
  });

  it("AC-MW-05 returns the same sections and items as REST for the person's own key", async () => {
    await open(bob, OPS, "@alice parity check");
    const rest = await work(alice);
    // Since S4b (AC-AX-02) the MCP default leaves the notification list out;
    // asking for every section returns exactly what REST returns.
    const mcp = await callTool(alice.apiKey, "context_my_work", {
      sections: ["mentions", "items", "waiting", "assigned", "notifications"],
    });
    expect(mcp.isError, mcp.text).toBe(false);
    for (const k of [
      "items",
      "waiting",
      "notifications",
      "assigned",
      "mentions",
      "waiting_on_me_total",
      "pagination",
      "mentions_pagination",
    ]) {
      expect(mcp.data[k], k).toEqual(rest[k]);
    }
    expect(mcp.text).toContain("parity check");
  });

  it("AC-MW-05 pages like REST (limit / mentions_offset)", async () => {
    const rest = await work(dana, "?limit=50&mentions_offset=50");
    const mcp = await callTool(dana.apiKey, "context_my_work", { limit: 50, mentions_offset: 50 });
    expect(mcp.data.mentions).toEqual(rest.mentions);
    expect(mcp.data.mentions_pagination).toEqual(rest.mentions_pagination);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MW-06 — code is not a mention
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-MW-06: a mention inside a code span or fence creates no item", () => {
  it("AC-MW-06 ignores inline code and fenced blocks", async () => {
    const inline = await open(bob, OPS, "run `notify @alice` in the shell");
    const fenced = await open(bob, docId, "```\ncurl -d '@alice' https://x\n```");
    // Control: the same author, the same channel, outside code — it lands.
    const control = await open(bob, OPS, "`notify` is broken, @alice can you look?");
    const ids = mentionThreads(await work(alice));
    expect(ids).toContain(control);
    expect(ids).not.toContain(inline);
    expect(ids).not.toContain(fenced);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Agent seam — mentions of an agent a person owns
// ═══════════════════════════════════════════════════════════════════════════

describe("AGENT-SEAM: an @handle that names no person reaches the agent's owner through one seam", () => {
  it("AGENT-SEAM stays out of My Work until the identity seam says who owns the handle", async () => {
    const t = await open(bob, OPS, "@grok summarise the incident");
    expect(mentionThreads(await work(alice))).not.toContain(t);
    setAgentMentionResolver(async ({ email }) => (email === alice.email ? ["grok"] : []));
    const m = (await work(alice)).mentions.find((x: any) => x.thread_id === t);
    expect(m).toMatchObject({ for_agent: "grok", kind: "channel" });
    // Answered = the owner (the person the agent writes as) replied after it.
    await tick();
    await reply(alice, OPS, t, "on it");
    expect(mentionThreads(await work(alice))).not.toContain(t);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Security review findings
// ═══════════════════════════════════════════════════════════════════════════

describe("SEC: mentions never reveal what the caller can't read", () => {
  it("SEC-1 an agent-seam claim can't surface a thread in a nest the caller can't read", async () => {
    const theirNest = (await jsonRequest(app, "POST", "/nests", { name: "Private" }, outsider.apiKey)).data.nest.id;
    const d = await jsonRequest(app, "POST", `/nests/${theirNest}/nodes`, { title: "Secret", content: "x" }, outsider.apiKey);
    const t = await open(outsider, d.data.node.id, "@grok secret plan", theirNest);
    setAgentMentionResolver(async () => ["grok"]);
    const w = await work(alice);
    expect(mentionThreads(w)).not.toContain(t);
    expect(w.mentions.some((m: any) => m.nest_id === theirNest)).toBe(false);
  });

  it("SEC-2 tagging someone off the nest gives them no item (and no count) for it", async () => {
    const t = await open(bob, OPS, "@outsider@else.test look at this");
    const w = await work(outsider);
    expect(mentionThreads(w)).not.toContain(t);
    expect(w.mentions_pagination.total).toBe(0);
  });

  it("SEC-3 a nest-scoped key sees only that nest's mentions over MCP", async () => {
    const other = (await jsonRequest(app, "POST", "/nests", { name: "Third" }, owner.apiKey)).data.nest.id;
    for (const u of [alice, bob]) {
      await jsonRequest(app, "POST", `/nests/${other}/collaborators`, { email: u.email, permission: "write" }, owner.apiKey);
    }
    const od = await jsonRequest(app, "POST", `/nests/${other}/nodes`, { title: "Other", content: "x" }, owner.apiKey);
    const elsewhere = await open(bob, od.data.node.id, "@alice over here", other);
    const here = await open(bob, OPS, "@alice in the scoped nest");
    const minted = await jsonRequest(app, "POST", "/auth/keys", { label: "scoped", nest_id: nestId }, alice.apiKey);
    expect(minted.status, JSON.stringify(minted.data)).toBeLessThan(300);
    const r = await callTool(minted.data.api_key, "context_my_work", {
      sections: ["mentions", "items", "waiting", "assigned", "notifications"],
    });
    expect(r.isError, r.text).toBe(false);
    expect(mentionThreads(r.data)).toContain(here);
    expect(r.data.mentions.every((m: any) => m.nest_id === nestId)).toBe(true);
    expect(mentionThreads(r.data)).not.toContain(elsewhere);
    expect([...r.data.items, ...r.data.waiting, ...r.data.notifications].every((i: any) => i.nest_id === nestId)).toBe(true);
    // The person's own unscoped key still sees it.
    expect(mentionThreads(await work(alice))).toContain(elsewhere);
  });

  it("SEC-4 the excerpt is plain text, capped, with the mention markup left as typed", async () => {
    const long = "@alice <img src=x onerror=alert(1)> " + "z".repeat(1000);
    const t = await open(bob, OPS, long);
    const m = (await work(alice)).mentions.find((x: any) => x.thread_id === t);
    expect(m.excerpt.length).toBeLessThanOrEqual(281);
    expect(m.excerpt.startsWith("@alice <img")).toBe(true);
  });
});
