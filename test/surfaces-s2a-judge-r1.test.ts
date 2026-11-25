/**
 * Surfaces S2a — blind-judge round 1 fixes (run/s7-eval-s2a-judge/eval.md):
 * AC-INS-09 for both teardown events, AC-JDG-13's remaining read paths (sync /
 * export and other agents' context), spec §13 (no folder names; an unseeded
 * listener proposes nowhere) and the forced-ask hold. Same fakes as
 * surfaces-s2a-slack.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit, settleSeals, testDbDriver } from "./helpers.js";

// ─── fake model ──────────────────────────────────────────────────────────────
type Turn = { content: any[]; stop_reason: string; usage?: Record<string, number> };
let modelImpl: (req: any) => Turn | Promise<Turn> = () => submit(noop());
const modelCalls: any[] = [];
function submit(input: any): Turn {
  return {
    content: [{ type: "tool_use", id: `tu_${Math.random().toString(36).slice(2, 8)}`, name: "submit_window_verdict", input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 3000, output_tokens: 400 },
  };
}
const noop = (reason = "chatter") => ({ verdict: "no_op", reason_code: reason, items: [], ask_signature: null });
const firstText = (req: any): string => {
  const c = req.messages?.[0]?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("") : "";
};
const idsIn = (req: any) => [...firstText(req).matchAll(/<message_[0-9a-f]+ id="(m\d+)"/g)].map((m) => m[1]);
function propose(req: any, over: Record<string, unknown> = {}) {
  const ids = idsIn(req);
  return submit({
    verdict: "propose",
    reason_code: "proposed",
    ask_signature: null,
    items: [
      {
        kind: "decision",
        op: "new",
        target_folder: "inbox/",
        target_node_id: null,
        title: `Decision ${randomUUID().slice(0, 8)} recorded for the team`,
        summary: "The team agreed on a change worth keeping.",
        body: "Decision: the team switches to the new approach from next quarter.",
        owner: null,
        due_date: null,
        evidence_message_ids: [ids[ids.length - 1] ?? "m1"],
        why: "An agreed decision",
        confidence: 0.9,
        sensitive: false,
        conflict: null,
        ...over,
      },
    ],
  });
}

/** Emails the server sent (the transport is replaced; nothing leaves). */
const sentEmails: Array<{ to: string[]; subject: string }> = [];
beforeAll(() => {
  vi.doMock("../src/notify/email.js", async () => {
    const actual = await vi.importActual<typeof import("../src/notify/email.js")>("../src/notify/email.js");
    return {
      ...actual,
      sendEmailToRecipient: async (to: string[] | string, ev: any) => {
        sentEmails.push({ to: Array.isArray(to) ? to : [to], subject: String(ev?.docTitle ?? "") });
        return "sent";
      },
    };
  });
});
afterAll(() => vi.doUnmock("../src/notify/email.js"));

beforeAll(() => {
  vi.doMock("../src/metacognition/model.js", async () => {
    const actual = await vi.importActual<typeof import("../src/metacognition/model.js")>("../src/metacognition/model.js");
    return {
      ...actual,
      createTurn: async (params: any) => {
        modelCalls.push(JSON.parse(JSON.stringify(params.request)));
        return await modelImpl(params.request);
      },
    };
  });
});

// ─── fake Slack Web API + network guard ──────────────────────────────────────
interface SlackUser {
  id: string;
  team_id: string;
  email?: string;
  name?: string;
  is_bot?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
}
const slack = {
  calls: [] as Array<{ method: string; params: Record<string, string>; auth: string | null }>,
  users: new Map<string, SlackUser>(),
  usersFail: new Set<string>(),
  usersGate: null as null | Promise<void>,
  convs: new Map<string, { info: Record<string, unknown>; members: string[] }>(),
  history: new Map<string, Array<{ ts: string; user: string; text: string; thread_ts?: string }>>(),
  rateLimit: new Map<string, number>(),
  oauth: null as null | Record<string, unknown>,
  posted: [] as Array<Record<string, string>>,
  ephemerals: [] as Array<Record<string, string>>,
  revoked: [] as string[],
};
const netCalls: string[] = [];
const realFetch = globalThis.fetch;

function slackUser(u: SlackUser) {
  return {
    id: u.id,
    team_id: u.team_id,
    name: u.name ?? u.id,
    deleted: false,
    is_bot: !!u.is_bot,
    is_restricted: !!u.is_restricted,
    is_ultra_restricted: !!u.is_ultra_restricted,
    ...(u.is_stranger ? { is_stranger: true } : {}),
    is_email_confirmed: true,
    profile: { email: u.email, display_name: u.name ?? u.id, real_name: u.name ?? u.id },
  };
}

async function fakeFetch(url: any, init?: any): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://slack.com/api/")) {
    netCalls.push(u);
    throw new Error(`network guard: ${u}`);
  }
  const method = u.slice("https://slack.com/api/".length).split("?")[0];
  const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
  const params: Record<string, string> = init?.headers?.["Content-Type"]?.includes("json") || init?.headers?.["content-type"]?.includes("json")
    ? JSON.parse(body || "{}")
    : Object.fromEntries(new URLSearchParams(body));
  const headers = new Headers(init?.headers ?? {});
  slack.calls.push({ method, params, auth: headers.get("authorization") });
  const json = (o: unknown, status = 200, h: Record<string, string> = {}) =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...h } });
  const limited = slack.rateLimit.get(method);
  if (limited) {
    slack.rateLimit.delete(method);
    return json({ ok: false, error: "ratelimited" }, 429, { "retry-after": String(limited) });
  }
  switch (method) {
    case "oauth.v2.access":
      return json(slack.oauth ?? { ok: false, error: "invalid_code" });
    case "auth.revoke":
      slack.revoked.push(headers.get("authorization") ?? params.token ?? "");
      return json({ ok: true, revoked: true });
    case "users.info": {
      if (slack.usersGate) await slack.usersGate;
      if (slack.usersFail.has(params.user)) return json({ ok: false, error: "fatal_error" }, 500);
      const user = slack.users.get(params.user);
      return json(user ? { ok: true, user: slackUser(user) } : { ok: false, error: "user_not_found" });
    }
    case "conversations.info": {
      const c = slack.convs.get(params.channel);
      return json(c ? { ok: true, channel: c.info } : { ok: false, error: "channel_not_found" });
    }
    case "conversations.members": {
      const c = slack.convs.get(params.channel);
      return json(c ? { ok: true, members: c.members, response_metadata: { next_cursor: "" } } : { ok: false, error: "channel_not_found" });
    }
    case "conversations.history":
    case "conversations.replies": {
      const msgs = slack.history.get(params.channel) ?? [];
      const pick =
        method === "conversations.history"
          ? msgs.filter((m) => m.ts === params.latest)
          : msgs.filter((m) => m.ts === params.ts || m.thread_ts === params.ts);
      return json({ ok: true, messages: pick, has_more: false });
    }
    case "chat.postMessage":
      slack.posted.push(params);
      return json({ ok: true, channel: params.channel, ts: `${Date.now() / 1000}` });
    case "chat.update":
      return json({ ok: true });
    case "chat.postEphemeral":
      slack.ephemerals.push(params);
      return json({ ok: true, message_ts: "1.1" });
    case "chat.getPermalink":
      return json({ ok: true, permalink: `https://acme.slack.com/archives/${params.channel}/p${String(params.message_ts).replace(".", "")}` });
    default:
      return json({ ok: false, error: "unknown_method" });
  }
}

