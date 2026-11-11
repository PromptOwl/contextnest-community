/**
 * Team chat C6 — memory snowball, the parts that need no model (PO-1199):
 *
 *   - Remember this: a message or a thread → a node proposed through the
 *     same path a person's own draft takes (draft + review queue on a
 *     governed nest; whatever their own POST /nodes does elsewhere), quoting
 *     the source, `source_thread` set, a reply card in the thread.
 *   - Corrections: a message marked as a correction of a node → an edit
 *     proposal on that node (a new draft version + review), the correction
 *     appended as a marked block.
 *   - Thread ↔ node relations recorded from wikilinks, cards, promote,
 *     remember and correct; read from both sides, never naming a node the
 *     reader can't open.
 *   - Channel knowledge view and `knowledge_count`.
 *   - Decision ledger.
 *
 * Every acceptance criterion is a describe block named by its AC id; SEC-*
 * blocks pin the security review's findings.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const OWNER_EMAIL = "owner@c6.test";
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const OPS = "nodes/channels/ops";

type User = { apiKey: string; userId: string; email: string; cookie: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let alice: User; // write collaborator on Team (governed) and Side (ungoverned)
let sam: User; // reviewer steward on Team (read collaborator)
let reader: User; // read collaborator on Team
let outsider: User;
let nestId: string;
let sideNestId: string;
let planId: string; // nodes/launch-plan, published before the nest was governed
let sideDocId: string; // a document in Side: a link to it from Team is cross-nest

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
async function reply(u: { apiKey: string }, node: string, threadId: string, body: string, extra: Record<string, unknown> = {}, nest = nestId) {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations/${threadId}/comments`, { body, ...extra }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  return r.data.thread as { id: string; comments: Array<{ id: string; body: string; author: string }> };
}
const remember = (u: User, threadId: string, body: Record<string, unknown>, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/threads/${threadId}/remember`, body, u.apiKey);
const correct = (u: User, threadId: string, body: Record<string, unknown>, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/threads/${threadId}/correct`, body, u.apiKey);
const readNode = async (u: User, id: string, nest = nestId) => {
  const r = await jsonRequest(app, "GET", `/nests/${nest}/nodes/${id}`, undefined, u.apiKey);
  return { status: r.status, node: r.data.node ?? r.data };
};
const queue = async (u: User, nest = nestId) => {
  const r = await jsonRequest(app, "GET", `/nests/${nest}/review-queue`, undefined, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data.requests as Array<{ id: string; nodeId: string; requestedBy: string; status: string; requestNote?: string }>;
};
const thread = async (u: User, threadId: string, channel = "ops") => {
  const r = await jsonRequest(app, "GET", `/nests/${nestId}/channels/${channel}?thread=${threadId}`, undefined, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data.thread as { post: any; replies: any[]; related_nodes: any[] };
};
const relations = (u: User, id: string, nest = nestId) => jsonRequest(app, "GET", `/nests/${nest}/nodes/${id}/relations`, undefined, u.apiKey);
/** A node the owner creates on the governed nest is a draft: send it through review so it is approved text. */
const publish = async (id: string) => {
  const sub = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/submit-review`, {}, owner.apiKey);
  expect(sub.status, JSON.stringify(sub.data)).toBeLessThan(300);
  const ok = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/approve`, { note: "ok" }, sam.apiKey);
  expect(ok.status, JSON.stringify(ok.data)).toBe(200);
};

