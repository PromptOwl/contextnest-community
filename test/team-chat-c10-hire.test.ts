/**
 * Team chat C10 (PO-1201): hire agents, and recommend them.
 *
 * Every acceptance criterion is a describe block named by its AC id
 * (AC-C10-01..11); SEC-* blocks pin the security review's findings.
 *
 * Hiring creates the thing the server already has — Hootie's per-nest hire
 * row, a metacognition agent, an agent webhook, a nest-scoped agent key —
 * through the existing service; recommendations are rule-based over existing
 * rows and never call a model.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";
import {
  ruleUnansweredQuestions,
  rulePromoteHotspots,
  ruleUnmatchedMentions,
  ruleFailingWebhooks,
  ruleIdleKeys,
  isQuestion,
  QUESTION_SILENCE_MS,
  PROMOTE_WINDOW_MS,
  KEY_IDLE_MS,
} from "../src/hire/rules.js";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const RUNNER = "https://runner.example.com/wake";
const GENERAL = "nodes/channels/general";
const OPS = "nodes/channels/ops";

type User = { apiKey: string; userId: string; email: string; cookie: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let db: any;
let owner: User;
let admin: User;
let writer: User;
let reader: User;
let bob: User; // reaches Team only through a share on one document
let stranger: User;
let nestId: string;
let sideNestId: string;

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
  const { body } = await rpc(`/nests/${nest}/mcp`, "tools/call", { name, arguments: args }, apiKey);
  return {
    text: String(body?.result?.content?.[0]?.text ?? ""),
    data: body?.result?.structuredContent,
    isError: body?.result?.isError === true,
    rpcError: body?.error as { message: string } | undefined,
  };
}

async function listTools(apiKey: string, nest = nestId): Promise<string[]> {
  const { body } = await rpc(`/nests/${nest}/mcp`, "tools/list", {}, apiKey);
  return (body?.result?.tools ?? []).map((t: any) => t.name);
}

async function open(u: User, node: string, body: string, nest = nestId) {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/nodes/${node}/annotations`, { body }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.thread as { id: string };
}

const hire = (u: User, body: Record<string, unknown>, nest = nestId) => jsonRequest(app, "POST", `/nests/${nest}/hire`, body, u.apiKey);
const hired = (u: User, nest = nestId) => jsonRequest(app, "GET", `/nests/${nest}/hire`, undefined, u.apiKey);
const catalog = (u: User, nest = nestId) => jsonRequest(app, "GET", `/nests/${nest}/hire/catalog`, undefined, u.apiKey);
const letGo = (u: User, kind: string, handle: string, nest = nestId) =>
  jsonRequest(app, "DELETE", `/nests/${nest}/hire/${kind}/${handle}`, undefined, u.apiKey);
const recs = async (u: User, nest = nestId) => {
  const r = await jsonRequest(app, "GET", `/nests/${nest}/agents/recommendations`, undefined, u.apiKey);
  return { status: r.status, list: (r.data?.recommendations ?? []) as any[], data: r.data };
};
const dismiss = (u: User, id: string, nest = nestId) =>
  jsonRequest(app, "POST", `/nests/${nest}/agents/recommendations/${encodeURIComponent(id)}/dismiss`, {}, u.apiKey);

/** "YYYY-MM-DD HH:MM:SS" — the format datetime('now') writes. */
const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

async function backdateThread(threadId: string, ms: number) {
  const at = sqlTime(Date.now() - ms);
  await db.run("UPDATE annotation_threads SET created_at = ? WHERE id = ?", [at, threadId]);
  await db.run("UPDATE annotation_comments SET created_at = ? WHERE thread_id = ?", [at, threadId]);
}