// ─── app state ───────────────────────────────────────────────────────────────
type User = { apiKey: string; userId: string; email: string };
let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: User; // server admin
let alice: User; // nest owner
let bob: User; // reader
let N: string; // the bound nest
let installId: string;
let bindingC1: string;
let S: {
  db: typeof import("../src/db/client.js");
  work: typeof import("../src/surfaces/services/work.js");
  windows: typeof import("../src/surfaces/services/window-service.js");
  purge: typeof import("../src/surfaces/services/purge-service.js");
  fetchq: typeof import("../src/surfaces/services/fetch-queue.js");
  crypto: typeof import("../src/surfaces/services/buffer-crypto.js");
  judge: typeof import("../src/surfaces/services/judge-service.js");
  spend: typeof import("../src/surfaces/services/spend-service.js");
  identity: typeof import("../src/surfaces/services/identity-service.js");
  runner: typeof import("../src/surfaces/services/guard-runner.js");
  readers: typeof import("../src/surfaces/services/readers.js");
  tools: typeof import("../src/metacognition/tools.js");
  manifest: typeof import("../src/surfaces/adapters/slack/manifest.js");
  listener: typeof import("../src/surfaces/services/listener-service.js");
};
const SIGNING = "slack-signing-secret-c1";
const BUFFER_KEY = randomBytes(32).toString("base64");
const BASE = "https://nest.surf.test";

const db = () => S.db.getDb();
const all = (sql: string, p: any[] = []) => db().all(sql, p) as Promise<any[]>;
const one = (sql: string, p: any[] = []) => db().get(sql, p) as Promise<any>;

function sign(raw: string, secret = SIGNING, ts = Math.floor(Date.now() / 1000)) {
  return { ts: String(ts), sig: `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}` };
}
async function postEvent(path: string, body: unknown, opts: { secret?: string; ts?: number; sig?: string; headers?: Record<string, string> } = {}) {
  const raw = JSON.stringify(body);
  const s = sign(raw, opts.secret ?? SIGNING, opts.ts);
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": s.ts,
      "X-Slack-Signature": opts.sig ?? s.sig,
      ...(opts.headers ?? {}),
    },
    body: raw,
  });
}
let evSeq = 0;
function envelope(event: Record<string, unknown>, team = "T1", eventId = `Ev${++evSeq}${randomUUID().slice(0, 6)}`) {
  return { type: "event_callback", team_id: team, api_app_id: "A1", event_id: eventId, event_time: Math.floor(Date.now() / 1000), event };
}
let tsSeq = 1_700_000_000;
const nextTs = () => `${++tsSeq}.000100`;
/** Bindings whose listener must keep NO folders (the unseeded case). */
const noFolders = new Set<string>();
/**
 * The listener has no folders until a seed sets them (spec §13). These tests
 * set them explicitly — the nest root and inbox/ — on every live binding.
 */
async function ensureFolders() {
  for (const b of await all("SELECT id FROM surface_bindings WHERE status <> 'removed' AND listener_agent_node_id IS NOT NULL")) {
    if (noFolders.has(b.id)) continue;
    const l = await S.listener.listenerFor(b.id);
    if (!l || ((l.config as any).surfaces_listener?.folders ?? []).length) continue;
    await S.listener.setListenerFolders(b.id, ["/", "inbox/"]);
  }
}
async function say(channel: string, user: string, text: string, over: Record<string, unknown> = {}, path?: string, team = "T1", secret?: string) {
  await ensureFolders();
  const ts = (over.ts as string) ?? nextTs();
  const ev = { type: "message", channel, user, text, ts, channel_type: "group", ...over };
  const res = await postEvent(path ?? `/surfaces/slack/${installId}/events`, envelope(ev, team), secret ? { secret } : {});
  expect(res.status).toBe(200);
  await S.work.waitForSurfacesWork();
  return ts;
}
async function send(ev: Record<string, unknown>, path?: string) {
  const res = await postEvent(path ?? `/surfaces/slack/${installId}/events`, envelope(ev));
  await S.work.waitForSurfacesWork();
  return res;
}
const bufferRows = (bindingId: string) => all("SELECT * FROM surface_buffer WHERE binding_id = ? ORDER BY ts", [bindingId]);
const counter = async (metric: string, bindingId?: string) =>
  Number(
    (
      await one(
        `SELECT COALESCE(SUM(value), 0) AS n FROM surface_counters WHERE metric = ?${bindingId ? " AND binding_id = ?" : ""}`,
        bindingId ? [metric, bindingId] : [metric],
      )
    ).n,
  );