beforeAll(async () => {
  env = setupTestEnv();
  process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  owner = await registerUser(app, OWNER_EMAIL, "Owner");
  alice = await registerUser(app, "alice@c6.test", "Alice Example");
  sam = await registerUser(app, "sam@c6.test", "Sam Steward");
  await resetAuthRateLimit();
  reader = await registerUser(app, "reader@c6.test", "Rita Reader");
  outsider = await registerUser(app, "outsider@else.test", "Outsider");

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  sideNestId = (await jsonRequest(app, "POST", "/nests", { name: "Side" }, owner.apiKey)).data.nest.id;
  for (const [u, permission] of [
    [alice, "write"],
    [sam, "read"],
    [reader, "read"],
  ] as const) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  {
    const r = await jsonRequest(app, "POST", `/nests/${sideNestId}/collaborators`, { email: alice.email, permission: "write" }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  for (const nest of [nestId, sideNestId]) {
    const ch = await jsonRequest(app, "POST", `/nests/${nest}/channels`, { name: "ops" }, owner.apiKey);
    expect(ch.status, JSON.stringify(ch.data)).toBeLessThan(300);
  }
  // Seeded while the nest is ungoverned, so these publish straight away.
  const plan = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Launch Plan", content: "# Launch Plan\n\nWe launch on Monday." }, owner.apiKey);
  expect(plan.status, JSON.stringify(plan.data)).toBe(201);
  planId = plan.data.node.id;
  const side = await jsonRequest(app, "POST", `/nests/${sideNestId}/nodes`, { title: "Side Roadmap", content: "x" }, owner.apiKey);
  expect(side.status, JSON.stringify(side.data)).toBe(201);
  sideDocId = side.data.node.id;
  // Now govern it: a reviewer steward, so a writer's create lands as a draft.
  const st = await jsonRequest(app, "POST", `/nests/${nestId}/stewards`, { scope: "nest", email: sam.email, role: "reviewer" }, owner.apiKey);
  expect(st.status, JSON.stringify(st.data)).toBeLessThan(300);
});

afterAll(async () => {
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  await env.cleanup();
});

// ─── AC-C6-01 ───────────────────────────────────────────────────────────

describe("AC-C6-01: remember a message → a node proposed through the person's own draft path", () => {
  it("on a governed nest: a draft under the caller's login, in the review queue, quoting the message, source_thread set, reply card in the thread", async () => {
    const t = await open(alice, OPS, "Heads up: the API rate limit is 600 requests a minute per key.");
    const r = await remember(alice, t.id, { message_id: t.comments[0].id, kind: "fact", title: "API rate limit" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.existing).toBe(false);
    expect(r.data.kind).toBe("fact");
    expect(r.data.node.id).toMatch(/^nodes\/facts\//);
    expect(r.data.node.status).toBe("pending_review");
    expect(r.data.node.review?.id).toBeTruthy();
    expect(r.data.source_thread).toEqual({ node_id: OPS, thread_id: t.id });
    expect(r.data.source_message_id).toBe(t.comments[0].id);
    expect(r.data.proposer).toEqual({ human: "Alice Example", agent: null, label: "Alice Example" });

    const { node } = await readNode(alice, r.data.node.id);
    expect(node.source_thread).toEqual({ node_id: OPS, thread_id: t.id });
    const body: string = node.content ?? node.body;
    expect(body).toContain("> Heads up: the API rate limit is 600 requests a minute per key.");
    expect(body).toContain("Alice Example");
    expect(body).toContain(`[[${OPS}]]`);
    expect(body).not.toContain(t.id);
    expect(node.author ?? node.created_by ?? alice.email).toBe(alice.email);

    const pending = (await queue(sam)).find((q) => q.nodeId === r.data.node.id);
    expect(pending, "the node sits in the review queue").toBeTruthy();
    expect(pending!.requestedBy).toBe(alice.email);
    expect(pending!.status).toBe("pending");

    const th = await thread(alice, t.id);
    const last = th.replies[th.replies.length - 1];
    expect(last.body).toContain(`[[${r.data.node.id}]]`);
    expect(last.author).toBe(alice.email);
  });

  it("on an ungoverned nest the node lands the way the caller's own POST /nodes does (published)", async () => {
    const t = await open(alice, OPS, "Side nest fact: deploys go out at 10:00 UTC.", {}, sideNestId);
    const r = await remember(alice, t.id, { message_id: t.comments[0].id, kind: "note" }, sideNestId);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.node.status).toBe("published");
    expect(r.data.node.review).toBeNull();
    expect(r.data.node.id).toMatch(/^nodes\/notes\//);
  });

  it("MCP context_remember returns the REST object", async () => {
    expect(await listToolNames(alice.apiKey)).toContain("context_remember");
    const t1 = await open(alice, OPS, "Parity one: we use UTC everywhere.");
    const t2 = await open(alice, OPS, "Parity two: we use UTC everywhere.");
    const rest = await remember(alice, t1.id, { kind: "fact", title: "Parity REST" });
    expect(rest.status, JSON.stringify(rest.data)).toBe(201);
    const mcp = await callTool(alice.apiKey, "context_remember", { thread: t2.id, kind: "fact", title: "Parity MCP" });
    expect(mcp.isError, mcp.text).toBe(false);
    const shape = (o: any): any =>
      o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape(o[k])])) : typeof o;
    expect(shape(mcp.data)).toEqual(shape(rest.data));
    expect(mcp.data.source_thread).toEqual({ node_id: OPS, thread_id: t2.id });
    expect(mcp.text).toContain(mcp.data.node.id);
    expect(mcp.text).toMatch(/review/i);
  });

  it("a bad kind, a non-string title or an unknown message are refused", async () => {
    const t = await open(alice, OPS, "Validation thread");
    expect((await remember(alice, t.id, { kind: "poem" })).status).toBe(400);
    expect((await remember(alice, t.id, { title: 5 })).status).toBe(400);
    expect((await remember(alice, t.id, { message_id: "00000000-0000-0000-0000-000000000000" })).status).toBe(404);
  });
});

// ─── AC-C6-02 ───────────────────────────────────────────────────────────

describe("AC-C6-02: remember a whole thread; idempotent per (thread, message, kind)", () => {
  it("quotes every message, and a second call for the same (thread, message, kind) returns the earlier node", async () => {
    const t = await open(alice, OPS, "How do we name releases?");
    await reply(owner, OPS, t.id, "Cities, alphabetical. Next one is Denver.");
    const first = await remember(alice, t.id, { kind: "decision", title: "Release names are cities" });
    expect(first.status, JSON.stringify(first.data)).toBe(201);
    expect(first.data.node.id).toMatch(/^nodes\/decisions\//);
    expect(first.data.source_message_id).toBeNull();
    const { node } = await readNode(alice, first.data.node.id);
    const body: string = node.content ?? node.body;
    expect(body).toContain("> How do we name releases?");
    expect(body).toContain("> Cities, alphabetical. Next one is Denver.");
    expect((node.tags ?? []).map((x: string) => x.replace(/^#/, ""))).toContain("decision");

    const again = await remember(alice, t.id, { kind: "decision", title: "Ignored" });
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    expect(again.data.existing).toBe(true);
    expect(again.data.node.id).toBe(first.data.node.id);
    expect(again.data.reply.comment_id).toBeNull();
    const th = await thread(alice, t.id);
    expect(th.replies.filter((m) => m.body.includes(`[[${first.data.node.id}]]`))).toHaveLength(1);

    // A different message of the same thread, or a different kind, is a new record.
    const other = await remember(alice, t.id, { kind: "note", title: "Release naming note" });
    expect(other.status, JSON.stringify(other.data)).toBe(201);
    expect(other.data.node.id).not.toBe(first.data.node.id);
  });
});

// ─── AC-C6-03 ───────────────────────────────────────────────────────────

describe("AC-C6-03: an agent remembers under its owner's login, recorded as proposer", () => {
  it("the node and the review are the person's; the agent is the proposer in the result and the body", async () => {
    const t = await open(alice, OPS, "Grok found this: staging uses the eu-west region.");
    const r = await remember(alice, t.id, { message_id: t.comments[0].id, kind: "fact", client: { agent: "grok" } });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.proposer).toEqual({ human: "Alice Example", agent: "grok", label: "grok, on behalf of Alice Example" });
    const pending = (await queue(sam)).find((q) => q.nodeId === r.data.node.id);
    expect(pending!.requestedBy).toBe(alice.email);
    const { node } = await readNode(alice, r.data.node.id);
    expect(node.content ?? node.body).toContain("grok, on behalf of Alice Example");
    const th = await thread(alice, t.id);
    const last = th.replies[th.replies.length - 1];
    expect(last.author).toBe(alice.email);
    expect(last.actor.agent).toBe("grok");
  });
});

// ─── AC-C6-04 ───────────────────────────────────────────────────────────

describe("AC-C6-04: a read-only member is told to ask a writer; non-members and other nests are not found", () => {
  it("403 with the ask-a-writer line for remember and correct; 404 for an outsider and a foreign thread", async () => {
    const t = await open(alice, OPS, "Reader wants this kept.");
    const ro = await remember(reader, t.id, { kind: "note" });
    expect(ro.status, JSON.stringify(ro.data)).toBe(403);
    expect(ro.data.error).toMatch(/ask a writer|@mention/i);
    const roc = await correct(reader, t.id, { message_id: t.comments[0].id, node_id: planId });
    expect(roc.status, JSON.stringify(roc.data)).toBe(403);
    expect(roc.data.error).toMatch(/ask a writer|@mention/i);
    expect((await remember(outsider, t.id, { kind: "note" })).status).toBe(404);
    expect((await remember(owner, t.id, { kind: "note" }, sideNestId)).status).toBe(404);
    const mcp = await callTool(reader.apiKey, "context_remember", { thread: t.id, kind: "note" });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toMatch(/ask a writer|@mention/i);
  });
});

// ─── AC-C6-05 ───────────────────────────────────────────────────────────

describe("AC-C6-05: a correction becomes an edit proposal on the node it corrects", () => {
  it("drafts a new version with the correction block appended, submits it for review, replies in the thread, records the relation", async () => {
    const before = await readNode(alice, planId);
    const t = await open(alice, OPS, `Actually [[${planId}]] is wrong: we launch on Tuesday, not Monday.`);
    const r = await correct(alice, t.id, { message_id: t.comments[0].id, node_id: planId, note: "Date slipped a day" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.existing).toBe(false);
    expect(r.data.node.id).toBe(planId);
    expect(r.data.node.version).toBe(Number(before.node.version) + 1);
    expect(r.data.node.status).toBe("pending_review");
    expect(r.data.source_thread).toEqual({ node_id: OPS, thread_id: t.id });

    const after = await readNode(alice, planId);
    const body: string = after.node.content ?? after.node.body;
    expect(body).toContain("We launch on Monday.");
    expect(body).toMatch(/## Correction from #ops \(\d+ \w{3} \d{4}\), by Alice Example/);
    expect(body).toContain("> Actually");
    expect(body).toContain("we launch on Tuesday, not Monday.");
    expect(body).not.toContain(t.id);
    const approved = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${planId}?approved_only=1`, undefined, alice.apiKey);
    expect(String(approved.data?.node?.content ?? approved.data?.content ?? "")).not.toContain("Correction from");

    const pending = (await queue(sam)).find((q) => q.nodeId === planId);
    expect(pending!.requestedBy).toBe(alice.email);
    expect(pending!.status).toBe("pending");

    const th = await thread(alice, t.id);
    const last = th.replies[th.replies.length - 1];
    expect(last.body).toContain(`[[${planId}]]`);
    expect(last.author).toBe(alice.email);
    expect(th.related_nodes.map((n: any) => n.node_id)).toContain(planId);
    const rel = await relations(alice, planId);
    expect(rel.data.discussed_in.map((d: any) => d.thread_id)).toContain(t.id);
    expect(rel.data.discussed_in.map((d: any) => d.kind)).toContain("corrected");
  });

  it("with `replacement` the draft body is the replacement text; MCP context_correct matches", async () => {
    // A fresh node for this case: the plan above is now locked by its review.
    const doc = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Support Hours", content: "# Support Hours\n\n9 to 5 CET." }, owner.apiKey);
    expect(doc.status, JSON.stringify(doc.data)).toBe(201);
    const id: string = doc.data.node.id;
    await publish(id);
    const t = await open(alice, OPS, "Support hours changed to 8 to 6 CET.");
    const mcp = await callTool(alice.apiKey, "context_correct", {
      thread: t.id,
      message_id: t.comments[0].id,
      node_id: id,
      replacement: "# Support Hours\n\n8 to 6 CET.",
    });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.node.id).toBe(id);
    expect(mcp.data.existing).toBe(false);
    expect(mcp.text).toContain(id);
    const after = await readNode(alice, id);
    const body: string = after.node.content ?? after.node.body;
    expect(body).toContain("8 to 6 CET.");
    expect(body).not.toContain("9 to 5 CET.");
    expect(body).toContain("Correction from #ops");
    expect((await queue(sam)).some((q) => q.nodeId === id && q.status === "pending")).toBe(true);
  });
});

// ─── AC-C6-06 ───────────────────────────────────────────────────────────

describe("AC-C6-06: correct refusals", () => {
  it("an unreadable node is 404, a node under review is 409, the same correction twice is 200 existing", async () => {
    const t = await open(alice, OPS, "Fix something");
    const m = t.comments[0].id;
    expect((await correct(alice, t.id, { message_id: m, node_id: "nodes/does-not-exist" })).status).toBe(404);
    expect((await correct(alice, t.id, { message_id: m, node_id: sideDocId })).status).toBe(404);
    expect((await correct(alice, t.id, { message_id: m, node_id: "../etc/passwd" })).status).toBe(400);
    // The launch plan has a pending review from AC-C6-05.
    const locked = await correct(alice, t.id, { message_id: m, node_id: planId });
    expect(locked.status, JSON.stringify(locked.data)).toBe(409);
    expect((await correct(alice, t.id, { node_id: planId })).status).toBe(400);

    const doc = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Oncall Rota", content: "# Oncall\n\nAlice this week." }, owner.apiKey);
    expect(doc.status).toBe(201);
    const id: string = doc.data.node.id;
    await publish(id);
    const first = await correct(alice, t.id, { message_id: m, node_id: id });
    expect(first.status, JSON.stringify(first.data)).toBe(201);
    const again = await correct(alice, t.id, { message_id: m, node_id: id });
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    expect(again.data.existing).toBe(true);
    expect(again.data.node.version).toBe(first.data.node.version);
  });
});

// ─── AC-C6-07 ───────────────────────────────────────────────────────────

describe("AC-C6-07: thread ↔ node relations are recorded automatically and read from both sides", () => {
  it("a wikilink in a message relates the thread to the node, once; the node lists the thread, the thread lists the node", async () => {
    const t = await open(alice, OPS, `Looking at [[${planId}]] again`);
    await reply(owner, OPS, t.id, `Yes [[${planId}]] and [[Launch Plan]] are the same thing`);
    const rel = await relations(alice, planId);
    expect(rel.status, JSON.stringify(rel.data)).toBe(200);
    const mine = rel.data.discussed_in.filter((d: any) => d.thread_id === t.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ thread_id: t.id, node_id: OPS, channel: "ops", kind: "mentioned" });
    expect(typeof mine[0].created_at).toBe("string");
    expect(mine[0].excerpt).toContain("Looking at");

    const th = await thread(alice, t.id);
    const related = th.related_nodes.filter((n: any) => n.node_id === planId);
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({ node_id: planId, title: "Launch Plan", type: "document", kind: "mentioned" });

    const mcp = await callTool(alice.apiKey, "context_relations", { id: planId });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.discussed_in.map((d: any) => d.thread_id)).toContain(t.id);
    expect(mcp.text).toContain("Discussed in");
  });

  it("a promoted thread is related as promoted", async () => {
    const t = await open(alice, OPS, "Promote me to a decision");
    const p = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t.id}/promote`, { kind: "decision", title: "Promoted relation" }, alice.apiKey);
    expect(p.status, JSON.stringify(p.data)).toBe(201);
    const rel = await relations(alice, p.data.node.id);
    expect(rel.data.discussed_in.map((d: any) => [d.thread_id, d.kind])).toContainEqual([t.id, "promoted"]);
  });

  it("a cross-nest link, a link to nothing, and a link in a code span record no relation", async () => {
    const url = `https://nest.example.com/nest/${sideNestId}?doc=${encodeURIComponent(sideDocId)}`;
    const t = await open(alice, OPS, `See ${url} and [[nodes/does-not-exist]] and \`[[${planId}]]\``);
    const th = await thread(alice, t.id);
    expect(th.related_nodes).toEqual([]);
    const side = await relations(owner, sideDocId, sideNestId);
    expect(side.data.discussed_in).toEqual([]);
    const plan = await relations(alice, planId);
    expect(plan.data.discussed_in.map((d: any) => d.thread_id)).not.toContain(t.id);
    // The timeline read carries `related_nodes` on each post too.
    const t2 = await open(alice, OPS, `Timeline link to [[${planId}]]`);
    const timeline = await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops`, undefined, alice.apiKey);
    const post = timeline.data.posts.find((p: any) => p.id === t2.id);
    expect(post.related_nodes.map((n: any) => n.node_id)).toEqual([planId]);
  });

  it("a visibility-only reader of the node sees no channel threads", async () => {
    const pub = (await jsonRequest(app, "POST", "/nests", { name: "Pub" }, owner.apiKey)).data.nest.id as string;
    await jsonRequest(app, "PATCH", `/nests/${pub}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${pub}/channels`, { name: "general" }, owner.apiKey);
    const doc = await jsonRequest(app, "POST", `/nests/${pub}/nodes`, { title: "Public Page", content: "v1" }, owner.apiKey);
    expect(doc.status).toBe(201);
    const t = await open(owner, "nodes/channels/general", `About [[${doc.data.node.id}]]`, {}, pub);
    const asOwner = await relations(owner, doc.data.node.id, pub);
    expect(asOwner.data.discussed_in.map((d: any) => d.thread_id)).toContain(t.id);
    const asPublic = await relations(outsider, doc.data.node.id, pub);
    expect(asPublic.status, JSON.stringify(asPublic.data)).toBe(200);
    expect(asPublic.data.discussed_in).toEqual([]);
  });
});

// ─── AC-C6-08 ───────────────────────────────────────────────────────────

describe("AC-C6-08: the channel knowledge view", () => {
  it("lists the nodes this channel produced with status, who and when, plus open proposals; the list carries knowledge_count; non-members get 404", async () => {
    const ch = await jsonRequest(app, "POST", `/nests/${nestId}/channels`, { name: "design" }, owner.apiKey);
    expect(ch.status).toBe(201);
    const D = "nodes/channels/design";
    const t1 = await open(alice, D, "Design decision: we use 8px spacing.");
    const t2 = await open(alice, D, "Fact: the palette has 5 colours.");
    const t3 = await open(alice, D, "Nothing here yet.");
    const p = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t1.id}/promote`, { kind: "decision", title: "Use 8px spacing" }, alice.apiKey);
    expect(p.status).toBe(201);
    const m = await remember(alice, t2.id, { message_id: t2.comments[0].id, kind: "fact", title: "Palette has 5 colours" });
    expect(m.status).toBe(201);
    const doc = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Design Tokens", content: "# Tokens\n\nSpacing 4px." }, owner.apiKey);
    expect(doc.status).toBe(201);
    await publish(doc.data.node.id);
    const c = await correct(alice, t3.id, { message_id: t3.comments[0].id, node_id: doc.data.node.id, replacement: "# Tokens\n\nSpacing 8px." });
    expect(c.status, JSON.stringify(c.data)).toBe(201);

    const k = await jsonRequest(app, "GET", `/nests/${nestId}/channels/design/knowledge`, undefined, reader.apiKey);
    expect(k.status, JSON.stringify(k.data)).toBe(200);
    expect(k.data.channel.name).toBe("design");
    const byId = Object.fromEntries(k.data.nodes.map((n: any) => [n.node_id, n]));
    // Promote keeps its existing rule: a draft on a governed nest, not yet submitted.
    expect(byId[p.data.node.id]).toMatchObject({ kind: "promoted", status: "draft", thread_id: t1.id, by: alice.email, title: "Use 8px spacing" });
    expect(byId[m.data.node.id]).toMatchObject({ kind: "remembered", status: "pending_review", thread_id: t2.id, memory_kind: "fact" });
    expect(byId[doc.data.node.id]).toMatchObject({ kind: "corrected", status: "pending_review", thread_id: t3.id });
    for (const n of k.data.nodes) {
      expect(typeof n.at).toBe("string");
      expect(n.url).toContain(encodeURIComponent(n.node_id));
      expect(n.proposer).toBeTruthy();
    }
    expect(k.data.open_proposals.map((o: any) => o.node_id).sort()).toEqual([m.data.node.id, doc.data.node.id].sort());
    expect(k.data.open_proposals[0]).toMatchObject({ requested_by: alice.email });
    expect(k.data.counts).toMatchObject({ total: 3, pending_review: 2, draft: 1 });

    // Approve the remembered fact: its status moves on.
    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${m.data.node.id}/approve`, { note: "yes" }, sam.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const k2 = await jsonRequest(app, "GET", `/nests/${nestId}/channels/design/knowledge`, undefined, alice.apiKey);
    expect(k2.data.nodes.find((n: any) => n.node_id === m.data.node.id).status).toMatch(/^(approved|published)$/);
    expect(k2.data.open_proposals).toHaveLength(1);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, alice.apiKey);
    expect(list.data.channels.find((c: any) => c.name === "design").knowledge_count).toBe(3);

    const mcp = await callTool(reader.apiKey, "context_channel_knowledge", { channel: "#design" });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.nodes).toHaveLength(3);
    expect(mcp.text).toContain("Use 8px spacing");
    expect(await listToolNames(reader.apiKey)).toContain("context_channel_knowledge");

    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/design/knowledge`, undefined, outsider.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/nope/knowledge`, undefined, alice.apiKey)).status).toBe(404);
  });
});

// ─── AC-C6-12 ───────────────────────────────────────────────────────────

describe("AC-C6-12: the decision ledger", () => {
  it("lists promoted and remembered decisions newest first with source thread, who and when; non-members get 404", async () => {
    const t1 = await open(alice, OPS, "Decision one: Postgres in prod.");
    const p = await jsonRequest(app, "POST", `/nests/${nestId}/threads/${t1.id}/promote`, { kind: "decision", title: "Postgres in prod" }, alice.apiKey);
    expect(p.status).toBe(201);
    const t2 = await open(owner, OPS, "Decision two: no Friday deploys.");
    const m = await remember(owner, t2.id, { kind: "decision", title: "No Friday deploys" });
    expect(m.status, JSON.stringify(m.data)).toBe(201);
    const t3 = await open(alice, OPS, "Just a note, not a decision.");
    const n = await remember(alice, t3.id, { kind: "note", title: "Not a decision" });
    expect(n.status).toBe(201);

    const r = await jsonRequest(app, "GET", `/nests/${nestId}/decisions`, undefined, alice.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const ids = r.data.decisions.map((d: any) => d.node_id);
    expect(ids.indexOf(m.data.node.id)).toBeLessThan(ids.indexOf(p.data.node.id));
    expect(ids).not.toContain(n.data.node.id);
    const two = r.data.decisions.find((d: any) => d.node_id === m.data.node.id);
    expect(two).toMatchObject({
      title: "No Friday deploys",
      decided_by: owner.email,
      decided_by_name: "Owner",
      source_thread: { node_id: OPS, thread_id: t2.id, channel: "ops" },
      kind: "remembered",
    });
    expect(typeof two.decided_at).toBe("string");
    expect(two.status).toBeTruthy();
    expect(r.data.pagination.total).toBeGreaterThanOrEqual(2);

    const mcp = await callTool(alice.apiKey, "context_decisions", { limit: 5 });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(mcp.data.decisions.map((d: any) => d.node_id)).toContain(m.data.node.id);
    expect(mcp.text).toContain("No Friday deploys");
    expect(await listToolNames(reader.apiKey)).toContain("context_decisions");

    expect((await jsonRequest(app, "GET", `/nests/${nestId}/decisions`, undefined, outsider.apiKey)).status).toBe(404);
  });
});

// ─── Security review (SEC-*) ────────────────────────────────────────────

describe("SEC-C6-02: a thread id from another nest is not found on either nest", () => {
  it("remember and correct answer 404 across nests; a message id from another thread is 404", async () => {
    const t = await open(alice, OPS, "Team thread");
    const side = await open(alice, OPS, "Side thread", {}, sideNestId);
    expect((await remember(alice, t.id, { kind: "note" }, sideNestId)).status).toBe(404);
    expect((await remember(alice, side.id, { kind: "note" }, nestId)).status).toBe(404);
    expect((await correct(alice, side.id, { message_id: side.comments[0].id, node_id: planId }, nestId)).status).toBe(404);
    expect((await remember(alice, t.id, { message_id: side.comments[0].id, kind: "note" })).status).toBe(404);
    const mcp = await callTool(alice.apiKey, "context_remember", { thread: side.id, kind: "note" });
    expect(mcp.isError).toBe(true);
  });
});

describe("SEC-C6-05: a correction never folds in someone else's unsaved draft", () => {
  it("refuses with 409 while another person has an unsealed draft on the node, and again when the head moved", async () => {
    const doc = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Release Checklist", content: "# Checklist\n\nRun the smoke tests." }, owner.apiKey);
    expect(doc.status, JSON.stringify(doc.data)).toBe(201);
    const id: string = doc.data.node.id;
    await publish(id);
    // The owner starts an edit (a draft on a governed nest, not submitted).
    const draft = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "# Checklist\n\nRun the smoke tests.\n\nOwner's unsaved thought." }, owner.apiKey);
    expect(draft.status, JSON.stringify(draft.data)).toBe(200);
    const t = await open(alice, OPS, "The checklist also needs the rollback step.");
    const r = await correct(alice, t.id, { message_id: t.comments[0].id, node_id: id });
    expect(r.status, JSON.stringify(r.data)).toBe(409);
    expect(r.data.error).toMatch(/draft someone else/i);
    const after = await readNode(owner, id);
    expect(after.node.content ?? after.node.body).not.toContain("Correction from");
    expect((await queue(sam)).some((q) => q.nodeId === id)).toBe(false);
  });
});

describe("SEC-C6-03: with EXPERIMENTAL_AGENT_STREAM off the channel parts are not found", () => {
  it("knowledge and watch routes and tools are gone; remember still works on a document thread like promote", async () => {
    process.env.EXPERIMENTAL_AGENT_STREAM = "false";
    try {
      expect((await jsonRequest(app, "GET", `/nests/${nestId}/channels/ops/knowledge`, undefined, alice.apiKey)).status).toBe(404);
      expect((await jsonRequest(app, "PUT", `/nests/${nestId}/channels/ops/watch`, { enabled: true, mode: "quiet" }, owner.apiKey)).status).toBe(404);
      const names = await listToolNames(owner.apiKey);
      expect(names).not.toContain("context_channel_knowledge");
      expect(names).not.toContain("context_channel_watch");
      const off = await callTool(owner.apiKey, "context_channel_knowledge", { channel: "ops" });
      expect(off.isError || !!off.rpcError).toBe(true);
      // A document thread is remembered like it is promoted: not behind the switch.
      const t = await open(alice, planId, "Keep this from the document thread.");
      const r = await remember(alice, t.id, { kind: "note", title: "From a document thread" });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      expect(r.data.source_thread.node_id).toBe(planId);
    } finally {
      process.env.EXPERIMENTAL_AGENT_STREAM = "true";
    }
  });
});