async function addChannel(nest: string, name: string, u: User = owner) {
  const r = await jsonRequest(app, "POST", `/nests/${nest}/channels`, { name, purpose: `Purpose of ${name}` }, u.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
}

beforeAll(async () => {
  env = setupTestEnv();
  process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.HOOTIE_ENABLED = "true";
  app = await createTestApp("key", {
    ownerEmail: "olivia@c10.test",
    gateway: { baseUrl: "https://gateway.example.test", key: "gw-test-key" },
  });
  db = (await import("../src/db/client.js")).getDb();
  owner = await registerUser(app, "olivia@c10.test", "Olivia Owner");
  admin = await registerUser(app, "adam@c10.test", "Adam Admin");
  writer = await registerUser(app, "wendy@c10.test", "Wendy Writer");
  await resetAuthRateLimit();
  reader = await registerUser(app, "rita@c10.test", "Rita Reader");
  bob = await registerUser(app, "bob@c10.test", "Bob Builder");
  stranger = await registerUser(app, "stranger@else.test", "Stranger");
  await resetAuthRateLimit();

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Team" }, owner.apiKey)).data.nest.id;
  sideNestId = (await jsonRequest(app, "POST", "/nests", { name: "Side" }, owner.apiKey)).data.nest.id;
  for (const [u, permission] of [
    [admin, "admin"],
    [writer, "write"],
    [reader, "read"],
  ] as const) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  }
  await addChannel(nestId, "general");
  await addChannel(nestId, "ops");
  await addChannel(sideNestId, "general");
  const plan = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Launch Plan", content: "# Plan" }, owner.apiKey);
  expect(plan.status, JSON.stringify(plan.data)).toBe(201);
  const g = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/grants`,
    { target_type: "document", target: "nodes/launch-plan", email: bob.email, role: "write" },
    owner.apiKey,
  );
  expect(g.status, JSON.stringify(g.data)).toBe(201);
});

afterEach(() => {
  process.env.EXPERIMENTAL_AGENT_STREAM = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.HOOTIE_ENABLED = "true";
});

afterAll(async () => {
  delete process.env.EXPERIMENTAL_AGENT_STREAM;
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  delete process.env.HOOTIE_ENABLED;
  await env.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-01 — the catalog
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-01: GET /hire/catalog lists the kinds this server can offer, with availability per caller", () => {
  it("AC-C10-01 every kind carries name, description, channel line, needs, permissions, cost and available", async () => {
    const r = await catalog(owner);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const kinds = r.data.catalog.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["hootie", "watcher", "webhook", "key"]));
    for (const e of r.data.catalog) {
      expect(typeof e.name).toBe("string");
      expect(e.description.length).toBeGreaterThan(20);
      expect(typeof e.in_channel).toBe("string");
      expect(Array.isArray(e.needs)).toBe(true);
      expect(Array.isArray(e.permissions)).toBe(true);
      expect(typeof e.cost).toBe("string");
      expect(typeof e.hire_by).toBe("string");
      expect(Array.isArray(e.config_fields)).toBe(true);
      expect(typeof e.available).toBe("boolean");
      expect(e.available ? e.reason === null : typeof e.reason === "string").toBe(true);
    }
    expect(r.data.catalog.every((e: any) => e.available)).toBe(true);
  });

  it("AC-C10-01 a read collaborator sees the catalog, with each kind unavailable and the reason naming who may hire", async () => {
    const r = await catalog(reader);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.data.catalog.map((e: any) => [e.kind, e]));
    expect(by.hootie.available).toBe(false);
    expect(by.hootie.reason).toMatch(/owner or an admin/i);
    expect(by.watcher.available).toBe(false);
    expect(by.webhook.available).toBe(false);
    expect(by.webhook.reason).toMatch(/owner or an admin/i);
    expect(by.key.available).toBe(false);
    expect(by.key.reason).toMatch(/write/i);
  });

  it("AC-C10-01 a writer may hire a key agent and nothing else", async () => {
    const r = await catalog(writer);
    const by = Object.fromEntries(r.data.catalog.map((e: any) => [e.kind, e]));
    expect(by.key.available).toBe(true);
    expect(by.webhook.available).toBe(false);
    expect(by.hootie.available).toBe(false);
  });

  it("AC-C10-01 Hootie off on the server → unavailable with the reason; metacognition off → the watcher is", async () => {
    process.env.HOOTIE_ENABLED = "false";
    let by = Object.fromEntries((await catalog(owner)).data.catalog.map((e: any) => [e.kind, e]));
    expect(by.hootie.available).toBe(false);
    expect(by.hootie.reason).toMatch(/off/i);
    process.env.HOOTIE_ENABLED = "true";
    process.env.FEATURE_METACOGNITION = "false";
    by = Object.fromEntries((await catalog(owner)).data.catalog.map((e: any) => [e.kind, e]));
    expect(by.watcher.available).toBe(false);
    expect(by.watcher.reason).toMatch(/not enabled|off/i);
  });

  it("AC-C10-01 a stranger and a share-only grantee get 404; with the switch off the routes do not exist", async () => {
    expect((await catalog(stranger)).status).toBe(404);
    expect((await catalog(bob)).status).toBe(404);
    expect((await hired(bob)).status).toBe(404);
    expect((await recs(bob)).status).toBe(404);
    process.env.EXPERIMENTAL_AGENT_STREAM = "false";
    expect((await catalog(owner)).status).toBe(404);
    expect((await hired(owner)).status).toBe(404);
    expect((await recs(owner)).status).toBe(404);
    expect((await hire(owner, { kind: "key", handle: "nope" })).status).toBe(404);
    expect(await listTools(owner.apiKey)).not.toContain("context_hire_catalog");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-02 — hire Hootie
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-02: hiring Hootie records it for the nest through the existing switch and credential", () => {
  it("AC-C10-02 an owner hires Hootie once; a second hire is idempotent", async () => {
    const r = await hire(owner, { kind: "hootie" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.created).toBe(true);
    expect(r.data.hired).toMatchObject({ kind: "hootie", handle: "hootie", hired_by: owner.email, status: "active" });
    expect(typeof r.data.hired.hired_at).toBe("string");
    const again = await hire(owner, { kind: "hootie" });
    expect(again.status).toBe(200);
    expect(again.data.created).toBe(false);
    expect(again.data.hired.hired_by).toBe(owner.email);
  });

  it("AC-C10-02 a writer may not hire Hootie (403); an admin collaborator may", async () => {
    expect((await hire(writer, { kind: "hootie" })).status).toBe(403);
    // Admin is not on Side: the same 404 as a nest that doesn't exist.
    expect((await hire(admin, { kind: "hootie" }, sideNestId)).status).toBe(404);
    expect((await hire(admin, { kind: "webhook", handle: "adm", config: { url: RUNNER } })).status).toBe(201);
  });

  it("AC-C10-02 with Hootie off the hire is refused and a hired Hootie reads as off", async () => {
    process.env.HOOTIE_ENABLED = "false";
    const r = await hire(owner, { kind: "hootie" }, sideNestId);
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/off/i);
    const list = await hired(owner);
    expect(list.data.hired.find((h: any) => h.kind === "hootie").status).toBe("off");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-03 — hire a watcher (metacognition over channels)
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-03: a watcher is a metacognition agent created and configured through the existing service", () => {
  it("AC-C10-03 hiring a watcher for #ops creates the agent document and configures it with scope.read on that channel", async () => {
    const r = await hire(owner, { kind: "watcher", handle: "ops-watcher", channels: ["ops"] });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.hired).toMatchObject({ kind: "watcher", handle: "ops-watcher", status: "active", channels: ["ops"] });
    const agents = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition`, undefined, owner.apiKey);
    expect(agents.status).toBe(200);
    const a = agents.data.agents.find((x: any) => x.node_id === "nodes/agents/ops-watcher");
    expect(a).toBeTruthy();
    expect(a.enabled).toBe(true);
    // inFolders matches by FOLDER (never a single node), so a channel watcher
    // reads the channels folder; which channels it watches is on the hire.
    expect(a.scope.read).toEqual(["channels"]);
    expect(a.scope.propose).toEqual([]);
    const doc = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/agents/ops-watcher`, undefined, owner.apiKey);
    expect(doc.status).toBe(200);
    expect(doc.data.node?.type ?? doc.data.type).toBe("agent");
  });

  it("AC-C10-03 hiring the same watcher again returns it unchanged; a writer gets 403; a bad channel is 404", async () => {
    const again = await hire(owner, { kind: "watcher", handle: "ops-watcher", channels: ["ops"] });
    expect(again.status).toBe(200);
    expect(again.data.created).toBe(false);
    expect((await hire(writer, { kind: "watcher", handle: "w2", channels: ["ops"] })).status).toBe(403);
    expect((await hire(owner, { kind: "watcher", handle: "w3", channels: ["nope"] })).status).toBe(404);
  });

  it("AC-C10-03 letting a watcher go removes the metacognition config and keeps the document", async () => {
    const r = await letGo(owner, "watcher", "ops-watcher");
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const agents = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition`, undefined, owner.apiKey);
    expect(agents.data.agents.some((x: any) => x.node_id === "nodes/agents/ops-watcher")).toBe(false);
    const doc = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/agents/ops-watcher`, undefined, owner.apiKey);
    expect(doc.status).toBe(200);
    expect((await letGo(owner, "watcher", "ops-watcher")).status).toBe(404);
  });

  it("AC-C10-03 with metacognition off the hire is refused", async () => {
    process.env.FEATURE_METACOGNITION = "false";
    const r = await hire(owner, { kind: "watcher", handle: "w4", channels: ["ops"] });
    expect(r.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-04 — hire a webhook agent
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-04: a webhook agent is the existing agent webhook — same fence, secret once", () => {
  it("AC-C10-04 hiring creates the webhook and returns the secret exactly once", async () => {
    const r = await hire(owner, { kind: "webhook", handle: "grok", config: { url: RUNNER } });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.secret).toMatch(/^whsec_/);
    expect(r.data.hired).toMatchObject({ kind: "webhook", handle: "grok", hired_by: owner.email, status: "active" });
    expect(JSON.stringify(r.data)).not.toContain(RUNNER);
    const hooks = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    expect(hooks.data.webhooks.map((w: any) => w.handle)).toContain("grok");
    const again = await hire(owner, { kind: "webhook", handle: "grok", config: { url: RUNNER } });
    expect(again.status).toBe(200);
    expect(again.data.created).toBe(false);
    expect(again.data.secret).toBeUndefined();
  });

  it("AC-C10-04 a private or non-https URL is refused by the shared fence (SSRF); a writer may not hire one", async () => {
    for (const url of ["http://127.0.0.1/wake", "https://10.0.0.5/wake", "https://169.254.169.254/latest", "ftp://runner.example.com/x", ""]) {
      const r = await hire(owner, { kind: "webhook", handle: "evil", config: { url } });
      expect(r.status, url).toBe(400);
    }
    const hooks = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    expect(hooks.data.webhooks.map((w: any) => w.handle)).not.toContain("evil");
    expect((await hire(writer, { kind: "webhook", handle: "w", config: { url: RUNNER } })).status).toBe(403);
  });

  it("AC-C10-04 letting a webhook agent go deletes the webhook", async () => {
    const r = await hire(admin, { kind: "webhook", handle: "temp", config: { url: RUNNER } });
    expect(r.status).toBe(201);
    expect((await letGo(admin, "webhook", "temp")).status).toBe(200);
    const hooks = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    expect(hooks.data.webhooks.map((w: any) => w.handle)).not.toContain("temp");
    expect((await letGo(admin, "webhook", "temp")).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-05 — hire a key agent
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-05: a key agent is a nest-scoped write key labelled with the handle, minted through the existing key service", () => {
  let museKey: string;

  it("AC-C10-05 a writer hires a key agent and gets the key once; it reaches this nest only", async () => {
    const r = await hire(writer, { kind: "key", handle: "muse" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.api_key).toMatch(/^cnst_/);
    expect(r.data.hired).toMatchObject({ kind: "key", handle: "muse", hired_by: writer.email, status: "active" });
    museKey = r.data.api_key;
    const mine = await jsonRequest(app, "GET", "/auth/keys", undefined, writer.apiKey);
    const row = (mine.data.keys ?? mine.data).find((k: any) => k.label === "muse");
    expect(row).toBeTruthy();
    expect(row.nest_id).toBe(nestId);
    expect(row.capability).toBe("write");
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, museKey)).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${sideNestId}`, undefined, museKey)).status).toBe(403);
    const again = await hire(writer, { kind: "key", handle: "muse" });
    expect(again.status).toBe(200);
    expect(again.data.created).toBe(false);
    expect(again.data.api_key).toBeUndefined();
  });

  it("AC-C10-05 a read collaborator may not hire a key agent; a nest-scoped key may not mint another", async () => {
    expect((await hire(reader, { kind: "key", handle: "r" })).status).toBe(403);
    const viaKey = await jsonRequest(app, "POST", `/nests/${nestId}/hire`, { kind: "key", handle: "laundered" }, museKey);
    expect(viaKey.status).toBe(403);
    const list = await hired(owner);
    expect(list.data.hired.map((h: any) => h.handle)).not.toContain("laundered");
  });

  it("AC-C10-05 the hirer or a nest owner/admin lets a key agent go; the key stops working", async () => {
    const d = await hire(writer, { kind: "key", handle: "duet" });
    expect(d.status).toBe(201);
    expect((await letGo(writer, "key", "duet")).status).toBe(200);
    expect((await letGo(owner, "key", "muse")).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, museKey)).status).toBe(401);
    expect((await letGo(owner, "key", "muse")).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-06 — announce
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-06: announce posts one welcome message per channel, authored by the hiring person", () => {
  it("AC-C10-06 'Hired @grok2: …' lands in each named channel as the hirer's own message", async () => {
    const r = await hire(owner, { kind: "webhook", handle: "grok2", config: { url: RUNNER }, channels: ["general", "ops"], announce: true });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.announced).toHaveLength(2);
    expect(r.data.announced.map((a: any) => a.channel).sort()).toEqual(["general", "ops"]);
    const tl = await jsonRequest(app, "GET", `/nests/${nestId}/channels/general`, undefined, owner.apiKey);
    const post = tl.data.posts.find((p: any) => p.body.startsWith("Hired @grok2:"));
    expect(post).toBeTruthy();
    expect(post.author).toBe(owner.email);
    expect(post.actor.agent).toBeNull();
    expect(post.id).toBe(r.data.announced.find((a: any) => a.channel === "general").thread_id);
  });

  it("AC-C10-06 a channel the hirer can't post in refuses the whole hire up front; an unknown channel is 404", async () => {
    const arch = await jsonRequest(app, "POST", `/nests/${nestId}/channels/ops/archive`, { archived: true }, owner.apiKey);
    expect(arch.status).toBe(200);
    const r = await hire(owner, { kind: "webhook", handle: "never", config: { url: RUNNER }, channels: ["ops"], announce: true });
    expect(r.status).toBe(409);
    await jsonRequest(app, "POST", `/nests/${nestId}/channels/ops/archive`, { archived: false }, owner.apiKey);
    const missing = await hire(owner, { kind: "webhook", handle: "never", config: { url: RUNNER }, channels: ["nope"], announce: true });
    expect(missing.status).toBe(404);
    const hooks = await jsonRequest(app, "GET", `/nests/${nestId}/agent-webhooks`, undefined, owner.apiKey);
    expect(hooks.data.webhooks.map((w: any) => w.handle)).not.toContain("never");
  });

  it("AC-C10-06 without announce nothing is posted", async () => {
    const before = (await jsonRequest(app, "GET", `/nests/${nestId}/channels/general`, undefined, owner.apiKey)).data.posts.length;
    const r = await hire(owner, { kind: "webhook", handle: "quiet", config: { url: RUNNER }, channels: ["general"] });
    expect(r.status).toBe(201);
    expect(r.data.announced).toEqual([]);
    const after = (await jsonRequest(app, "GET", `/nests/${nestId}/channels/general`, undefined, owner.apiKey)).data.posts.length;
    expect(after).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-07 — the hired list
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-07: GET /hire lists hired agents with who, when and a status", () => {
  it("AC-C10-07 a read collaborator sees the list; every row carries kind, handle, hired_by, hired_at, status", async () => {
    const r = await hired(reader);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const handles = r.data.hired.map((h: any) => `${h.kind}:${h.handle}`);
    expect(handles).toEqual(expect.arrayContaining(["hootie:hootie", "webhook:grok", "webhook:grok2", "webhook:quiet"]));
    for (const h of r.data.hired) {
      expect(["hootie", "watcher", "webhook", "key"]).toContain(h.kind);
      expect(typeof h.handle).toBe("string");
      expect(typeof h.hired_by).toBe("string");
      expect(typeof h.hired_at).toBe("string");
      expect(["active", "failing", "no_key", "off"]).toContain(h.status);
    }
    expect(JSON.stringify(r.data)).not.toContain(RUNNER);
  });

  it("AC-C10-07 a webhook whose recent deliveries failed reads as failing", async () => {
    for (let i = 0; i < 3; i++) {
      await db.run(
        `INSERT INTO agent_wake_deliveries (idempotency_key, nest_id, handle, node_id, thread_id, comment_id, status, error, created_at, attempts, finished_at, event)
         VALUES (?, ?, 'grok', ?, 't', 'c', 'failed', 'responded 503', ?, 3, ?, 'agent.mention')`,
        [`k-grok-${i}`, nestId, GENERAL, new Date(Date.now() - (3 - i) * 1000).toISOString(), new Date().toISOString()],
      );
    }
    const r = await hired(owner);
    expect(r.data.hired.find((h: any) => h.handle === "grok").status).toBe("failing");
    expect(r.data.hired.find((h: any) => h.handle === "grok").detail).toMatch(/failed/i);
    expect(r.data.hired.find((h: any) => h.handle === "grok2").status).toBe("active");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-08 — the rules are pure functions
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-08: each recommendation rule is a pure function", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const N = "nest-1";

  it("AC-C10-08 isQuestion: a question mark outside a code span", () => {
    expect(isQuestion("Is the deploy done?")).toBe(true);
    expect(isQuestion("who owns this? thanks")).toBe(true);
    expect(isQuestion("Done.")).toBe(false);
    expect(isQuestion("`a ? b : c` ternary")).toBe(false);
    expect(isQuestion("")).toBe(false);
  });

  it("AC-C10-08 unanswered questions for 24 h and no Hootie → hire Hootie, with evidence per thread", () => {
    const threads = [
      { thread_id: "t1", channel: "ops", body: "Is the deploy done?", created_at: ago(QUESTION_SILENCE_MS + 60_000), replies: 0, status: "open" },
      { thread_id: "t2", channel: "general", body: "Who owns pricing?", created_at: ago(QUESTION_SILENCE_MS * 2), replies: 0, status: "open" },
      { thread_id: "t3", channel: "ops", body: "Answered?", created_at: ago(QUESTION_SILENCE_MS * 2), replies: 1, status: "open" },
      { thread_id: "t4", channel: "ops", body: "Fresh?", created_at: ago(60_000), replies: 0, status: "open" },
      { thread_id: "t5", channel: "ops", body: "Resolved?", created_at: ago(QUESTION_SILENCE_MS * 2), replies: 0, status: "resolved" },
      { thread_id: "t6", channel: "ops", body: "Not a question", created_at: ago(QUESTION_SILENCE_MS * 2), replies: 0, status: "open" },
    ];
    const rec = ruleUnansweredQuestions(threads, { now, nestId: N, hootieHired: false });
    expect(rec).toBeTruthy();
    expect(rec!.id).toBe("hootie:unanswered");
    expect(rec!.action).toBe("hire");
    expect(rec!.hire).toEqual({ kind: "hootie" });
    expect(rec!.evidence.map((e) => e.link)).toEqual([
      `/nest/${N}/channels?channel=ops&thread=t1`,
      `/nest/${N}/channels?channel=general&thread=t2`,
    ]);
    expect(rec!.channels.sort()).toEqual(["general", "ops"]);
    expect(rec!.reason).toMatch(/2 questions/);
    expect(ruleUnansweredQuestions(threads, { now, nestId: N, hootieHired: true })).toBeNull();
    expect(ruleUnansweredQuestions([], { now, nestId: N, hootieHired: false })).toBeNull();
  });

  it("AC-C10-08 ≥3 promotes in a channel in 7 days and no watcher → hire a watcher there", () => {
    const promotes = [
      { channel: "ops", at: ago(1000), node_id: "nodes/decisions/a", title: "A" },
      { channel: "ops", at: ago(2000), node_id: "nodes/decisions/b", title: "B" },
      { channel: "ops", at: ago(3000), node_id: "nodes/tasks/c", title: "C" },
      { channel: "ops", at: ago(PROMOTE_WINDOW_MS + 1000), node_id: "nodes/decisions/old", title: "Old" },
      { channel: "general", at: ago(1000), node_id: "nodes/decisions/d", title: "D" },
      { channel: "general", at: ago(1000), node_id: "nodes/decisions/e", title: "E" },
      { channel: "sales", at: ago(1000), node_id: "nodes/decisions/f", title: "F" },
      { channel: "sales", at: ago(1000), node_id: "nodes/decisions/g", title: "G" },
      { channel: "sales", at: ago(1000), node_id: "nodes/decisions/h", title: "H" },
    ];
    const out = rulePromoteHotspots(promotes, { now, nestId: N, watched: (c) => c === "sales" });
    expect(out.map((r) => r.id)).toEqual(["watcher:ops"]);
    expect(out[0].hire).toEqual({ kind: "watcher", handle: "ops-watcher", channels: ["ops"] });
    expect(out[0].handle_suggestion).toBe("ops-watcher");
    expect(out[0].evidence).toHaveLength(3);
    expect(out[0].evidence[0].link).toBe(`/nest/${N}?doc=nodes%2Fdecisions%2Fa`);
    expect(out[0].channels).toEqual(["ops"]);
  });

  it("AC-C10-08 ≥3 mentions of a handle that matched nobody → hire an agent with that handle (key, or a webhook)", () => {
    const mentions = [
      { handle: "nobody", channel: "general", thread_id: "t1", at: ago(1000) },
      { handle: "nobody", channel: "general", thread_id: "t2", at: ago(2000) },
      { handle: "nobody", channel: "ops", thread_id: "t3", at: ago(3000) },
      { handle: "twice", channel: "ops", thread_id: "t4", at: ago(1000) },
      { handle: "twice", channel: "ops", thread_id: "t5", at: ago(1000) },
      { handle: "grok", channel: "ops", thread_id: "t6", at: ago(1000) },
      { handle: "grok", channel: "ops", thread_id: "t7", at: ago(1000) },
      { handle: "grok", channel: "ops", thread_id: "t8", at: ago(1000) },
    ];
    const out = ruleUnmatchedMentions(mentions, { nestId: N, known: new Set(["grok"]) });
    expect(out.map((r) => r.id)).toEqual(["mention:nobody"]);
    expect(out[0].handle_suggestion).toBe("nobody");
    expect(out[0].hire).toEqual({ kind: "key", handle: "nobody" });
    expect(out[0].reason).toMatch(/3 times/);
    expect(out[0].reason).toMatch(/webhook/i);
    expect(out[0].channels.sort()).toEqual(["general", "ops"]);
    expect(out[0].evidence.length).toBeLessThanOrEqual(3);
  });

  it("AC-C10-08 a webhook whose last 3 deliveries failed → fix or replace, not a hire", () => {
    const out = ruleFailingWebhooks(
      [
        { handle: "flaky", recent: ["failed", "failed", "failed"] },
        { handle: "ok", recent: ["ok", "failed", "failed"] },
        { handle: "new", recent: [] },
        { handle: "once", recent: ["failed"] },
        { handle: "mixed", recent: ["failed", "ok", "failed"] },
      ],
      { nestId: N },
    );
    expect(out.map((r) => r.id)).toEqual(["webhook-fix:flaky", "webhook-fix:once"]);
    expect(out[0].action).toBe("fix");
    expect(out[0].hire).toBeNull();
    expect(out[0].evidence[0].link).toBe(`/nest/${N}/settings/agent-webhooks`);
  });

  it("AC-C10-08 a key agent silent for 30 days → let go?", () => {
    const out = ruleIdleKeys(
      [
        { handle: "oldie", created_at: ago(KEY_IDLE_MS * 3), last_used_at: ago(KEY_IDLE_MS + 1000) },
        { handle: "never", created_at: ago(KEY_IDLE_MS + 1000), last_used_at: null },
        { handle: "fresh", created_at: ago(1000), last_used_at: null },
        { handle: "busy", created_at: ago(KEY_IDLE_MS * 3), last_used_at: ago(1000) },
        { handle: "sqlfmt", created_at: "2026-01-01 00:00:00", last_used_at: "2026-09-01 10:00:00" },
      ],
      { now, nestId: N },
    );
    expect(out.map((r) => r.id)).toEqual(["key-idle:oldie", "key-idle:never", "key-idle:sqlfmt"]);
    expect(out[0].action).toBe("let_go");
    expect(out[0].let_go).toEqual({ kind: "key", handle: "oldie" });
    expect(out[0].hire).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-09 — recommendations over real data, per person
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-09: GET /agents/recommendations computes up to 5 from existing data, dismissible per person", () => {
  let recNest: string;

  beforeAll(async () => {
    recNest = (await jsonRequest(app, "POST", "/nests", { name: "Rec" }, owner.apiKey)).data.nest.id;
    for (const [u, permission] of [
      [writer, "write"],
      [reader, "read"],
    ] as const) {
      await jsonRequest(app, "POST", `/nests/${recNest}/collaborators`, { email: u.email, permission }, owner.apiKey);
    }
    await addChannel(recNest, "general");
    await addChannel(recNest, "ops");
    await addChannel(recNest, "quiet");
  });

  it("AC-C10-09 three mentions of @nobody → hire a key agent named nobody, with evidence in the channels where it was said", async () => {
    await open(writer, GENERAL, "@nobody can you summarise this?", recNest);
    await open(writer, GENERAL, "@nobody ping", recNest);
    await open(owner, OPS, "@nobody again", recNest);
    const { status, list } = await recs(writer, recNest);
    expect(status).toBe(200);
    const rec = list.find((r) => r.id === "mention:nobody");
    expect(rec).toBeTruthy();
    expect(rec).toMatchObject({ action: "hire", kind: "key", handle_suggestion: "nobody", dismissible: true });
    expect(rec.hire).toEqual({ kind: "key", handle: "nobody" });
    expect(rec.channels.sort()).toEqual(["general", "ops"]);
    expect(rec.evidence.length).toBeGreaterThan(0);
    expect(rec.evidence[0].link).toContain(`/nest/${recNest}/channels?channel=`);
    expect(typeof rec.title).toBe("string");
    expect(typeof rec.reason).toBe("string");
  });

  it("AC-C10-09 a question unanswered for 24 h → hire Hootie; hiring Hootie retires it", async () => {
    const t = await open(writer, OPS, "Is the deploy done?", recNest);
    await backdateThread(t.id, QUESTION_SILENCE_MS + 60_000);
    const before = (await recs(owner, recNest)).list.find((r) => r.id === "hootie:unanswered");
    expect(before).toBeTruthy();
    expect(before.hire).toEqual({ kind: "hootie" });
    expect(before.evidence[0].link).toBe(`/nest/${recNest}/channels?channel=ops&thread=${t.id}`);
    expect((await hire(owner, { kind: "hootie" }, recNest)).status).toBe(201);
    expect((await recs(owner, recNest)).list.find((r) => r.id === "hootie:unanswered")).toBeUndefined();
  });

  it("AC-C10-09 three promotes from #ops in a week → hire a watcher there; hiring it retires the recommendation", async () => {
    for (const title of ["Ship on Friday", "Freeze the API", "Rotate the keys"]) {
      const t = await open(owner, OPS, `${title} — agreed`, recNest);
      const p = await jsonRequest(app, "POST", `/nests/${recNest}/threads/${t.id}/promote`, { kind: "decision", title }, owner.apiKey);
      expect(p.status, JSON.stringify(p.data)).toBe(201);
    }
    const rec = (await recs(writer, recNest)).list.find((r) => r.id === "watcher:ops");
    expect(rec).toBeTruthy();
    expect(rec.hire).toEqual({ kind: "watcher", handle: "ops-watcher", channels: ["ops"] });
    expect(rec.evidence.map((e: any) => e.label)).toEqual(expect.arrayContaining(["Ship on Friday"]));
    expect((await hire(owner, rec.hire, recNest)).status).toBe(201);
    expect((await recs(writer, recNest)).list.find((r) => r.id === "watcher:ops")).toBeUndefined();
  });

  it("AC-C10-09 a failing webhook and an idle key are nudges for those who can act on them", async () => {
    expect((await hire(owner, { kind: "webhook", handle: "flaky", config: { url: RUNNER } }, recNest)).status).toBe(201);
    for (let i = 0; i < 3; i++) {
      await db.run(
        `INSERT INTO agent_wake_deliveries (idempotency_key, nest_id, handle, node_id, thread_id, comment_id, status, error, created_at, attempts, finished_at, event)
         VALUES (?, ?, 'flaky', ?, 't', 'c', 'failed', 'timed out', ?, 3, ?, 'agent.mention')`,
        [`k-flaky-${i}`, recNest, OPS, new Date(Date.now() - (3 - i) * 1000).toISOString(), new Date().toISOString()],
      );
    }
    expect((await hire(owner, { kind: "key", handle: "oldie" }, recNest)).status).toBe(201);
    await db.run("UPDATE api_keys SET last_used_at = ? WHERE nest_id = ? AND label = 'oldie'", [sqlTime(Date.now() - KEY_IDLE_MS - 1000), recNest]);
    const forOwner = (await recs(owner, recNest)).list;
    const fix = forOwner.find((r) => r.id === "webhook-fix:flaky");
    expect(fix).toBeTruthy();
    expect(fix).toMatchObject({ action: "fix", kind: "webhook", hire: null });
    const idle = forOwner.find((r) => r.id === "key-idle:oldie");
    expect(idle).toBeTruthy();
    expect(idle).toMatchObject({ action: "let_go", kind: "key", let_go: { kind: "key", handle: "oldie" } });
    const forWriter = (await recs(writer, recNest)).list.map((r) => r.id);
    expect(forWriter).not.toContain("webhook-fix:flaky");
    expect(forWriter).not.toContain("key-idle:oldie");
  });

  it("AC-C10-09 dismiss hides a recommendation for that person only; a read collaborator may dismiss; a bad id is 400", async () => {
    expect((await dismiss(writer, "mention:nobody", recNest)).status).toBe(200);
    expect((await recs(writer, recNest)).list.map((r) => r.id)).not.toContain("mention:nobody");
    expect((await recs(owner, recNest)).list.map((r) => r.id)).toContain("mention:nobody");
    expect((await dismiss(reader, "mention:nobody", recNest)).status).toBe(200);
    expect((await recs(reader, recNest)).list.map((r) => r.id)).not.toContain("mention:nobody");
    expect((await dismiss(owner, "not a rec", recNest)).status).toBe(400);
    expect((await dismiss(stranger, "mention:nobody", recNest)).status).toBe(404);
  });

  it("AC-C10-09 never more than 5", async () => {
    for (const h of ["one", "two", "three", "four", "five", "six"]) {
      for (let i = 0; i < 3; i++) await open(owner, GENERAL, `@${h} hello ${i}`, recNest);
    }
    const { list } = await recs(owner, recNest);
    expect(list.length).toBeLessThanOrEqual(5);
    expect(list.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-10 — MCP parity
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-10: the four MCP tools return the REST objects under the REST gates", () => {
  let readKey: string;

  beforeAll(async () => {
    const r = await jsonRequest(app, "POST", "/auth/keys", { label: "ro-c10", nest_id: nestId, capability: "read" }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    readKey = r.data.api_key;
  });

  it("AC-C10-10 tools/list offers them while the switch is on", async () => {
    const names = await listTools(owner.apiKey);
    expect(names).toEqual(expect.arrayContaining(["context_hire_catalog", "context_hire_agent", "context_hired_agents", "context_agent_recommendations"]));
  });

  it("AC-C10-10 context_hire_catalog and context_hired_agents equal the REST bodies", async () => {
    const cat = await callTool(owner.apiKey, "context_hire_catalog", {});
    expect(cat.isError, cat.text).toBe(false);
    expect(cat.data.catalog.map((e: any) => [e.kind, e.available])).toEqual((await catalog(owner)).data.catalog.map((e: any) => [e.kind, e.available]));
    expect(cat.text).toMatch(/hootie/i);
    const list = await callTool(owner.apiKey, "context_hired_agents", {});
    expect(list.isError, list.text).toBe(false);
    expect(list.data.hired.map((h: any) => h.handle)).toEqual((await hired(owner)).data.hired.map((h: any) => h.handle));
  });

  it("AC-C10-10 context_hire_agent hires (secret once) and lets go", async () => {
    const r = await callTool(owner.apiKey, "context_hire_agent", { kind: "webhook", handle: "mcpbot", config: { url: RUNNER }, channels: ["general"], announce: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.secret).toMatch(/^whsec_/);
    expect(r.data.hired.handle).toBe("mcpbot");
    expect(r.data.announced).toHaveLength(1);
    expect(r.text).toContain("whsec_");
    const again = await callTool(owner.apiKey, "context_hire_agent", { kind: "webhook", handle: "mcpbot", config: { url: RUNNER } });
    expect(again.data.created).toBe(false);
    expect(again.data.secret).toBeUndefined();
    const w = await callTool(writer.apiKey, "context_hire_agent", { kind: "webhook", handle: "w", config: { url: RUNNER } });
    expect(w.isError).toBe(true);
    const gone = await callTool(owner.apiKey, "context_hire_agent", { action: "let_go", kind: "webhook", handle: "mcpbot" });
    expect(gone.isError, gone.text).toBe(false);
    expect(gone.data.deleted).toBe(true);
    expect((await hired(owner)).data.hired.map((h: any) => h.handle)).not.toContain("mcpbot");
  });

  it("AC-C10-10 context_agent_recommendations lists and dismisses like REST", async () => {
    for (let i = 0; i < 3; i++) await open(writer, GENERAL, `@mcpghost hi ${i}`);
    const l = await callTool(writer.apiKey, "context_agent_recommendations", {});
    expect(l.isError, l.text).toBe(false);
    expect(l.data.recommendations.map((r: any) => r.id)).toContain("mention:mcpghost");
    expect(l.text).toContain("mcpghost");
    const d = await callTool(writer.apiKey, "context_agent_recommendations", { action: "dismiss", id: "mention:mcpghost" });
    expect(d.isError, d.text).toBe(false);
    expect((await recs(writer)).list.map((r) => r.id)).not.toContain("mention:mcpghost");
  });

  it("AC-C10-10 a read-only key reads the catalog, the hired list and the recommendations, and can neither hire, let go nor dismiss", async () => {
    expect((await callTool(readKey, "context_hire_catalog", {})).isError).toBe(false);
    expect((await callTool(readKey, "context_hired_agents", {})).isError).toBe(false);
    expect((await callTool(readKey, "context_agent_recommendations", {})).isError).toBe(false);
    const d = await callTool(readKey, "context_agent_recommendations", { action: "dismiss", id: "mention:mcpghost" });
    expect(d.isError).toBe(true);
    expect(d.text).toMatch(/read-only/i);
    const h = await callTool(readKey, "context_hire_agent", { kind: "key", handle: "x" });
    expect(h.isError || !!h.rpcError).toBe(true);
    expect(`${h.text}${h.rpcError?.message ?? ""}`).toMatch(/read-only/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C10-11 — the channel list badge
// ═══════════════════════════════════════════════════════════════════════════

describe("AC-C10-11: the channel list carries recommendations_count for members", () => {
  it("AC-C10-11 a channel with open recommendations counts them; one without reads 0", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/channels`, undefined, owner.apiKey);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.data.channels.map((c: any) => [c.name, c]));
    expect(typeof by.general.recommendations_count).toBe("number");
    expect(by.general.recommendations_count).toBeGreaterThan(0); // @mcpghost ×3 in #general, not dismissed by the owner
    const fresh = (await jsonRequest(app, "GET", `/nests/${sideNestId}/channels`, undefined, owner.apiKey)).data.channels;
    expect(fresh.find((c: any) => c.name === "general").recommendations_count).toBe(0);
  });

  it("AC-C10-11 the MCP channel list carries it too", async () => {
    const r = await callTool(owner.apiKey, "context_channels", {});
    expect(r.data.channels.find((c: any) => c.name === "general").recommendations_count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEC — the security review's findings
// ═══════════════════════════════════════════════════════════════════════════

describe("SEC-C10: hire is never a way up, inputs are validated, and nothing leaks", () => {
  it("SEC-C10-01 an unknown kind, a bad handle and a non-object body are 400", async () => {
    expect((await hire(owner, { kind: "overlord" })).status).toBe(400);
    expect((await hire(owner, { kind: "webhook", handle: "Bad Handle!", config: { url: RUNNER } })).status).toBe(400);
    expect((await hire(owner, { kind: "key", handle: "@x y" })).status).toBe(400);
    const raw = await app.request(`/nests/${nestId}/hire`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.apiKey}`, "Content-Type": "application/json" },
      body: "[1]",
    });
    expect(raw.status).toBe(400);
    expect((await letGo(owner, "overlord", "x")).status).toBe(400);
  });

  it("SEC-C10-02 letting go follows the underlying gate: a writer can't drop a webhook or a watcher, nor another person's key", async () => {
    expect((await hire(owner, { kind: "key", handle: "owners-bot" })).status).toBe(201);
    expect((await letGo(writer, "webhook", "grok")).status).toBe(403);
    expect((await letGo(writer, "key", "owners-bot")).status).toBe(403);
    expect((await letGo(reader, "key", "owners-bot")).status).toBe(403);
    expect((await hired(owner)).data.hired.map((h: any) => h.handle)).toEqual(expect.arrayContaining(["grok", "owners-bot"]));
  });

  it("SEC-C10-03 recommendations for a nest the caller is not on are 404, and a dismissal there is too", async () => {
    expect((await recs(writer, sideNestId)).status).toBe(404);
    expect((await dismiss(writer, "mention:nobody", sideNestId)).status).toBe(404);
  });

  it("SEC-C10-05 a member who is not owner/admin gets no delivery outcomes: a failing webhook reads active with no detail", async () => {
    const r = await hired(reader);
    const grok = r.data.hired.find((h: any) => h.handle === "grok");
    expect(grok.status).toBe("active");
    expect(grok.detail).toBeNull();
    expect((await hired(writer)).data.hired.find((h: any) => h.handle === "grok").status).toBe("active");
    expect((await hired(admin)).data.hired.find((h: any) => h.handle === "grok").status).toBe("failing");
  });

  it("SEC-C10-06 a key agent is one that was hired, never a personal key inferred from its label", async () => {
    const k = await jsonRequest(app, "POST", "/auth/keys", { label: "ci", nest_id: nestId }, writer.apiKey);
    expect(k.status).toBe(201);
    expect((await hired(owner)).data.hired.map((h: any) => `${h.kind}:${h.handle}`)).not.toContain("key:ci");
    expect((await letGo(owner, "key", "ci")).status).toBe(404);
    await db.run("UPDATE api_keys SET last_used_at = ? WHERE nest_id = ? AND label = 'ci'", [sqlTime(Date.now() - KEY_IDLE_MS - 1000), nestId]);
    expect((await recs(owner)).list.map((r) => r.id)).not.toContain("key-idle:ci");
    // writer's own personal key still works and is still theirs to revoke
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, k.data.api_key)).status).toBe(200);
    expect((await jsonRequest(app, "DELETE", `/auth/keys/${k.data.id}`, undefined, writer.apiKey)).status).toBe(200);
  });

  it("SEC-C10-06 an admin can't let go a key agent the nest owner hired; the owner can", async () => {
    expect((await hire(owner, { kind: "key", handle: "owners-pet" })).status).toBe(201);
    expect((await letGo(admin, "key", "owners-pet")).status).toBe(403);
    expect((await letGo(owner, "key", "owners-pet")).status).toBe(200);
    // …and letting go revokes the key itself, not only the hire
    const r = await hire(owner, { kind: "key", handle: "owners-pet2" });
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, r.data.api_key)).status).toBe(200);
    expect((await letGo(owner, "key", "owners-pet2")).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, r.data.api_key)).status).toBe(401);
  });

  it("SEC-C10-07 promote evidence is bounded by the same rule as the node list: every evidence node is one the caller can list", async () => {
    const sam = await registerUser(app, "sam@c10.test", "Sam Steward");
    await resetAuthRateLimit();
    const gov = (await jsonRequest(app, "POST", "/nests", { name: "Gov" }, owner.apiKey)).data.nest.id;
    await addChannel(gov, "ops");
    const st = await jsonRequest(app, "PATCH", `/nests/${gov}/settings`, { stewardship_enabled: true }, owner.apiKey);
    expect(st.status, JSON.stringify(st.data)).toBe(200);
    const sw = await jsonRequest(
      app,
      "POST",
      `/nests/${gov}/stewards`,
      { scope: "document", email: sam.email, role: "viewer", nodePattern: OPS },
      owner.apiKey,
    );
    expect(sw.status, JSON.stringify(sw.data)).toBeLessThan(300);
    for (const title of ["Secret Plan A", "Secret Plan B", "Secret Plan C"]) {
      const t = await open(owner, OPS, `${title} — agreed`, gov);
      const p = await jsonRequest(app, "POST", `/nests/${gov}/threads/${t.id}/promote`, { kind: "decision", title }, owner.apiKey);
      expect(p.status, JSON.stringify(p.data)).toBe(201);
    }
    // The promoted nodes go through filterAccessible — the node list's own
    // gate — before they count or are named. For every caller, what the
    // evidence names is a subset of what GET /nodes lists them.
    for (const u of [owner, sam]) {
      const r = await recs(u, gov);
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      const listed = new Set(((await jsonRequest(app, "GET", `/nests/${gov}/nodes`, undefined, u.apiKey)).data.nodes ?? []).map((n: any) => n.id));
      const rec = r.list.find((x) => x.id === "watcher:ops");
      const named = rec ? rec.evidence.map((e: any) => decodeURIComponent(e.link.split("?doc=")[1])) : [];
      for (const id of named) expect(listed.has(id), `${u.email} sees ${id}`).toBe(true);
      if (u === owner) expect(named).toHaveLength(3);
    }
    // And a document-share grantee who is not a member gets nothing at all.
    const g = await jsonRequest(app, "POST", `/nests/${gov}/grants`, { target_type: "document", target: "nodes/decisions/secret-plan-a", email: bob.email, role: "read" }, owner.apiKey);
    expect(g.status, JSON.stringify(g.data)).toBe(201);
    expect((await recs(bob, gov)).status).toBe(404);
  });

  it("SEC-C10-08 only a recommendation that is currently made can be dismissed", async () => {
    expect((await dismiss(owner, "mention:ghost-of-nobody")).status).toBe(404);
    expect((await dismiss(owner, "key-idle:ci")).status).toBe(404);
  });

  it("SEC-C10-04 announce text is the hirer's own: a handle can't inject markdown or a second line", async () => {
    const r = await hire(owner, { kind: "key", handle: "plain-bot", channels: ["general"], announce: true });
    expect(r.status).toBe(201);
    const tl = await jsonRequest(app, "GET", `/nests/${nestId}/channels/general`, undefined, owner.apiKey);
    const post = tl.data.posts.find((p: any) => p.body.startsWith("Hired @plain-bot:"));
    expect(post.body.split("\n")).toHaveLength(1);
    expect(post.body).not.toMatch(/cnst_|whsec_/);
  });
});