const later = (min: number) => Date.now() + min * 60_000;
async function tick(min = 21) {
  const r = await S.windows.windowTick(later(min));
  await S.work.waitForSurfacesWork();
  return r;
}
async function login(email: string): Promise<string> {
  const r = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass" }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
function setChannel(id: string, members: string[], over: Record<string, unknown> = {}) {
  slack.convs.set(id, {
    info: { id, name: id.toLowerCase(), is_channel: false, is_group: true, is_im: false, is_mpim: false, is_private: true, is_ext_shared: false, is_general: false, ...over },
    members,
  });
}

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
async function mcp(path: string, method: string, params: Record<string, unknown>, key: string) {
  const res = await app.request(path, { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  const line = text.split("\n").find((l: string) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice("data: ".length)) : { raw: text };
}

/** Full manifest-install flow for a workspace: create → credentials → OAuth. */
async function installWorkspace(team: string, homeNest: string, opts: { botUserId?: string; authedUser?: string; enterprise?: boolean } = {}) {
  const created = await jsonRequest(app, "POST", "/surfaces/slack/installs", { home_nest_id: homeNest }, root.apiKey);
  expect(created.status).toBe(201);
  const id = created.data.install_id as string;
  const cred = await jsonRequest(app, "PUT", `/surfaces/slack/installs/${id}/credentials`, { client_id: "cid.1", client_secret: "csecret-xyz", signing_secret: SIGNING }, root.apiKey);
  expect(cred.status).toBe(200);
  const cookie = await login(root.email);
  const start = await app.request(`/surfaces/slack/installs/${id}/oauth/start`, { headers: { Cookie: cookie } });
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  slack.oauth = {
    ok: true,
    access_token: `xoxb-${team}-token`,
    token_type: "bot",
    bot_user_id: opts.botUserId ?? "UBOT",
    app_id: "A1",
    team: { id: team, name: team },
    enterprise: null,
    is_enterprise_install: !!opts.enterprise,
    authed_user: { id: opts.authedUser ?? "U_ROOT" },
  };
  const cb = await app.request(`/surfaces/slack/oauth/callback?code=c-${team}&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie, Accept: "application/json" } });
  return { id, status: cb.status, body: await cb.json().catch(() => ({})), cookie, state };
}

async function newNode(nestId: string, title: string, folder: string, content: string, key = alice.apiKey) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content, folder }, key);
  expect(r.status).toBeLessThan(300);
  return r.data.node?.id ?? r.data.id;
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  process.env.SURFACES_BUFFER_KEY = BUFFER_KEY;
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.METACOGNITION_STARTS_PER_HOUR = "1000";
  vi.stubGlobal("fetch", fakeFetch);
  env = setupTestEnv();
  app = await createTestApp("key", {
    superAdmins: ["root@surf.test"],
    gateway: { baseUrl: "https://gateway.promptowl.test", key: "po-key", defaultModel: "default-claude/claude-sonnet-5" },
  });
  root = await registerUser(app, "root@surf.test", "Root");
  alice = await registerUser(app, "alice@surf.test", "Alice");
  bob = await registerUser(app, "bob@surf.test", "Bob");
  await resetAuthRateLimit();

  S = {
    db: await import("../src/db/client.js"),
    work: await import("../src/surfaces/services/work.js"),
    windows: await import("../src/surfaces/services/window-service.js"),
    purge: await import("../src/surfaces/services/purge-service.js"),
    fetchq: await import("../src/surfaces/services/fetch-queue.js"),
    crypto: await import("../src/surfaces/services/buffer-crypto.js"),
    judge: await import("../src/surfaces/services/judge-service.js"),
    spend: await import("../src/surfaces/services/spend-service.js"),
    identity: await import("../src/surfaces/services/identity-service.js"),
    runner: await import("../src/surfaces/services/guard-runner.js"),
    readers: await import("../src/surfaces/services/readers.js"),
    tools: await import("../src/metacognition/tools.js"),
    manifest: await import("../src/surfaces/adapters/slack/manifest.js"),
    listener: await import("../src/surfaces/services/listener-service.js"),
  };

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Acme team" }, alice.apiKey);
  N = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${N}/collaborators`, { email: bob.email, permission: "read" }, alice.apiKey);
  // No starter ontology (Project November): the listener proposes into the
  // nest root and inbox/ by default.
  await newNode(N, "Acme moves to annual billing", "inbox", "Acme renewal is billed annually.");
  await newNode(N, "Staff engineer comp", "how-we-work", "the compensation band for staff engineers is one hundred ninety thousand dollars per year");
  await settleSeals();

  slack.users.set("U_ROOT", { id: "U_ROOT", team_id: "T1", email: "root@surf.test", name: "Root" });
  slack.users.set("U_ALICE", { id: "U_ALICE", team_id: "T1", email: "alice@surf.test", name: "Alice" });
  slack.users.set("U_BOB", { id: "U_BOB", team_id: "T1", email: "bob@surf.test", name: "Bob" });
  slack.users.set("U_DAN", { id: "U_DAN", team_id: "T1", email: "dan@elsewhere.test", name: "Dan" });
  slack.users.set("U_EXT", { id: "U_EXT", team_id: "T9", email: "ext@partner.test", name: "Ext" });
  slack.users.set("U_GUEST", { id: "U_GUEST", team_id: "T1", email: "guest@surf.test", name: "Guest", is_restricted: true });
  slack.users.set("UBOT", { id: "UBOT", team_id: "T1", name: "nest", is_bot: true });
  setChannel("C1", ["U_ALICE", "U_BOB", "U_DAN", "U_EXT", "U_GUEST", "UBOT"]);
  setChannel("C_UNBOUND", ["U_ALICE", "U_BOB"]);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
  vi.doUnmock("../src/metacognition/model.js");
  for (const k of ["FEATURE_WORKFLOW_PLANE", "FEATURE_METACOGNITION", "FEATURE_SURFACES", "SURFACES_BUFFER_KEY", "PUBLIC_BASE_URL", "FEATURE_SURFACES_SLACK_HOSTED"]) delete process.env[k];
  await env?.cleanup();
});


// ─── setup ───────────────────────────────────────────────────────────────────
let bindingC2: string;
let R: {
  tools: typeof import("../src/metacognition/tools.js");
  store: typeof import("../src/metacognition/store.js");
  mcpPool: typeof import("../src/metacognition/mcp-client.js");
};
async function brain(channel: string, ts: string, by = "U_ALICE", author = "U_BOB") {
  await db().run("DELETE FROM surface_ask_counts");
  return send({ type: "reaction_added", user: by, reaction: "brain", item_user: author, item: { type: "message", channel, ts }, event_ts: nextTs() });
}
let newDraft = "";
const EDITED = "nodes/inbox/runbook";

beforeAll(async () => {
  R = {
    tools: await import("../src/metacognition/tools.js"),
    store: await import("../src/metacognition/store.js"),
    mcpPool: await import("../src/metacognition/mcp-client.js"),
  };
  await newNode(N, "Runbook", "inbox", "Escalations go to the on-call engineer first.");
  await settleSeals();
  const r = await installWorkspace("T1", N);
  expect(r.status).toBe(200);
  installId = r.id;
  await S.identity.linkExplicit({ installId, surfaceUserId: "U_ALICE", communityUserId: alice.userId });
  await S.identity.linkExplicit({ installId, surfaceUserId: "U_BOB", communityUserId: bob.userId });
  const b1 = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C1", nest_id: N }, alice.apiKey);
  expect(b1.status, JSON.stringify(b1.data)).toBe(201);
  bindingC1 = b1.data.binding.id;
  setChannel("C2", ["U_ALICE", "U_BOB", "UBOT"]);
  const b2 = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C2", nest_id: N }, alice.apiKey);
  expect(b2.status, JSON.stringify(b2.data)).toBe(201);
  bindingC2 = b2.data.binding.id;
  // A pending NEW draft and a pending EDIT draft, both from C2.
  modelImpl = (req) => propose(req, { title: "Quokka migration plan agreed", body: "Decision: QUOKKADRAFT migrate the billing service." });
  let ts = await say("C2", "U_BOB", "the quokka migration plan is agreed by everyone here");
  await brain("C2", ts);
  newDraft = (await one("SELECT node_id FROM surface_proposal_items WHERE title = 'Quokka migration plan agreed'")).node_id;
  modelImpl = (req) => propose(req, { kind: "correction", op: "edit", target_node_id: EDITED, title: "Runbook corrected", body: "Escalations go to PELICANDRAFT first." });
  ts = await say("C2", "U_BOB", "the runbook is wrong about escalations, fix it");
  await brain("C2", ts);
  expect(await one("SELECT 1 AS x FROM surface_proposal_items WHERE target_node_id = ? AND state = 'pending'", [EDITED])).toBeTruthy();
});

// ═══ 1. AC-INS-09 for both teardown events ═══════════════════════════════════

describe.each(["app_uninstalled", "tokens_revoked"])("AC-INS-09 (%s)", (event) => {
  it(`AC-INS-09 (${event}): secrets deleted, bindings removed, buffer purged, pending withdrawn, drafts purged, links deleted; approved nodes stay`, async () => {
    const team = event === "app_uninstalled" ? "TU1" : "TU2";
    const bot = `UBOT_${team}`;
    slack.users.set(`UA_${team}`, { id: `UA_${team}`, team_id: team, email: "alice@surf.test", name: "Alice" });
    slack.users.set(`UB_${team}`, { id: `UB_${team}`, team_id: team, email: "bob@surf.test", name: "Bob" });
    slack.users.set(bot, { id: bot, team_id: team, name: "nest", is_bot: true });
    const inst = await installWorkspace(team, N, { botUserId: bot, authedUser: `UR_${team}` });
    expect(inst.status).toBe(200);
    await S.identity.linkExplicit({ installId: inst.id, surfaceUserId: `UA_${team}`, communityUserId: alice.userId });
    await S.identity.linkExplicit({ installId: inst.id, surfaceUserId: `UB_${team}`, communityUserId: bob.userId });
    const ch = `CU_${team}`;
    setChannel(ch, [`UA_${team}`, `UB_${team}`, bot]);
    const b = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: inst.id, conversation_id: ch, nest_id: N }, alice.apiKey);
    expect(b.status, JSON.stringify(b.data)).toBe(201);
    const path = `/surfaces/slack/${inst.id}/events`;
    modelImpl = (req) => propose(req, { title: `Teardown ${team} decision kept`, body: "Decision: kept for the teardown check." });
    const ts = await say(ch, `UB_${team}`, "this decision is agreed and worth keeping for teardown", {}, path, team);
    await db().run("DELETE FROM surface_ask_counts");
    await postEvent(path, envelope({ type: "reaction_added", user: `UA_${team}`, reaction: "brain", item_user: `UB_${team}`, item: { type: "message", channel: ch, ts }, event_ts: nextTs() }, team));
    await S.work.waitForSurfacesWork();
    const pending = await all(
      "SELECT i.* FROM surface_proposal_items i JOIN surface_proposals p ON p.id = i.proposal_id WHERE p.binding_id = ? AND i.state = 'pending'",
      [b.data.binding.id],
    );
    expect(pending.length).toBe(1);
    await say(ch, `UB_${team}`, "a message buffered right before the teardown event", {}, path, team);
    expect((await all("SELECT * FROM surface_buffer WHERE install_id = ?", [inst.id])).length).toBeGreaterThan(0);

    const res = await postEvent(path, envelope({ type: event, ...(event === "tokens_revoked" ? { tokens: { bot: [bot] } } : {}) }, team));
    expect(res.status).toBe(200);
    await S.work.waitForSurfacesWork();
    expect((await all("SELECT * FROM surface_secrets WHERE install_id = ?", [inst.id])).length).toBe(0);
    expect((await all("SELECT * FROM surface_bindings WHERE install_id = ? AND status <> 'removed'", [inst.id])).length).toBe(0);
    expect((await all("SELECT * FROM surface_buffer WHERE install_id = ?", [inst.id])).length).toBe(0);
    expect((await all("SELECT * FROM surface_identity_links WHERE install_id = ?", [inst.id])).length).toBe(0);
    const item = await one("SELECT * FROM surface_proposal_items WHERE id = ?", [pending[0].id]);
    expect(item.state).toBe("withdrawn");
    expect(item.title).toBeNull();
    expect((await one("SELECT status FROM review_requests WHERE id = ?", [pending[0].review_id]))?.status ?? "gone").not.toBe("pending");
    expect((await jsonRequest(app, "GET", `/nests/${N}/nodes/${pending[0].node_id}`, undefined, bob.apiKey)).status).not.toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${N}/nodes/nodes/inbox/acme-moves-to-annual-billing`, undefined, bob.apiKey)).status).toBe(200);
    expect((await one("SELECT status FROM surface_installs WHERE id = ?", [inst.id])).status).toBe("revoked");
  });
});

// ═══ 2. AC-JDG-13: the remaining read paths ═════════════════════════════════

describe("AC-JDG-13: sync/pull and other agents never see a pending Surfaces draft", () => {
  it("AC-JDG-13 sync: GET /changes (with content) carries neither the new draft nor the edit's draft text", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${N}/changes?since=2000-01-01T00:00:00Z&include_content=1`, undefined, bob.apiKey);
    expect(r.status).toBe(200);
    const out = JSON.stringify(r.data);
    expect(out).not.toContain(newDraft);
    expect(out).not.toMatch(/QUOKKADRAFT|PELICANDRAFT/);
    expect(out).toContain("on-call engineer"); // the edited node, at its approved body
  });

  it("AC-JDG-13 pull: GET /export?format=markdown and the bundle carry no pending draft", async () => {
    const md = await app.request(`/nests/${N}/export?format=markdown`, { headers: { Authorization: `Bearer ${bob.apiKey}`, Accept: "text/markdown" } });
    expect(md.status).toBe(200);
    const text = await md.text();
    expect(text).not.toMatch(/QUOKKADRAFT|PELICANDRAFT/);
    expect(text).not.toContain(newDraft);
    expect(text).toContain("on-call engineer");
    const zipRes = await app.request(`/nests/${N}/export?format=bundle&includeDrafts=1`, { headers: { Authorization: `Bearer ${bob.apiKey}` } });
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await zipRes.arrayBuffer());
    let all = "";
    for (const f of Object.values(zip.files)) if (!f.dir) all += await f.async("string");
    expect(all).not.toMatch(/QUOKKADRAFT|PELICANDRAFT/);
  });

  it("AC-JDG-13 agents: another metacognition agent on the nest (owner can write) can't read, search or list the pending draft", async () => {
    const other = await R.store.upsertAgent({
      nestId: N,
      nodeId: "nodes/other-agent",
      config: {
        persona: { name: "Other agent", avatar: null },
        scope: { read: [], propose: [] },
        caps: { max_steps: 4, max_tokens: 20000, max_seconds: 60, max_proposals: 0, max_comments: 0 },
        feeds: [],
        mcp_servers: [],
        model: null,
        notify: { recipients: [], channels: [], max_per_run: 1 },
      } as any,
      enabled: false,
      savedBy: alice.email,
    });
    const ctx: any = {
      nestId: N,
      runId: "",
      agent: other,
      owner: { userId: alice.userId, email: alice.email },
      baseUrl: BASE,
      proposals: { made: 0 },
      comments: { made: 0 },
      accessRequests: { made: 0 },
      notifications: { made: 0 },
      read: new Set(),
      mcp: new R.mcpPool.McpPool(() => null),
      signal: new AbortController().signal,
      quiet: true,
    };
    const read = await R.tools.runTool(ctx, "read_node", { id: newDraft });
    expect(read.isError).toBe(true);
    expect(read.content).not.toContain("QUOKKADRAFT");
    const search = await R.tools.runTool(ctx, "search_nest", { query: "Quokka migration plan" });
    expect(search.content).not.toContain(newDraft);
    const list = await R.tools.runTool(ctx, "list_nodes", { folder: "inbox" });
    expect(list.content).not.toContain(newDraft);
    expect(list.content).toContain(EDITED);
    const edited = await R.tools.runTool(ctx, "read_node", { id: EDITED });
    expect(edited.content).toContain("on-call engineer");
    expect(edited.content).not.toContain("PELICANDRAFT");
    await R.store.deleteAgent(N, "nodes/other-agent");
  });

  it("AC-JDG-13 agents: an MCP client of another read-level user gets nothing of either draft (get, search, list)", async () => {
    const calls = [
      await mcp(`/nests/${N}/mcp`, "tools/call", { name: "context_get", arguments: { id: newDraft } }, bob.apiKey),
      await mcp(`/nests/${N}/mcp`, "tools/call", { name: "context_get", arguments: { id: EDITED } }, bob.apiKey),
      await mcp(`/nests/${N}/mcp`, "tools/call", { name: "context_search", arguments: { query: "QUOKKADRAFT" } }, bob.apiKey),
      await mcp(`/nests/${N}/mcp`, "tools/call", { name: "context_search", arguments: { query: "PELICANDRAFT" } }, bob.apiKey),
      await mcp(`/nests/${N}/mcp`, "tools/call", { name: "context_list", arguments: {} }, bob.apiKey),
    ];
    for (const [i, c] of calls.entries()) {
      const out = JSON.stringify(c.result ?? c);
      expect(out).not.toContain("QUOKKADRAFT migrate");
      expect(out).not.toContain("PELICANDRAFT first");
      // calls[0] asked for the draft id itself: "not found" may echo the caller's own input.
      if (i > 0) expect(out).not.toContain(newDraft);
    }
    expect(calls[0].result?.isError).toBe(true);
    expect(JSON.stringify(calls[1])).toContain("on-call engineer");
  });
});

// ═══ 3. §13: no folder names; an unseeded listener proposes nowhere ═════════

describe("§13 folders", () => {
  it("AC-SEED-09: an unseeded binding (no listener folders) ends windows as no_target_folder, no model call, one counts-only admin alert", async () => {
    setChannel("C3", ["U_ALICE", "U_BOB", "UBOT"]);
    const b3 = (await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C3", nest_id: N }, alice.apiKey)).data.binding.id;
    noFolders.add(b3);
    modelImpl = () => submit(noop());
    await tick(30); // flush other open windows first
    const listener = await S.listener.listenerFor(b3);
    expect((listener!.config as any).surfaces_listener.folders).toEqual([]);
    const calls = modelCalls.length;
    for (let i = 0; i < 2; i++) {
      await say("C3", "U_BOB", `we agreed on decision number ${i} for the unseeded channel today`);
      const w = await one("SELECT * FROM surface_windows WHERE id = ?", [(await tick(21)).find(Boolean)]);
      expect(w.verdict).toBe("no_target_folder");
    }
    expect(modelCalls.length).toBe(calls);
    const notices = await all("SELECT * FROM surface_notices WHERE kind = 'no_target_folder' AND binding_id = ?", [b3]);
    expect(notices.length).toBe(1);
    expect(JSON.parse(notices[0].detail)).toEqual({ windows: 1 });
    expect(JSON.stringify(notices)).not.toMatch(/decision number/);
    expect(sentEmails.some((m) => /nowhere to propose/i.test(m.subject))).toBe(true);
  });

  it("§13 / AC-SEED-06 (early): no folder-path literal appears anywhere in src/surfaces", async () => {
    const { readdirSync, readFileSync, statSync } = await import("fs");
    const { join } = await import("path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));
    const FOLDERS = "inbox|decisions|people|projects|customers|how-we-work|agents";
    const re = new RegExp(`(?<![\\w-])(${FOLDERS})/|["'\`](${FOLDERS})["'\`]`, "g");
    const hits: string[] = [];
    for (const f of walk(join(process.cwd(), "src", "surfaces"))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(re)) hits.push(`${f.split("src/surfaces/")[1]}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});

// ═══ 4. Forced asks and the 7-day hold ═══════════════════════════════════════

describe("forced asks bypass the 7-day hold (PRD §4.9)", () => {
  it("a forced ask matching a rejected proposal is not dropped; a readers-only room sees 'Previously not kept on <date>'", async () => {
    modelImpl = (req) => propose(req, { title: "Kiwi offsite moves to May", body: "Decision: the offsite moves to May." });
    let ts = await say("C2", "U_BOB", "the kiwi offsite moves to may, agreed by all of us");
    await brain("C2", ts);
    const first = await one("SELECT * FROM surface_proposal_items WHERE title = 'Kiwi offsite moves to May'");
    // A reviewer said no (recorded as the review service records it; the
    // REST route needs a reviewer steward, which this nest doesn't have).
    await db().run("UPDATE review_requests SET status = 'rejected', resolved_by = ?, resolution_note = 'not now', resolved_at = ? WHERE id = ?", [
      alice.email,
      new Date().toISOString().slice(0, 19).replace("T", " "),
      first.review_id,
    ]);
    expect((await one("SELECT status FROM review_requests WHERE id = ?", [first.review_id])).status).toBe("rejected");
    ts = await say("C2", "U_BOB", "really, keep this: the kiwi offsite moves to may");
    const n = slack.posted.length;
    await brain("C2", ts);
    const again = await all("SELECT * FROM surface_proposal_items WHERE item_kind = 'decision' AND id <> ? AND created_at >= ? ORDER BY created_at DESC", [first.id, first.created_at]);
    expect(again.length).toBeGreaterThan(0);
    expect(again[0].state).toBe("pending");
    expect(again[0].previously_held_on).toBeTruthy();
    const out = JSON.stringify(slack.posted.slice(n));
    expect(out).toContain("Previously not kept on");
  });

  it("…while a room with non-readers sees only the fixed sentence (no hold date)", async () => {
    await db().run(
      "INSERT INTO surface_fingerprints (id, nest_id, kind, op, target_folder, title_tokens, title_hash, source, hold_until, created_at) VALUES (?, ?, 'decision', 'new', 'inbox/', ?, 'h', 'rejected', ?, ?)",
      [randomUUID(), N, JSON.stringify(["mango", "launch", "slips"]), new Date(Date.now() + 4 * 86400_000).toISOString(), new Date(Date.now() - 2 * 86400_000).toISOString()],
    );
    modelImpl = (req) => propose(req, { title: "Mango launch slips" });
    const ts = await say("C1", "U_BOB", "the mango launch slips, keep it for the record");
    const n = slack.posted.length;
    await brain("C1", ts);
    const item = await one("SELECT * FROM surface_proposal_items WHERE title = 'Mango launch slips'");
    expect(item.state).toBe("pending");
    const out = JSON.stringify(slack.posted.slice(n));
    expect(out).not.toContain("Previously not kept");
    expect(out).not.toContain("Mango");
    expect(out).toContain("A proposed decision from this conversation is waiting for review in Acme team");
  });
});

// ═══ N6 (round-3 re-check): typed targets and agent instructions ═════════════

describe("N6: Surfaces edits never reach configuration documents", () => {
  const TYPED: Array<[string, Record<string, unknown>]> = [
    ["agent", { type: "agent", content: "Agent instructions body." }],
    ["skill", { type: "skill", content: "Skill body." }],
    ["view", { type: "view", content: "View intro.", view: { blocks: [{ callout: { text: "hi" } }] } }],
    ["table", { type: "table", content: "sku,price\nA1,10\n" }],
    ["task", { type: "task", content: "Task body." }],
  ];
  for (const [type, body] of TYPED) {
    it(`N6: a forced edit targeting a ${type} node is refused (no_op / target_not_document) and the node is untouched`, async () => {
      const r = await jsonRequest(app, "POST", `/nests/${N}/nodes`, { title: `Typed ${type} node`, folder: "inbox", ...body }, alice.apiKey);
      expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
      const id = r.data.node.id as string;
      await settleSeals();
      const before = (await jsonRequest(app, "GET", `/nests/${N}/nodes/${id}`, undefined, alice.apiKey)).data.node.content;
      modelImpl = (req) => propose(req, { kind: "correction", op: "edit", target_node_id: id, title: `Typed ${type} corrected`, body: "INJECTED-CONFIG replaces this." });
      const ts = await say("C2", "U_BOB", `the ${type} configuration is wrong, please correct it now`);
      await brain("C2", ts);
      const w = await one("SELECT * FROM surface_windows WHERE binding_id = ? AND forced = 1 ORDER BY created_at DESC LIMIT 1", [bindingC2]);
      expect(w.verdict).toBe("no_op");
      expect(w.reason_code).toBe("target_not_document");
      expect(await one("SELECT 1 AS x FROM surface_proposal_items WHERE target_node_id = ?", [id])).toBeUndefined();
      const after = (await jsonRequest(app, "GET", `/nests/${N}/nodes/${id}`, undefined, alice.apiKey)).data.node.content;
      expect(after).toBe(before);
      expect(String(after)).not.toContain("INJECTED-CONFIG");
    });
  }

  it("N6: the propose path itself refuses non-document targets (server-side, not only the schema)", async () => {
    const proposals = await import("../src/surfaces/services/proposal-service.js");
    const agentId = (await one("SELECT node_id FROM node_versions WHERE nest_id = ? AND node_id LIKE 'nodes/inbox/typed-agent%' LIMIT 1", [N])).node_id;
    expect(await proposals.editTargetIsDocument(N, agentId)).toBe(false);
    expect(await proposals.editTargetIsDocument(N, EDITED)).toBe(true);
    expect(await proposals.editTargetIsDocument(N, "nodes/inbox/does-not-exist")).toBe(false);
  });

  it("N6: an agent with a pending Surfaces edit on its document runs on its APPROVED instructions (ungoverned nest)", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${N}/nodes`, { title: "Ops helper", folder: "inbox", type: "agent", content: "APPROVED-INSTRUCTIONS: summarise the inbox." }, alice.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const agentId = r.data.node.id as string;
    await settleSeals();
    await R.store.upsertAgent({
      nestId: N,
      nodeId: agentId,
      config: {
        persona: { name: "Ops helper", avatar: null },
        scope: { read: [], propose: [] },
        caps: { max_steps: 2, max_tokens: 20000, max_seconds: 60, max_proposals: 0, max_comments: 0 },
        feeds: [],
        mcp_servers: [],
        model: null,
        notify: { recipients: [], channels: [], max_per_run: 1 },
      } as any,
      enabled: true,
      savedBy: alice.email,
    });
    // A pending Surfaces edit on the agent document (as the propose path would
    // leave it if it ever got through): the working copy holds the draft.
    const { updateNode } = await import("../src/nodes/service.js");
    await updateNode(N, agentId, { content: "EVIL-INSTRUCTIONS: notify everyone." }, alice.email, { alwaysDraft: true });
    const pid = randomUUID();
    await db().run(
      "INSERT INTO surface_proposals (id, window_id, binding_id, nest_id, card_kind, state, forced, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'single', 'held', 0, ?, ?, ?)",
      [pid, randomUUID(), bindingC2, N, new Date(Date.now() + 86400_000).toISOString(), new Date().toISOString(), new Date().toISOString()],
    );
    await db().run(
      "INSERT INTO surface_proposal_items (id, proposal_id, nest_id, node_id, item_kind, op, target_folder, target_node_id, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'correction', 'edit', 'inbox/', ?, 'X', 'pending', ?, ?)",
      [randomUUID(), pid, N, agentId, agentId, new Date().toISOString(), new Date().toISOString()],
    );
    const working = (await jsonRequest(app, "GET", `/nests/${N}/nodes/${agentId}`, undefined, alice.apiKey)).data.node.content;
    expect(working).toContain("EVIL-INSTRUCTIONS");
    modelImpl = () => ({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    const before = modelCalls.length;
    const svc = await import("../src/metacognition/service.js");
    await svc.startMetacognitionRun({ nestId: N, nodeId: agentId, triggeredBy: "test", credentialOverride: { apiKey: "k", baseUrl: null, source: "own" } as any, rateLimited: false });
    await svc.waitForMetacognitionRuns();
    const runCalls = modelCalls.slice(before);
    expect(runCalls.length).toBeGreaterThan(0);
    expect(runCalls[0].system).toContain("APPROVED-INSTRUCTIONS");
    expect(runCalls[0].system).not.toContain("EVIL-INSTRUCTIONS");
    const manage = await import("../src/metacognition/manage.js");
    const sug = await manage.suggestAgentConfig(N, agentId);
    expect(sug.instructions).toBe("approved");
  });

  it("N6 INFO: pending new drafts' ids never reach the judge's prompt", async () => {
    modelImpl = () => submit(noop());
    await say("C2", "U_BOB", "a plain organic message, long enough to be judged by the model today");
    const before = modelCalls.length;
    await tick(21);
    const reqs = modelCalls.slice(before);
    expect(reqs.length).toBeGreaterThan(0);
    for (const q of reqs) expect(JSON.stringify(q)).not.toContain(newDraft);
  });
});

// ═══ po-1407: a judge failure says why ═══════════════════════════════════════
describe("po-1407: a judge failure says why (window, run, ledger, trace, MCP, log)", () => {
  async function ledgerCall(path: string, name: string, args: Record<string, unknown>) {
    const res = await app.request(path, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${alice.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.json();
    return JSON.parse(body?.result?.content?.[0]?.text ?? "null");
  }
  // A nest of its own: earlier cases give N an agent reader, which the
  // binding guard (rightly) refuses.
  let F: string;
  beforeAll(async () => {
    F = (await jsonRequest(app, "POST", "/nests", { name: "Ops judge failures" }, alice.apiKey)).data.nest.id;
  });
  const range = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });

  /** Bind a fresh channel, fail its window's model call twice, return the window. */
  async function failWindow(channel: string, fail: () => never) {
    setChannel(channel, ["U_ALICE", "U_BOB", "UBOT"]);
    const b = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: channel, nest_id: F }, alice.apiKey);
    expect(b.status, JSON.stringify(b.data)).toBe(201);
    modelImpl = () => submit(noop());
    await tick(30); // flush other open windows first
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    try {
      modelImpl = fail;
      await say(channel, "U_BOB", "we agreed the cutover moves to friday after the review meeting PLATYPUSCHAT");
      await tick(21); // first failure: the claim is released for one retry
      const first = await one("SELECT * FROM surface_windows WHERE binding_id = ? ORDER BY opened_at DESC LIMIT 1", [b.data.binding.id]);
      expect(first.status).toBe("closing");
      expect(first.reason_code).toBeNull();
      await tick(21); // second failure: final
    } finally {
      spy.mockRestore();
      modelImpl = () => submit(noop());
    }
    const w = await one("SELECT * FROM surface_windows WHERE binding_id = ? ORDER BY opened_at DESC LIMIT 1", [b.data.binding.id]);
    return { w, bindingId: b.data.binding.id as string, logged };
  }

  it("a model key refused (401) twice: window error/model_auth, a failed run with the same code, and REST, trace and MCP all say model_auth", async () => {
    const { w, bindingId, logged } = await failWindow("C407", () => {
      throw Object.assign(new Error("invalid x-api-key sk-ant-SECRET0000"), { status: 401 });
    });
    expect(w.status).toBe("judged");
    expect(w.verdict).toBe("error");
    expect(w.reason_code).toBe("model_auth");
    expect(w.run_id).toBeTruthy();

    // A run for the ledger trace to follow: failed, verdict error, the code.
    const run = await one("SELECT * FROM runs WHERE id = ?", [w.run_id]);
    expect(run.status).toBe("failed");
    expect(run.verdict).toBe("error");
    expect(run.reason_code).toBe("model_auth");
    expect(run.triggered_by).toBe("surfaces:window");
    expect(JSON.parse(run.trace)).toMatchObject({ kind: "surfaces_judge", verdict: "error", reason_code: "model_auth", http_status: 401 });
    expect(JSON.stringify(run)).not.toMatch(/SECRET|sk-ant|PLATYPUS/);

    // The server log: name, code, status — never the message or the chat.
    const lines = logged.filter((l) => l.includes(w.id));
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l).toMatch(/failed: \w+ reason=model_auth status=401/);
    expect(logged.join("\n")).not.toMatch(/SECRET|sk-ant|PLATYPUS/);

    // REST ledger and trace (the Control room's reads: superadmin only, po-1406).
    const q = new URLSearchParams({ ...range(), binding: bindingId }).toString();
    const led = await jsonRequest(app, "GET", `/nests/${F}/ledger?${q}`, undefined, root.apiKey);
    expect(led.status).toBe(200);
    const e = led.data.entries.find((x: any) => x.entry_id === `win_${w.id}`);
    expect(e.verdict).toMatchObject({ code: "error", reason_code: "model_auth" });
    expect(e.run).toMatchObject({ id: w.run_id, outcome: "failed" });
    const tr = await jsonRequest(app, "GET", `/ledger/win_${w.id}`, undefined, root.apiKey);
    expect(tr.status).toBe(200);
    expect(tr.data.chain.run).toMatchObject({ id: w.run_id, status: "failed" });
    expect(tr.data.chain.verdict.reason_code).toBe("model_auth");
    expect(tr.data.gaps).not.toContain("run");
    expect(JSON.stringify(tr.data)).not.toMatch(/SECRET|sk-ant|PLATYPUS/);

    // MCP parity: the same code from the nest, trace and org tools.
    const m = await ledgerCall(`/nests/${F}/mcp`, "context_agent_ledger", { ...range(), binding: bindingId });
    expect(m.entries.find((x: any) => x.entry_id === `win_${w.id}`).verdict.reason_code).toBe("model_auth");
    const mt = await ledgerCall(`/nests/${F}/mcp`, "context_agent_ledger_trace", { entry_id: `win_${w.id}` });
    expect(mt.chain.verdict.reason_code).toBe("model_auth");
    const mo = await ledgerCall("/mcp", "context_agent_ledger_org", { ...range(), nest_id: F, binding: bindingId });
    expect(mo.entries.find((x: any) => x.entry_id === `win_${w.id}`).verdict.reason_code).toBe("model_auth");
  });

  it("an out-of-credit model account (LiteLLM 400 'credit balance is too low') ends as model_billing and alerts admins once a day, counts only", async () => {
    const credit = () => {
      throw Object.assign(
        new Error('400 litellm.BadRequestError: AnthropicException - {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'),
        { status: 400 },
      );
    };
    const before = (await all("SELECT * FROM surface_notices WHERE kind = 'model_billing' AND nest_id = ?", [F])).length;
    const a = await failWindow("C410", credit);
    expect(a.w.reason_code).toBe("model_billing");
    expect((await one("SELECT reason_code FROM runs WHERE id = ?", [a.w.run_id])).reason_code).toBe("model_billing");
    expect(a.logged.filter((l) => l.includes(a.w.id)).every((l) => /reason=model_billing status=400 /.test(l))).toBe(true);
    // A second window the same day: same code, no second alert.
    const b = await failWindow("C411", credit);
    expect(b.w.reason_code).toBe("model_billing");
    const notices = await all("SELECT * FROM surface_notices WHERE kind = 'model_billing' AND nest_id = ?", [F]);
    expect(notices.length - before).toBe(1);
    const n = notices[notices.length - 1];
    expect(n.audience).toBe("admins");
    expect(JSON.parse(n.detail)).toEqual({ windows: 1 });
    expect(JSON.stringify(notices)).not.toMatch(/credit balance|Anthropic|litellm|PLATYPUS/i);
    expect(sentEmails.some((m) => /out of credit/i.test(m.subject))).toBe(true);
    const led = await jsonRequest(app, "GET", `/nests/${F}/ledger?${new URLSearchParams({ ...range(), binding: a.bindingId })}`, undefined, root.apiKey);
    expect(led.data.entries.find((x: any) => x.entry_id === `win_${a.w.id}`).verdict.reason_code).toBe("model_billing");
  });

  it("a throw after the run is recorded (commit stage) adds no failed run: the window keeps its succeeded run", async () => {
    setChannel("C412", ["U_ALICE", "U_BOB", "UBOT"]);
    const b = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C412", nest_id: F }, alice.apiKey);
    expect(b.status, JSON.stringify(b.data)).toBe(201);
    modelImpl = () => submit(noop());
    await tick(30); // flush other open windows first
    const failedBefore = (await all("SELECT id FROM runs WHERE nest_id = ? AND status = 'failed'", [F])).length;
    // Both attempts' commit finalize throws; the error handler's finalize then succeeds.
    let reads = 0;
    Object.defineProperty(S.judge.judgeTestHooks, "failPurge", { configurable: true, get: () => reads++ < 2 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await say("C412", "U_BOB", "we agreed the cutover moves to friday after the review meeting today");
      await tick(21);
      await tick(21);
    } finally {
      delete (S.judge.judgeTestHooks as { failPurge?: boolean }).failPurge;
      spy.mockRestore();
    }
    const w = await one("SELECT * FROM surface_windows WHERE binding_id = ? ORDER BY opened_at DESC LIMIT 1", [b.data.binding.id]);
    expect(reads).toBe(3);
    expect(w.verdict).toBe("error");
    expect((await all("SELECT id FROM runs WHERE nest_id = ? AND status = 'failed'", [F])).length).toBe(failedBefore);
    expect((await one("SELECT status FROM runs WHERE id = ?", [w.run_id])).status).toBe("succeeded");
  });

  /** Bind a channel and judge one window with the given model answer. */
  async function judgeOnce(channel: string, answer: (req: any) => any, judge?: Record<string, unknown>) {
    setChannel(channel, ["U_ALICE", "U_BOB", "UBOT"]);
    const b = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: channel, nest_id: F }, alice.apiKey);
    expect(b.status, JSON.stringify(b.data)).toBe(201);
    const id = b.data.binding.id as string;
    modelImpl = () => submit(noop());
    await tick(30); // flush other open windows first
    await S.listener.setListenerFolders(id, ["/", "inbox/"]);
    if (judge) expect((await jsonRequest(app, "PATCH", `/surfaces/bindings/${id}`, { judge }, alice.apiKey)).status).toBe(200);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    const calls = modelCalls.length;
    try {
      modelImpl = answer;
      await say(channel, "U_BOB", "we agreed the cutover moves to friday after the review meeting PLATYPUSCHAT");
      await tick(21);
    } finally {
      spy.mockRestore();
      modelImpl = () => submit(noop());
    }
    const w = await one("SELECT * FROM surface_windows WHERE binding_id = ? ORDER BY opened_at DESC LIMIT 1", [id]);
    const run = await one("SELECT * FROM runs WHERE id = ?", [w.run_id]);
    return { id, w, run, trace: JSON.parse(run.trace), logged: logged.filter((l) => l.includes(w.id)), calls: modelCalls.slice(calls) };
  }

  it("EX-1..EX-3, EX-7: a finished call with no usable verdict is a failed run that says why, with its tokens and times; the ledger says the same", async () => {
    const usage = { input_tokens: 3000, output_tokens: 1500 };
    const cut = await judgeOnce("C420", () => ({ content: [], stop_reason: "max_tokens", usage }));
    expect(cut.w).toMatchObject({ verdict: "error_schema", reason_code: "output_limit" });
    expect(cut.run).toMatchObject({ status: "failed", verdict: "error", reason_code: "output_limit" });
    expect(cut.trace.error).toMatch(/ran out of output tokens.*stop: max_tokens/);
    expect(cut.trace.usage).toMatchObject({ input_tokens: 3000, output_tokens: 1500 });
    expect(Date.parse(cut.run.started_at)).toBeLessThanOrEqual(Date.parse(cut.run.finished_at));
    expect(cut.logged).toHaveLength(1);
    expect(cut.logged[0]).toMatch(/reason=output_limit .*max_output_tokens=1500 .*output_tokens=1500/);
    const tr = await jsonRequest(app, "GET", `/ledger/win_${cut.w.id}`, undefined, root.apiKey);
    expect(tr.data.entry.run).toMatchObject({ outcome: "failed", error: cut.trace.error });
    expect(tr.data.entry.verdict.reason_code).toBe("output_limit");

    const mute = await judgeOnce("C421", () => ({ content: [{ type: "text", text: "PLATYPUSCHAT is a no" }], stop_reason: "end_turn", usage }));
    expect(mute.run).toMatchObject({ status: "failed", reason_code: "no_verdict" });
    expect(mute.trace.error).toMatch(/without submitting a decision.*stop: end_turn/);

    const bad = await judgeOnce("C422", (req) => propose(req, { title: `PLATYPUSCHAT ${"x".repeat(81)}` }));
    expect(bad.run).toMatchObject({ status: "failed", reason_code: "invalid_output" });
    expect(bad.trace.error).toBe("The model's decision was invalid. (rule: title)");

    // EX-5: neither the chat nor the model's words are recorded anywhere.
    for (const r of [cut, mute, bad]) expect(JSON.stringify([r.run, r.w, r.logged])).not.toMatch(/PLATYPUS/);
  });

  it("EX-6: a valid no_op is still a succeeded run", async () => {
    const ok = await judgeOnce("C423", () => submit(noop()));
    expect(ok.run).toMatchObject({ status: "succeeded", verdict: "no_op" });
    expect(ok.trace.error).toBeUndefined();
  });

  it("EX-4, EX-5: an error with no fixed explanation shows the provider's own words, without secrets or chat text", async () => {
    const { w, logged } = await failWindow("C424", () => {
      throw Object.assign(new Error("Unsupported parameter: max_tokens for gpt-5 key sk-abcdefghijklmnop1234 PLATYPUSCHAT"), { status: 400 });
    });
    const run = await one("SELECT * FROM runs WHERE id = ?", [w.run_id]);
    expect(run.reason_code).toBe("model_rejected");
    expect(JSON.parse(run.trace).error).toMatch(/refused the request\. \(Unsupported parameter: max_tokens for gpt-5/);
    const lines = logged.filter((l) => l.includes(w.id));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/attempt=1 .*detail="Unsupported parameter/);
    expect(lines[1]).toMatch(/attempt=2/);
    expect(JSON.stringify([run, lines])).not.toMatch(/PLATYPUS|abcdefghijklmnop/);
  });

  it("EX-8, EX-12: saved settings reach the model call and the reservation, and the folders and the tie stay", async () => {
    const judge = { model: "openai/gpt-5", max_output_tokens: 4000, temperature: 0.5, timeout_seconds: 200 };
    const reserved: number[] = [];
    const r = await judgeOnce("C425", (req) => {
      reserved.push(req.max_tokens);
      return submit(noop());
    }, judge);
    expect(r.calls[0]).toMatchObject({ model: "openai/gpt-5", max_tokens: 4000, temperature: 0.5 });
    expect(r.trace.model).toBe("openai/gpt-5");
    expect(S.spend.reservationMicros("openai/gpt-5", 4000)).toBeGreaterThan(S.spend.reservationMicros("openai/gpt-5"));
    const l = await S.listener.listenerFor(r.id);
    expect(l).toBeTruthy();
    expect(S.listener.listenerFolders(l!).folders).toEqual(["/", "inbox/"]);
    const view = await jsonRequest(app, "GET", `/surfaces/bindings/${r.id}`, undefined, alice.apiKey);
    expect(view.data.binding.judge).toMatchObject(judge);
    // A seed re-applied later keeps them.
    await S.listener.setListenerFolders(r.id, ["inbox/"]);
    expect((await jsonRequest(app, "GET", `/surfaces/bindings/${r.id}`, undefined, alice.apiKey)).data.binding.judge).toMatchObject(judge);
  });

  it("EX-9..EX-11: blank keeps today's defaults; out of range, unknown or not an admin is refused and changes nothing; MCP parity", async () => {
    const r = await judgeOnce("C426", () => submit(noop()));
    expect(r.calls[0]).toMatchObject({ max_tokens: 1500, temperature: 0 });
    const url = `/surfaces/bindings/${r.id}`;
    for (const judge of [{ max_output_tokens: 9000 }, { max_output_tokens: 600.5 }, { temperature: 2 }, { timeout_seconds: 5 }, { model: "bad name!" }, { folders: ["x/"] }, { folders: [] }, { name: "<b>" }, { max_turns: 1 }, { max_items: 4 }, { enabled: true }, { feeds: [] }, "x"]) {
      expect((await jsonRequest(app, "PATCH", url, { judge }, alice.apiKey)).status, JSON.stringify(judge)).toBe(422);
    }
    expect((await jsonRequest(app, "PATCH", url, { judge: { temperature: 1 }, explicit_public_bind: false }, alice.apiKey)).status).toBe(422);
    expect((await jsonRequest(app, "PATCH", url, { judge: { temperature: 1 } }, bob.apiKey)).status).toBe(403);
    const unset = { name: null, avatar: null, folders: null, max_turns: null, max_items: null, model: null, max_output_tokens: null, temperature: null, timeout_seconds: null };
    expect((await jsonRequest(app, "GET", url, undefined, alice.apiKey)).data.binding.judge).toEqual(unset);
    // The values in use, for the dialog: what the judge call above really used.
    const inUse = (await jsonRequest(app, "GET", url, undefined, alice.apiKey)).data.binding.judge_defaults;
    expect(inUse).toMatchObject({ max_output_tokens: r.calls[0].max_tokens, temperature: r.calls[0].temperature, max_turns: 4, max_items: 3, timeout_seconds: 120 });
    // The configured name; the call itself may carry the gateway's provider prefix.
    expect(inUse.model).toBe(r.calls[0].model.split("/").pop());
    expect(inUse.name).toMatch(/^c426 nest agent /);
    const mcp = await app.request(`/nests/${F}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${alice.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_surfaces_binding_update", arguments: { binding_id: r.id, judge: { max_output_tokens: 2000 } } } }),
    });
    expect(mcp.status).toBe(200);
    expect((await jsonRequest(app, "GET", url, undefined, alice.apiKey)).data.binding.judge).toEqual({ ...unset, max_output_tokens: 2000 });
    expect((await jsonRequest(app, "PATCH", url, { judge: { max_output_tokens: null } }, alice.apiKey)).data.binding.judge).toEqual(unset);
  });

  it("EX-13, EX-14: name, folders, steps and suggestions per run take effect, and the listener stays tied", async () => {
    const r = await judgeOnce("C427", (req) => {
      const one = propose(req, { title: "Cutover moves to Friday", target_folder: "inbox/", confidence: 0.8 });
      const item = one.content[0].input.items[0];
      one.content[0].input.items = [item, { ...item, title: "Billing uses annual plans", summary: "Plans are billed yearly.", body: "Plans are billed yearly.", confidence: 0.95 }];
      return one;
    }, { name: "General ears", avatar: "🦉", folders: ["inbox/"], max_turns: 2, max_items: 1 });
    const l = (await S.listener.listenerFor(r.id))!;
    expect(l).toBeTruthy();
    expect(l.persona.name).toBe("General ears");
    expect(S.listener.listenerFolders(l).folders).toEqual(["inbox/"]);
    expect(r.calls[0].system).toContain('target_folder must be one of: "inbox/"');
    expect(JSON.parse(r.w.blocked)).toEqual({ over_limit: 1 });
    expect(r.w.item_count).toBe(1);
    // EX-22: the draft names the listener as creator, editor and requester, never its internal address.
    const made = await one("SELECT i.node_id FROM surface_proposal_items i JOIN surface_proposals p ON p.id = i.proposal_id WHERE p.window_id = ?", [r.w.id]);
    const doc = await jsonRequest(app, "GET", `/nests/${F}/nodes/${made.node_id}`, undefined, alice.apiKey);
    expect(doc.status).toBe(200);
    const shown = doc.data.node ?? doc.data;
    expect(shown.author_name).toBe("General ears");
    expect(shown.last_edit.edited_by_system).toBe("General ears");
    const queue = await jsonRequest(app, "GET", `/nests/${F}/review-queue`, undefined, alice.apiKey);
    expect(queue.status).toBe(200);
    expect((queue.data.requests ?? []).find((x: any) => x.nodeId === made.node_id)?.requestedByName).toBe("General ears");
    const tr = await jsonRequest(app, "GET", `/ledger/win_${r.w.id}`, undefined, root.apiKey);
    expect(tr.data.entry.agent.name).toBe("General ears");
    const roll = await jsonRequest(app, "GET", `/nests/${F}/rollups?${new URLSearchParams({ ...range(), by: "agent", grain: "week" })}`, undefined, root.apiKey);
    expect(roll.status).toBe(200);
    expect(roll.data.rows.map((x: any) => x.label)).toContain("General ears");

    // EX-15: with no name of its own, a listener is called by its channel, on every screen.
    expect((await jsonRequest(app, "PATCH", `/surfaces/bindings/${r.id}`, { judge: { name: null } }, alice.apiKey)).status).toBe(200);
    const called = `c427 nest agent ${l.node_id.split("-").pop()}`;
    expect((await jsonRequest(app, "GET", `/ledger/win_${r.w.id}`, undefined, root.apiKey)).data.entry.agent.name).toBe(called);
    const again = await jsonRequest(app, "GET", `/nests/${F}/rollups?${new URLSearchParams({ ...range(), by: "agent", grain: "week" })}`, undefined, root.apiKey);
    expect(again.data.rows.map((x: any) => x.label)).toContain(called);
    const list = await jsonRequest(app, "GET", `/nests/${F}/metacognition`, undefined, alice.apiKey);
    expect(list.data.agents.find((a: any) => a.node_id === l.node_id).persona.name).toBe(called);

    // Two steps: a third turn is never asked for.
    const loop = await judgeOnce("C428", () => ({ content: [{ type: "tool_use", id: `t${Math.random()}`, name: "list_nodes", input: { folder: "inbox" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 10 } }), { max_turns: 2 });
    expect(loop.calls).toHaveLength(2);
    expect(loop.run).toMatchObject({ status: "failed", reason_code: "no_verdict" });
    expect(loop.trace.error).toMatch(/stop: turn_limit/);

    // A folder the starter drops later is not brought back by the choice.
    await S.listener.setListenerFolders(r.id, ["/"]);
    expect(S.listener.listenerFolders((await S.listener.listenerFor(r.id))!).folders).toEqual([]);
  });

  it("a rate limit (429) and a timeout end as model_rate_limited and model_timeout", async () => {
    const limited = await failWindow("C408", () => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    });
    expect(limited.w.reason_code).toBe("model_rate_limited");
    const timedOut = await failWindow("C409", () => {
      throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
    });
    expect(timedOut.w.reason_code).toBe("model_timeout");
    const run = await one("SELECT status, trace FROM runs WHERE id = ?", [timedOut.w.run_id]);
    expect(run.status).toBe("failed");
    expect(JSON.parse(run.trace).timeout).toBe(true);
  });
});
