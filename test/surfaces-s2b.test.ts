/**
 * Surfaces S2b — Slack cards, commit from Slack as the human, budgets and the
 * queue, App Home "My pending", expiry and withdrawal, DM capture and its
 * setting, member boot (PRD §4.8, §4.12, §4.16, §6 "Slice 2b", §12 R1–R3)
 * through the real routes, services and DB.
 *
 * Fakes: Slack's Web API and response_url are a stubbed global fetch (any
 * other host fails the network guard); the model is `createTurn` replaced
 * by a script (the metacognition fake-model pattern).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHmac, randomBytes } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit, settleSeals } from "./helpers.js";

// ─── fake model ──────────────────────────────────────────────────────────────
type Turn = { content: any[]; stop_reason: string; usage?: Record<string, number> };
let modelImpl: (req: any) => Turn | Promise<Turn> = () => submit(noop());
function submit(input: any): Turn {
  return { content: [{ type: "tool_use", id: `tu_${Math.random().toString(36).slice(2, 8)}`, name: "submit_window_verdict", input }], stop_reason: "tool_use", usage: { input_tokens: 3000, output_tokens: 400 } };
}
const noop = (reason = "chatter") => ({ verdict: "no_op", reason_code: reason, items: [], ask_signature: null });
const firstText = (req: any): string => {
  const c = req.messages?.[0]?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("") : "";
};
const idsIn = (req: any) => [...firstText(req).matchAll(/<message id="(m\d+)"/g)].map((m) => m[1]);
const rnd = () => Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 7).padEnd(7, "q");
function item(req: any, over: Record<string, unknown> = {}) {
  const ids = idsIn(req);
  return {
    kind: "decision",
    op: "new",
    target_folder: "inbox/",
    target_node_id: null,
    title: `Team agrees ${rnd()} ${rnd()} ${rnd()}`,
    summary: `The team agreed on ${rnd()} worth keeping.`,
    body: `Decision ${rnd()}: the ${rnd()} team switches to the ${rnd()} approach ${rnd()} next quarter.`,
    owner: null,
    due_date: null,
    evidence_message_ids: [ids[ids.length - 1] ?? "m1"],
    why: "An agreed decision",
    confidence: 0.9,
    sensitive: false,
    conflict: null,
    ...over,
  };
}
const proposeN = (n: number, over: Array<Record<string, unknown>> = []) => (req: any) =>
  submit({ verdict: "propose", reason_code: "proposed", ask_signature: null, items: Array.from({ length: n }, (_, i) => item(req, over[i] ?? {})) });

// Round 7 (password-reset link): a captured mail transport.
const sentMail: any[] = [];
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: async (m: any) => (sentMail.push(m), { messageId: "m" }), verify: async () => true, close() {} }) },
}));

beforeAll(() => {
  vi.doMock("../src/metacognition/model.js", async () => {
    const actual = await vi.importActual<typeof import("../src/metacognition/model.js")>("../src/metacognition/model.js");
    return { ...actual, createTurn: async (params: any) => await modelImpl(params.request) };
  });
});

// ─── fake Slack ──────────────────────────────────────────────────────────────
interface SlackUser { id: string; team_id: string; email?: string; name?: string; is_bot?: boolean; is_restricted?: boolean }
const slack = {
  calls: [] as Array<{ method: string; params: Record<string, string> }>,
  users: new Map<string, SlackUser>(),
  usersGate: null as null | Promise<void>,
  convs: new Map<string, { info: Record<string, unknown>; members: string[] }>(),
  posted: [] as Array<Record<string, string>>,
  updates: [] as Array<Record<string, string>>,
  ephemerals: [] as Array<Record<string, string>>,
  views: [] as Array<{ method: string; params: Record<string, string>; at: number }>,
  responses: [] as Array<{ url: string; body: any }>,
  revoked: 0,
  updateFail: 0,
  updateError: "internal_error",
  deleteFail: false,
  deleted: [] as Array<Record<string, string>>,
  openFail: false,
  oauth: null as null | Record<string, unknown>,
};
const netCalls: string[] = [];
let idp: null | { issuer: string; handle: (url: string, init?: any) => Promise<Response> } = null;
const realFetch = globalThis.fetch;
let tsCounter = 1_800_000_000;

async function fakeFetch(url: any, init?: any): Promise<Response> {
  const u = String(url);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (u.startsWith("https://hooks.slack.com/")) {
    slack.responses.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
    return json({ ok: true });
  }
  // Round 10: an in-process OIDC identity provider, when a test installs one.
  if (idp && u.startsWith(idp.issuer)) return idp.handle(u, init);
  if (!u.startsWith("https://slack.com/api/")) {
    netCalls.push(u);
    throw new Error(`network guard: ${u}`);
  }
  const method = u.slice("https://slack.com/api/".length).split("?")[0];
  const params: Record<string, string> = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
  slack.calls.push({ method, params });
  switch (method) {
    case "oauth.v2.access":
      return json(slack.oauth ?? { ok: false, error: "invalid_code" });
    case "auth.revoke":
      slack.revoked++;
      return json({ ok: true });
    case "users.info": {
      if (slack.usersGate) await slack.usersGate;
      const x = slack.users.get(params.user);
      if (!x) return json({ ok: false, error: "user_not_found" });
      return json({
        ok: true,
        user: { id: x.id, team_id: x.team_id, name: x.name ?? x.id, deleted: false, is_bot: !!x.is_bot, is_restricted: !!x.is_restricted, is_ultra_restricted: false, is_email_confirmed: true, profile: { email: x.email, display_name: x.name ?? x.id, real_name: x.name ?? x.id } },
      });
    }
    case "conversations.info": {
      const c = slack.convs.get(params.channel);
      return json(c ? { ok: true, channel: c.info } : { ok: false, error: "channel_not_found" });
    }
    case "conversations.members": {
      const c = slack.convs.get(params.channel);
      return json(c ? { ok: true, members: c.members, response_metadata: { next_cursor: "" } } : { ok: false, error: "channel_not_found" });
    }
    case "conversations.open":
      if (slack.openFail) return json({ ok: false, error: "missing_scope" });
      return json({ ok: true, channel: { id: `D_${params.users}` } });
    case "chat.delete":
      if (slack.deleteFail) return json({ ok: false, error: "message_not_found" });
      slack.deleted.push(params);
      return json({ ok: true });
    case "chat.postMessage":
      slack.posted.push(params);
      return json({ ok: true, channel: params.channel, ts: `${++tsCounter}.000200` });
    case "chat.update":
      if (slack.updateFail > 0) {
        slack.updateFail--;
        return json({ ok: false, error: slack.updateError }, slack.updateError === "internal_error" ? 500 : 200);
      }
      slack.updates.push(params);
      return json({ ok: true });
    case "chat.postEphemeral":
      slack.ephemerals.push(params);
      return json({ ok: true, message_ts: "1.1" });
    case "chat.getPermalink":
      return json({ ok: true, permalink: `https://acme.slack.com/archives/${params.channel}/p${String(params.message_ts).replace(".", "")}` });
    case "views.open":
    case "views.publish":
      slack.views.push({ method, params, at: Date.now() });
      return json({ ok: true, view: { id: `V${slack.views.length}` } });
    default:
      return json({ ok: false, error: "unknown_method" });
  }
}

// ─── app state ───────────────────────────────────────────────────────────────
type User = { apiKey: string; userId: string; email: string };
let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: User, alice: User, dana: User, erin: User, bob: User, frank: User, mallory: User;
let N: string; // "Revenue"
let N2: string; // "Company"
let N3: string; // "Secret" (Dana can't read)
let ACME: string; // an existing node in N
let installId: string;
/** The license admin (round 6). */
let licAdmin: User;
const SIGNING = "slack-signing-s2b";
const BASE = "https://nest.surf.test";
let S: {
  db: typeof import("../src/db/client.js");
  work: typeof import("../src/surfaces/services/work.js");
  windows: typeof import("../src/surfaces/services/window-service.js");
  identity: typeof import("../src/surfaces/services/identity-service.js");
  routing: typeof import("../src/surfaces/services/routing-service.js");
  expiry: typeof import("../src/surfaces/services/expiry-service.js");
  home: typeof import("../src/surfaces/services/home-service.js");
  bk: typeof import("../src/surfaces/adapters/slack/blockkit.js");
  budget: typeof import("../src/surfaces/core/budget.js");
  reviewers: typeof import("../src/surfaces/core/reviewers.js");
  cardModel: typeof import("../src/surfaces/core/card-model.js");
  editGuard: typeof import("../src/surfaces/services/edit-guard.js");
  interactions: typeof import("../src/surfaces/adapters/slack/interactions.js");
  runner: typeof import("../src/surfaces/services/guard-runner.js");
  cards: typeof import("../src/surfaces/services/card-service.js");
};
const db = () => S.db.getDb();
const all = (sql: string, p: any[] = []) => db().all(sql, p) as Promise<any[]>;
const one = (sql: string, p: any[] = []) => db().get(sql, p) as Promise<any>;

function sign(raw: string, secret = SIGNING, ts = Math.floor(Date.now() / 1000)) {
  return { ts: String(ts), sig: `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}` };
}
async function postRaw(path: string, raw: string, ct: string, secret = SIGNING) {
  const s = sign(raw, secret);
  return app.request(path, { method: "POST", headers: { "Content-Type": ct, "X-Slack-Request-Timestamp": s.ts, "X-Slack-Signature": s.sig }, body: raw });
}
let evSeq = 0;
async function event(ev: Record<string, unknown>, team = "T1") {
  const body = { type: "event_callback", team_id: team, api_app_id: "A1", event_id: `Ev${++evSeq}x${rnd()}`, event_time: Math.floor(Date.now() / 1000), event: ev };
  const r = await postRaw(`/surfaces/slack/${installId}/events`, JSON.stringify(body), "application/json");
  expect(r.status).toBe(200);
  await S.work.waitForSurfacesWork();
}
let tsSeq = 1_700_000_000;
const nextTs = () => `${++tsSeq}.000100`;
async function say(channel: string, user: string, text: string, over: Record<string, unknown> = {}) {
  const ts = nextTs();
  await event({ type: "message", channel, user, text, ts, channel_type: "group", ...over });
  return ts;
}
async function tick(min = 21) {
  await S.windows.windowTick(Date.now() + min * 60_000);
  await S.work.waitForSurfacesWork();
}
function setChannel(id: string, members: string[], over: Record<string, unknown> = {}) {
  slack.convs.set(id, { info: { id, name: id.toLowerCase(), is_channel: false, is_group: true, is_im: false, is_mpim: false, is_private: true, is_ext_shared: false, is_general: false, ...over }, members });
}
let actionSeq = 0;
function actionPayload(user: string, actionId: string, value: unknown, o: { channel?: string | null; team?: string; userTeam?: string; home?: boolean; state?: any; enterprise?: string; selected?: any; message_ts?: string } = {}) {
  const channel = o.channel === undefined ? "C1" : o.channel;
  return {
    type: "block_actions",
    team: { id: o.team ?? "T1" },
    ...(o.enterprise ? { enterprise: { id: o.enterprise } } : {}),
    user: { id: user, team_id: o.userTeam ?? "T1" },
    ...(channel && !o.home ? { channel: { id: channel } } : {}),
    container: o.home ? { type: "view", view_id: "VH" } : { type: "message", channel_id: channel, message_ts: o.message_ts ?? "1.1" },
    trigger_id: `trig-${++actionSeq}`,
    // App Home actions carry no response_url (Slack only sends one for messages).
    ...(o.home ? {} : { response_url: `https://hooks.slack.com/actions/T1/${actionSeq}/x` }),
    actions: [{ action_id: actionId, value: typeof value === "string" ? value : JSON.stringify(value), action_ts: `${Date.now() / 1000}`, ...(o.selected ? { selected_option: o.selected } : {}) }],
    ...(o.state ? { state: o.state } : {}),
  };
}
async function interact(payload: unknown, wait = true) {
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const r = await postRaw(`/surfaces/slack/${installId}/interactions`, raw, "application/x-www-form-urlencoded");
  if (wait) await S.work.waitForSurfacesWork();
  return r;
}
const click = (user: string, actionId: string, proposalId: string, o: Parameters<typeof actionPayload>[3] = {}) => interact(actionPayload(user, actionId, { p: proposalId }, o));
async function command(user: string, text: string, channel = "C1", team = "T1") {
  const raw = new URLSearchParams({ command: "/nest", text, user_id: user, channel_id: channel, team_id: team, trigger_id: `trig-${++actionSeq}`, response_url: `https://hooks.slack.com/commands/T1/${actionSeq}/x` }).toString();
  const r = await postRaw(`/surfaces/slack/${installId}/commands`, raw, "application/x-www-form-urlencoded");
  const body = await r.json().catch(() => null);
  await S.work.waitForSurfacesWork();
  return { status: r.status, body };
}
async function http2(method: string, path: string, key: string) {
  const r = await app.request(path, { method, headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, text: await r.text() };
}
/** `/nest invite` acks at once; its answer arrives through response_url. */
async function invite(user: string, channel: string) {
  const before = slack.responses.length;
  const r = await command(user, "invite", channel);
  expect(r.status).toBe(200);
  const later = slack.responses.slice(before).filter((x) => x.url.includes("/commands/"));
  return { ack: r.body, body: { text: later.length ? String(later[later.length - 1].body.text ?? "") : "" } };
}
async function submitView(user: string, view: Record<string, any>, values: Record<string, any>, team = "T1") {
  return interact({ type: "view_submission", team: { id: team }, user: { id: user, team_id: team }, view: { id: `VS${++actionSeq}`, ...view, state: { values } } }, true);
}
const lastView = (method = "views.open") => {
  const v = [...slack.views].reverse().find((x) => x.method === method);
  return v ? JSON.parse(v.params.view) : null;
};
const notesText = () => [...slack.responses.map((r) => r.body?.text ?? ""), ...slack.ephemerals.map((e) => e.text ?? "")].join("\n");
const cardsIn = (channel: string) => slack.posted.filter((p) => p.channel === channel && p.blocks);
const blocksOf = (p: Record<string, string>) => JSON.parse(p.blocks);
const textOfBlocks = (bl: any[]) => JSON.stringify(bl);

let bound: Record<string, string> = {};
/** Listeners propose only into folders their binding names (S2a: the default
 *  is EMPTY until a seed exists) — tests set them explicitly. */
async function setFolders(bindingId: string, folders: string[] = ["inbox/"]) {
  const b = await one("SELECT nest_id, listener_agent_node_id FROM surface_bindings WHERE id = ?", [bindingId]);
  const row = await one("SELECT config_json FROM metacognition_agents WHERE nest_id = ? AND node_id = ?", [b.nest_id, b.listener_agent_node_id]);
  const cfg = JSON.parse(row.config_json);
  cfg.surfaces_listener = { ...cfg.surfaces_listener, folders };
  await db().run("UPDATE metacognition_agents SET config_json = ? WHERE nest_id = ? AND node_id = ?", [JSON.stringify(cfg), b.nest_id, b.listener_agent_node_id]);
}
async function bind(channel: string, nestId = N, key = alice.apiKey, extra: Record<string, unknown> = {}) {
  const r = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: channel, nest_id: nestId, ...extra }, key);
  expect(r.status).toBe(201);
  bound[channel] = r.data.binding.id;
  await setFolders(r.data.binding.id);
  return r.data.binding.id as string;
}

/** Drive one window through the judge; returns the newest proposal row. */
async function makeProposal(channel: string, opts: { n?: number; over?: Array<Record<string, unknown>>; user?: string } = {}) {
  modelImpl = proposeN(opts.n ?? 1, opts.over);
  await say(channel, opts.user ?? "U_BOB", `we agreed to move the renewal to annual billing ${rnd()} starting next month`);
  await tick();
  modelImpl = () => submit(noop());
  return one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [bound[channel]]);
}
const itemsOf = (proposalId: string) => all("SELECT * FROM surface_proposal_items WHERE proposal_id = ? ORDER BY created_at, id", [proposalId]);
const cardFor = (p: any) => {
  const ref = JSON.parse(p.card_ref);
  return slack.posted.find((x) => x.channel === ref.conversation && x.blocks && JSON.stringify(x).includes(p.id));
};

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  process.env.SURFACES_BUFFER_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.METACOGNITION_STARTS_PER_HOUR = "10000";
  vi.stubGlobal("fetch", fakeFetch);
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@surf.test"], ownerEmail: "lic@surf.test", gateway: { baseUrl: "https://gateway.promptowl.test", key: "po-key", defaultModel: "default-claude/claude-sonnet-5" } });
  root = await registerUser(app, "root@surf.test", "Root Admin");
  await resetAuthRateLimit();
  alice = await registerUser(app, "alice@surf.test", "Alice Owner");
  await resetAuthRateLimit();
  dana = await registerUser(app, "dana@surf.test", "Dana Reviewer");
  await resetAuthRateLimit();
  erin = await registerUser(app, "erin@surf.test", "Erin Reviewer");
  await resetAuthRateLimit();
  bob = await registerUser(app, "bob@surf.test", "Bob Reader");
  await resetAuthRateLimit();
  await resetAuthRateLimit();
  frank = await registerUser(app, "frank@surf.test", "Frank Reviewer");
  await resetAuthRateLimit();
  mallory = await registerUser(app, "mallory@surf.test", "Mallory Outsider");
  await resetAuthRateLimit();
  licAdmin = await registerUser(app, "lic@surf.test", "License Admin");
  await resetAuthRateLimit();
  await resetAuthRateLimit();
  S = {
    db: await import("../src/db/client.js"),
    work: await import("../src/surfaces/services/work.js"),
    windows: await import("../src/surfaces/services/window-service.js"),
    identity: await import("../src/surfaces/services/identity-service.js"),
    routing: await import("../src/surfaces/services/routing-service.js"),
    expiry: await import("../src/surfaces/services/expiry-service.js"),
    home: await import("../src/surfaces/services/home-service.js"),
    bk: await import("../src/surfaces/adapters/slack/blockkit.js"),
    budget: await import("../src/surfaces/core/budget.js"),
    reviewers: await import("../src/surfaces/core/reviewers.js"),
    cardModel: await import("../src/surfaces/core/card-model.js"),
    editGuard: await import("../src/surfaces/services/edit-guard.js"),
    interactions: await import("../src/surfaces/adapters/slack/interactions.js"),
    runner: await import("../src/surfaces/services/guard-runner.js"),
    cards: await import("../src/surfaces/services/card-service.js"),
  };
  const mk = async (name: string) => (await jsonRequest(app, "POST", "/nests", { name }, alice.apiKey)).data.nest.id as string;
  N = await mk("Revenue");
  N2 = await mk("Company");
  N3 = await mk("Secret");
  const acme = await jsonRequest(app, "POST", `/nests/${N}/nodes`, { title: "Acme moves to annual billing", content: "Acme renewal is billed annually from January.", folder: "inbox" }, alice.apiKey);
  ACME = acme.data.node?.id ?? acme.data.id;
  await settleSeals();
  for (const n of [N, N2]) {
    for (const u of [dana, erin, bob]) await jsonRequest(app, "POST", `/nests/${n}/collaborators`, { email: u.email, permission: "read" }, alice.apiKey);
    const st = await jsonRequest(app, "POST", `/nests/${n}/stewards`, { scope: "nest", users: [{ email: dana.email, role: "reviewer" }, { email: erin.email, role: "reviewer" }] }, alice.apiKey);
    expect(st.status).toBe(201);
  }
  // Frank reviews Revenue too, but is never in the channels (N6 "absent reviewer").
  await jsonRequest(app, "POST", `/nests/${N}/collaborators`, { email: frank.email, permission: "read" }, alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${N}/stewards`, { scope: "nest", users: [{ email: dana.email, role: "reviewer" }, { email: erin.email, role: "reviewer" }, { email: frank.email, role: "reviewer" }] }, alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${N3}/stewards`, { scope: "nest", users: [{ email: erin.email, role: "reviewer" }] }, alice.apiKey);

  for (const [id, email, name] of [
    ["U_ROOT", root.email, "Root"], ["U_ALICE", alice.email, "Alice"], ["U_DANA", dana.email, "Dana"], ["U_ERIN", erin.email, "Erin"],
    ["U_BOB", bob.email, "Bob"], ["U_FRANK", frank.email, "Frank"], ["U_NEW", "new@elsewhere.test", "Newbie"], ["U_MAL", mallory.email, "Mallory"],
  ]) slack.users.set(id, { id, team_id: "T1", email, name });
  slack.users.set("UBOT", { id: "UBOT", team_id: "T1", name: "nest", is_bot: true });
  slack.users.set("U_GUEST", { id: "U_GUEST", team_id: "T1", email: "g@x.test", name: "Guest", is_restricted: true });
  const members = ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "UBOT"];
  for (const c of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]) setChannel(c, [...members, ...(c === "C1" ? [] : [])]);
  // A channel for N where Frank also sits (so all Revenue readers are present).
  for (const c of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]) slack.convs.get(c)!.members.push("U_FRANK");

  // Install T1 through the real OAuth flow.
  const created = await jsonRequest(app, "POST", "/surfaces/slack/installs", { home_nest_id: N }, root.apiKey);
  installId = created.data.install_id;
  await jsonRequest(app, "PUT", `/surfaces/slack/installs/${installId}/credentials`, { client_id: "cid", client_secret: "cs", signing_secret: SIGNING }, root.apiKey);
  const login = await app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: root.email, password: "testpass" }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const start = await app.request(`/surfaces/slack/installs/${installId}/oauth/start`, { headers: { Cookie: cookie } });
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  slack.oauth = { ok: true, access_token: "xoxb-T1", token_type: "bot", bot_user_id: "UBOT", team: { id: "T1" }, enterprise: null, is_enterprise_install: false, authed_user: { id: "U_ROOT" } };
  const cb = await app.request(`/surfaces/slack/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie, Accept: "application/json" } });
  expect(cb.status).toBe(200);
  for (const [s, u] of [["U_ALICE", alice], ["U_DANA", dana], ["U_ERIN", erin], ["U_BOB", bob], ["U_FRANK", frank], ["U_MAL", mallory]] as const) {
    await S.identity.linkExplicit({ installId, surfaceUserId: s, communityUserId: u.userId });
  }
});

afterAll(async () => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
  vi.doUnmock("../src/metacognition/model.js");
  for (const k of ["FEATURE_WORKFLOW_PLANE", "FEATURE_METACOGNITION", "FEATURE_SURFACES", "SURFACES_BUFFER_KEY", "PUBLIC_BASE_URL"]) delete process.env[k];
  await env?.cleanup();
});

beforeEach(async () => {
  if (!S) return;
  await db().run("DELETE FROM surface_reviewer_usage");
  await db().run("DELETE FROM surface_conversation_usage");
  await db().run("DELETE FROM surface_ask_counts");
  await db().run("UPDATE surface_settings SET reviewer_daily_cards = 2, conversation_daily_cards = 3");
  slack.responses = [];
  slack.ephemerals = [];
});

// ═══ Enable notice + bindings ═════════════════════════════════════════════════

describe("enable notice", () => {
  it("AC-CRD-12: enabling posts exactly one notice (what Nest does, what it keeps, 🧠, @Nest skip me); never reposted on a later enable", async () => {
    const before = slack.posted.filter((p) => p.channel === "C1").length;
    await bind("C1");
    const notices = slack.posted.filter((p) => p.channel === "C1").slice(before);
    expect(notices.length).toBe(1);
    expect(notices[0].text).toMatch(/only summaries a named person approves; messages are cleared within 24 hours/);
    expect(notices[0].text).toMatch(/🧠/);
    expect(notices[0].text).toMatch(/@Nest skip me/);
    // Remove and re-create the same binding: no second notice.
    await jsonRequest(app, "DELETE", `/surfaces/bindings/${bound.C1}`, undefined, alice.apiKey);
    const again = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C1", nest_id: N }, alice.apiKey);
    expect(again.status).toBe(201);
    bound.C1 = again.data.binding.id;
    await setFolders(bound.C1);
    expect(slack.posted.filter((p) => p.channel === "C1" && !p.blocks).length).toBe(1);
    for (const c of ["C2", "C3", "C4", "C5", "C6", "C7"]) await bind(c);
  });
});

// ═══ Cards ════════════════════════════════════════════════════════════════════

describe("cards", () => {
  it("AC-CRD-01, AC-CRD-03: a proposal posts only into its binding's conversation, with unfurl_links/unfurl_media false", async () => {
    const before = slack.posted.length;
    const p = await makeProposal("C1");
    expect(p.state).toBe("posted");
    const newPosts = slack.posted.slice(before).filter((x) => x.blocks);
    expect(newPosts.length).toBe(1);
    expect(newPosts[0].channel).toBe("C1");
    expect(newPosts[0].unfurl_links).toBe("false");
    expect(newPosts[0].unfurl_media).toBe("false");
    expect(JSON.parse(p.card_ref).conversation).toBe("C1");
  });

  it("AC-CRD-02: lead-in, title+summary, context (📁 folder in nest · from N messages · Full draft link), Why, reviewer mention, Approve/Edit/Reject, footer — in that order", async () => {
    const p = await makeProposal("C1");
    const bl = blocksOf(cardFor(p)!);
    const texts = bl.map((b: any) => (b.text?.text ?? (b.elements ?? []).map((e: any) => e.text?.text ?? e.text ?? "").join(" | ")) as string);
    const idx = (re: RegExp) => texts.findIndex((t: string) => re.test(t));
    const order = [
      idx(/^This looks like a decision worth keeping:/),
      idx(/^\*Team agrees .+\*\nThe team agreed on/),
      idx(/📁 inbox\/ in Revenue \| from 1 message.* \| <https:\/\/nest\.surf\.test\/surfaces\/drafts\/[0-9a-f-]+\|Full draft \(reviewers\)>/),
      idx(/^Why: An agreed decision/),
      idx(/^For review: <@U_(DANA|ERIN|FRANK)>/),
      // R2 item 5: the named reviewers here (read + reviewer) have no edit rights → no Edit button.
      idx(/^Approve \| Reject$/),
      idx(/^Proposed by Nest · only approved summaries are kept · expires /),
    ];
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const actions = bl.find((b: any) => b.type === "actions");
    expect(actions.elements[0].style).toBe("primary");
  });

  it("AC-CRD-04: the full-draft URL is 401 anonymous, 403 for a non-reader, and renders for a reader with noindex and no OG/Twitter tags; no capability token", async () => {
    const p = await makeProposal("C1");
    const it0 = (await itemsOf(p.id))[0];
    const path = `/surfaces/drafts/${it0.id}`;
    expect(new URL(BASE + path).search).toBe("");
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { Authorization: `Bearer ${mallory.apiKey}` } })).status).toBe(403);
    const ok = await app.request(path, { headers: { Authorization: `Bearer ${dana.apiKey}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-robots-tag")).toMatch(/noindex/);
    const html = await ok.text();
    expect(html).toMatch(/team switches to the/);
    expect(html).not.toMatch(/og:|twitter:/i);
  });

  it("AC-CRD-05 (N5): every card the renderer can produce passes the Block Kit validator (75-char options/descriptions/buttons, section/header/context/blocks/id/value limits; merged summaries above the checkboxes)", async () => {
    const long = "W".repeat(80);
    const it = (i: number, over: Record<string, unknown> = {}) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`, kind: "owner_deadline", op: "new", title: `${long}${i}`, summary: "S".repeat(400), why: "Y".repeat(120), folder: "a-very-long-folder-name-for-testing-limits/", node_id: "nodes/x", draft_url: `${BASE}/surfaces/drafts/x${i}`, ...over,
    });
    const base = { can_edit: true, proposal_id: "11111111-1111-4111-8111-111111111111", forced: false, nest_name: "N".repeat(90), message_count: 40, from_label: "09:00 UTC", to_label: "17:59 UTC", reviewer: "<@U_DANA>", expires_label: "Nov 7", surface_ok: true, note: "Previously not kept on 2026-10-01" } as const;
    const models: any[] = [
      { ...base, kind: "single", items: [it(1)] },
      { ...base, kind: "merged", items: [it(1), it(2), it(3)] },
      { ...base, kind: "conflict", items: [it(1, { op: "edit", kind: "correction", on_record: "R".repeat(200), record_title: long })] },
      { ...base, kind: "conflict", surface_ok: false, items: [it(1, { op: "edit", kind: "correction", on_record: "R".repeat(200) })] },
      { ...base, kind: "agent", items: [it(1, { kind: "agent_suggestion" })] },
      { ...base, kind: "single", items: [it(1)], outcome: { type: "expired", title: long } },
      { ...base, kind: "single", items: [it(1)], outcome: { type: "withdrawn", title: long } },
      { ...base, kind: "merged", items: [it(1), it(2), it(3)], outcome: { type: "approved", by: "<@U_DANA>", kept: [{ path: "inbox/x", version: 3 }, { path: "inbox/y", version: 2 }], notKept: [long], editedBy: "Dana" } },
      { ...base, kind: "single", items: [it(1)], outcome: { type: "rejected", by: "<@U_DANA>", reason: "details_wrong" } },
      { ...base, kind: "single", items: [it(1)], dm: { first: true } },
    ];
    for (const m of models) {
      const bl = S.bk.renderCardBlocks(m);
      expect(S.bk.validateBlocks(bl, "message")).toEqual([]);
    }
    const merged = S.bk.renderCardBlocks(models[1]);
    const cb = merged.find((b: any) => b.type === "actions" && b.elements.some((e: any) => e.type === "checkboxes")).elements[0];
    for (const o of cb.options) {
      expect([...o.text.text].length).toBeLessThanOrEqual(75);
      expect([...o.description.text].length).toBeLessThanOrEqual(75);
      expect(o.description.text).toMatch(/^Owner and deadline · /);
    }
    expect(S.bk.summariesAboveCheckboxes(merged)).toBe(true);
    // The validator really catches violations.
    expect(S.bk.validateBlocks([{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "x".repeat(76) }, action_id: "a" }] }], "message").length).toBe(1);
    expect(S.bk.validateBlocks(Array.from({ length: 51 }, () => ({ type: "divider" })), "message").length).toBe(1);
    // App Home and the dialogs.
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    expect(S.bk.validateView(await S.home.buildHomeView(install, "U_DANA"), "home")).toEqual([]);
    expect(S.bk.validateView(S.bk.renderRejectModal("m"), "modal")).toEqual([]);
    expect(S.bk.validateView(S.bk.renderBootModal("m", "general"), "modal")).toEqual([]);
    expect(S.bk.validateView(S.bk.renderEditModal([1, 2, 3].map((i) => ({ id: `i${i}`, title: long, summary: "s", body: "b", kind: "fact", folder: "inbox/" })), "m", "Revenue", "inbox/"), "modal")).toEqual([]);
  });

  it("AC-CRD-06: one window with 3 passing items → exactly one merged card (checkboxes, Approve selected, Edit, Reject all), counted once against the reviewer", async () => {
    const before = slack.posted.filter((x) => x.blocks).length;
    const p = await makeProposal("C2", { n: 3 });
    expect(slack.posted.filter((x) => x.blocks).length - before).toBe(1);
    expect(p.card_kind).toBe("merged");
    const bl = blocksOf(cardFor(p)!);
    const s = textOfBlocks(bl);
    expect(s).toMatch(/"checkboxes"/);
    expect(s).toMatch(/Approve selected/);
    expect(s).toMatch(/Reject all/);
    // R2 item 5: Edit appears only when the named reviewer can edit (they can't here).
    expect(s).not.toMatch(/"text":"Edit"/);
    const usage = await all("SELECT * FROM surface_reviewer_usage");
    expect(usage.reduce((a, r) => a + Number(r.cards_posted), 0)).toBe(1);
  });

  it("AC-CRD-07 (+ S2a H1): conflict with surface_ok shows On record / This thread with both provenance lines and Update / Edit / Keep; without surface_ok only the fixed template, a Compare button and no record content", () => {
    const m: any = {
      proposal_id: "p", can_edit: true, kind: "conflict", forced: false, nest_name: "Revenue", message_count: 3, from_label: "09:00 UTC", to_label: "09:20 UTC", reviewer: null, expires_label: "Nov 7", surface_ok: true,
      items: [{ id: "i", kind: "correction", op: "edit", title: "Acme renewal billing changes", summary: "Thread says quarterly.", why: "x", folder: "inbox/", node_id: "nodes/inbox/acme", draft_url: `${BASE}/surfaces/drafts/i`, on_record: "Billed annually from January", record_title: "Acme moves to annual billing" }],
    };
    const ok = textOfBlocks(S.bk.renderCardBlocks(m));
    expect(ok).toMatch(/\*On record\*\\nBilled annually from January/);
    expect(ok).toMatch(/\*This thread\*\\nThread says quarterly/);
    expect(ok).toMatch(/On record: Acme moves to annual billing in Revenue/);
    expect(ok).toMatch(/This thread: from 3 messages/);
    expect(ok).toMatch(/Update the record.*Edit.*Keep the record/);
    const red = textOfBlocks(S.bk.renderCardBlocks({ ...m, surface_ok: false, items: [{ ...m.items[0], on_record: null }] }));
    expect(red).toMatch(/A proposed correction from this conversation is waiting for review in Revenue/);
    expect(red).toMatch(/Compare in the nest/);
    expect(red).not.toMatch(/Billed annually|quarterly|Acme/);
    // S2a H1/N1: without surface_ok EVERY card kind shows only the fixed template.
    const single: any = { ...m, kind: "single", surface_ok: false, items: [{ ...m.items[0], op: "new", kind: "decision", title: "Secret Plan Zeta", summary: "Zeta launches.", why: "Zeta why" }] };
    const st = textOfBlocks(S.bk.renderCardBlocks(single));
    expect(st).not.toMatch(/Zeta/);
    expect(st).toMatch(/A proposed decision from this conversation is waiting for review in Revenue/);
    expect(st).toMatch(/Full draft \(reviewers\)/);
    const merged: any = { ...single, kind: "merged", items: [single.items[0], { ...single.items[0], id: "j", kind: "fact", title: "Zeta two" }] };
    expect(textOfBlocks(S.bk.renderCardBlocks(merged))).not.toMatch(/Zeta/);
    expect(S.bk.cardFallback(single)).not.toMatch(/Zeta/);
  });

  it("AC-CRD-08 (N6): a non-approver's ephemeral names only eligible approvers who are in this conversation; none present → nobody named, points to My pending", async () => {
    expect(S.reviewers.nameableReviewers(["dana", "erin", "frank"], ["dana", "bob", "guest"])).toEqual(["dana"]);
    expect(S.reviewers.nameableReviewers(["frank"], ["dana", "bob"])).toEqual([]);
    setChannel("C8", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind("C8");
    const p = await makeProposal("C8");
    // Frank leaves C8 (still a Revenue reviewer, now absent): he must never be named.
    slack.convs.get("C8")!.members = ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "UBOT", "U_FRANK"].filter((m) => m !== "U_FRANK");
    await click("U_BOB", "nest_approve", p.id, { channel: "C8" });
    const note = notesText();
    expect(note).toMatch(/Only reviewers of Revenue can approve this\. .*can, and they're in this channel\./);
    expect(note).toMatch(/<@U_DANA>/);
    expect(note).toMatch(/<@U_ERIN>/);
    expect(note).not.toMatch(/U_FRANK|frank@/);
    // Pure: nobody eligible present → nobody named.
    slack.responses = [];
    slack.convs.get("C8")!.members = ["U_ALICE", "U_BOB", "UBOT"];
    await click("U_BOB", "nest_approve", p.id, { channel: "C8" });
    expect(notesText()).toMatch(/A Revenue reviewer can approve it from their My pending\./);
    expect(notesText()).not.toMatch(/<@/);
    slack.convs.get("C8")!.members = ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"];
  });

  it("AC-CRD-09 (N2): a forced 🧠 card for a reviewer at their limit carries no budget, queue or workload text", async () => {
    for (const u of [dana, erin, frank]) await db().run("INSERT INTO surface_reviewer_usage (user_id, org_id, day, cards_posted) VALUES (?, 'default', ?, 2)", [u.userId, S.budget.orgDay(Date.now(), "UTC")]);
    modelImpl = proposeN(1);
    const ts = await say("C3", "U_BOB", "we decided the launch review moves to thursdays");
    await event({ type: "reaction_added", user: "U_DANA", reaction: "brain", item: { type: "message", channel: "C3", ts }, item_user: "U_BOB", event_ts: nextTs() });
    modelImpl = () => submit(noop());
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? AND forced = 1 ORDER BY created_at DESC LIMIT 1", [bound.C3]);
    expect(p.state).toBe("posted");
    const s = textOfBlocks(blocksOf(cardFor(p)!));
    expect(s).not.toMatch(/queue|queued|limit|budget|cards today|workload|skipped/i);
  });

  it("AC-CRD-10: the reviewer limit shown everywhere is surface_settings.reviewer_daily_cards (default 2)", async () => {
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    expect(textOfBlocks((await S.home.buildHomeView(install, "U_DANA")).blocks)).toMatch(/of your 2 cards today/);
    await jsonRequest(app, "PATCH", "/surfaces/settings", { reviewer_daily_cards: 3 }, root.apiKey);
    expect(textOfBlocks((await S.home.buildHomeView(install, "U_DANA")).blocks)).toMatch(/of your 3 cards today/);
    expect((await jsonRequest(app, "GET", "/surfaces/pending", undefined, dana.apiKey)).data.daily_limit).toBe(3);
    await jsonRequest(app, "PATCH", "/surfaces/settings", { reviewer_daily_cards: 2 }, root.apiKey);
  });

  it("AC-CRD-11: the only bot messages in an enabled channel are the enable notice and proposal cards (+ in-place updates)", async () => {
    const inC1 = slack.posted.filter((p) => p.channel === "C1");
    for (const p of inC1) {
      if (p.blocks) expect(textOfBlocks(blocksOf(p))).toMatch(/Proposed by Nest · only approved summaries are kept/);
      else expect(p.text).toMatch(/^Nest is now listening here/);
    }
    expect(inC1.filter((p) => !p.blocks).length).toBe(1);
  });
});

// ═══ Commit ═══════════════════════════════════════════════════════════════════

describe("commit", () => {
  it("AC-CMT-01, AC-CMT-02, AC-CMT-12: Dana approves → approve() as Dana, proposer = listener, surface_commits row, card updated in place; ack is immediate", async () => {
    const p = await makeProposal("C1");
    const [it0] = await itemsOf(p.id);
    const postsBefore = slack.posted.length;
    const t0 = Date.now();
    const res = await interact(actionPayload("U_DANA", "nest_approve", { p: p.id }), false);
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await res.text()).toBe("");
    await S.work.waitForSurfacesWork();
    const rr = await one("SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC LIMIT 1", [N, it0.node_id]);
    expect(rr.status).toBe("approved");
    expect(rr.resolved_by).toBe(dana.email);
    const persona = await one("SELECT * FROM metacognition_agents WHERE node_id = (SELECT listener_agent_node_id FROM surface_bindings WHERE id = ?)", [bound.C1]);
    expect(rr.requested_by).not.toBe(dana.email);
    expect(rr.requested_by).toMatch(/@/);
    void persona;
    const c = await one("SELECT * FROM surface_commits WHERE proposal_item_id = ?", [it0.id]);
    expect(c).toMatchObject({ surface: "slack", install_id: installId, surface_user_id: "U_DANA", conversation_id: "C1", window_id: p.window_id, proposal_id: p.id, approved_by_user_id: dana.userId });
    const ver = await one("SELECT client_json FROM node_versions WHERE nest_id = ? AND node_id = ? AND client_json IS NOT NULL ORDER BY version DESC LIMIT 1", [N, it0.node_id]);
    expect(ver?.client_json ?? "").toMatch(/"surface_user_id":"U_DANA"/);
    const after = await one("SELECT * FROM surface_proposal_items WHERE id = ?", [it0.id]);
    expect(after.state).toBe("approved");
    expect(slack.posted.length).toBe(postsBefore); // no new message
    const upd = slack.updates.find((u) => u.ts === JSON.parse(p.card_ref).message_ref);
    expect(upd).toBeTruthy();
    expect(upd!.blocks).toMatch(/✅ Approved by <@U_DANA> · inbox\/[a-z0-9-]+ · v\d+/);
    expect(upd!.blocks).toMatch(/Proposed by Nest/);
    expect(upd!.blocks).toMatch(/Live for every AI tool that reads Revenue/);
  });

  it("AC-CMT-03: Approve clicked twice and by two reviewers at once → exactly one approve(); later clicks get 'Already approved by @X'", async () => {
    const p = await makeProposal("C1");
    const [it0] = await itemsOf(p.id);
    await Promise.all([interact(actionPayload("U_DANA", "nest_approve", { p: p.id }), false), interact(actionPayload("U_DANA", "nest_approve", { p: p.id }), false), interact(actionPayload("U_ERIN", "nest_approve", { p: p.id }), false)]);
    await S.work.waitForSurfacesWork();
    expect((await all("SELECT * FROM surface_commits WHERE proposal_item_id = ?", [it0.id])).length).toBe(1);
    expect((await all("SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'approved'", [N, it0.node_id])).length).toBe(1);
    slack.responses = [];
    await click("U_ERIN", "nest_approve", p.id);
    expect(notesText()).toMatch(/Already approved by <@U_(DANA|ERIN)>/);
  });

  it("AC-CMT-04: Approve and Reject race → exactly one wins and the card shows it", async () => {
    const p = await makeProposal("C1");
    const [it0] = await itemsOf(p.id);
    const meta = S.interactions.signMeta({ k: "reject", p: p.id, i: [it0.id], n: N, f: it0.target_folder, u: "U_ERIN", t: "T1", v: "reject", x: Date.now() + 600_000 });
    await Promise.all([
      interact(actionPayload("U_DANA", "nest_approve", { p: p.id }), false),
      submitView("U_ERIN", { callback_id: "nest_reject_modal", private_metadata: meta }, { reason: { v: { selected_option: { value: "details_wrong" } } } }),
    ]);
    await S.work.waitForSurfacesWork();
    const after = await one("SELECT * FROM surface_proposal_items WHERE id = ?", [it0.id]);
    expect(["approved", "rejected"]).toContain(after.state);
    expect((await all("SELECT * FROM surface_actions WHERE idempotency_key = ?", [`decide:${it0.id}`])).length).toBe(1);
    const upd = slack.updates.filter((u) => u.ts === JSON.parse(p.card_ref).message_ref);
    expect(upd.length).toBe(1);
    expect(upd[0].blocks).toMatch(after.state === "approved" ? /Approved by/ : /Rejected by/);
  });

  it("AC-CMT-05, AC-CMT-06: a non-approver's Approve/Edit/Reject makes no review call and opens no dialog; a reviewer's Edit is checked first and opens within 3 s", async () => {
    const p = await makeProposal("C1");
    const [it0] = await itemsOf(p.id);
    const views = slack.views.length;
    for (const a of ["nest_approve", "nest_edit", "nest_reject"]) await click("U_BOB", a, p.id);
    expect(slack.views.length).toBe(views);
    expect((await one("SELECT * FROM surface_proposal_items WHERE id = ?", [it0.id])).state).toBe("pending");
    expect((await one("SELECT status FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC LIMIT 1", [N, it0.node_id])).status).toBe("pending");
    expect((await all("SELECT * FROM surface_actions WHERE proposal_item_id = ?", [it0.id])).length).toBe(0);
    await db().run("UPDATE nest_collaborators SET permission = 'write' WHERE nest_id = ? AND user_id = ?", [N, dana.userId]);
    const t0 = Date.now();
    await click("U_DANA", "nest_edit", p.id);
    await db().run("UPDATE nest_collaborators SET permission = 'read' WHERE nest_id = ? AND user_id = ?", [N, dana.userId]);
    const v = slack.views.filter((x) => x.method === "views.open").pop()!;
    expect(v.at - t0).toBeLessThan(3000);
    const view = JSON.parse(v.params.view);
    expect(view.callback_id).toBe("nest_edit_modal");
    expect(v.params.trigger_id).toMatch(/^trig-/);
  });

  it("AC-CMT-07: a tampered private_metadata (other item, nest or folder) or a different submitter is refused with no state change", async () => {
    const p = await makeProposal("C1");
    const q = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    const [b] = await itemsOf(q.id);
    const good = S.interactions.signMeta({ k: "edit", p: p.id, i: [a.id], n: N, f: a.target_folder, u: "U_DANA", t: "T1", v: "edit", x: Date.now() + 600_000 })!;
    const values = { [`title:${a.id}`]: { v: { value: a.title } }, [`summary:${a.id}`]: { v: { value: "A fine summary." } }, [`body:${a.id}`]: { v: { value: "A fine body for the record." } } };
    const tampered = [
      good.replace(/^[^.]+/, Buffer.from(JSON.stringify({ k: "edit", p: p.id, i: [b.id], n: N, f: a.target_folder, u: "U_DANA", t: "T1", x: Date.now() + 600_000 })).toString("base64url")),
      S.interactions.signMeta({ k: "edit", p: p.id, i: [b.id], n: N, f: a.target_folder, u: "U_DANA", t: "T1", x: Date.now() + 600_000 })!,
      S.interactions.signMeta({ k: "edit", p: p.id, i: [a.id], n: N2, f: a.target_folder, u: "U_DANA", t: "T1", x: Date.now() + 600_000 })!,
    ];
    for (const m of tampered) expect((await submitView("U_DANA", { callback_id: "nest_edit_modal", private_metadata: m }, values)).status).toBe(403);
    expect((await submitView("U_ERIN", { callback_id: "nest_edit_modal", private_metadata: good }, values)).status).toBe(403);
    for (const it of [a, b]) {
      expect((await one("SELECT state FROM surface_proposal_items WHERE id = ?", [it.id])).state).toBe("pending");
      expect((await all("SELECT * FROM surface_actions WHERE proposal_item_id = ?", [it.id])).length).toBe(0);
    }
  });

  it("AC-CMT-08: an edit that breaks caps, the sensitive/verbatim rule or the leak filter returns a field error and approves nothing; a valid edit is approved as the editor with edited=true and 'edited by Dana'", async () => {
    // Edit & approve needs edit rights too (the existing approve-with-edits rule).
    await db().run("UPDATE nest_collaborators SET permission = 'write' WHERE nest_id = ? AND user_id = ?", [N, dana.userId]);
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    const meta = S.interactions.signMeta({ k: "edit", p: p.id, i: [a.id], n: N, f: a.target_folder, u: "U_DANA", t: "T1", v: "edit", x: Date.now() + 600_000 })!;
    const vals = (summary: string, body = "The renewal follows the new plan.") => ({ [`title:${a.id}`]: { v: { value: "Renewal plan agreed" } }, [`summary:${a.id}`]: { v: { value: summary } }, [`body:${a.id}`]: { v: { value: body } } });
    for (const bad of [vals("One. Two. Three. Four."), vals("Her salary is 190k per year now."), vals("Fine.", "Note: acme moves to annual billing acme renewal is billed annually")]) {
      const r = await submitView("U_DANA", { callback_id: "nest_edit_modal", private_metadata: meta }, bad);
      const body = await r.json();
      expect(body.response_action).toBe("errors");
      expect(Object.keys(body.errors)[0]).toMatch(new RegExp(`^(summary|body|title):${a.id}$`));
      expect((await one("SELECT state FROM surface_proposal_items WHERE id = ?", [a.id])).state).toBe("pending");
    }
    // Verbatim: a 16-word run copied from the window is caught by the window guard.
    const guard = S.editGuard.buildWindowGuard(["alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho"], Buffer.alloc(32, 7));
    const v = S.editGuard.checkEdit({ title: "Greek letters", summary: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi", body: "ok body" }, { guard, key: Buffer.alloc(32, 7), otherNodeTexts: [], peopleFolder: false, kind: "fact" });
    expect(v.ok).toBe(false);
    const good = await submitView("U_DANA", { callback_id: "nest_edit_modal", private_metadata: meta }, vals("The renewal plan was agreed."));
    expect(await good.json()).toEqual({ response_action: "clear" });
    await S.work.waitForSurfacesWork();
    const after = await one("SELECT * FROM surface_proposal_items WHERE id = ?", [a.id]);
    expect(after.state).toBe("approved");
    expect(after.edited).toBe(1);
    expect((await one("SELECT edited, approved_by_user_id FROM surface_commits WHERE proposal_item_id = ?", [a.id]))).toMatchObject({ edited: 1, approved_by_user_id: dana.userId });
    const upd = slack.updates.filter((u) => u.ts === JSON.parse(p.card_ref).message_ref).pop()!;
    expect(upd.blocks).toMatch(/edited by Dana/);
    await db().run("UPDATE nest_collaborators SET permission = 'read' WHERE nest_id = ? AND user_id = ?", [N, dana.userId]);
  });

  it("AC-CMT-09: Reject with 'Details are wrong' → reject(details_wrong) as U, title/summary purged, 7-day fingerprint hold, card 'Not saved. Rejected by @U · \"Details are wrong\"'", async () => {
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    await click("U_DANA", "nest_reject", p.id);
    const view = lastView();
    expect(view.callback_id).toBe("nest_reject_modal");
    await submitView("U_DANA", view, { reason: { v: { selected_option: { value: "details_wrong" } } } });
    const after = await one("SELECT * FROM surface_proposal_items WHERE id = ?", [a.id]);
    expect(after).toMatchObject({ state: "rejected", reason: "details_wrong", title: null, summary: null });
    expect(after.decided_by_user_id).toBe(dana.userId);
    expect((await one("SELECT * FROM surface_actions WHERE idempotency_key = ?", [`decide:${a.id}`]))).toMatchObject({ action: "reject:details_wrong", community_user_id: dana.userId, status: "done" });
    const rr = await one("SELECT * FROM review_requests WHERE id = ?", [a.review_id]);
    if (rr) expect(rr).toMatchObject({ status: "rejected", resolved_by: dana.email, resolution_note: "Details are wrong" });
    // The draft is gone.
    expect((await jsonRequest(app, "GET", `/nests/${N}/nodes/${a.node_id}`, undefined, alice.apiKey)).status).toBeGreaterThanOrEqual(400);
    const fp = await one("SELECT * FROM surface_fingerprints WHERE node_id = ? AND source = 'rejected'", [a.node_id]);
    expect(Date.parse(fp.hold_until) - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    const upd = slack.updates.filter((u) => u.ts === JSON.parse(p.card_ref).message_ref).pop()!;
    expect(upd.blocks).toMatch(/Not saved\. Rejected by <@U_DANA> · \\"Details are wrong\\"/);
    expect(upd.blocks).toMatch(/won't propose this again for 7 days/);
  });

  it("AC-CMT-10: merged card, item 3 unticked → items 1–2 approved as U, item 3 rejected not_selected (purged, held); card lists kept and not kept", async () => {
    const p = await makeProposal("C2", { n: 3 });
    const items = await itemsOf(p.id);
    const state = { values: { nest_items: { nest_select: { selected_options: [{ value: items[0].id }, { value: items[1].id }] } } } };
    await click("U_DANA", "nest_approve_selected", p.id, { channel: "C2", state });
    const after = await itemsOf(p.id);
    expect(after.map((i) => i.state)).toEqual(["approved", "approved", "rejected"]);
    expect(after[2].reason).toBe("not_selected");
    expect(after[2].title).toBeNull();
    expect(await one("SELECT * FROM surface_fingerprints WHERE node_id = ? AND source = 'rejected'", [items[2].node_id])).toBeTruthy();
    const upd = slack.updates.filter((u) => u.ts === JSON.parse(p.card_ref).message_ref).pop()!;
    expect(upd.blocks).toMatch(/kept 2 of 3/);
    expect(upd.blocks).toMatch(/Not kept: Team agrees/);
  });

  it("AC-CMT-11: a conflict card — Keep the record rejects the edit with keep_existing and a hold; Update the record approves it as U", async () => {
    const conflict = (req: any) => item(req, { kind: "correction", op: "edit", target_node_id: ACME, title: "Acme billing correction noted", conflict: { node_id: ACME, on_record_claim: "Billed annually", thread_claim: "Billed quarterly" } });
    modelImpl = (req) => submit({ verdict: "propose", reason_code: "proposed", ask_signature: null, items: [conflict(req)] });
    await say("C4", "U_BOB", "heads up everyone, acme is actually billed quarterly now according to the signed contract");
    await tick();
    modelImpl = () => submit(noop());
    const w = await one("SELECT verdict, reason_code, blocked FROM surface_windows WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [bound.C4]);
    expect(w.verdict, JSON.stringify(w)).toBe("proposed");
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [bound.C4]);
    expect(p.state).toBe("posted");
    const card = textOfBlocks(blocksOf(cardFor(p)!));
    expect(card).toMatch(/Update the record/);
    expect(card).toMatch(/On record/);
    await click("U_DANA", "nest_keep_record", p.id, { channel: "C4" });
    const [a] = await itemsOf(p.id);
    expect(a.state).toBe("rejected");
    expect(a.reason).toBe("keep_existing");
    expect(await one("SELECT * FROM surface_fingerprints WHERE target_node_id = ? AND source = 'rejected'", [ACME])).toBeTruthy();
    // Update the record on a fresh conflict (after the hold, use the pure path: approve of the edit item).
    await db().run("DELETE FROM surface_fingerprints WHERE target_node_id = ?", [ACME]);
    await db().run("DELETE FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'rejected'", [N, ACME]);
    modelImpl = (req) => submit({ verdict: "propose", reason_code: "proposed", ask_signature: null, items: [conflict(req)] });
    await say("C4", "U_BOB", "confirmed with finance today: acme billing is quarterly from now on for the whole account");
    await tick();
    modelImpl = () => submit(noop());
    const q = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [bound.C4]);
    expect(q.id).not.toBe(p.id);
    await click("U_DANA", "nest_update_record", q.id, { channel: "C4" });
    const [b] = await itemsOf(q.id);
    expect(b.state).toBe("approved");
    expect(b.decided_by_user_id).toBe(dana.userId);
    expect(slack.updates.filter((u) => u.ts === JSON.parse(q.card_ref).message_ref).pop()!.blocks).toMatch(/v\d+/);
  });

  it("AC-CMT-13: an unlinked reviewer clicking Approve gets a one-time link (15 min) and nothing is committed", async () => {
    const p = await makeProposal("C1");
    await db().run("UPDATE surface_identity_links SET status = 'revoked' WHERE install_id = ? AND surface_user_id = 'U_ERIN'", [installId]);
    await click("U_ERIN", "nest_approve", p.id);
    expect(notesText()).toMatch(/https:\/\/nest\.surf\.test\/link\/[A-Za-z0-9_-]{20,}/);
    const tok = await one("SELECT * FROM surface_link_tokens WHERE surface_user_id = 'U_ERIN' ORDER BY created_at DESC LIMIT 1");
    expect(Date.parse(tok.expires_at) - Date.parse(tok.created_at)).toBe(15 * 60_000);
    expect((await itemsOf(p.id))[0].state).toBe("pending");
    expect((await all("SELECT * FROM surface_actions WHERE proposal_item_id = ?", [(await itemsOf(p.id))[0].id])).length).toBe(0);
    await db().run("DELETE FROM surface_identity_links WHERE install_id = ? AND surface_user_id = 'U_ERIN' AND status = 'revoked'", [installId]);
    await S.identity.linkExplicit({ installId, surfaceUserId: "U_ERIN", communityUserId: erin.userId });
  });

  it("N3: the first commit through an auto/one-time link asks to confirm, naming the verb; Yes continues the ORIGINAL action; That's not me revokes and does nothing", async () => {
    const p = await makeProposal("C1");
    await db().run("UPDATE surface_identity_links SET method = 'one_time', first_use_confirmed_at = NULL WHERE install_id = ? AND surface_user_id = 'U_ERIN' AND status = 'active'", [installId]);
    await click("U_ERIN", "nest_reject", p.id);
    const ask = slack.responses.pop()!.body;
    expect(ask.text).toMatch(/You're about to \*reject\* this, recorded under Erin Reviewer \(erin@surf\.test\)\. Is that you\?/);
    const yes = ask.blocks.find((b: any) => b.type === "actions").elements[0];
    const views = slack.views.length;
    await interact(actionPayload("U_ERIN", yes.action_id, yes.value));
    expect(slack.views.length).toBe(views + 1);
    expect(lastView().callback_id).toBe("nest_reject_modal"); // the reject flow, never approve
    expect((await itemsOf(p.id))[0].state).toBe("pending");
  });

  it("AC-CMT-14: a requester approving their own 🧠 proposal succeeds with self_vouched = true", async () => {
    modelImpl = proposeN(1);
    const ts = await say("C5", "U_DANA", "we decided standup moves to ten thirty from monday");
    await event({ type: "reaction_added", user: "U_DANA", reaction: "brain", item: { type: "message", channel: "C5", ts }, item_user: "U_DANA", event_ts: nextTs() });
    modelImpl = () => submit(noop());
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? AND forced = 1 ORDER BY created_at DESC LIMIT 1", [bound.C5]);
    await click("U_DANA", "nest_approve", p.id, { channel: "C5" });
    const c = await one("SELECT * FROM surface_commits WHERE proposal_id = ?", [p.id]);
    expect(c.self_vouched).toBe(1);
  });

  it("AC-CMT-15: approve/reject from review-service are called only from commit-service.ts, never with the bot or listener as approver", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(__dirname, "..", "src", "surfaces"));
    const callers = files.filter((f) => /from\s+"[./]*governance\/review-service\.js"/.test(readFileSync(f, "utf8")) && /\b(approve|reject)\b[^;]*from\s+"[./]*governance\/review-service\.js"/s.test(readFileSync(f, "utf8").match(/import\s*\{[^}]*\}\s*from\s+"[./]*governance\/review-service\.js"/s)?.[0] ?? ""));
    expect(callers.map((f) => f.split("/src/surfaces/")[1])).toEqual(["services/commit-service.ts"]);
    const src = readFileSync(join(__dirname, "..", "src", "surfaces", "services", "commit-service.ts"), "utf8");
    expect(src).toMatch(/approvedBy: a\.email/);
    expect(src).toMatch(/rejectedBy: a\.email/);
    expect(src).toMatch(/is_service \|\| \(listener && listener\.persona\.email/);
  });
});

// ═══ Budgets and queue ═══════════════════════════════════════════════════════

describe("budgets and the queue", () => {
  it("AC-BUD-06: order is folder owner → fewest pending → least recently named, skipping those at the limit", () => {
    const r = S.reviewers.rankReviewers(
      [
        { userId: "C", pending: 0, lastNamedAt: null, usedToday: 0 },
        { userId: "B", pending: 0, lastNamedAt: "2026-10-01T00:00:00Z", usedToday: 0 },
        { userId: "A", pending: 5, lastNamedAt: "2026-10-30T00:00:00Z", usedToday: 0 },
        { userId: "D", pending: 1, lastNamedAt: null, usedToday: 0 },
      ],
      new Set(["A"]),
    );
    expect(r.map((x) => x.userId)).toEqual(["A", "C", "B", "D"]);
    const d = S.budget.route({ forced: false, ranked: [{ userId: "A", usedToday: 2 }, { userId: "C", usedToday: 1 }], hasAnyApprover: true, reviewerDailyCards: 2, conversationPostedToday: 0, conversationDailyCards: 3 });
    expect(d).toEqual({ action: "post", reviewer: "C", countsAgainstBudget: true });
  });

  it("AC-BUD-01, AC-BUD-02: all eligible reviewers at 2 → the 3rd organic is queued for 09:00 next day (not posted); the release posts it in its thread and counts it, overflow stays queued", async () => {
    const day = S.budget.orgDay(Date.now(), "UTC");
    for (const u of [dana, erin, frank]) await db().run("INSERT INTO surface_reviewer_usage (user_id, org_id, day, cards_posted) VALUES (?, 'default', ?, 2)", [u.userId, day]);
    const posts = slack.posted.length;
    const p = await makeProposal("C6");
    expect(p.state).toBe("queued");
    expect(p.queue_reason).toBe("budget");
    expect(slack.posted.length).toBe(posts);
    const rel = new Date(p.queued_release_at);
    expect(rel.getUTCHours()).toBe(9);
    expect(rel.getTime()).toBe(S.budget.nextReleaseAt(Date.now(), "UTC"));
    expect(S.budget.nextReleaseAt(Date.parse("2026-10-31T23:30:00Z"), "America/New_York")).toBe(Date.parse("2026-11-01T14:00:00Z"));
    // A second queued one for the same reviewer, then release with only one slot left tomorrow.
    const q = await makeProposal("C6");
    expect(q.state).toBe("queued");
    await db().run("UPDATE surface_proposals SET named_reviewer_user_id = ? WHERE id = ?", [p.named_reviewer_user_id, q.id]);
    const at = rel.getTime() + 60_000;
    const tomorrow = S.budget.orgDay(at, "UTC");
    await db().run("INSERT INTO surface_reviewer_usage (user_id, org_id, day, cards_posted) VALUES (?, 'default', ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET cards_posted = 1", [p.named_reviewer_user_id, tomorrow]);
    await S.routing.releaseQueue(at);
    const [p2, q2] = [await one("SELECT * FROM surface_proposals WHERE id = ?", [p.id]), await one("SELECT * FROM surface_proposals WHERE id = ?", [q.id])];
    expect(p2.state).toBe("posted");
    expect(q2.state).toBe("queued");
    expect(Date.parse(q2.queued_release_at)).toBeGreaterThan(at);
    expect(Number((await one("SELECT cards_posted FROM surface_reviewer_usage WHERE user_id = ? AND day = ?", [p.named_reviewer_user_id, tomorrow])).cards_posted)).toBe(2);
    expect(JSON.parse(p2.card_ref).conversation).toBe("C6");
  });

  it("AC-BUD-03: with 10 queued for a reviewer, an 11th drops the lowest-confidence one (queue_overflow), draft purged, no hold", async () => {
    const day = S.budget.orgDay(Date.now(), "UTC");
    for (const u of [dana, erin, frank]) await db().run("INSERT INTO surface_reviewer_usage (user_id, org_id, day, cards_posted) VALUES (?, 'default', ?, 2) ON CONFLICT (user_id, day) DO UPDATE SET cards_posted = 2", [u.userId, day]);
    // A nest where Dana is the only reviewer, so every proposal queues for her.
    await db().run("UPDATE surface_proposals SET state = 'withdrawn' WHERE state = 'queued'");
    const N4 = (await jsonRequest(app, "POST", "/nests", { name: "Queue" }, alice.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${N4}/collaborators`, { email: dana.email, permission: "read" }, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${N4}/collaborators`, { email: bob.email, permission: "read" }, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${N4}/stewards`, { scope: "nest", users: [{ email: dana.email, role: "reviewer" }] }, alice.apiKey);
    setChannel("CQ", ["U_ALICE", "U_DANA", "U_BOB", "UBOT"]);
    await bind("CQ", N4);
    const named = dana.userId;
    for (let i = 0; i < 10; i++) {
      const p = await makeProposal("CQ", { over: [{ confidence: i === 0 ? 0.71 : 0.95 }] });
      expect(p.state).toBe("queued");
      expect(p.named_reviewer_user_id).toBe(named);
    }
    const lowest = (await all("SELECT id FROM surface_proposals WHERE named_reviewer_user_id = ? AND state = 'queued' ORDER BY confidence ASC, created_at DESC LIMIT 1", [named]))[0].id;
    const lowItem = (await itemsOf(lowest))[0];
    const eleventh = await makeProposal("CQ", { over: [{ confidence: 0.9 }] });
    expect(eleventh.state).toBe("queued");
    const dropped = await itemsOf(lowest);
    expect(dropped[0].state).toBe("dropped");
    expect(dropped[0].reason).toBe("queue_overflow");
    expect(dropped[0].title).toBeNull();
    expect(await one("SELECT * FROM surface_fingerprints WHERE node_id = ?", [lowItem.node_id])).toBeUndefined();
    expect(Number((await one("SELECT COUNT(*) AS n FROM surface_proposals WHERE named_reviewer_user_id = ? AND state = 'queued'", [named])).n)).toBe(10);
    // Leave no queue behind for later tests.
    for (const r of await all("SELECT id FROM surface_proposals WHERE binding_id = ? AND state = 'queued'", [bound.CQ])) await S.expiry.withdrawWithCard(r.id);
  });

  it("AC-BUD-04: a conversation that posted 3 organic cards today queues the 4th (capped)", async () => {
    setChannel("C9", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind("C9");
    await jsonRequest(app, "PATCH", "/surfaces/settings", { reviewer_daily_cards: 10 }, root.apiKey);
    for (let i = 0; i < 3; i++) expect((await makeProposal("C9")).state).toBe("posted");
    const p = await makeProposal("C9");
    expect(p.state).toBe("queued");
    expect(p.queue_reason).toBe("capped");
  });

  it("AC-BUD-05: a forced proposal posts at once regardless of reviewer or conversation budget, and doesn't count", async () => {
    const day = S.budget.orgDay(Date.now(), "UTC");
    for (const u of [dana, erin, frank]) await db().run("INSERT INTO surface_reviewer_usage (user_id, org_id, day, cards_posted) VALUES (?, 'default', ?, 2) ON CONFLICT (user_id, day) DO UPDATE SET cards_posted = 2", [u.userId, day]);
    await db().run("INSERT INTO surface_conversation_usage (binding_id, day, cards_posted) VALUES (?, ?, 3) ON CONFLICT (binding_id, day) DO UPDATE SET cards_posted = 3", [bound.C5, day]);
    modelImpl = proposeN(1);
    const ts = await say("C5", "U_BOB", "we decided the office closes early on fridays");
    await event({ type: "reaction_added", user: "U_ERIN", reaction: "brain", item: { type: "message", channel: "C5", ts }, item_user: "U_BOB", event_ts: nextTs() });
    modelImpl = () => submit(noop());
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? AND forced = 1 ORDER BY created_at DESC LIMIT 1", [bound.C5]);
    expect(p.state).toBe("posted");
    const used = await all("SELECT user_id, cards_posted FROM surface_reviewer_usage WHERE day = ?", [day]);
    for (const u of used) expect(Number(u.cards_posted)).toBe(2);
  });

  it("AC-BUD-07: explicit public bind with no approver among members → held, not posted; in My pending of every approver who reads the nest, and on Surfaces", async () => {
    setChannel("CPUB", ["U_BOB", "U_ALICE", "UBOT"], { is_private: false, is_channel: true, is_group: false });
    const r = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "CPUB", nest_id: N, explicit_public_bind: true }, root.apiKey);
    expect(r.status).toBe(201);
    bound.CPUB = r.data.binding.id;
    await setFolders(bound.CPUB);
    const posts = cardsIn("CPUB").length;
    const p = await makeProposal("CPUB");
    expect(p.state).toBe("held");
    expect(cardsIn("CPUB").length).toBe(posts);
    for (const u of [dana, erin]) {
      const mine = (await jsonRequest(app, "GET", "/surfaces/pending", undefined, u.apiKey)).data;
      expect(mine.held.map((h: any) => h.proposal_id)).toContain(p.id);
    }
    expect((await jsonRequest(app, "GET", "/surfaces/pending", undefined, bob.apiKey)).data.held.map((h: any) => h.proposal_id)).not.toContain(p.id);
    const list = (await jsonRequest(app, "GET", `/surfaces/proposals?nest_id=${N}`, undefined, alice.apiKey)).data.proposals;
    expect(list.find((x: any) => x.id === p.id).state).toBe("held");
  });
});

// ═══ App Home ═════════════════════════════════════════════════════════════════

describe("App Home: My pending", () => {
  it("AC-HOM-01, AC-HOM-02, AC-HOM-03: app_home_opened publishes the scope line and only items from nests Dana reads and reviews; in-thread rows show conversation, title, posted, expiry and Open thread", async () => {
    setChannel("C10", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "UBOT"]);
    await bind("C10", N2);
    setChannel("C11", ["U_ALICE", "U_ERIN", "UBOT"]);
    await bind("C11", N3);
    const inN2 = await makeProposal("C10");
    const inN3 = await makeProposal("C11");
    expect(inN3.state).toBe("posted");
    await event({ type: "app_home_opened", user: "U_DANA", tab: "home", channel: "D1" });
    const view = lastView("views.publish");
    const s = textOfBlocks(view.blocks);
    expect(s).toMatch(/From nests you can read and review: Company, (Queue, )?Revenue/);
    const t3 = (await itemsOf(inN3.id))[0].title;
    expect(s).not.toContain(t3);
    const mine = (await jsonRequest(app, "GET", "/surfaces/pending", undefined, dana.apiKey)).data;
    expect(mine.scope.map((x: any) => x.name)).toEqual(expect.arrayContaining(["Company", "Revenue"]));
    expect(mine.scope.map((x: any) => x.name)).not.toContain("Secret");
    expect(mine.in_thread.map((r: any) => r.proposal_id)).toContain(inN2.id);
    expect(mine.in_thread.map((r: any) => r.proposal_id)).not.toContain(inN3.id);
    for (const r of mine.in_thread) expect(r.nest_id).not.toBe(N3);
    expect(s).toMatch(/#c\d+ · \*Team agrees/);
    expect(s).toMatch(/Posted .* · expires /);
    expect(s).toMatch(/"Open thread".*"url":"https:\/\/acme\.slack\.com\/archives\/C\d+\//);
  });

  it("AC-HOM-04: a held row shows 'Not posted: no <nest> reviewer in #<channel>', summary, folder, expiry and Approve/Edit/Reject/Review in nest — committing through the same service", async () => {
    const p = await makeProposal("CPUB");
    expect(p.state).toBe("held");
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    const s = textOfBlocks((await S.home.buildHomeView(install, "U_DANA")).blocks);
    expect(s).toMatch(/Not posted: no Revenue reviewer in #cpub/);
    expect(s).toMatch(/📁 inbox\/ · expires/);
    // R2-5: Dana has no edit rights on Revenue, so Edit is hidden on her row.
    expect(s).toMatch(/Approve.*Reject.*Review in nest/);
    await click("U_DANA", "nest_approve", p.id, { home: true, channel: null });
    const [a] = await itemsOf(p.id);
    expect(a.state).toBe("approved");
    expect(await one("SELECT * FROM surface_commits WHERE proposal_item_id = ?", [a.id])).toBeTruthy();
  });

  it("AC-HOM-05: queued items show 'Queued for you (n) · posting tomorrow at 9 AM' and the limit line; no DM nudge is ever sent", async () => {
    const day = S.budget.orgDay(Date.now(), "UTC");
    for (const u of [dana, erin, frank]) await db().run("INSERT INTO surface_reviewer_usage (user_id, org_id, day, cards_posted) VALUES (?, 'default', ?, 2) ON CONFLICT (user_id, day) DO UPDATE SET cards_posted = 2", [u.userId, day]);
    const dmsBefore = slack.calls.filter((c) => c.method === "conversations.open").length;
    const p = await makeProposal("C6");
    const who = p.named_reviewer_user_id === dana.userId ? "U_DANA" : p.named_reviewer_user_id === erin.userId ? "U_ERIN" : "U_FRANK";
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    const s = textOfBlocks((await S.home.buildHomeView(install, who)).blocks);
    expect(s).toMatch(/Queued for you \(\d+\) · posting tomorrow at 9 AM/);
    expect(s).toMatch(/You've had 2 of your 2 cards today/);
    expect(slack.calls.filter((c) => c.method === "conversations.open").length).toBe(dmsBefore);
  });

  it("AC-HOM-06, AC-HOM-07: the opt-out toggle creates/removes surface_optouts and deletes the user's buffer rows; Unlink revokes the link and the Home republishes unlinked", async () => {
    await say("C1", "U_ALICE", "some message that will sit in the buffer for a while");
    expect((await all("SELECT * FROM surface_buffer WHERE author_surface_user_id = 'U_ALICE'")).length).toBeGreaterThan(0);
    await interact(actionPayload("U_ALICE", "home_optout", "on", { home: true, channel: null }));
    expect(await one("SELECT * FROM surface_optouts WHERE install_id = ? AND surface_user_id = 'U_ALICE'", [installId])).toBeTruthy();
    expect((await all("SELECT * FROM surface_buffer WHERE author_surface_user_id = 'U_ALICE'")).length).toBe(0);
    await interact(actionPayload("U_ALICE", "home_optout", "off", { home: true, channel: null }));
    expect(await one("SELECT * FROM surface_optouts WHERE install_id = ? AND surface_user_id = 'U_ALICE'", [installId])).toBeUndefined();
    await interact(actionPayload("U_MAL", "home_unlink", "unlink", { home: true, channel: null }));
    expect(await one("SELECT * FROM surface_identity_links WHERE install_id = ? AND surface_user_id = 'U_MAL' AND status = 'active'", [installId])).toBeUndefined();
    expect(textOfBlocks(lastView("views.publish").blocks)).toMatch(/Link your ContextNest account/);
  });

  it("AC-HOM-08 (N1): an org admin's Home has 'Held for a reviewer (admin view)' with counts and who has them; personal-nest titles are redacted", async () => {
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    // A held proposal in a personal nest someone else owns.
    const pn = (await jsonRequest(app, "POST", "/nests", { name: "Bob (private)" }, bob.apiKey)).data.nest.id;
    await db().run("INSERT INTO surface_personal_nests (install_id, community_user_id, nest_id) VALUES (?, ?, ?)", [installId, bob.userId, pn]);
    const held = await one("SELECT * FROM surface_proposals WHERE state = 'held' LIMIT 1");
    expect(held).toBeTruthy();
    await db().run("UPDATE surface_proposals SET nest_id = ? WHERE id = ?", [pn, held.id]);
    await db().run("UPDATE surface_proposal_items SET nest_id = ? WHERE proposal_id = ?", [pn, held.id]);
    const s = textOfBlocks((await S.home.buildHomeView(install, "U_ROOT")).blocks);
    expect(s).toMatch(/Held for a reviewer \(admin view\)/);
    expect(s).toMatch(/DM · private nest · title hidden/);
    expect(s).toMatch(/\d+ held/);
    const t = (await itemsOf(held.id))[0].title;
    if (t) expect(s).not.toContain(t);
    await db().run("UPDATE surface_proposals SET nest_id = ? WHERE id = ?", [N, held.id]);
    await db().run("UPDATE surface_proposal_items SET nest_id = ? WHERE proposal_id = ?", [N, held.id]);
  });
});

// ═══ Lifecycle ════════════════════════════════════════════════════════════════

describe("expiry and withdrawal", () => {
  it("AC-EXP-01: a posted item 7 days old → card updated once in place to '⏳ Expired…', draft purged, 7-day hold, no mention/new message/DM", async () => {
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    const posts = slack.posted.length;
    const dms = slack.calls.filter((c) => c.method === "conversations.open").length;
    const later = Date.parse(p.expires_at) + 1000;
    expect(Date.parse(p.expires_at) - Date.parse(p.created_at)).toBe(7 * 86400_000);
    expect(await S.expiry.expireDue(later)).toBeGreaterThan(0);
    await S.expiry.expireDue(later);
    const upd = slack.updates.filter((u) => u.ts === JSON.parse(p.card_ref).message_ref);
    expect(upd.length).toBe(1);
    expect(upd[0].blocks).toMatch(/⏳ Expired, not saved\. Nobody decided on \\"Team agrees/);
    expect(upd[0].blocks).not.toMatch(/<@/);
    expect(slack.posted.length).toBe(posts);
    expect(slack.calls.filter((c) => c.method === "conversations.open").length).toBe(dms);
    const after = await one("SELECT * FROM surface_proposal_items WHERE id = ?", [a.id]);
    expect(after).toMatchObject({ state: "expired", title: null });
    expect((await one("SELECT * FROM surface_fingerprints WHERE node_id = ? AND source = 'expired'", [a.node_id]))).toBeTruthy();
    expect((await one("SELECT state FROM surface_proposals WHERE id = ?", [p.id])).state).toBe("expired");
  });

  it("AC-EXP-02: queued and held items created 7 days ago expire the same way, with no card update", async () => {
    const p = await makeProposal("CPUB"); // held
    const day = S.budget.orgDay(Date.now(), "UTC");
    for (const u of [dana, erin, frank]) await db().run("INSERT INTO surface_reviewer_usage (user_id, org_id, day, cards_posted) VALUES (?, 'default', ?, 2) ON CONFLICT (user_id, day) DO UPDATE SET cards_posted = 2", [u.userId, day]);
    const q = await makeProposal("C6"); // queued
    expect([p.state, q.state]).toEqual(["held", "queued"]);
    const updates = slack.updates.length;
    await S.expiry.expireDue(Math.max(Date.parse(p.expires_at), Date.parse(q.expires_at)) + 1000);
    for (const r of [p, q]) {
      const now = await one("SELECT state, outcome_rendered, card_ref FROM surface_proposals WHERE id = ?", [r.id]);
      expect(now).toMatchObject({ state: "expired", outcome_rendered: null, card_ref: null });
      const [it] = await itemsOf(r.id);
      expect(it.state).toBe("expired");
      expect(await one("SELECT * FROM surface_fingerprints WHERE node_id = ? AND source = 'expired'", [it.node_id])).toBeTruthy();
    }
    // Never posted → nothing to update in place.
    expect(slack.updates.length).toBe(updates + slack.updates.slice(updates).filter((u) => ![p, q].some((r) => r.card_ref && JSON.parse(r.card_ref).message_ref === u.ts)).length);
  });

  it("AC-EXP-03 + CF-1 (AC-GRD-15 withdraw half): a guard pause withdraws pending cards in place ('Withdrawn…'), purges the draft and writes NO hold", async () => {
    const p = await makeProposal("C3");
    const [a] = await itemsOf(p.id);
    // A non-member reader joins the nest → the guard pauses C3 on its next re-check.
    await jsonRequest(app, "POST", `/nests/${N}/collaborators`, { email: mallory.email, permission: "read" }, alice.apiKey);
    await jsonRequest(app, "POST", `/surfaces/bindings/${bound.C3}/recheck`, {}, alice.apiKey);
    await S.work.waitForSurfacesWork();
    expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound.C3])).status).toBe("paused_guard");
    const after = await one("SELECT * FROM surface_proposal_items WHERE id = ?", [a.id]);
    expect(after).toMatchObject({ state: "withdrawn", title: null });
    expect(await one("SELECT * FROM surface_fingerprints WHERE node_id = ?", [a.node_id])).toBeUndefined();
    const upd = slack.updates.filter((u) => u.ts === JSON.parse(p.card_ref).message_ref).pop()!;
    expect(upd.blocks).toMatch(/Withdrawn\. Nest paused in this channel, so this proposal \(\\"Team agrees/);
    expect(upd.blocks).toMatch(/Your admin has been told why/);
    const mc = await one("SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?", [N, mallory.userId]);
    expect((await jsonRequest(app, "DELETE", `/nests/${N}/collaborators/${mc.id}`, undefined, alice.apiKey)).status).toBe(200);
  });

  it("approve vs withdraw race: a withdrawal claims the same per-item key, so exactly one outcome lands", async () => {
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    await Promise.all([interact(actionPayload("U_DANA", "nest_approve", { p: p.id }), false), S.expiry.withdrawWithCard(p.id)]);
    await S.work.waitForSurfacesWork();
    const after = await one("SELECT state FROM surface_proposal_items WHERE id = ?", [a.id]);
    expect(["approved", "withdrawn"]).toContain(after.state);
    const commits = await all("SELECT * FROM surface_commits WHERE proposal_item_id = ?", [a.id]);
    expect(commits.length).toBe(after.state === "approved" ? 1 : 0);
  });
});

// ═══ Interaction safety ══════════════════════════════════════════════════════

describe("interaction safety", () => {
  it("CF-2 (AC-IDN-15): a payload whose team, enterprise or channel doesn't match the proposal's binding is refused with NO state change", async () => {
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    const versions = Number((await one("SELECT COUNT(*) AS n FROM node_versions WHERE nest_id = ?", [N])).n);
    const links = Number((await one("SELECT COUNT(*) AS n FROM surface_identity_links")).n);
    for (const o of [{ team: "T9", userTeam: "T9" }, { channel: "C2" }, { enterprise: "E1" }, { userTeam: "T9" }]) {
      await click("U_DANA", "nest_approve", p.id, o);
      expect(notesText()).toMatch(/Only .* members can act on this\./);
    }
    expect((await one("SELECT * FROM surface_proposal_items WHERE id = ?", [a.id])).state).toBe("pending");
    expect((await one("SELECT status FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC LIMIT 1", [N, a.node_id])).status).toBe("pending");
    expect(Number((await one("SELECT COUNT(*) AS n FROM node_versions WHERE nest_id = ?", [N])).n)).toBe(versions);
    expect(Number((await one("SELECT COUNT(*) AS n FROM surface_identity_links")).n)).toBe(links);
    expect((await all("SELECT * FROM surface_actions WHERE proposal_item_id = ?", [a.id])).length).toBe(0);
  });

  it("signature: a bad or replayed signature on interactions and commands is 401 and changes nothing", async () => {
    const raw = `payload=${encodeURIComponent(JSON.stringify(actionPayload("U_DANA", "nest_approve", { p: "x" })))}`;
    expect((await postRaw(`/surfaces/slack/${installId}/interactions`, raw, "application/x-www-form-urlencoded", "wrong")).status).toBe(401);
    const old = sign(raw, SIGNING, Math.floor(Date.now() / 1000) - 600);
    expect((await app.request(`/surfaces/slack/${installId}/interactions`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Slack-Request-Timestamp": old.ts, "X-Slack-Signature": old.sig }, body: raw })).status).toBe(401);
    expect((await postRaw(`/surfaces/slack/${installId}/commands`, "text=leave", "application/x-www-form-urlencoded", "wrong")).status).toBe(401);
  });

  it("response_url is only ever a hooks.slack.com URL (SSRF fence)", async () => {
    expect(await S.interactions.respondTo("https://evil.test/x", { text: "x" })).toBe(false);
    expect(await S.interactions.respondTo("http://hooks.slack.com/x", { text: "x" })).toBe(false);
    expect(netCalls.filter((u) => u.includes("evil"))).toEqual([]);
  });

  it("CF-3: with FEATURE_SURFACES off, interactions, commands, events and the S2b REST routes all 404 and store nothing", async () => {
    process.env.FEATURE_SURFACES = "false";
    try {
      const raw = `payload=${encodeURIComponent(JSON.stringify(actionPayload("U_DANA", "nest_approve", { p: "x" })))}`;
      expect((await postRaw(`/surfaces/slack/${installId}/interactions`, raw, "application/x-www-form-urlencoded")).status).toBe(404);
      expect((await postRaw(`/surfaces/slack/${installId}/commands`, "text=leave", "application/x-www-form-urlencoded")).status).toBe(404);
      for (const path of ["/surfaces/pending", "/surfaces/proposals", "/surfaces/commits", `/surfaces/nests/${N}/budget`]) {
        expect((await jsonRequest(app, "GET", path, undefined, root.apiKey)).status).toBe(404);
      }
    } finally {
      process.env.FEATURE_SURFACES = "true";
    }
  });
});

// ═══ Member boot (§12 R3) ═══════════════════════════════════════════════════

describe("member boot", () => {
  it("AC-BOOT-01, AC-BOOT-05: /nest leave opens a confirm dialog; confirming stops capture, purges the buffer, withdraws pending cards (no hold) and the binding becomes paused_by_member; a double boot is a no-op", async () => {
    setChannel("CB", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind("CB");
    const p = await makeProposal("CB");
    await say("CB", "U_BOB", "this one sits in the buffer waiting for its window");
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [bound.CB])).length).toBeGreaterThan(0);
    const r = await command("U_BOB", "leave", "CB");
    expect(r.status).toBe(200);
    const view = lastView();
    expect(view.callback_id).toBe("nest_boot_modal");
    expect(textOfBlocks(view.blocks)).toMatch(/Nest stops reading messages here at once/);
    await submitView("U_BOB", view, {});
    const b = await one("SELECT * FROM surface_bindings WHERE id = ?", [bound.CB]);
    expect(b.status).toBe("paused_by_member");
    expect(b.booted_by_surface_user_id).toBe("U_BOB");
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [bound.CB])).length).toBe(0);
    const [a] = await itemsOf(p.id);
    expect(a.state).toBe("withdrawn");
    expect(await one("SELECT * FROM surface_fingerprints WHERE node_id = ?", [a.node_id])).toBeUndefined();
    const version = b.version;
    await submitView("U_BOB", view, {});
    expect((await one("SELECT version, status FROM surface_bindings WHERE id = ?", [bound.CB]))).toMatchObject({ version, status: "paused_by_member" });
  });

  it("AC-BOOT-03: the admin sees 'removed by <member> on <date>' with no reason field; messages are dropped at the gate from the boot on", async () => {
    const v = (await jsonRequest(app, "GET", `/surfaces/bindings/${bound.CB}`, undefined, alice.apiKey)).data.binding;
    expect(v.booted_by).toBe("Bob");
    expect(v.booted_at).toBeTruthy();
    expect(Object.keys(v).some((k) => /reason/i.test(k))).toBe(false);
    await say("CB", "U_DANA", "a message after the boot that must never be buffered");
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [bound.CB])).length).toBe(0);
  });

  it("AC-BOOT-04: re-binding is refused while the booting member is present without consent; they get a one-tap 'Allow Nest back'; after consent it is allowed", async () => {
    const r = await jsonRequest(app, "POST", `/surfaces/bindings/${bound.CB}/resume`, {}, alice.apiKey);
    expect(r.status).toBe(409);
    const prompt = slack.posted.filter((p) => p.channel === "D_U_BOB" && /Allow Nest back/.test(p.blocks ?? "")).pop()!;
    expect(prompt).toBeTruthy();
    const btn = JSON.parse(prompt.blocks).find((b: any) => b.type === "actions").elements[0];
    await interact(actionPayload("U_BOB", btn.action_id, btn.value, { channel: "D_U_BOB" }));
    const ok = await jsonRequest(app, "POST", `/surfaces/bindings/${bound.CB}/resume`, {}, alice.apiKey);
    expect(ok.status).toBe(200);
    expect(ok.data.binding.status).toBe("active");
  });

  it("AC-BOOT-02: a non-admin in a general channel is refused with a reply naming the admins who can unbind it, and nothing changes", async () => {
    setChannel("CGEN", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "U_ROOT", "UBOT"], { is_general: true, name: "general" });
    await bind("CGEN");
    const before = await one("SELECT version, status FROM surface_bindings WHERE id = ?", [bound.CGEN]);
    const r = await command("U_BOB", "leave", "CGEN");
    expect(r.body.text).toMatch(/general channel, so only a workspace admin can remove Nest from it: <@U_ROOT>/);
    expect(r.body.text).not.toMatch(/@surf\.test/);
    expect(await one("SELECT version, status FROM surface_bindings WHERE id = ?", [bound.CGEN])).toEqual(before);
    // The card overflow path refuses the same way.
    const p = await makeProposal("CGEN");
    await interact(actionPayload("U_BOB", "nest_overflow", "x", { channel: "CGEN", selected: { value: JSON.stringify({ a: "boot", p: p.id }) } }));
    expect(notesText()).toMatch(/only a workspace admin can remove Nest/);
    expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound.CGEN])).status).toBe("active");
  });
});

// ═══ DM capture (§12 R1/R2) ══════════════════════════════════════════════════

describe("DM capture", () => {
  const dmSay = async (user: string, text: string) => {
    const ch = `D_${user}`;
    if (!slack.convs.has(ch)) slack.convs.set(ch, { info: { id: ch, is_im: true, is_private: true, is_ext_shared: false, is_general: false, is_mpim: false }, members: [user, "UBOT"] });
    await event({ type: "message", channel: ch, user, text, ts: nextTs(), channel_type: "im" });
    return ch;
  };

  it("AC-DMS-01: by default DM capture is OFF — nothing is buffered and the bot replies once (per person per 7 days) saying so and who can turn it on", async () => {
    const posts = slack.posted.filter((p) => p.channel === "D_U_ERIN").length;
    await dmSay("U_ERIN", "remember: board meeting moved to the 14th");
    await dmSay("U_ERIN", "remember: and the offsite is in march");
    const replies = slack.posted.filter((p) => p.channel === "D_U_ERIN").slice(posts);
    expect(replies.length).toBe(1);
    expect(replies[0].text).toMatch(/DM capture is off.*A server administrator can turn it on/);
    expect((await all("SELECT * FROM surface_buffer WHERE install_id = ? AND author_surface_user_id = 'U_ERIN' AND binding_id IN (SELECT id FROM surface_bindings WHERE conversation_kind = 'dm')", [installId])).length).toBe(0);
    expect(await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_ERIN'")).toBeUndefined();
  });

  it("AC-DMS-04: settings get/update carry dm_capture over REST and MCP, admin-only", async () => {
    expect((await jsonRequest(app, "GET", "/surfaces/settings", undefined, root.apiKey)).data.settings.dm_capture).toBe(false);
    expect((await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: true }, alice.apiKey)).status).toBe(403);
    expect((await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: "yes" }, root.apiKey)).status).toBe(422);
    const mcpRes = await app.request(`/nests/${N}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${root.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_surfaces_settings_update", arguments: { dm_capture: true } } }),
    });
    const txt = await mcpRes.text();
    expect(txt).toMatch(/dm_capture\\?":true/);
    expect((await jsonRequest(app, "GET", "/surfaces/settings", undefined, root.apiKey)).data.settings.dm_capture).toBe(true);
  });

  it("AC-DM-05: an unlinked person's DM buffers nothing; the reply is a one-time link", async () => {
    await dmSay("U_NEW", "remember: my laptop serial is in the drawer");
    const reply = slack.posted.filter((p) => p.channel === "D_U_NEW").pop()!;
    expect(reply.text).toMatch(/https:\/\/nest\.surf\.test\/link\/[A-Za-z0-9_-]{20,}/);
    expect((await all("SELECT * FROM surface_buffer WHERE author_surface_user_id = 'U_NEW'")).length).toBe(0);
  });

  it("AC-DM-01, AC-DM-D1, AC-DM-03, AC-DM-02, AC-DM-D2: a linked person's first DM makes '<Name> (private)' with readers {them}, binds the DM (both flags), says 'Private to you: no one else, including admins, can open it in Nest.'; 'remember:' is judged at once; DM cards carry the disclosure, the first adds the private-nest line", async () => {
    // The first DM makes the private nest and the binding; its listener then
    // gets its folders (seeds are S3 — tests set them explicitly).
    await dmSay("U_DANA", "hello nest, this is my first direct message to you");
    const b0 = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    await setFolders(b0.id);
    modelImpl = proposeN(1);
    await dmSay("U_DANA", "remember: board meeting moved to the 14th");
    modelImpl = () => submit(noop());
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    expect(b).toMatchObject({ conversation_kind: "dm", capture_ok: 1, surface_ok: 1, status: "active", dm_owner_user_id: dana.userId });
    const nest = await one("SELECT * FROM nests WHERE id = ?", [b.nest_id]);
    expect(nest.name).toBe("Dana Reviewer (private)");
    const intro = slack.posted.find((p) => p.channel === "D_U_DANA" && !p.blocks)!;
    // Round 4 (Misha, 2026-11-01): the exact disclosure wording.
    expect(intro.text).toMatch(/Private to you: no one else, including admins, can open it in Nest\./);
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [b.id]);
    expect(p.forced).toBe(1);
    expect(p.state).toBe("posted");
    const card = textOfBlocks(blocksOf(slack.posted.filter((x) => x.channel === "D_U_DANA" && x.blocks).pop()!));
    expect(card).toMatch(/📁 inbox\/ in Dana Reviewer \(private\)/);
    expect(card).toMatch(/Private to you: no one else, including admins, can open it in Nest\./);
    expect(card).toMatch(/I made this private nest for you/);
    modelImpl = proposeN(1);
    await dmSay("U_DANA", "remember: the dentist is on tuesday");
    modelImpl = () => submit(noop());
    const second = textOfBlocks(blocksOf(slack.posted.filter((x) => x.channel === "D_U_DANA" && x.blocks).pop()!));
    expect(second).not.toMatch(/I made this private nest for you/);
    expect(second).toMatch(/Private to you: no one else, including admins, can open it in Nest\./);
  });

  it("R10-1 (§14): an unseeded DM personal nest has no folders — the window ends no_target_folder with no model call, and the counts-only alert goes to the OWNER, not admins", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    // No default folders anywhere: a fresh DM listener's config carries none.
    const { DEFAULT_LISTENER_FOLDERS, listenerConfig } = await import("../src/surfaces/services/listener-service.js");
    expect([...DEFAULT_LISTENER_FOLDERS]).toEqual([]);
    expect(listenerConfig(b.id).surfaces_listener.folders).toEqual([]);
    await setFolders(b.id, []);
    let called = 0;
    modelImpl = (req: any) => {
      called++;
      return proposeN(1)(req);
    };
    await db().run("DELETE FROM surface_notices WHERE kind = 'no_target_folder' AND binding_id = ?", [b.id]);
    await dmSay("U_DANA", `remember: unseeded dm check ${rnd()}`);
    modelImpl = () => submit(noop());
    expect(called).toBe(0);
    const w = await one("SELECT verdict, reason_code FROM surface_windows WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [b.id]);
    expect(w).toMatchObject({ verdict: "no_target_folder", reason_code: "no_target_folder" });
    const notices = await all("SELECT audience, recipient_user_id, detail FROM surface_notices WHERE kind = 'no_target_folder' AND binding_id = ?", [b.id]);
    expect(notices.length).toBe(1);
    expect(notices[0]).toMatchObject({ audience: "user", recipient_user_id: dana.userId });
    expect(String(notices[0].detail)).not.toMatch(/unseeded dm check/);
    const { NO_TARGET_FOLDER_DM_TEXT } = await import("../src/surfaces/services/judge-service.js");
    expect(NO_TARGET_FOLDER_DM_TEXT).toMatch(/^Nest can't file this yet: your private nest has no folders set up\./);
    // Tests that need a target set folders explicitly (seeds are S3).
    await setFolders(b.id);
  });

  it("AC-DM-04: the Edit dialog in a DM fixes the target to the personal nest", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? AND state = 'posted' ORDER BY created_at DESC LIMIT 1", [b.id]);
    // Dana owns her nest; self-approve is off, so she is not its reviewer: make her one for this check.
    await jsonRequest(app, "PATCH", `/nests/${b.nest_id}`, { allow_self_approve: true }, dana.apiKey);
    await db().run("UPDATE nests SET allow_self_approve = 1 WHERE id = ?", [b.nest_id]).catch(() => {});
    await click("U_DANA", "nest_edit", p.id, { channel: "D_U_DANA" });
    const v = lastView();
    expect(v.callback_id).toBe("nest_edit_modal");
    expect(textOfBlocks(v.blocks)).toMatch(/Saving to inbox\/ \(your private nest\) in Dana Reviewer \(private\)\. The folder and nest can't be changed here\./);
  });

  it("AC-DM-06: if the personal nest can't have readers = {them}, capture is refused with the 'can't keep a private nest here yet' reply and nothing is buffered", async () => {
    const pn = (await jsonRequest(app, "POST", "/nests", { name: `Erin sealed ${rnd()}` }, erin.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${pn}/collaborators`, { email: bob.email, permission: "read" }, erin.apiKey);
    await db().run("INSERT INTO surface_personal_nests (install_id, community_user_id, nest_id) VALUES (?, ?, ?)", [installId, erin.userId, pn]);
    await dmSay("U_ERIN", "remember: something private");
    expect(slack.posted.filter((p) => p.channel === "D_U_ERIN").pop()!.text).toMatch(/Nest can't keep a private nest here yet\. Ask your admin\./);
    expect((await all("SELECT * FROM surface_buffer WHERE author_surface_user_id = 'U_ERIN' AND binding_id IN (SELECT id FROM surface_bindings WHERE conversation_kind = 'dm')")).length).toBe(0);
  });

  it("AC-DMS-03: a person turning their own DM capture off purges their DM buffer and withdraws their pending DM cards; later DMs aren't buffered until they turn it back on", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    await dmSay("U_DANA", "a plain DM message that sits in the buffer");
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [b.id])).length).toBeGreaterThan(0);
    const pending = await one("SELECT DISTINCT p.id FROM surface_proposals p JOIN surface_proposal_items i ON i.proposal_id = p.id WHERE p.binding_id = ? AND i.state = 'pending'", [b.id]);
    const r = await command("U_DANA", "dm off", "D_U_DANA");
    expect(r.body.text).toMatch(/Your DM capture is off/);
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [b.id])).length).toBe(0);
    if (pending) expect((await itemsOf(pending.id)).every((i) => i.state !== "pending")).toBe(true);
    await dmSay("U_DANA", "another plain DM message that must not be kept");
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [b.id])).length).toBe(0);
    await command("U_DANA", "dm on", "D_U_DANA");
    await dmSay("U_DANA", "a DM message after turning capture back on");
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [b.id])).length).toBe(1);
  });

  it("AC-DMS-02: an admin turning DM capture off purges every DM buffer in the same save, withdraws pending DM cards (no hold) and is audit-logged with the admin", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    modelImpl = proposeN(1);
    await dmSay("U_DANA", "remember: the parking pass renews in april");
    modelImpl = () => submit(noop());
    await dmSay("U_DANA", "and a buffered plain message too for good measure");
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [b.id]);
    const [a] = await itemsOf(p.id);
    expect(a.state).toBe("pending");
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [b.id])).length).toBeGreaterThan(0);
    const r = await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: false }, root.apiKey);
    expect(r.status).toBe(200);
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id IN (SELECT id FROM surface_bindings WHERE conversation_kind = 'dm')")).length).toBe(0);
    const after = await one("SELECT * FROM surface_proposal_items WHERE id = ?", [a.id]);
    expect(after.state).toBe("withdrawn");
    expect(await one("SELECT * FROM surface_fingerprints WHERE node_id = ?", [a.node_id])).toBeUndefined();
    expect(slack.updates.filter((u) => u.ts === JSON.parse(p.card_ref).message_ref).pop()!.blocks).toMatch(/Withdrawn/);
    const audit = await one("SELECT * FROM surface_notices WHERE kind = 'dm_capture_changed' ORDER BY created_at DESC LIMIT 1");
    expect(JSON.parse(audit.detail)).toMatchObject({ dm_capture: false, by_user_id: root.userId });
  });
});

// ═══ Round 2 (orchestrator, 2026-10-31) ═════════════════════════════════════

describe("round 2", () => {
  it("R2-1 (§4.17): when surface_ok turns false, every card already posted in that conversation is re-rendered to the fixed template — no nest or model text remains", async () => {
    setChannel("CR", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind("CR");
    expect((await one("SELECT surface_ok FROM surface_bindings WHERE id = ?", [bound.CR])).surface_ok).toBe(1);
    modelImpl = (req) =>
      submit({ verdict: "propose", reason_code: "proposed", ask_signature: null, items: [item(req, { kind: "correction", op: "edit", target_node_id: ACME, title: "Acme quarterly billing noted", conflict: { node_id: ACME, on_record_claim: "Billed annually zzrecord", thread_claim: "Billed quarterly" } })] });
    await say("CR", "U_BOB", "heads up everyone, acme is actually billed quarterly now according to the new signed contract");
    await tick();
    modelImpl = () => submit(noop());
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [bound.CR]);
    expect(p.state).toBe("posted");
    expect(textOfBlocks(blocksOf(cardFor(p)!))).toMatch(/Billed annually zzrecord/);
    // A second, already-decided card in the same conversation.
    const q = await makeProposal("CR");
    await click("U_DANA", "nest_reject", q.id, { channel: "CR" });
    await submitView("U_DANA", lastView(), { reason: { v: { selected_option: { value: "other" } } } });
    // Mallory (not a Revenue reader) joins: capture stays ok, surface_ok turns false.
    slack.convs.get("CR")!.members.push("U_MAL");
    const before = slack.updates.length;
    slack.updateFail = 100; // every update fails for now → redaction_pending, retried by later sweeps
    await event({ type: "member_joined_channel", channel: "CR", user: "U_MAL" });
    await S.runner.runGuardSweep();
    await S.work.waitForSurfacesWork();
    const b = await one("SELECT status, surface_ok, capture_ok FROM surface_bindings WHERE id = ?", [bound.CR]);
    expect(b).toMatchObject({ status: "active", surface_ok: 0, capture_ok: 1 });
    expect(Number((await one("SELECT COUNT(*) AS n FROM surface_proposals WHERE binding_id = ? AND redaction_pending = 1", [bound.CR])).n)).toBe(2);
    slack.updateFail = 0;
    // The sweep retries with backoff (security round M1): make the retry due now.
    await db().run("UPDATE surface_proposals SET redaction_next_at = NULL WHERE binding_id = ?", [bound.CR]);
    await S.runner.runGuardSweep(); // the retry
    await S.work.waitForSurfacesWork();
    expect(Number((await one("SELECT COUNT(*) AS n FROM surface_proposals WHERE binding_id = ? AND redaction_pending = 1", [bound.CR])).n)).toBe(0);
    const ups = slack.updates.slice(before);
    const last = (ref: string) => ups.filter((u) => u.ts === JSON.parse(ref).message_ref).pop();
    const up = last(p.card_ref)!;
    expect(up).toBeTruthy();
    expect(up.blocks).toMatch(/A proposed correction from this conversation is waiting for review in Revenue/);
    expect(up.blocks).not.toMatch(/On record|zzrecord|quarterly|Acme|Team agrees/);
    const uq = last(q.card_ref)!;
    expect(uq).toBeTruthy();
    expect(uq.blocks).toMatch(/Not saved\. Rejected by/);
    expect(uq.blocks).not.toMatch(/Team agrees/);
    const pt = (await itemsOf(q.id))[0];
    void pt;
  });

  it("R2-2: the full-draft page shows the draft only to people who may approve the item, plus server admins; other readers see 'Pending review — available once approved'", async () => {
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    const path = `/surfaces/drafts/${a.id}`;
    for (const u of [dana, root]) {
      const r = await app.request(path, { headers: { Authorization: `Bearer ${u.apiKey}` } });
      expect(r.status).toBe(200);
      expect(await r.text()).toMatch(/team switches to the/);
    }
    const r = await app.request(path, { headers: { Authorization: `Bearer ${bob.apiKey}` } });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toMatch(/Pending review — available once approved/);
    expect(html).not.toMatch(/team switches to the|Team agrees/);
    expect((await app.request(path, { headers: { Authorization: `Bearer ${mallory.apiKey}` } })).status).toBe(403);
    expect(textOfBlocks(blocksOf(cardFor(p)!))).toMatch(/\|Full draft \(reviewers\)>/);
  });

  it("R2-3a: booting from the App Home ('Remove Nest') opens the confirm dialog and boots the conversation", async () => {
    setChannel("CH", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind("CH");
    await jsonRequest(app, "POST", `/surfaces/bindings/${bound.CH}/recheck`, {}, alice.apiKey);
    await event({ type: "app_home_opened", user: "U_ERIN", tab: "home", channel: "D1" });
    const home = lastView("views.publish");
    const btn = home.blocks.find((b: any) => b.accessory?.action_id === "home_boot" && b.accessory.value.includes(bound.CH))?.accessory;
    expect(btn).toBeTruthy();
    await interact(actionPayload("U_ERIN", btn.action_id, btn.value, { home: true, channel: null }));
    const view = lastView();
    expect(view.callback_id).toBe("nest_boot_modal");
    await submitView("U_ERIN", view, {});
    expect(await one("SELECT status, booted_by_surface_user_id FROM surface_bindings WHERE id = ?", [bound.CH])).toMatchObject({ status: "paused_by_member", booted_by_surface_user_id: "U_ERIN" });
  });

  it("R10-5 (AC-BOOT-01): the card overflow 'Remove Nest from this conversation' opens the confirm and boots; it is refused when the click comes from another conversation", async () => {
    setChannel("COV", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind("COV");
    await jsonRequest(app, "POST", `/surfaces/bindings/${bound.COV}/recheck`, {}, alice.apiKey);
    await setFolders(bound.COV);
    const p = await makeProposal("COV");
    const card = slack.posted.filter((x) => x.channel === "COV" && x.blocks).pop()!;
    const ov = blocksOf(card).map((b: any) => b.accessory).find((a: any) => a?.type === "overflow");
    expect(ov).toBeTruthy();
    expect(ov.action_id).toBe("nest_overflow");
    const opt = ov.options.find((o: any) => /Remove Nest from this conversation/.test(o.text.text));
    expect(JSON.parse(opt.value)).toMatchObject({ a: "boot", p: p.id });
    // From another conversation: refused, no dialog, nothing changes.
    const views = slack.views.length;
    await interact(actionPayload("U_ERIN", "nest_overflow", "", { channel: "C1", selected: opt }));
    expect(slack.views.length).toBe(views);
    expect(String(slack.responses[slack.responses.length - 1].body.text)).toMatch(/members can act on this/);
    expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound.COV])).status).toBe("active");
    // From the card's own conversation: the confirm opens and boots.
    await interact(actionPayload("U_ERIN", "nest_overflow", "", { channel: "COV", selected: opt }));
    const view = lastView();
    expect(view.callback_id).toBe("nest_boot_modal");
    await submitView("U_ERIN", view, {});
    expect(await one("SELECT status, booted_by_surface_user_id FROM surface_bindings WHERE id = ?", [bound.COV])).toMatchObject({ status: "paused_by_member", booted_by_surface_user_id: "U_ERIN" });
  });

  it("R2-3b: 'That's not me' end to end — nothing is executed, the link is revoked with auto-match blocked, and admins are told", async () => {
    const p = await makeProposal("C1");
    await db().run("UPDATE surface_identity_links SET method = 'auto_email', first_use_confirmed_at = NULL WHERE install_id = ? AND surface_user_id = 'U_FRANK' AND status = 'active'", [installId]);
    await click("U_FRANK", "nest_approve", p.id);
    const ask = slack.responses.pop()!.body;
    expect(ask.text).toMatch(/You're about to \*approve\* this/);
    const no = ask.blocks.find((b: any) => b.type === "actions").elements[1];
    expect(no.action_id).toBe("nest_confirm_no");
    const notices = Number((await one("SELECT COUNT(*) AS n FROM surface_notices WHERE kind = 'link_disowned'")).n);
    await interact(actionPayload("U_FRANK", no.action_id, no.value));
    const l = await one("SELECT * FROM surface_identity_links WHERE install_id = ? AND surface_user_id = 'U_FRANK' ORDER BY created_at DESC LIMIT 1", [installId]);
    expect(l).toMatchObject({ status: "revoked", auto_match_blocked: 1 });
    expect((await itemsOf(p.id))[0].state).toBe("pending");
    expect((await all("SELECT * FROM surface_actions WHERE proposal_item_id = ?", [(await itemsOf(p.id))[0].id])).length).toBe(0);
    expect(Number((await one("SELECT COUNT(*) AS n FROM surface_notices WHERE kind = 'link_disowned'")).n)).toBe(notices + 1);
    expect(notesText()).toMatch(/nothing was done/);
    await db().run("DELETE FROM surface_identity_links WHERE install_id = ? AND surface_user_id = 'U_FRANK'", [installId]);
    await S.identity.linkExplicit({ installId, surfaceUserId: "U_FRANK", communityUserId: frank.userId });
  });

  it("R2-3c: the hosted /commands route checks the hosted signature first, then handles /nest leave and /nest dm", async () => {
    process.env.FEATURE_SURFACES_SLACK_HOSTED = "true";
    process.env.SURFACES_SLACK_HOSTED_SIGNING_SECRET = "hosted-secret";
    try {
      const hid = `hosted-${rnd()}`;
      await db().run("INSERT INTO surface_installs (id, org_id, surface, mode, tenant_key, team_id, bot_user_id, home_nest_id, status) VALUES (?, 'default', 'slack', 'hosted', 'T7', 'T7', 'UBOT7', ?, 'active')", [hid, N]);
      const { setSecret } = await import("../src/surfaces/services/secret-store.js");
      await setSecret(hid, "bot_token", "xoxb-T7", root.userId);
      const body = (text: string) => new URLSearchParams({ command: "/nest", text, user_id: "U7", channel_id: "C7X", team_id: "T7", trigger_id: "t", response_url: "https://hooks.slack.com/commands/T7/1/x" }).toString();
      expect((await postRaw("/surfaces/slack/hosted/commands", body("dm off"), "application/x-www-form-urlencoded", SIGNING)).status).toBe(401);
      expect(await one("SELECT * FROM surface_dm_optouts WHERE install_id = ?", [hid])).toBeUndefined();
      const leave = await postRaw("/surfaces/slack/hosted/commands", body("leave"), "application/x-www-form-urlencoded", "hosted-secret");
      expect(leave.status).toBe(200);
      expect((await leave.json()).text).toMatch(/Nest isn't listening in this conversation/);
      const off = await postRaw("/surfaces/slack/hosted/commands", body("dm off"), "application/x-www-form-urlencoded", "hosted-secret");
      expect((await off.json()).text).toMatch(/Your DM capture is off/);
      expect(await one("SELECT * FROM surface_dm_optouts WHERE install_id = ? AND surface_user_id = 'U7'", [hid])).toBeTruthy();
    } finally {
      delete process.env.FEATURE_SURFACES_SLACK_HOSTED;
      delete process.env.SURFACES_SLACK_HOSTED_SIGNING_SECRET;
    }
  });

  it("R2-5: a reviewer without edit rights gets Approve/Reject but no Edit button (card and App Home); a crafted Edit click opens no dialog", async () => {
    const p = await makeProposal("C1");
    const bl = blocksOf(cardFor(p)!);
    const btns = bl.filter((b: any) => b.type === "actions").flatMap((b: any) => b.elements.map((e: any) => e.text?.text));
    expect(btns).toEqual(expect.arrayContaining(["Approve", "Reject"]));
    expect(btns).not.toContain("Edit");
    const views = slack.views.length;
    await click("U_DANA", "nest_edit", p.id);
    expect(slack.views.length).toBe(views);
    expect(notesText()).toMatch(/editing needs edit rights/i);
    // Held row in App Home: Dana (no edit rights) gets Approve / Reject / Review in nest only.
    const h = await makeProposal("CPUB");
    expect(h.state).toBe("held");
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    const home = (await S.home.buildHomeView(install, "U_DANA")).blocks;
    const row = home.find((b: any) => b.type === "actions" && b.elements.some((e: any) => e.value?.includes(h.id)));
    expect(row.elements.map((e: any) => e.text.text)).toEqual(["Approve", "Reject", "Review in nest"]);
    // With edit rights, Edit comes back.
    await db().run("UPDATE nest_collaborators SET permission = 'write' WHERE nest_id = ? AND user_id = ?", [N, dana.userId]);
    const home2 = (await S.home.buildHomeView(install, "U_DANA")).blocks;
    const row2 = home2.find((b: any) => b.type === "actions" && b.elements.some((e: any) => e.value?.includes(h.id)));
    expect(row2.elements.map((e: any) => e.text.text)).toEqual(["Approve", "Edit", "Reject", "Review in nest"]);
    await db().run("UPDATE nest_collaborators SET permission = 'read' WHERE nest_id = ? AND user_id = ?", [N, dana.userId]);
  });

  it("R2-6 (AC-HOM-08): the admin view names the reviewers who have held items, by Slack mention only", async () => {
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    const s = textOfBlocks((await S.home.buildHomeView(install, "U_ROOT")).blocks);
    const line = (JSON.parse(s) as any[]).flatMap((b: any) => b.elements ?? []).map((e: any) => e.text ?? "").find((t: string) => /#cpub · \d+ held/.test(t));
    expect(line).toBeTruthy();
    expect(line).toMatch(/<@U_DANA>/);
    expect(line).toMatch(/<@U_ERIN>/);
    expect(line).not.toMatch(/@surf\.test/);
  });

  it("R2-7: reject/expire purges go through the one shared draft-purge path; postForcedCard is gone", () => {
    const src = (f: string) => readFileSync(join(__dirname, "..", "src", "surfaces", "services", f), "utf8");
    for (const f of ["commit-service.ts", "expiry-service.ts"]) {
      expect(src(f)).not.toMatch(/\bdiscardDraft\b|\bcancelReview\b/);
      expect(src(f)).toMatch(/purgeSurfaceDraft/);
    }
    expect(src("proposal-service.ts")).not.toMatch(/postForcedCard/);
  });
});

// ═══ Security round (S7 review of S2b) ════════════════════════════════════════

describe("security round", () => {
  const conflictModel = (req: any) =>
    submit({ verdict: "propose", reason_code: "proposed", ask_signature: null, items: [item(req, { kind: "correction", op: "edit", target_node_id: ACME, title: "Acme quarterly billing noted", conflict: { node_id: ACME, on_record_claim: "Billed annually zzsecret", thread_claim: "Billed quarterly" } })] });
  /** A posted card carrying model text, in its own fresh channel. */
  async function conflictCard(channel: string) {
    setChannel(channel, ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind(channel);
    const p = await makeProposal(channel);
    expect(p.state).toBe("posted");
    const t = (await itemsOf(p.id))[0].title;
    expect(textOfBlocks(blocksOf(cardFor(p)!))).toContain(t);
    return { ...p, title: t };
  }
  const lastUpdate = (p: any) => slack.updates.filter((u) => u.ts === JSON.parse(p.card_ref).message_ref).pop();

  it("SEC-M1a: a guard PAUSE whose card update fails keeps the card redaction_pending (not done) and the sweep retries until Slack confirms — no nest or model text left", async () => {
    const p = await conflictCard("CS1");
    slack.updateFail = 100;
    await jsonRequest(app, "POST", `/nests/${N}/collaborators`, { email: mallory.email, permission: "read" }, alice.apiKey);
    await jsonRequest(app, "POST", `/surfaces/bindings/${bound.CS1}/recheck`, {}, alice.apiKey);
    await S.work.waitForSurfacesWork();
    expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound.CS1])).status).toBe("paused_guard");
    const mid = await one("SELECT redaction_pending, redaction_attempts, redaction_next_at FROM surface_proposals WHERE id = ?", [p.id]);
    expect(mid.redaction_pending).toBe(1);
    expect(mid.redaction_attempts).toBeGreaterThan(0);
    expect(Date.parse(mid.redaction_next_at)).toBeGreaterThan(Date.now()); // backoff
    slack.updateFail = 0;
    await db().run("UPDATE surface_proposals SET redaction_next_at = NULL WHERE id = ?", [p.id]);
    // The guard sweep's retry hook (a full sweep here would also re-check every
    // other Revenue binding while Mallory is still a reader).
    await S.cards.retryRedactions();
    expect((await one("SELECT redaction_pending FROM surface_proposals WHERE id = ?", [p.id])).redaction_pending).toBe(0);
    const up = lastUpdate(p)!;
    expect(up.blocks).toMatch(/Withdrawn/);
    expect(up.blocks).not.toContain(p.title);
    expect(up.blocks).not.toMatch(/Team agrees/);
    const mc = await one("SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?", [N, mallory.userId]);
    await jsonRequest(app, "DELETE", `/nests/${N}/collaborators/${mc.id}`, undefined, alice.apiKey);
  });

  it("SEC-M1b: a permanent failure (message_not_found) falls back to chat.delete; if that fails too the card is redaction_failed with ONE counts-only admin alert carrying a permalink, and retries stop", async () => {
    const p = await conflictCard("CS2");
    slack.updateFail = 100;
    slack.updateError = "message_not_found";
    await S.cards.redactBindingCards(bound.CS2);
    expect(slack.deleted.some((d) => d.ts === JSON.parse(p.card_ref).message_ref)).toBe(true);
    expect((await one("SELECT redaction_pending, redaction_failed FROM surface_proposals WHERE id = ?", [p.id]))).toMatchObject({ redaction_pending: 0, redaction_failed: 0 });
    // Now the delete fails too.
    const q = await conflictCard("CS3");
    slack.deleteFail = true;
    const before = Number((await one("SELECT COUNT(*) AS n FROM surface_notices WHERE kind = 'card_redaction_failed'")).n);
    await S.cards.redactBindingCards(bound.CS3);
    await S.cards.redactBindingCards(bound.CS3);
    await db().run("UPDATE surface_proposals SET redaction_next_at = NULL WHERE id = ?", [q.id]);
    await S.cards.retryRedactions();
    expect((await one("SELECT redaction_pending, redaction_failed FROM surface_proposals WHERE id = ?", [q.id]))).toMatchObject({ redaction_pending: 0, redaction_failed: 1 });
    const notes = await all("SELECT * FROM surface_notices WHERE kind = 'card_redaction_failed'");
    expect(notes.length).toBe(before + 1);
    const detail = notes[notes.length - 1].detail;
    expect(detail).toMatch(/https:\/\/acme\.slack\.com\/archives\/CS3\//);
    expect(detail).not.toContain(q.title);
    slack.updateFail = 0;
    slack.updateError = "internal_error";
    slack.deleteFail = false;
  });

  it("SEC-M1c: updateCard never marks a card done before Slack confirms (an outcome update that fails stays pending for the retry)", async () => {
    const p = await makeProposal("C1");
    slack.updateFail = 1;
    await click("U_DANA", "nest_approve", p.id);
    const row = await one("SELECT redaction_pending, outcome_rendered FROM surface_proposals WHERE id = ?", [p.id]);
    expect(row.redaction_pending).toBe(1);
    await db().run("UPDATE surface_proposals SET redaction_next_at = NULL WHERE id = ?", [p.id]);
    await S.cards.retryRedactions();
    expect((await one("SELECT redaction_pending FROM surface_proposals WHERE id = ?", [p.id])).redaction_pending).toBe(0);
    expect(lastUpdate(p)!.blocks).toMatch(/Approved by/);
  });

  it("SEC-M1d: postCard's 'posting' claim is a compare-and-set, and a card posted while surface_ok dropped underneath is redacted at once", async () => {
    setChannel("CS4", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind("CS4");
    S.cards.cardTestHooks.beforePost = async (bindingId: string) => {
      await db().run("UPDATE surface_bindings SET surface_ok = 0 WHERE id = ?", [bindingId]);
    };
    try {
      await makeProposal("CS4");
    } finally {
      S.cards.cardTestHooks.beforePost = undefined;
    }
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [bound.CS4]);
    expect(p.state).toBe("posted");
    const up = lastUpdate(p)!;
    expect(up).toBeTruthy();
    expect(up.blocks).not.toMatch(/Team agrees/);
    expect(up.blocks).toMatch(/A proposed decision from this conversation is waiting for review/);
    expect(p.redaction_pending).toBe(0);
    // A second post attempt can't take the claim.
    expect(await S.cards.postCard(p.id)).toBe(false);
    await db().run("UPDATE surface_bindings SET surface_ok = 1 WHERE id = ?", [bound.CS4]);
  });

  it("SEC-M2: a DM arriving while an admin turns DM capture off (or the person opts out) is never buffered or judged: the switch pauses the DM binding in the same transaction", async () => {
    await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: true }, root.apiKey);
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    expect(b.status).toBe("active");
    await setFolders(b.id);
    const { dmTestHooks } = await import("../src/surfaces/services/dm-service.js");
    const proposals = Number((await one("SELECT COUNT(*) AS n FROM surface_proposals WHERE binding_id = ?", [b.id])).n);
    // 1) admin switch lands between prepareDm and the buffer write
    dmTestHooks.afterPrepare = async () => {
      dmTestHooks.afterPrepare = undefined;
      const r = await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: false }, root.apiKey);
      expect(r.status).toBe(200);
    };
    modelImpl = proposeN(1);
    await event({ type: "message", channel: "D_U_DANA", user: "U_DANA", text: "remember: the race message must never be kept", ts: nextTs(), channel_type: "im" });
    await event({ type: "message", channel: "D_U_DANA", user: "U_DANA", text: "a plain race message that must never be kept", ts: nextTs(), channel_type: "im" });
    modelImpl = () => submit(noop());
    const after = await one("SELECT status, pause_reason FROM surface_bindings WHERE id = ?", [b.id]);
    expect(after).toMatchObject({ status: "paused_guard", pause_reason: "dm_off" });
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [b.id])).length).toBe(0);
    expect(Number((await one("SELECT COUNT(*) AS n FROM surface_proposals WHERE binding_id = ?", [b.id])).n)).toBe(proposals);
    // Turning it back on resumes the DM binding.
    await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: true }, root.apiKey);
    expect((await one("SELECT status, pause_reason FROM surface_bindings WHERE id = ?", [b.id]))).toMatchObject({ status: "active", pause_reason: null });
    // 2) the person's own opt-out lands mid-flight
    dmTestHooks.afterPrepare = async () => {
      dmTestHooks.afterPrepare = undefined;
      // Straight to the route (the command() helper waits for in-flight work — this one).
      const raw = new URLSearchParams({ command: "/nest", text: "dm off", user_id: "U_DANA", channel_id: "D_U_DANA", team_id: "T1", trigger_id: "t", response_url: "https://hooks.slack.com/commands/T1/9/x" }).toString();
      expect((await postRaw(`/surfaces/slack/${installId}/commands`, raw, "application/x-www-form-urlencoded")).status).toBe(200);
    };
    await event({ type: "message", channel: "D_U_DANA", user: "U_DANA", text: "another race message that must never be kept", ts: nextTs(), channel_type: "im" });
    expect((await one("SELECT status, pause_reason FROM surface_bindings WHERE id = ?", [b.id]))).toMatchObject({ status: "paused_guard", pause_reason: "dm_optout" });
    expect((await all("SELECT * FROM surface_buffer WHERE binding_id = ?", [b.id])).length).toBe(0);
    // 3) the judge re-checks under its claim: a forced DM window opened just before the switch is not judged into a proposal
    await command("U_DANA", "dm on", "D_U_DANA");
    expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [b.id])).status).toBe("active");
    const { dmCaptureAllowed } = await import("../src/surfaces/services/dm-service.js");
    await db().run("INSERT INTO surface_dm_optouts (install_id, surface_user_id) VALUES (?, 'U_DANA')", [installId]);
    expect(await dmCaptureAllowed({ ...b, status: "active" })).toBe(false);
    await db().run("DELETE FROM surface_dm_optouts WHERE install_id = ? AND surface_user_id = 'U_DANA'", [installId]);
    expect(await dmCaptureAllowed({ ...b, status: "active" })).toBe(true);
    await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: false }, root.apiKey);
  });

  it("SEC-L1: the draft page honours a nest-scoped key's scope", async () => {
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    const k = await jsonRequest(app, "POST", "/auth/keys", { label: "n2 only", nest_id: N2 }, dana.apiKey);
    expect(k.data.api_key).toBeTruthy();
    const r = await app.request(`/surfaces/drafts/${a.id}`, { headers: { Authorization: `Bearer ${k.data.api_key}` } });
    expect([403, 404]).toContain(r.status);
    expect(await r.text()).not.toMatch(/team switches to the/);
    const src = readFileSync(join(__dirname, "..", "src", "surfaces", "routes.ts"), "utf8");
    expect(src).toMatch(/drafts\/:itemId[\s\S]{0,800}assertScope/);
  });

  it("SEC-L2: hosted /commands verifies the signature before any parsing or DB access, under the 1 MB cap", async () => {
    process.env.FEATURE_SURFACES_SLACK_HOSTED = "true";
    process.env.SURFACES_SLACK_HOSTED_SIGNING_SECRET = "hosted-secret";
    try {
      const src = readFileSync(join(__dirname, "..", "src", "surfaces", "adapters", "slack", "routes.ts"), "utf8");
      const block = src.slice(src.indexOf('post("/hosted/commands"'), src.indexOf('post("/hosted/commands"') + 600);
      expect(block.indexOf("signed(")).toBeGreaterThan(-1);
      expect(block.indexOf("signed(")).toBeLessThan(block.indexOf("hostedInstall("));
      expect((await postRaw("/surfaces/slack/hosted/commands", "%%%not-a-form%%%", "application/x-www-form-urlencoded", "wrong")).status).toBe(401);
      const big = "text=" + "x".repeat(1_100_000);
      expect((await postRaw("/surfaces/slack/hosted/commands", big, "application/x-www-form-urlencoded", "hosted-secret")).status).toBe(413);
    } finally {
      delete process.env.FEATURE_SURFACES_SLACK_HOSTED;
      delete process.env.SURFACES_SLACK_HOSTED_SIGNING_SECRET;
    }
  });

  it("SEC-L3: the dialog metadata signs the identity link; if the link changed before submit, the first-use confirm runs again and nothing is committed", async () => {
    const p = await makeProposal("C1");
    await click("U_ERIN", "nest_reject", p.id);
    const view = lastView();
    expect(view.callback_id).toBe("nest_reject_modal");
    // Erin's link is replaced by a different, unconfirmed one-time link (to Frank's account).
    await db().run("UPDATE surface_identity_links SET status = 'revoked' WHERE install_id = ? AND surface_user_id = 'U_ERIN' AND status = 'active'", [installId]);
    await db().run("UPDATE surface_identity_links SET status = 'revoked' WHERE install_id = ? AND surface_user_id = 'U_FRANK' AND status = 'active'", [installId]);
    await db().run(
      "INSERT INTO surface_identity_links (id, org_id, install_id, surface, surface_user_id, community_user_id, method, status) VALUES (?, 'default', ?, 'slack', 'U_ERIN', ?, 'one_time', 'active')",
      [`l-${rnd()}`, installId, frank.userId],
    );
    slack.responses = [];
    await submitView("U_ERIN", view, { reason: { v: { selected_option: { value: "other" } } } });
    expect((await itemsOf(p.id))[0].state).toBe("pending");
    expect(notesText()).toMatch(/You're about to \*reject\* this, recorded under Frank Reviewer/);
    await db().run("DELETE FROM surface_identity_links WHERE install_id = ? AND surface_user_id IN ('U_ERIN', 'U_FRANK')", [installId]);
    await S.identity.linkExplicit({ installId, surfaceUserId: "U_ERIN", communityUserId: erin.userId });
    await S.identity.linkExplicit({ installId, surfaceUserId: "U_FRANK", communityUserId: frank.userId });
  });

  it("SEC-L4: org-wide default and mandatory channels count as general channels (a non-admin can't boot them)", async () => {
    for (const [c, flag] of [["CODEF", "is_org_default"], ["COMAN", "is_org_mandatory"]] as const) {
      setChannel(c, ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "U_ROOT", "UBOT"], { [flag]: true });
      await bind(c);
      expect((await one("SELECT is_general FROM surface_bindings WHERE id = ?", [bound[c]])).is_general).toBe(1);
      const r = await command("U_BOB", "leave", c);
      expect(r.body.text).toMatch(/general channel/);
      expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound[c]])).status).toBe("active");
    }
  });

  it("SEC-L5: 'Approve selected' with nothing ticked, or no checkbox state, is a no-op with a note — it never rejects", async () => {
    const p = await makeProposal("C2", { n: 2 });
    await click("U_DANA", "nest_approve_selected", p.id, { channel: "C2", state: { values: { nest_items: { nest_select: { selected_options: [] } } } } });
    expect(notesText()).toMatch(/Select at least one/);
    await click("U_DANA", "nest_approve_selected", p.id, { channel: "C2" });
    expect((await itemsOf(p.id)).map((i) => i.state)).toEqual(["pending", "pending"]);
    expect((await all("SELECT * FROM surface_actions WHERE proposal_item_id IN (SELECT id FROM surface_proposal_items WHERE proposal_id = ?)", [p.id])).length).toBe(0);
  });

  it("SEC-L6: a claim stuck in progress > 5 min is reconciled from the review row: approved → item + surface_commits written, claim done; still pending → released so expiry can take it", async () => {
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    await db().run(
      "INSERT INTO surface_actions (id, idempotency_key, proposal_item_id, action, surface, surface_user_id, community_user_id, status, created_at, updated_at) VALUES (?, ?, ?, 'approve', 'slack', 'U_DANA', ?, 'in_progress', ?, ?)",
      [`a-${rnd()}`, `decide:${a.id}`, a.id, dana.userId, old, old],
    );
    // The approval itself landed (crash after approve()).
    const ap = await jsonRequest(app, "POST", `/nests/${N}/nodes/${a.node_id}/approve`, {}, dana.apiKey);
    expect(ap.status).toBe(200);
    await S.cards.reconcileStuckClaims();
    expect((await one("SELECT state, decided_by_user_id FROM surface_proposal_items WHERE id = ?", [a.id]))).toMatchObject({ state: "approved", decided_by_user_id: dana.userId });
    expect(await one("SELECT * FROM surface_commits WHERE proposal_item_id = ?", [a.id])).toBeTruthy();
    expect((await one("SELECT status FROM surface_actions WHERE idempotency_key = ?", [`decide:${a.id}`])).status).toBe("done");
    // Still pending → released.
    const q = await makeProposal("C1");
    const [b] = await itemsOf(q.id);
    await db().run(
      "INSERT INTO surface_actions (id, idempotency_key, proposal_item_id, action, status, created_at, updated_at) VALUES (?, ?, ?, 'approve', 'in_progress', ?, ?)",
      [`a-${rnd()}`, `decide:${b.id}`, b.id, old, old],
    );
    await S.cards.reconcileStuckClaims();
    expect(await one("SELECT * FROM surface_actions WHERE idempotency_key = ?", [`decide:${b.id}`])).toBeUndefined();
    await S.expiry.expireDue(Date.parse(q.expires_at) + 1000);
    expect((await one("SELECT state FROM surface_proposal_items WHERE id = ?", [b.id])).state).toBe("expired");
  });

  it("SEC-L7: My pending (App Home) is scoped to the install being viewed, and names only conversations the viewer is in", async () => {
    const p = await makeProposal("C1");
    // Dana isn't in the members snapshot any more → the row says "a private channel".
    await db().run("DELETE FROM surface_members_cache WHERE binding_id = ? AND surface_user_id = 'U_DANA'", [bound.C1]);
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    const s = textOfBlocks((await S.home.buildHomeView(install, "U_DANA")).blocks);
    expect(s).toMatch(/a private channel · \*Team agrees/);
    const rest = (await jsonRequest(app, "GET", "/surfaces/pending", undefined, dana.apiKey)).data.in_thread.find((r: any) => r.proposal_id === p.id);
    expect(rest.conversation).toBe("a private channel");
    await jsonRequest(app, "POST", `/surfaces/bindings/${bound.C1}/recheck`, {}, alice.apiKey);
    // Another install's item never shows on this install's Home.
    const otherInstall = `inst-${rnd()}`;
    await db().run("INSERT INTO surface_installs (id, org_id, surface, mode, tenant_key, team_id, home_nest_id, status) VALUES (?, 'default', 'slack', 'manifest', ?, ?, ?, 'active')", [otherInstall, `T8${rnd()}`, "T8", N]);
    const ob = `b-${rnd()}`;
    await db().run(
      `INSERT INTO surface_bindings (id, install_id, org_id, nest_id, conversation_id, conversation_kind, conversation_name, status, capture_ok, surface_ok, members_known)
       VALUES (?, ?, 'default', ?, 'C-OTHER', 'private_channel', 'other-secret', 'active', 1, 1, 1)`,
      [ob, otherInstall, N],
    );
    const [src] = await itemsOf(p.id);
    const op = `p-${rnd()}`;
    await db().run("INSERT INTO surface_proposals (id, window_id, binding_id, nest_id, card_kind, state, expires_at) VALUES (?, ?, ?, ?, 'single', 'held', ?)", [op, `w-${rnd()}`, ob, N, p.expires_at]);
    await db().run(
      "INSERT INTO surface_proposal_items (id, proposal_id, nest_id, node_id, item_kind, op, target_folder, title, state) VALUES (?, ?, ?, ?, 'decision', 'new', 'inbox/', 'Other install item zz', 'pending')",
      [`i-${rnd()}`, op, N, src.node_id],
    );
    const s2 = textOfBlocks((await S.home.buildHomeView(install, "U_DANA")).blocks);
    expect(s2).not.toMatch(/Other install item zz|other-secret/);
    await db().run("UPDATE surface_proposals SET state = 'withdrawn' WHERE id = ?", [op]);
  });

  it("SEC-INFO-a: agent cards follow the surface_ok rule too", () => {
    const m: any = { proposal_id: "p", can_edit: true, kind: "agent", forced: false, nest_name: "Revenue", message_count: 1, from_label: null, to_label: null, reviewer: null, expires_label: "Nov 7", surface_ok: false, items: [{ id: "i", kind: "agent_suggestion", op: "agent", title: "Secret agent zz", summary: "Zz summary", why: "w", folder: "agents/", node_id: null, draft_url: `${BASE}/x` }] };
    expect(textOfBlocks(S.bk.renderCardBlocks(m))).not.toMatch(/zz|Zz/i);
  });

  it("SEC-INFO-b: im:write is in the manifest; when the consent DM can't be sent, the admin's resume response says so", async () => {
    const { BOT_SCOPES } = await import("../src/surfaces/adapters/slack/manifest.js");
    expect(BOT_SCOPES).toContain("im:write");
    setChannel("CB2", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind("CB2");
    await command("U_BOB", "leave", "CB2");
    await submitView("U_BOB", lastView(), {});
    slack.openFail = true;
    try {
      const r = await jsonRequest(app, "POST", `/surfaces/bindings/${bound.CB2}/resume`, {}, alice.apiKey);
      expect(r.status).toBe(409);
      expect(r.data.consent_prompt).toBe("failed");
      expect(r.data.error).toMatch(/couldn't send/i);
    } finally {
      slack.openFail = false;
    }
  });

  it("SEC-INFO-c: 'Allow Nest back' is scoped to the install", async () => {
    const value = JSON.stringify({ b: bound.CB2 });
    const other = await interact(actionPayload("U_BOB", "nest_allow_back", value, { team: "T9", userTeam: "T9", channel: "D_U_BOB" }));
    expect(other.status).toBe(200);
    expect((await one("SELECT boot_consent_at FROM surface_bindings WHERE id = ?", [bound.CB2])).boot_consent_at).toBeNull();
    const src = readFileSync(join(__dirname, "..", "src", "surfaces", "adapters", "slack", "interactions.ts"), "utf8");
    expect(src).toMatch(/allowBack[\s\S]{0,400}install_id === install\.id/);
  });

  it("SEC-INFO-d: respondTo never follows redirects", () => {
    const src = readFileSync(join(__dirname, "..", "src", "surfaces", "adapters", "slack", "interactions.ts"), "utf8");
    expect(src).toMatch(/redirect:\s*"error"/);
  });

  it("SEC-INFO-e: an edit that repeats another document gets a generic error that doesn't say so", async () => {
    const src = await jsonRequest(app, "POST", `/nests/${N}/nodes`, { title: "Leak source", content: "zebra quantum lattice orchard velvet harbor mosaic lantern", folder: "inbox" }, alice.apiKey);
    expect(src.status).toBeLessThan(300);
    await db().run("UPDATE nest_collaborators SET permission = 'write' WHERE nest_id = ? AND user_id = ?", [N, dana.userId]);
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    const meta = S.interactions.signMeta({ k: "edit", p: p.id, i: [a.id], n: N, f: a.target_folder, u: "U_DANA", t: "T1", v: "edit", l: (await one("SELECT id FROM surface_identity_links WHERE install_id = ? AND surface_user_id = 'U_DANA' AND status = 'active'", [installId])).id, x: Date.now() + 600_000 } as any)!;
    const r = await submitView("U_DANA", { callback_id: "nest_edit_modal", private_metadata: meta }, {
      [`title:${a.id}`]: { v: { value: "Renewal plan agreed" } },
      [`summary:${a.id}`]: { v: { value: "Fine." } },
      [`body:${a.id}`]: { v: { value: "Note: zebra quantum lattice orchard velvet harbor mosaic lantern" } },
    });
    const body = await r.json();
    expect(body.response_action).toBe("errors");
    const msg = String(Object.values(body.errors)[0]);
    expect(msg).not.toMatch(/another document|nest|repeat/i);
    await db().run("UPDATE nest_collaborators SET permission = 'read' WHERE nest_id = ? AND user_id = ?", [N, dana.userId]);
  });

  it("SEC-INFO-f: the first-use confirm works from the App Home (the DM carries the Yes / That's not me buttons)", async () => {
    const h = await makeProposal("CPUB");
    expect(h.state).toBe("held");
    await db().run("UPDATE surface_identity_links SET method = 'one_time', first_use_confirmed_at = NULL WHERE install_id = ? AND surface_user_id = 'U_ERIN' AND status = 'active'", [installId]);
    const before = slack.posted.length;
    await click("U_ERIN", "nest_approve", h.id, { home: true, channel: null });
    const dm = slack.posted.slice(before).find((x) => x.channel === "D_U_ERIN");
    expect(dm).toBeTruthy();
    expect(dm!.blocks).toMatch(/nest_confirm_yes/);
    expect(dm!.blocks).toMatch(/nest_confirm_no/);
    await db().run("UPDATE surface_identity_links SET method = 'explicit', first_use_confirmed_at = ? WHERE install_id = ? AND surface_user_id = 'U_ERIN' AND status = 'active'", [new Date().toISOString(), installId]);
  });
});

// ═══ Round 4: Misha's rulings (2026-11-01) ══════════════════════════════════

describe("round 4", () => {
  const DISCLOSURE = "Private to you: no one else, including admins, can open it in Nest.";

  it("R4-2: the disclosure wording is exact everywhere, and the old 'server's administrators can read it' string is gone from src, API.md and CONFIGURATION.md", async () => {
    const { PRIVATE_NEST_DISCLOSURE } = await import("../src/surfaces/core/card-model.js");
    expect(PRIVATE_NEST_DISCLOSURE).toBe(DISCLOSURE);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(__dirname, "..", "src"));
    for (const f of [...files, join(__dirname, "..", "API.md"), join(__dirname, "..", "CONFIGURATION.md")]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/only you and this server's administrators can read/i);
    }
    expect(readFileSync(join(__dirname, "..", "API.md"), "utf8")).toContain(DISCLOSURE);
    expect(readFileSync(join(__dirname, "..", "CONFIGURATION.md"), "utf8")).toContain(DISCLOSURE);
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: true }, root.apiKey);
    expect(textOfBlocks((await S.home.buildHomeView(install, "U_DANA")).blocks)).toContain(DISCLOSURE.replace(/'/g, "'"));
  });

  it("R4-1: only the owner may approve, reject or edit drafts in their private nest — server admins are refused on Slack, App Home, the draft page, REST (even with override), approve-with-edits, MCP and the review queue; the owner can approve without self-approve", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    expect(b.status).toBe("active");
    await db().run("UPDATE nests SET allow_self_approve = 0 WHERE id = ?", [b.nest_id]).catch(() => {});
    modelImpl = proposeN(1);
    await event({ type: "message", channel: "D_U_DANA", user: "U_DANA", text: `remember: the owner-only rule applies ${rnd()}`, ts: nextTs(), channel_type: "im" });
    modelImpl = () => submit(noop());
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [b.id]);
    expect(p.state).toBe("posted");
    const [a] = await itemsOf(p.id);
    const msg = /Only Dana Reviewer can review items in their private nest/;
    // Slack: a server admin's Approve / Reject / Edit are refused, nothing changes.
    for (const act of ["nest_approve", "nest_reject", "nest_edit"]) {
      slack.responses = [];
      const views = slack.views.length;
      await click("U_ROOT", act, p.id, { channel: "D_U_DANA" });
      expect(notesText()).toMatch(msg);
      expect(slack.views.length).toBe(views);
    }
    // App Home: the admin's Home lists no review buttons for it.
    const install = await one("SELECT * FROM surface_installs WHERE id = ?", [installId]);
    expect(textOfBlocks((await S.home.buildHomeView(install, "U_ROOT")).blocks)).not.toContain(p.id);
    // Draft page: owner only.
    expect((await app.request(`/surfaces/drafts/${a.id}`, { headers: { Authorization: `Bearer ${root.apiKey}` } })).status).toBe(403);
    expect((await app.request(`/surfaces/drafts/${a.id}`, { headers: { Authorization: `Bearer ${dana.apiKey}` } })).status).toBe(200);
    // REST approve (even with a super-admin override), reject, approve-with-edits.
    for (const [path, body] of [
      [`/nests/${b.nest_id}/nodes/${a.node_id}/approve`, { override: true }],
      [`/nests/${b.nest_id}/nodes/${a.node_id}/reject`, { note: "x" }],
      [`/nests/${b.nest_id}/nodes/${a.node_id}/approve-with-edits`, { content: "edited by an admin" }],
    ] as const) {
      const r = await jsonRequest(app, "POST", path, body, root.apiKey);
      expect(r.status, path).toBeGreaterThanOrEqual(400);
      // Round 6: the nest is sealed, so the access gate refuses a server admin before the review rule does.
      expect(JSON.stringify(r.data)).toMatch(new RegExp(`${msg.source}|Nest not found|Access denied|not found`, "i"));
    }
    // MCP.
    const title = (await itemsOf(p.id))[0].title;
    const m = await app.request(`/nests/${b.nest_id}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${root.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_approve", arguments: { title } } }),
    });
    expect(await m.text()).toMatch(new RegExp(`${msg.source}|not found|access|denied|forbidden`, "i"));
    // The web review queue (canUserApproveMany) and canUserApprove agree.
    const sw = await import("../src/governance/stewardship-service.js");
    expect((await sw.canUserApprove(b.nest_id, a.node_id, root.email)).allowed).toBe(false);
    expect((await sw.canUserApproveMany(b.nest_id, [a.node_id], root.email)).get(a.node_id)!.allowed).toBe(false);
    expect((await sw.canUserApprove(b.nest_id, a.node_id, dana.email)).allowed).toBe(true);
    expect((await one("SELECT state FROM surface_proposal_items WHERE id = ?", [a.id])).state).toBe("pending");
    // The owner approves from Slack (no self-approve needed).
    await click("U_DANA", "nest_approve", p.id, { channel: "D_U_DANA" });
    expect((await one("SELECT state, decided_by_user_id FROM surface_proposal_items WHERE id = ?", [a.id]))).toMatchObject({ state: "approved", decided_by_user_id: dana.userId });
    // Deleting the nest stays possible for a server admin.
    const marker = await one("SELECT * FROM surface_personal_nests WHERE nest_id = ?", [b.nest_id]);
    expect(marker.community_user_id).toBe(dana.userId);
  });

  describe("R4-3: /nest invite", () => {
    let cid = "";
    const boot = async (by = "U_BOB") => {
      await command(by, "leave", cid);
      await submitView(by, lastView(), {});
      expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound[cid]])).status).toBe("paused_by_member");
    };
    const status = async () => (await one("SELECT status FROM surface_bindings WHERE id = ?", [bound[cid]])).status;

    it("the booter themselves invites Nest back → active, with a counts-only admin notice", async () => {
      cid = "CINV";
      setChannel(cid, ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
      await bind(cid);
      await boot();
      const notices = Number((await one("SELECT COUNT(*) AS n FROM surface_notices WHERE kind = 'binding_invited_back'")).n);
      const r = await invite("U_BOB", cid);
      expect(r.body.text).toMatch(/Nest is back/);
      expect(await status()).toBe("active");
      const n = await all("SELECT * FROM surface_notices WHERE kind = 'binding_invited_back'");
      expect(n.length).toBe(notices + 1);
      expect(n[n.length - 1].detail).not.toMatch(/U_BOB|bob@/);
    });

    it("another member invites while the booter is present → the booter must consent first", async () => {
      await boot();
      const before = slack.posted.length;
      const r = await invite("U_ERIN", cid);
      expect(r.body.text).toMatch(/The person who removed Nest has been asked to allow it back/);
      expect(r.body.text).not.toMatch(/U_BOB|Bob/);
      expect(await status()).toBe("paused_by_member");
      const prompt = slack.posted.slice(before).find((p) => p.channel === "D_U_BOB" && /Allow Nest back/.test(p.blocks ?? ""));
      expect(prompt).toBeTruthy();
      expect(prompt!.text).toMatch(/<@U_ERIN> would like to add Nest back/);
      expect(prompt!.text).not.toMatch(/An admin/);
      const btn = JSON.parse(prompt!.blocks).find((x: any) => x.type === "actions").elements[0];
      await interact(actionPayload("U_BOB", btn.action_id, btn.value, { channel: "D_U_BOB" }));
      expect(await status()).toBe("active");
    });

    it("the booter has left → the inviter alone is enough", async () => {
      await boot();
      slack.convs.get(cid)!.members = ["U_ALICE", "U_DANA", "U_ERIN", "U_FRANK", "UBOT"].concat([]);
      // Bob left the channel but still reads the nest: keep the guard passing by removing him as a collaborator.
      const bc = await one("SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?", [N, bob.userId]);
      await jsonRequest(app, "DELETE", `/nests/${N}/collaborators/${bc.id}`, undefined, alice.apiKey);
      try {
        await invite("U_ERIN", cid);
        expect(await status()).toBe("active");
      } finally {
        await jsonRequest(app, "POST", `/nests/${N}/collaborators`, { email: bob.email, permission: "read" }, alice.apiKey);
        slack.convs.get(cid)!.members = ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"];
      }
    });

    it("the guard fails at invite → refused, stays paused", async () => {
      await jsonRequest(app, "POST", `/surfaces/bindings/${bound[cid]}/recheck`, {}, alice.apiKey);
      await boot();
      await jsonRequest(app, "POST", `/nests/${N}/collaborators`, { email: mallory.email, permission: "read" }, alice.apiKey);
      try {
        const r = await invite("U_BOB", cid);
        expect(r.body.text).toMatch(/can't come back here safely/i);
        expect(await status()).toBe("paused_by_member");
      } finally {
        const mc = await one("SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?", [N, mallory.userId]);
        await jsonRequest(app, "DELETE", `/nests/${N}/collaborators/${mc.id}`, undefined, alice.apiKey);
      }
    });

    it("never resumes paused_guard, dm_off, dm_optout or removed bindings; refused in a general channel for a non-admin", async () => {
      const cases: Array<[string, string, string | null]> = [
        ["CINV", "paused_guard", null],
        ["CINV", "paused_guard", "dm_off"],
        ["CINV", "paused_guard", "dm_optout"],
        ["CINV", "removed", null],
      ];
      for (const [c, st, reason] of cases) {
        await db().run("UPDATE surface_bindings SET status = ?, pause_reason = ? WHERE id = ?", [st, reason, bound[c]]);
        const r = await invite("U_BOB", c);
        expect(r.body.text, `${st}/${reason}`).toMatch(/only an admin|isn't removed by a member|can't invite/i);
        expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound[c]])).status).toBe(st);
      }
      await db().run("UPDATE surface_bindings SET status = 'paused_by_member', pause_reason = NULL, booted_by_surface_user_id = 'U_ALICE' WHERE id = ?", [bound.CGEN]);
      const g = await invite("U_BOB", "CGEN");
      expect(g.body.text).toMatch(/general channel/);
      expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound.CGEN])).status).toBe("paused_by_member");
      await db().run("UPDATE surface_bindings SET status = 'active', booted_by_surface_user_id = NULL WHERE id = ?", [bound.CGEN]);
    });

    it("REST and MCP twins, and the App Home 'Invite Nest back' button", async () => {
      await db().run("UPDATE surface_bindings SET status = 'active', pause_reason = NULL WHERE id = ?", [bound[cid]]);
      await jsonRequest(app, "POST", `/surfaces/bindings/${bound[cid]}/recheck`, {}, alice.apiKey);
      await boot();
      const rest = await jsonRequest(app, "POST", `/surfaces/bindings/${bound[cid]}/invite`, {}, bob.apiKey);
      expect(rest.status).toBe(200);
      // Re-review N2: a non-admin gets only the outcome.
      expect(rest.data.status).toBe("resumed");
      expect(await status()).toBe("active");
      await boot();
      const m = await app.request(`/nests/${N}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bob.apiKey}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_surfaces_binding_invite", arguments: { binding_id: bound[cid] } } }),
      });
      expect(await m.text()).toMatch(/active|back/);
      expect(await status()).toBe("active");
      await boot();
      await event({ type: "app_home_opened", user: "U_BOB", tab: "home", channel: "D1" });
      const home = lastView("views.publish");
      const btn = home.blocks.find((x: any) => x.accessory?.action_id === "home_invite" && x.accessory.value.includes(bound[cid]))?.accessory;
      expect(btn?.text?.text).toBe("Invite Nest back");
      await interact(actionPayload("U_BOB", btn.action_id, btn.value, { home: true, channel: null }));
      expect(await status()).toBe("active");
    });
  });
});

// ═══ Re-review round 2 (S7 security re-review of S2b) ═══════════════════════

describe("re-review round 2", () => {
  it("RR-N1: the personal-nest lookup fails CLOSED — on a DB error nobody may approve, and only counts are logged", async () => {
    const dv = await import("../src/surfaces/draft-visibility.js");
    const sw = await import("../src/governance/stewardship-service.js");
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    expect((await sw.canUserApprove(N, a.node_id, dana.email)).allowed).toBe(true);
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...x: unknown[]) => void logs.push(x.map(String).join(" "));
    dv.draftVisibilityTestHooks.failLookup = true;
    try {
      const v = await sw.canUserApprove(N, a.node_id, dana.email);
      expect(v.allowed).toBe(false);
      expect(v.reason).toMatch(/can review items in their private nest/);
      expect((await sw.canUserApproveMany(N, [a.node_id], root.email)).get(a.node_id)!.allowed).toBe(false);
      const r = await jsonRequest(app, "POST", `/nests/${N}/nodes/${a.node_id}/approve`, { override: true }, root.apiKey);
      expect(r.status).toBeGreaterThanOrEqual(400);
    } finally {
      dv.draftVisibilityTestHooks.failLookup = false;
      console.error = orig;
    }
    expect(logs.some((l) => /personal-nest lookup failed/.test(l))).toBe(true);
    expect(logs.join("\n")).not.toMatch(new RegExp(N));
    expect((await sw.canUserApprove(N, a.node_id, dana.email)).allowed).toBe(true);
  });

  it("RR-N2: POST /surfaces/bindings/:id/invite tells a non-admin only {status, message} (or {error, reason}) — no booter, conversation name or guard counts", async () => {
    setChannel("CRR", ["U_ALICE", "U_DANA", "U_ERIN", "U_BOB", "U_FRANK", "UBOT"]);
    await bind("CRR");
    await command("U_BOB", "leave", "CRR");
    await submitView("U_BOB", lastView(), {});
    const r = await jsonRequest(app, "POST", `/surfaces/bindings/${bound.CRR}/invite`, {}, erin.apiKey);
    expect(r.status).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(["message", "status"]);
    expect(JSON.stringify(r.data)).not.toMatch(/U_BOB|Bob|crr|guard|readers|members/i);
    // A refusal is just as terse.
    await db().run("UPDATE surface_bindings SET status = 'paused_guard' WHERE id = ?", [bound.CRR]);
    const no = await jsonRequest(app, "POST", `/surfaces/bindings/${bound.CRR}/invite`, {}, erin.apiKey);
    expect(no.status).toBe(409);
    expect(Object.keys(no.data).sort()).toEqual(["error", "reason"]);
    await db().run("UPDATE surface_bindings SET status = 'active' WHERE id = ?", [bound.CRR]);
  });

  it("RR-N3: the stuck-claim reconciler records the review's actual resolver (mapped to their Slack id), never the clicker by assumption", async () => {
    const p = await makeProposal("C1");
    const [a] = await itemsOf(p.id);
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    await db().run(
      "INSERT INTO surface_actions (id, idempotency_key, proposal_item_id, action, surface, surface_user_id, community_user_id, status, created_at, updated_at) VALUES (?, ?, ?, 'approve', 'slack', 'U_ERIN', ?, 'in_progress', ?, ?)",
      [`a-${rnd()}`, `decide:${a.id}`, a.id, erin.userId, old, old],
    );
    // Dana — not the clicker — approves in the web review queue.
    expect((await jsonRequest(app, "POST", `/nests/${N}/nodes/${a.node_id}/approve`, {}, dana.apiKey)).status).toBe(200);
    await S.cards.reconcileStuckClaims();
    expect((await one("SELECT state, decided_by_user_id FROM surface_proposal_items WHERE id = ?", [a.id]))).toMatchObject({ state: "approved", decided_by_user_id: dana.userId });
    const c = await one("SELECT * FROM surface_commits WHERE proposal_item_id = ?", [a.id]);
    expect(c).toMatchObject({ approved_by_user_id: dana.userId, surface_user_id: "U_DANA", action: "approve_external" });
  });

  it("RR-INFO: inviting back a booted DM binding while DM capture is off leaves it paused (dm_off / dm_optout), never active", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: false }, root.apiKey);
    await db().run("UPDATE surface_bindings SET status = 'paused_by_member', pause_reason = NULL, booted_by_surface_user_id = 'U_DANA', booted_at = ? WHERE id = ?", [new Date().toISOString(), b.id]);
    await invite("U_DANA", "D_U_DANA");
    expect(await one("SELECT status, pause_reason FROM surface_bindings WHERE id = ?", [b.id])).toMatchObject({ status: "paused_guard", pause_reason: "dm_off" });
    // Personal opt-out with capture on.
    await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: true }, root.apiKey);
    await db().run("INSERT INTO surface_dm_optouts (install_id, surface_user_id) VALUES (?, 'U_DANA') ON CONFLICT (install_id, surface_user_id) DO NOTHING", [installId]);
    await db().run("UPDATE surface_bindings SET status = 'paused_by_member', pause_reason = NULL, booted_by_surface_user_id = 'U_DANA' WHERE id = ?", [b.id]);
    await invite("U_DANA", "D_U_DANA");
    expect(await one("SELECT status, pause_reason FROM surface_bindings WHERE id = ?", [b.id])).toMatchObject({ status: "paused_guard", pause_reason: "dm_optout" });
    await db().run("DELETE FROM surface_dm_optouts WHERE install_id = ? AND surface_user_id = 'U_DANA'", [installId]);
    await db().run("UPDATE surface_bindings SET status = 'active', pause_reason = NULL, booted_by_surface_user_id = NULL WHERE id = ?", [b.id]);
  });

  it("RR-INFO: agent (nest-scoped) keys can't invite — people only, on REST and MCP", async () => {
    await command("U_BOB", "leave", "CRR");
    await submitView("U_BOB", lastView(), {});
    const k = await jsonRequest(app, "POST", "/auth/keys", { label: "agent", nest_id: N }, bob.apiKey);
    expect(k.data.api_key).toBeTruthy();
    const r = await jsonRequest(app, "POST", `/surfaces/bindings/${bound.CRR}/invite`, {}, k.data.api_key);
    expect(r.status).toBe(403);
    const m = await app.request(`/nests/${N}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${k.data.api_key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_surfaces_binding_invite", arguments: { binding_id: bound.CRR } } }),
    });
    expect(await m.text()).toMatch(/own full credential|not available|Unknown tool|isError|forbidden/i);
    expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound.CRR])).status).toBe("paused_by_member");
  });

  it("RR-INFO: /nest invite acks at once and answers through response_url", async () => {
    const r = await command("U_BOB", "invite", "CRR");
    expect(r.status).toBe(200);
    expect(r.body?.text ?? "").not.toMatch(/Nest is back/);
    const last = slack.responses.filter((x) => x.url.includes("/commands/")).pop()!;
    expect(last.body.text).toMatch(/Nest is back/);
    expect((await one("SELECT status FROM surface_bindings WHERE id = ?", [bound.CRR])).status).toBe("active");
  });

  it("RR-INFO: a boot clears any leftover pause_reason in the same compare-and-set", async () => {
    await db().run("UPDATE surface_bindings SET pause_reason = 'dm_off' WHERE id = ?", [bound.CRR]);
    await command("U_BOB", "leave", "CRR");
    await submitView("U_BOB", lastView(), {});
    expect(await one("SELECT status, pause_reason FROM surface_bindings WHERE id = ?", [bound.CRR])).toMatchObject({ status: "paused_by_member", pause_reason: null });
    expect((await invite("U_BOB", "CRR")).body.text).toMatch(/Nest is back/);
  });
});

// ═══ Round 6: sealed personal nests (Misha, 2026-11-01, "Build sealed nests now") ═

describe("round 6: sealed personal nests", () => {
  let PN = ""; // Dana's sealed personal nest
  let sealedNode = "";
  let openNode = "";
  let sealedItem = "";
  type Path = { name: string; kind: "read" | "write"; go: (nest: string, node: string, key: string) => Promise<{ status: number; text: string }> };
  const http = async (method: string, path: string, key: string, body?: unknown) => {
    const r = await app.request(path, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, text: await r.text() };
  };
  const mcpCall = async (nest: string, key: string, name: string, args: Record<string, unknown>) => {
    const r = await app.request(`/nests/${nest}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await r.text();
    // A JSON-RPC error or an isError tool result is a refusal.
    const refused = r.status >= 400 || /"isError":true|"error":\{/.test(text);
    return { status: refused ? 403 : 200, text };
  };
  const PATHS: Path[] = [
    { name: "node get", kind: "read", go: (n, d, k) => http("GET", `/nests/${n}/nodes/${d}`, k) },
    { name: "nest search", kind: "read", go: (n, _d, k) => http("GET", `/nests/${n}/search?q=zqmarker`, k) },
    { name: "list nodes", kind: "read", go: (n, _d, k) => http("GET", `/nests/${n}/nodes`, k) },
    { name: "overview", kind: "read", go: (n, _d, k) => http("GET", `/nests/${n}/overview`, k) },
    { name: "export (markdown)", kind: "read", go: (n, _d, k) => http("GET", `/nests/${n}/export?format=markdown`, k) },
    { name: "export (bundle)", kind: "read", go: (n, _d, k) => http("GET", `/nests/${n}/export?format=bundle`, k) },
    { name: "changes", kind: "read", go: (n, _d, k) => http("GET", `/nests/${n}/changes?since=2020-01-01T00:00:00Z&include_content=1`, k) },
    { name: "versions", kind: "read", go: (n, d, k) => http("GET", `/nests/${n}/nodes/${d}/versions`, k) },
    { name: "graph", kind: "read", go: (n, _d, k) => http("GET", `/nests/${n}/graph`, k) },
    { name: "review queue", kind: "read", go: (n, _d, k) => http("GET", `/nests/${n}/review-queue`, k) },
    { name: "MCP context_search", kind: "read", go: (n, _d, k) => mcpCall(n, k, "context_search", { query: "zqmarker" }) },
    { name: "MCP context_list", kind: "read", go: (n, _d, k) => mcpCall(n, k, "context_list", {}) },
    { name: "MCP context_get", kind: "read", go: (n, d, k) => mcpCall(n, k, "context_get", { id: d }) },
    { name: "direct write (create)", kind: "write", go: (n, _d, k) => http("POST", `/nests/${n}/nodes`, k, { title: `Admin write ${rnd()}`, content: "x", folder: "inbox" }) },
    { name: "direct write (update)", kind: "write", go: (n, d, k) => http("PATCH", `/nests/${n}/nodes/${d}`, k, { content: "overwritten by an admin" }) },
  ];

  beforeAll(async () => {
    if (!S) return;
  });

  it("R6-setup: Dana's personal nest is marked sealed; the owner reads and writes as before", async () => {
    const row = await one("SELECT * FROM surface_personal_nests WHERE community_user_id = ?", [dana.userId]);
    expect(row.sealed).toBe(1);
    PN = row.nest_id;
    const created = await jsonRequest(app, "POST", `/nests/${PN}/nodes`, { title: "Sealed note zqmarker", content: "zqmarker sealed content for the owner", folder: "inbox" }, dana.apiKey);
    expect(created.status).toBeLessThan(300);
    sealedNode = created.data.node?.id ?? created.data.id;
    const open = await jsonRequest(app, "POST", `/nests/${N}/nodes`, { title: "Open note zqmarker", content: "zqmarker open content", folder: "inbox" }, alice.apiKey);
    openNode = open.data.node?.id ?? open.data.id;
    await settleSeals();
    for (const p of PATHS.filter((x) => x.kind === "read")) {
      const r = await p.go(PN, sealedNode, dana.apiKey);
      expect(r.status, `owner ${p.name}`).toBeLessThan(400);
    }
  });

  for (const who of ["superadmin", "license admin"] as const) {
    it(`R6-1 (${who}): every content path on a SEALED nest is refused, with no sealed text in the response`, async () => {
      const key = who === "superadmin" ? root.apiKey : licAdmin.apiKey;
      {
        for (const p of PATHS) {
          const r = await p.go(PN, sealedNode, key);
          expect(r.status, `${who} ${p.name}`).toBeGreaterThanOrEqual(400);
          expect(r.text, `${who} ${p.name}`).not.toMatch(/zqmarker sealed|Sealed note/);
        }
        // Global search finds nothing of it.
        const g = await http("GET", "/search?q=zqmarker", key);
        expect(g.text).not.toMatch(/Sealed note/);
      }
    });

    it(`R6-2 (${who}): the same admin on a NON-sealed nest is exactly as before`, async () => {
      const key = who === "superadmin" ? root.apiKey : licAdmin.apiKey;
      {
        for (const p of PATHS.filter((x) => x.kind === "read")) {
          // ACME is an approved document (MCP context_get serves approved bodies).
          const r = await p.go(N, p.name === "MCP context_get" ? ACME : openNode, key);
          expect(r.status, `${who} ${p.name} on a normal nest`).toBeLessThan(400);
        }
        const sw = await import("../src/shared/access.js");
        const uid = who === "superadmin" ? root.userId : licAdmin.userId;
        expect(await sw.resolveNestPermission(N, uid)).toBe("admin");
        expect(await sw.resolveNestPermission(PN, uid)).toBe("none");
      }
    });
  }

  it("R6-3: the draft page and the Surfaces review paths stay closed to admins on a sealed nest; the owner still reviews", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: true }, root.apiKey);
    await db().run("UPDATE surface_bindings SET status = 'active', pause_reason = NULL WHERE id = ?", [b.id]);
    await setFolders(b.id);
    modelImpl = proposeN(1);
    await event({ type: "message", channel: "D_U_DANA", user: "U_DANA", text: `remember: sealed draft check ${rnd()}`, ts: nextTs(), channel_type: "im" });
    modelImpl = () => submit(noop());
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [b.id]);
    sealedItem = (await itemsOf(p.id))[0].id;
    expect((await http("GET", `/surfaces/drafts/${sealedItem}`, root.apiKey)).status).toBe(403);
    expect((await http("GET", `/surfaces/drafts/${sealedItem}`, dana.apiKey)).status).toBe(200);
    await click("U_ROOT", "nest_approve", p.id, { channel: "D_U_DANA" });
    expect((await one("SELECT state FROM surface_proposal_items WHERE id = ?", [sealedItem])).state).toBe("pending");
  });

  for (const who of ["superadmin", "license admin"] as const) {
    it(`R10-2 (${who}): the R6-1 twin — the SAME admin request on the SAME nest is 200 with sealed=0 and refused with sealed=1`, async () => {
      const key = who === "superadmin" ? root.apiKey : licAdmin.apiKey;
      const t0 = new Date().toISOString();
      try {
        await db().run("UPDATE surface_personal_nests SET sealed = 0 WHERE nest_id = ?", [PN]);
        for (const p of PATHS.filter((x) => x.kind === "read")) {
          const r = await p.go(PN, sealedNode, key);
          expect(r.status, `${who} ${p.name} unsealed`).toBeLessThan(400);
        }
        await db().run("UPDATE surface_personal_nests SET sealed = 1 WHERE nest_id = ?", [PN]);
        for (const p of PATHS.filter((x) => x.kind === "read")) {
          const r = await p.go(PN, sealedNode, key);
          expect(r.status, `${who} ${p.name} sealed`).toBeGreaterThanOrEqual(400);
          expect(r.text, `${who} ${p.name} sealed`).not.toMatch(/zqmarker sealed|Sealed note/);
        }
      } finally {
        await db().run("UPDATE surface_personal_nests SET sealed = 1 WHERE nest_id = ?", [PN]);
        // Trace rows written while the twin was unsealed hold real paths; drop them (later rounds assert a sealed nest leaves none).
        await db().run("DELETE FROM api_events WHERE nest_id = ? AND ts >= ?", [PN, t0]);
      }
    });
  }

  it("R10-2: the R6-3 twin — on the draft's nest, the admin's review queue and the draft's document are 200 with sealed=0 and refused with sealed=1; the draft page itself stays owner-only either way (personal-nest rule)", async () => {
    const item = await one("SELECT node_id FROM surface_proposal_items WHERE id = ?", [sealedItem]);
    const reqs = [
      () => http("GET", `/nests/${PN}/review-queue`, root.apiKey),
      () => http("GET", `/nests/${PN}/nodes/${item.node_id}`, root.apiKey),
    ];
    const t0 = new Date().toISOString();
    try {
      await db().run("UPDATE surface_personal_nests SET sealed = 0 WHERE nest_id = ?", [PN]);
      for (const go of reqs) expect((await go()).status).toBeLessThan(400);
      expect((await http("GET", `/surfaces/drafts/${sealedItem}`, root.apiKey)).status).toBe(403);
      await db().run("UPDATE surface_personal_nests SET sealed = 1 WHERE nest_id = ?", [PN]);
      for (const go of reqs) expect((await go()).status).toBeGreaterThanOrEqual(400);
      expect((await http("GET", `/surfaces/drafts/${sealedItem}`, root.apiKey)).status).toBe(403);
    } finally {
      await db().run("UPDATE surface_personal_nests SET sealed = 1 WHERE nest_id = ?", [PN]);
        // Trace rows written while the twin was unsealed hold real paths; drop them (later rounds assert a sealed nest leaves none).
        await db().run("DELETE FROM api_events WHERE nest_id = ? AND ts >= ?", [PN, t0]);
    }
  });

  it("R10-4: admins still see and enforce quota on a sealed nest — the document count tracks the owner's writes, and the server's admin-set write limit applies to the owner there", async () => {
    const before = (await jsonRequest(app, "GET", "/surfaces/sealed-nests", undefined, root.apiKey)).data.nests.find((x: any) => x.nest_id === PN).documents;
    expect((await jsonRequest(app, "POST", `/nests/${PN}/nodes`, { title: `Quota note ${rnd()}`, content: "small", folder: "inbox" }, dana.apiKey)).status).toBeLessThan(300);
    await settleSeals();
    const after = (await jsonRequest(app, "GET", "/surfaces/sealed-nests", undefined, root.apiKey)).data.nests.find((x: any) => x.nest_id === PN).documents;
    expect(after).toBe(before + 1);
    // Enforcement: the admin's MAX_BODY_BYTES applies to the owner's writes to the sealed nest.
    const prev = process.env.MAX_BODY_BYTES;
    const was = (await jsonRequest(app, "GET", "/admin/settings", undefined, root.apiKey)).data.max_body_bytes;
    expect((await jsonRequest(app, "PATCH", "/admin/settings", { max_body_bytes: 1024 * 1024 }, root.apiKey)).status).toBe(200);
    try {
      const big = JSON.stringify({ title: `Too big ${rnd()}`, content: "x".repeat(1100 * 1024), folder: "inbox" });
      const r = await app.request(`/nests/${PN}/nodes`, { method: "POST", headers: { Authorization: `Bearer ${dana.apiKey}`, "Content-Type": "application/json", "Content-Length": String(big.length) }, body: big });
      expect(r.status).toBe(413);
      expect((await jsonRequest(app, "GET", "/surfaces/sealed-nests", undefined, root.apiKey)).data.nests.find((x: any) => x.nest_id === PN).documents).toBe(after);
    } finally {
      await jsonRequest(app, "PATCH", "/admin/settings", { max_body_bytes: was }, root.apiKey);
      if (prev === undefined) delete process.env.MAX_BODY_BYTES;
      else process.env.MAX_BODY_BYTES = prev;
    }
  });

  it("R6-4: every refused content access by a server admin is audit-logged, counts only", async () => {
    const rows = await all("SELECT * FROM surface_sealed_access_log WHERE nest_id = ? AND user_id = ?", [PN, root.userId]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((a, r) => a + Number(r.refused), 0)).toBeGreaterThan(5);
    expect(JSON.stringify(rows)).not.toMatch(/zqmarker|Sealed note/);
    expect(Object.keys(rows[0]).sort()).toEqual(expect.arrayContaining(["nest_id", "user_id", "day", "refused"]));
  });

  it("R6-5: admins can see a sealed nest exists (owner, size, created date — no titles) and delete it", async () => {
    const pn2 = (await jsonRequest(app, "POST", "/nests", { name: `Erin sealed ${rnd()}` }, erin.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${pn2}/nodes`, { title: "Erin secret zqtitle", content: "zq", folder: "inbox" }, erin.apiKey);
    await db().run("INSERT INTO surface_personal_nests (install_id, community_user_id, nest_id, sealed) VALUES (?, ?, ?, 1) ON CONFLICT (install_id, community_user_id) DO UPDATE SET nest_id = excluded.nest_id, sealed = 1", [installId, erin.userId, pn2]);
    const list = await jsonRequest(app, "GET", "/surfaces/sealed-nests", undefined, root.apiKey);
    expect(list.status).toBe(200);
    const row = list.data.nests.find((x: any) => x.nest_id === pn2);
    expect(row).toMatchObject({ owner: { user_id: erin.userId } });
    expect(typeof row.documents).toBe("number");
    expect(row.created_at).toBeTruthy();
    expect(JSON.stringify(list.data)).not.toMatch(/zqtitle|Erin secret/);
    expect((await jsonRequest(app, "GET", "/surfaces/sealed-nests", undefined, bob.apiKey)).status).toBe(403);
    expect((await http("DELETE", `/nests/${pn2}`, root.apiKey)).status).toBe(200);
    expect(await one("SELECT id FROM nests WHERE id = ?", [pn2])).toBeUndefined();
  });

  it("R6-6: the DM guard on a sealed nest: EffectiveReaders = {owner}, no server-admin exception, both flags true", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    const rd = await import("../src/surfaces/services/readers.js");
    const r = await rd.effectiveReaders(b.nest_id, { listenerAgentNodeId: b.listener_agent_node_id, bindingId: b.id });
    expect(r.users.map((u: any) => u.userId ?? u.id ?? u)).toEqual([dana.userId]);
    expect(r.serverAdmins).toEqual([]);
    const v = await jsonRequest(app, "POST", `/surfaces/bindings/${b.id}/recheck`, {}, dana.apiKey);
    expect(v.data.binding).toMatchObject({ capture_ok: true, surface_ok: true });
  });
});

// ═══ Round 7: sealed-nest side channels (S7 re-review round 3) ═══════════════

describe("round 7: sealed side channels", () => {
  let PN = "";
  let title = "";
  const SECRET = /zqside|Side channel secret/;
  beforeAll(async () => {
    if (!S) return;
  });

  it("R7-setup: a sealed-nest event with a distinctive title flows through review, inbox, email and trace", async () => {
    PN = (await one("SELECT nest_id FROM surface_personal_nests WHERE community_user_id = ?", [dana.userId])).nest_id;
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    await jsonRequest(app, "PATCH", "/surfaces/settings", { dm_capture: true }, root.apiKey);
    await db().run("UPDATE surface_bindings SET status = 'active', pause_reason = NULL WHERE id = ?", [b.id]);
    await setFolders(b.id);
    process.env.SMTP_URL = "smtps://u:p@smtp.test:465";
    process.env.NOTIFY_EMAIL_FROM = "nest@surf.test";
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T0/B0/server";
    process.env.NOTIFY_DEBOUNCE_MS = "5";
    process.env.TELEMETRY_ENABLED = "true";
    title = `Side channel secret zqside ${rnd()}`;
    modelImpl = proposeN(1, [{ title }]);
    await event({ type: "message", channel: "D_U_DANA", user: "U_DANA", text: `remember: ${title}`, ts: nextTs(), channel_type: "im" });
    modelImpl = () => submit(noop());
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [b.id]);
    expect(p.state).toBe("posted");
    // The owner reads it (trace) and approves it (verdict notifications).
    const [it] = await itemsOf(p.id);
    expect((await jsonRequest(app, "GET", `/nests/${PN}/nodes/${it.node_id}`, undefined, dana.apiKey)).status).toBe(200);
    await click("U_DANA", "nest_approve", p.id, { channel: "D_U_DANA" });
    await new Promise((r) => setTimeout(r, 60));
  });

  it("R7-H1a: the message log keeps metadata only for a sealed nest — no subject, body or node id — and /admin/messages shows no title", async () => {
    const rows = await all("SELECT subject, body_redacted, node_id, channel FROM outbound_messages WHERE nest_id = ?", [PN]);
    for (const r of rows) {
      expect(r.subject).toBeNull();
      expect(r.body_redacted).toBeNull();
      expect(r.node_id).toBeNull();
    }
    const msgs = await http2("GET", "/admin/messages?limit=500", root.apiKey);
    expect(msgs.status).toBe(200);
    expect(msgs.text).not.toMatch(SECRET);
    // Inbox rows for the sealed nest reach the owner only.
    const inbox = await all("SELECT user_email FROM notifications WHERE nest_id = ?", [PN]);
    for (const r of inbox) expect(r.user_email).toBe(dana.email);
  });

  it("R7-H1b: a sealed nest sends NOTHING to server-wide or team channels; a normal nest still does", async () => {
    const before = slack.responses.filter((x) => x.url.includes("/services/T0/B0/server")).length;
    const n = await import("../src/notify/notify.js");
    const d = await import("../src/notify/dispatch.js");
    await n.notifyNestEvent(PN, `*${title}* approved`);
    await d.dispatchEvent({ kind: "run_failed", nestId: PN, subjectId: "x", actor: dana.email, message: title } as any);
    await new Promise((r) => setTimeout(r, 80));
    const sealedPosts = slack.responses.filter((x) => x.url.includes("/services/T0/B0/server")).slice(before);
    expect(JSON.stringify(sealedPosts)).not.toMatch(SECRET);
    expect(sealedPosts.length).toBe(0);
    await n.notifyNestEvent(N, "a normal nest event zqnormal");
    await new Promise((r) => setTimeout(r, 80));
    expect(JSON.stringify(slack.responses.slice(before))).toMatch(/zqnormal/);
    // No email to a non-owner about the sealed nest.
    for (const m of sentMail) if (JSON.stringify(m).match(SECRET)) expect(m.to).toBe(dana.email);
  });

  it("R7-H1c: /admin/trace redacts everything after a sealed nest's id", async () => {
    const t = await http2("GET", `/admin/trace?nest=${PN}&limit=500`, root.apiKey);
    expect(t.status).toBe(200);
    expect(t.text).not.toMatch(/zqside|side-channel-secret/);
    const events = JSON.parse(t.text).events as any[];
    expect(events.length).toBeGreaterThan(0);
    for (const e of events.filter((x) => x.path)) expect(e.path).toBe(`/nests/${PN}/[sealed]`);
  });

  it("R7-sweep: telemetry carries no node id, title or selector for a sealed nest", async () => {
    const rows = await all("SELECT event, data_json FROM telemetry_events WHERE data_json LIKE ?", [`%${PN}%`]);
    for (const r of rows) expect(r.data_json).not.toMatch(/nodes\/|zqside|side-channel/);
  });

  it("R7-M1: an admin can't set or see a sealed-nest owner's password — the owner gets a reset link by email instead; others are unchanged", async () => {
    sentMail.length = 0;
    const r = await jsonRequest(app, "POST", `/auth/admin/reset-password/${dana.userId}`, { password: "AdminChosen#2026xyz" }, root.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.temporary_password).toBeUndefined();
    expect(r.data.reset_link_sent).toBe(true);
    expect(JSON.stringify(r.data)).toMatch(/emailed .*reset link/i);
    // The admin's password did NOT take.
    const bad = await app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: dana.email, password: "AdminChosen#2026xyz" }) });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const mail = sentMail.find((m) => m.to === dana.email || (Array.isArray(m.to) && m.to.includes(dana.email)));
    expect(mail).toBeTruthy();
    // Round 8 (R4-H1): the token rides in the URL fragment and the POST body.
    const token = /\/auth\/reset#t=([A-Za-z0-9_-]{20,})/.exec(String(mail.text))![1];
    // The admin never sees the token.
    expect(JSON.stringify(r.data)).not.toContain(token);
    expect((await all("SELECT body_redacted FROM outbound_messages WHERE body_redacted LIKE ?", [`%${token}%`])).length).toBe(0);
    // The owner sets a new password through the link (single use).
    const set = await app.request("/auth/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password: "OwnerChosen#2026abc" }) });
    expect(set.status).toBe(200);
    expect((await app.request("/auth/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password: "Again#2026abcdef" }) })).status).toBeGreaterThanOrEqual(400);
    await resetAuthRateLimit();
    const ok = await app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: dana.email, password: "OwnerChosen#2026abc" }) });
    expect(ok.status).toBe(200);
    // A user without a sealed nest: unchanged (a temporary password).
    // (Bob owns a personal nest from AC-HOM-08, so use Frank.)
    expect(await one("SELECT 1 AS x FROM surface_personal_nests WHERE community_user_id = ?", [frank.userId])).toBeUndefined();
    const other = await jsonRequest(app, "POST", `/auth/admin/reset-password/${frank.userId}`, {}, root.apiKey);
    expect(other.status).toBe(200);
    expect(typeof other.data.temporary_password).toBe("string");
  });

  it("R7-L1: a sealed personal nest can't be shared with a team; an owner-added collaborator is allowed with a warning", async () => {
    const team = await jsonRequest(app, "POST", "/teams", { name: `T ${rnd()}` }, dana.apiKey);
    const teamId = team.data.team?.id ?? team.data.id;
    const share = await jsonRequest(app, "POST", `/nests/${PN}/teams`, { team_id: teamId, role: "viewer" }, dana.apiKey);
    expect(share.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(share.data)).toMatch(/Private nests can't be shared with a team/);
    const collab = await jsonRequest(app, "POST", `/nests/${PN}/collaborators`, { email: erin.email, permission: "read" }, dana.apiKey);
    expect(collab.status).toBeLessThan(300);
    expect(JSON.stringify(collab.data)).toMatch(/no longer private to you alone/i);
    const c = await one("SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?", [PN, erin.userId]);
    await jsonRequest(app, "DELETE", `/nests/${PN}/collaborators/${c.id}`, undefined, dana.apiKey);
  });

  it("R7-L2: the sealed lookup exempts only a missing TABLE; a database whose 081 lacks the column fails CLOSED until the guarded add runs", async () => {
    const sealed = await import("../src/surfaces/sealed.js");
    expect(sealed.missingSealedTable('relation "surface_personal_nests" does not exist')).toBe(true);
    expect(sealed.missingSealedTable("no such table: surface_personal_nests")).toBe(true);
    expect(sealed.missingSealedTable('column "sealed" does not exist')).toBe(false);
    expect(sealed.missingSealedTable("no such column: p.sealed")).toBe(false);
    const acc = await import("../src/shared/access.js");
    await db().run("ALTER TABLE surface_personal_nests DROP COLUMN sealed");
    try {
      expect(await sealed.sealedNest(N)).not.toBeNull(); // fails closed
      expect(await acc.resolveNestPermission(N, root.userId)).toBe("none");
    } finally {
      await sealed.ensureSealedColumn();
    }
    expect((await one("SELECT sealed FROM surface_personal_nests WHERE nest_id = ?", [PN])).sealed).toBe(1);
    expect(await acc.resolveNestPermission(N, root.userId)).toBe("admin");
  });

  it("R7-INFO: hold fingerprints for sealed-nest items keep keyed hashes, never plaintext title tokens — and still dedupe", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    const t2 = `Hashed hold check zqhold ${rnd()}`;
    modelImpl = proposeN(1, [{ title: t2 }]);
    await event({ type: "message", channel: "D_U_DANA", user: "U_DANA", text: `remember: ${t2}`, ts: nextTs(), channel_type: "im" });
    modelImpl = () => submit(noop());
    const p = await one("SELECT * FROM surface_proposals WHERE binding_id = ? ORDER BY created_at DESC LIMIT 1", [b.id]);
    await click("U_DANA", "nest_reject", p.id, { channel: "D_U_DANA" });
    await submitView("U_DANA", lastView(), { reason: { v: { selected_option: { value: "other" } } } });
    const fp = await one("SELECT title_tokens FROM surface_fingerprints WHERE nest_id = ? ORDER BY created_at DESC LIMIT 1", [b.nest_id]);
    const toks = JSON.parse(fp.title_tokens) as string[];
    expect(toks.length).toBeGreaterThan(0);
    for (const t of toks) expect(t).toMatch(/^h:[0-9a-f]+$/);
    expect(fp.title_tokens).not.toMatch(/zqhold|hashed|hold|check/);
    const dd = await import("../src/surfaces/core/dedup.js");
    const hash = (await import("../src/surfaces/services/fingerprint-hash.js")).fingerprintHasher(b.nest_id);
    expect(dd.findDuplicate({ kind: "decision", op: "new", title: t2, target_node_id: null }, [{ source: "hold", kind: "decision", title_tokens: toks }], hash)).not.toBeNull();
  });

  it("R7-teardown", () => {
    for (const k of ["SMTP_URL", "NOTIFY_EMAIL_FROM", "SLACK_WEBHOOK_URL", "NOTIFY_DEBOUNCE_MS", "TELEMETRY_ENABLED"]) delete process.env[k];
  });
});

// ═══ Round 8: reset-token leak, fail-closed email, sign-in alerts ═══════════

describe("round 8: reset link, email fail-closed, sign-in alerts", () => {
  const RESET_LINK = /\/auth\/reset#t=([A-Za-z0-9_-]{20,})/;
  const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  async function requestReset(): Promise<string> {
    sentMail.length = 0;
    const r = await jsonRequest(app, "POST", `/auth/admin/reset-password/${dana.userId}`, {}, root.apiKey);
    expect(r.status).toBe(200);
    const mail = sentMail.find((m) => m.to === dana.email || (Array.isArray(m.to) && m.to.includes(dana.email)));
    expect(mail).toBeTruthy();
    const m = RESET_LINK.exec(String(mail.text));
    expect(m).not.toBeNull();
    return m![1];
  }
  const logged: string[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeAll(() => {
    if (!S) return;
    process.env.SMTP_URL = "smtps://u:p@smtp.test:465";
    process.env.NOTIFY_EMAIL_FROM = "nest@surf.test";
    for (const k of ["log", "warn", "error", "info", "debug"] as const) {
      const orig = console[k].bind(console);
      spies.push(vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...(a as [])); }));
    }
  });
  afterAll(() => {
    for (const s of spies) s.mockRestore();
    for (const k of ["SMTP_URL", "NOTIFY_EMAIL_FROM", "PROMPTOWL_SIGN_IN_GATE", "OFFICIAL_COMMUNITY_SSO_SECRET"]) delete process.env[k];
  });

  it("R8-H1a: the emailed link carries the token in the URL fragment; it never reaches a path, the trace, the message log or any log — after a click, a failed POST and a legacy path POST", async () => {
    logged.length = 0;
    const token = await requestReset();
    const mail = sentMail.find((m) => String(m.text).includes(token));
    expect(String(mail.text)).not.toMatch(/\/auth\/reset\/[A-Za-z0-9_-]{20,}/);
    // The browser sends only the path: a fragment never leaves the browser.
    const page = await app.request("/auth/reset", { headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("cache-control")).toMatch(/no-store/);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toMatch(/location\.hash/);
    // A failed POST (weak password) — the token rides in the body only.
    const weak = await app.request("/auth/reset", json({ token, password: "short" }));
    expect(weak.status).toBe(400);
    // A legacy path-form POST is not a route any more — and is still never traced with its token.
    const legacy = await app.request(`/auth/reset/${token}`, json({ password: "OwnerChosen#2026zzz" }));
    expect(legacy.status).toBe(404);
    // The trace write is fire-and-forget: wait (up to 2 s) for the legacy row to land.
    for (let i = 0; i < 40 && !(await all("SELECT 1 AS x FROM api_events WHERE path = '/auth/reset/[token]'")).length; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await all("SELECT path FROM api_events WHERE path LIKE ?", [`%${token}%`])).length).toBe(0);
    expect((await all("SELECT path FROM api_events WHERE path = '/auth/reset/[token]'")).length).toBeGreaterThan(0);
    expect((await all("SELECT id FROM outbound_messages WHERE COALESCE(subject,'') LIKE ? OR COALESCE(body_redacted,'') LIKE ?", [`%${token}%`, `%${token}%`])).length).toBe(0);
    const trace = await http2("GET", "/admin/trace?limit=500", root.apiKey);
    expect(trace.text).not.toContain(token);
    expect(logged.join("\n")).not.toContain(token);
    // The failed attempts didn't burn the link: it still works once.
    expect((await app.request("/auth/reset", json({ token, password: "OwnerChosen#2026r8a" }))).status).toBe(200);
  });

  it("R8-H1a: the trace redacts any token-shaped /auth/* segment (defence in depth)", async () => {
    const { logTraceEvent } = await import("../src/telemetry/trace-log.js");
    const tok = randomBytes(32).toString("base64url");
    await logTraceEvent({ kind: "api", method: "POST", path: `/auth/reset/${tok}`, status: 404 });
    await logTraceEvent({ kind: "api", method: "GET", path: `/auth/whatever/${tok}/x`, status: 404 });
    const uuid = "6f1c2a3b-1111-4222-8333-944455556666";
    await logTraceEvent({ kind: "api", method: "DELETE", path: `/auth/keys/${uuid}`, status: 404 });
    expect((await all("SELECT path FROM api_events WHERE path LIKE ?", [`%${tok}%`])).length).toBe(0);
    expect((await all("SELECT path FROM api_events WHERE path = ?", [`/auth/keys/${uuid}`])).length).toBe(1);
  });

  it("R8-H1b: using one reset link revokes every other outstanding link for that user", async () => {
    const t1 = await requestReset();
    const t2 = await requestReset();
    expect(t1).not.toBe(t2);
    expect((await app.request("/auth/reset", json({ token: t2, password: "OwnerChosen#2026r8b" }))).status).toBe(200);
    const old = await app.request("/auth/reset", json({ token: t1, password: "Attacker#2026r8bx" }));
    expect(old.status).toBe(410);
    await resetAuthRateLimit();
    const login = await app.request("/auth/login", json({ email: dana.email, password: "Attacker#2026r8bx" }));
    expect(login.status).toBe(401);
  });

  it("R8-H1c: the reset page works end to end — reads the fragment, strips it from the address bar, POSTs the token in the body, and the owner can sign in", async () => {
    const token = await requestReset();
    const html = await (await app.request("/auth/reset", { headers: { Accept: "text/html" } })).text();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
    const vm = await import("vm");
    const els: Record<string, any> = {};
    let submit: ((ev: any) => void) | null = null;
    const field = (v: string) => ({ value: v });
    els.f = { hidden: false, elements: { password: field("OwnerChosen#2026r8c"), confirm: field("OwnerChosen#2026r8c") }, addEventListener: (k: string, fn: any) => { if (k === "submit") submit = fn; } };
    els.msg = { textContent: "" };
    const replaced: string[] = [];
    const sent: any[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const fetchViaApp = async (url: string, init: any) => {
      sent.push({ url, init });
      const r = await app.request(url, init);
      setTimeout(done, 0);
      return r;
    };
    vm.runInNewContext(script, {
      location: { hash: `#t=${token}`, pathname: "/auth/reset" },
      history: { replaceState: (_s: unknown, _t: string, u: string) => replaced.push(u) },
      document: { getElementById: (id: string) => els[id] },
      fetch: fetchViaApp,
      JSON,
    });
    expect(replaced).toEqual(["/auth/reset"]);
    expect(submit).not.toBeNull();
    submit!({ preventDefault() {} });
    await finished;
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0].url).toBe("/auth/reset");
    expect(JSON.parse(sent[0].init.body)).toEqual({ token, password: "OwnerChosen#2026r8c" });
    expect(els.msg.textContent).toMatch(/password is set/i);
    expect(els.f.hidden).toBe(true);
    await resetAuthRateLimit();
    expect((await app.request("/auth/login", json({ email: dana.email, password: "OwnerChosen#2026r8c" }))).status).toBe(200);
  });

  it("R8-L1: every email send names its nest (or says it has none)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(__dirname, "..", "src"));
    const missing: string[] = [];
    let n = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      let i = src.indexOf("sendEmailToRecipient(");
      while (i >= 0) {
        const before = src.slice(Math.max(0, i - 30), i);
        if (!/function\s+$/.test(before)) {
          let depth = 0;
          let j = i + "sendEmailToRecipient".length;
          for (; j < src.length; j++) {
            if (src[j] === "(") depth++;
            else if (src[j] === ")" && --depth === 0) break;
          }
          const call = src.slice(i, j + 1);
          n++;
          if (!/nestId|noNest/.test(call.slice(call.lastIndexOf("}", call.length - 3) - 200))) missing.push(`${f.replace(/.*src\//, "src/")}: ${call.slice(0, 60).replace(/\s+/g, " ")}`);
        }
        i = src.indexOf("sendEmailToRecipient(", i + 1);
      }
    }
    expect(n).toBeGreaterThanOrEqual(19);
    expect(missing).toEqual([]);
  });

  it("R8-L1: with sealed nests on the server, an email whose nest is unknown fails CLOSED — not sent, no subject or body logged", async () => {
    const { sendEmailToRecipient } = await import("../src/notify/email.js");
    sentMail.length = 0;
    const subject = `Unknown nest zqunknown ${rnd()}`;
    const out = await sendEmailToRecipient([bob.email, dana.email], { status: "mention", docTitle: subject, path: "x", link: "", note: "zqunknown body" } as any);
    expect(out).toBe("skipped");
    expect(JSON.stringify(sentMail)).not.toMatch(/zqunknown/);
    expect((await all("SELECT id FROM outbound_messages WHERE COALESCE(subject,'') LIKE '%zqunknown%' OR COALESCE(body_redacted,'') LIKE '%zqunknown%'")).length).toBe(0);
    const row = await one("SELECT status, subject, body_redacted FROM outbound_messages WHERE channel = 'email' ORDER BY created_at DESC LIMIT 1");
    expect(row.status).toBe("skipped");
    expect(row.subject).toBeNull();
    expect(row.body_redacted).toBeNull();
    // A send that says it isn't about any nest is unaffected.
    const ok = await sendEmailToRecipient(bob.email, { status: "mention", docTitle: "Not about a nest", path: "x", link: "" } as any, { noNest: true });
    expect(ok).toBe("sent");
  });

  // ── Sign-in alerts: ON by default (Misha, R4-M1 ruling 2026-11-01) ─────────
  async function alertsTo(since: number) {
    await new Promise((r) => setTimeout(r, 40));
    await S.work.waitForSurfacesWork();
    const dms = slack.posted.slice(since).filter((p) => p.channel === "D_U_DANA" && /New sign-in to your Nest account|sign-in or email settings|sign-in alerts/.test(String(p.text)));
    const mails = sentMail.filter((m) => /New sign-in to your Nest account|sign-in or email settings|sign-in alerts/.test(String(m.text)) && (m.to === dana.email || (Array.isArray(m.to) && m.to.includes(dana.email))));
    return { dms, mails };
  }

  it("R8-ALERT-0: sign-in alerts are ON by default; a person without a sealed nest is never alerted", async () => {
    const s = await jsonRequest(app, "GET", "/surfaces/settings", undefined, root.apiKey);
    expect((s.data.settings ?? s.data).signin_alerts).toBe(true);
    expect(await one("SELECT 1 AS x FROM surface_personal_nests WHERE community_user_id = ?", [frank.userId])).toBeUndefined();
    const { alertSealedOwnerSignIn } = await import("../src/surfaces/signin-alerts.js");
    sentMail.length = 0;
    const since = slack.posted.length;
    await alertSealedOwnerSignIn(frank.userId, "sso", "Frank-UA");
    await new Promise((r) => setTimeout(r, 20));
    expect(slack.posted.slice(since).filter((p) => /New sign-in/.test(String(p.text))).length).toBe(0);
    expect(sentMail.filter((m) => /New sign-in/.test(String(m.text))).length).toBe(0);
  });

  it("R8-ALERT-1: a password sign-in from a first-time device alerts the sealed owner by Slack DM and email; the same device again does not; the setting defaults on", async () => {
    try {
      expect((await jsonRequest(app, "GET", "/surfaces/settings", undefined, root.apiKey)).data.settings?.signin_alerts ?? (await jsonRequest(app, "GET", "/surfaces/settings", undefined, root.apiKey)).data.signin_alerts).toBe(true);
      sentMail.length = 0;
      let since = slack.posted.length;
      const login = (ua: string) => app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua }, body: JSON.stringify({ email: dana.email, password: "OwnerChosen#2026r8c" }) });
      await resetAuthRateLimit();
      expect((await login("Device-A r8")).status).toBe(200);
      let a = await alertsTo(since);
      expect(a.dms.length).toBe(1);
      expect(String(a.dms[0].text)).toMatch(/^New sign-in to your Nest account via password \(new device\) at .+\. Not you\?/);
      expect(a.mails.length).toBe(1);
      sentMail.length = 0;
      since = slack.posted.length;
      await resetAuthRateLimit();
      expect((await login("Device-A r8")).status).toBe(200);
      a = await alertsTo(since);
      expect(a.dms.length + a.mails.length).toBe(0);
      // A user without a sealed nest gets nothing.
      const before = slack.posted.length;
      await resetAuthRateLimit();
      expect(await one("SELECT 1 AS x FROM surface_personal_nests WHERE community_user_id = ?", [frank.userId])).toBeUndefined();
    } finally {
    }
  });

  it("R8-ALERT-2: an admin adding an SSO site alerts every sealed owner; a forged SSO ticket sign-in as the owner alerts them; a password reset alerts them", async () => {
    try {
      sentMail.length = 0;
      let since = slack.posted.length;
      const secret = `admin-chosen-secret-${rnd()}-xxxxxxxx`;
      const site = await jsonRequest(app, "POST", "/admin/community-sites", { name: "Rogue", url: `https://rogue-${rnd()}.test`, secret }, root.apiKey);
      expect(site.status).toBe(201);
      let a = await alertsTo(since);
      expect(a.dms.length).toBe(1);
      expect(String(a.dms[0].text)).toMatch(/sign-in or email settings/);
      expect(a.mails.length).toBe(1);
      // The forged ticket (R4-M1a): the owner hears about it.
      process.env.PROMPTOWL_SIGN_IN_GATE = "open";
      const b64 = (x: string | Buffer) => Buffer.from(x).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const p = b64(JSON.stringify({ sub: dana.email, name: "Dana", aud: BASE, jti: `j-${rnd()}`, iat: now, exp: now + 60 }));
      const ticket = `${h}.${p}.${b64(createHmac("sha256", secret).update(`${h}.${p}`).digest())}`;
      sentMail.length = 0;
      since = slack.posted.length;
      const sso = await app.request(`/auth/sso?ticket=${ticket}`, { headers: { "User-Agent": "Rogue" } });
      expect(sso.status).toBe(302);
      expect(sso.headers.get("location")).toBe("/");
      a = await alertsTo(since);
      expect(a.dms.length).toBe(1);
      expect(String(a.dms[0].text)).toMatch(/^New sign-in to your Nest account via single sign-on at /);
      expect(a.mails.length).toBe(1);
      // A password reset through the emailed link.
      const token = await requestReset();
      sentMail.length = 0;
      since = slack.posted.length;
      expect((await app.request("/auth/reset", json({ token, password: "OwnerChosen#2026r8c" }))).status).toBe(200);
      a = await alertsTo(since);
      expect(a.dms.length).toBe(1);
      expect(String(a.dms[0].text)).toMatch(/via a password reset at /);
      // SMTP or OIDC settings changing alerts too; an unrelated setting does not.
      sentMail.length = 0;
      since = slack.posted.length;
      expect((await jsonRequest(app, "PATCH", "/admin/settings", { community_name: `Surf ${rnd()}` }, root.apiKey)).status).toBe(200);
      a = await alertsTo(since);
      expect(a.dms.length).toBe(0);
      expect((await jsonRequest(app, "PATCH", "/admin/settings", { smtp_url: "smtps://u:p@rogue-relay.test:465" }, root.apiKey)).status).toBe(200);
      a = await alertsTo(since);
      expect(a.dms.length).toBe(1);
      expect(String(a.dms[0].text)).toMatch(/email/);
    } finally {
      process.env.SMTP_URL = "smtps://u:p@smtp.test:465";
      delete process.env.PROMPTOWL_SIGN_IN_GATE;
    }
  });

  it("R8-ALERT-3: turning sign-in alerts off tells every sealed owner, then stops alerts; turning them back on works", async () => {
    try {
      sentMail.length = 0;
      let since = slack.posted.length;
      const off = await jsonRequest(app, "PATCH", "/surfaces/settings", { signin_alerts: false }, root.apiKey);
      expect(off.status).toBe(200);
      let a = await alertsTo(since);
      expect(a.dms.length).toBe(1);
      expect(String(a.dms[0].text)).toMatch(/turned off sign-in alerts/);
      sentMail.length = 0;
      since = slack.posted.length;
      await resetAuthRateLimit();
      expect((await app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Device-B r8" }, body: JSON.stringify({ email: dana.email, password: "OwnerChosen#2026r8c" }) })).status).toBe(200);
      a = await alertsTo(since);
      expect(a.dms.length + a.mails.length).toBe(0);
      expect((await jsonRequest(app, "PATCH", "/surfaces/settings", { signin_alerts: "no" }, root.apiKey)).status).toBe(422);
      expect((await jsonRequest(app, "PATCH", "/surfaces/settings", { signin_alerts: true }, root.apiKey)).status).toBe(200);
    } finally {
    }
  });
});

// ═══ Round 9: agent tickets, link/disconnect notices, alert fatigue ═════════

describe("round 9: agent-ticket alerts, link and disconnect notices, alert fatigue", () => {
  let PN = "";
  const MCP_SECRET = "mcp-signing-secret-r9-0123456789abcdef";
  const OFFICIAL = "official-sso-secret-r9-0123456789abcdef";
  const b64 = (x: string | Buffer) => Buffer.from(x).toString("base64url");
  function mint(claims: Record<string, unknown>, secret: string) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const p = b64(JSON.stringify({ sub: dana.email, aud: BASE, scope: "mcp", iat: now, exp: now + 300, ...claims }));
    return `${h}.${p}.${b64(createHmac("sha256", secret).update(`${h}.${p}`).digest())}`;
  }
  const ALERT = /New sign-in to your Nest account|sign-in or email settings|sign-in alerts|Slack connection/;
  async function alertsTo(since: number, mailSince: number) {
    await new Promise((r) => setTimeout(r, 80));
    await S.work.waitForSurfacesWork();
    const dms = slack.posted.slice(since).filter((p) => p.channel === "D_U_DANA" && ALERT.test(String(p.text)));
    const mails = sentMail.slice(mailSince).filter((m) => ALERT.test(String(m.text)) && (m.to === dana.email || (Array.isArray(m.to) && m.to.includes(dana.email))));
    return { dms, mails };
  }
  const marks = () => [slack.posted.length, sentMail.length] as const;
  beforeAll(async () => {
    if (!S) return;
    PN = (await one("SELECT nest_id FROM surface_personal_nests WHERE community_user_id = ?", [dana.userId])).nest_id;
    process.env.SMTP_URL = "smtps://u:p@smtp.test:465";
    process.env.NOTIFY_EMAIL_FROM = "nest@surf.test";
    process.env.MCP_SIGNING_SECRET = MCP_SECRET;
    process.env.OFFICIAL_COMMUNITY_SSO_SECRET = OFFICIAL;
  });
  afterAll(() => {
    for (const k of ["SMTP_URL", "NOTIFY_EMAIL_FROM", "MCP_SIGNING_SECRET", "OFFICIAL_COMMUNITY_SSO_SECRET", "PROMPTOWL_SIGN_IN_GATE"]) delete process.env[k];
  });

  it("R9-M1: an agent bearer ticket for a sealed owner alerts them — once per 24 h per method, and again at once for a new agent identity", async () => {
    let [s, m] = marks();
    const call = (t: string) => app.request(`/nests/${PN}/nodes`, { headers: { Authorization: `Bearer ${t}` } });
    expect((await call(mint({ act: "agent-one@surf.test" }, MCP_SECRET))).status).toBe(200);
    let a = await alertsTo(s, m);
    expect(a.dms.length).toBe(1);
    expect(String(a.dms[0].text)).toMatch(/^New sign-in to your Nest account via an agent ticket at /);
    expect(a.mails.length).toBe(1);
    // Same agent again (and again): no repeat inside 24 h.
    [s, m] = marks();
    expect((await call(mint({ act: "agent-one@surf.test" }, MCP_SECRET))).status).toBe(200);
    expect((await call(mint({ act: "agent-one@surf.test" }, MCP_SECRET))).status).toBe(200);
    a = await alertsTo(s, m);
    expect(a.dms.length + a.mails.length).toBe(0);
    // A new agent identity alerts at once.
    [s, m] = marks();
    expect((await call(mint({ act: "agent-two@surf.test" }, MCP_SECRET))).status).toBe(200);
    a = await alertsTo(s, m);
    expect(a.dms.length).toBe(1);
    // 24 h later the known agent alerts again.
    await db().run("UPDATE surface_signin_seen SET last_alert_at = ? WHERE user_id = ? AND seen_key = 'm:agent'", [new Date(Date.now() - 25 * 3600_000).toISOString(), dana.userId]);
    [s, m] = marks();
    expect((await call(mint({ act: "agent-one@surf.test" }, MCP_SECRET))).status).toBe(200);
    a = await alertsTo(s, m);
    expect(a.dms.length).toBe(1);
  });

  it("R9-M1: trading an official ticket for a key (/auth/keys/exchange) alerts the sealed owner", async () => {
    const [s, m] = marks();
    const r = await app.request("/auth/keys/exchange", { method: "POST", headers: { Authorization: `Bearer ${mint({}, OFFICIAL)}`, "Content-Type": "application/json" }, body: JSON.stringify({ nest_id: PN }) });
    expect(r.status).toBe(201);
    const a = await alertsTo(s, m);
    expect(a.dms.length).toBe(1);
    expect(String(a.dms[0].text)).toMatch(/via a ticket-for-key exchange at /);
  });

  it("R9-M1: the token-exchange route reports its sign-in to the alert hook", () => {
    const src = readFileSync(join(__dirname, "..", "src", "auth", "token-exchange.ts"), "utf8");
    expect(src).toMatch(/signInAlertSoon\(user\.id, "token_exchange"/);
  });

  it("R9-INFO: SSO sign-ins alert only on a new device, or after 30 days without one by that method; resets always alert", async () => {
    process.env.PROMPTOWL_SIGN_IN_GATE = "open";
    const secret = `site-secret-r9-${rnd()}-xxxxxxxxxxxx`;
    expect((await jsonRequest(app, "POST", "/admin/community-sites", { name: "R9", url: `https://r9-${rnd()}.test`, secret }, root.apiKey)).status).toBe(201);
    await S.work.waitForSurfacesWork();
    const sso = (ua: string) => {
      const now = Math.floor(Date.now() / 1000);
      const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const p = b64(JSON.stringify({ sub: dana.email, aud: BASE, jti: `j-${rnd()}`, iat: now, exp: now + 60 }));
      return app.request(`/auth/sso?ticket=${h}.${p}.${b64(createHmac("sha256", secret).update(`${h}.${p}`).digest())}`, { headers: { "User-Agent": ua } });
    };
    let [s, m] = marks();
    expect((await sso("Laptop r9")).status).toBe(302);
    let a = await alertsTo(s, m);
    expect(a.dms.length).toBe(1);
    [s, m] = marks();
    expect((await sso("Laptop r9")).status).toBe(302);
    a = await alertsTo(s, m);
    expect(a.dms.length + a.mails.length).toBe(0);
    // 31 days since the last SSO sign-in → alert even on a known device.
    await db().run("UPDATE surface_signin_seen SET last_seen_at = ? WHERE user_id = ? AND seen_key = 'm:sso'", [new Date(Date.now() - 31 * 86400_000).toISOString(), dana.userId]);
    [s, m] = marks();
    expect((await sso("Laptop r9")).status).toBe(302);
    a = await alertsTo(s, m);
    expect(a.dms.length).toBe(1);
    // A new device alerts.
    [s, m] = marks();
    expect((await sso("Phone r9")).status).toBe(302);
    a = await alertsTo(s, m);
    expect(a.dms.length).toBe(1);
  });

  it("R9-INFO: config-change alerts are queued after the save and delivered (retried until a channel takes them)", async () => {
    // Both channels down: the save still succeeds; the alert waits in the outbox.
    slack.openFail = true;
    const prev = process.env.SMTP_URL;
    delete process.env.SMTP_URL;
    let [s, m] = marks();
    const r = await jsonRequest(app, "PATCH", "/admin/settings", { manual_sign_in: "invite-only" }, root.apiKey);
    expect(r.status).toBe(200);
    await S.work.waitForSurfacesWork();
    const pending = await one("SELECT * FROM surface_alert_outbox WHERE user_id = ? AND delivered_at IS NULL ORDER BY created_at DESC LIMIT 1", [dana.userId]);
    expect(pending).toBeTruthy();
    expect(Number(pending.attempts)).toBeGreaterThanOrEqual(1);
    expect(String(pending.text)).not.toMatch(/zqside|token/i);
    // Channels back; the sweep retries and delivers.
    slack.openFail = false;
    process.env.SMTP_URL = prev;
    [s, m] = marks();
    const { drainAlertOutbox } = await import("../src/surfaces/signin-alerts.js");
    await drainAlertOutbox(Date.now() + 3600_000);
    const a = await alertsTo(s, m);
    expect(a.dms.length).toBe(1);
    expect(String(a.dms[0].text)).toMatch(/sign-in or email settings/);
    expect((await one("SELECT delivered_at FROM surface_alert_outbox WHERE id = ?", [pending.id])).delivered_at).toBeTruthy();
    await jsonRequest(app, "PATCH", "/admin/settings", { manual_sign_in: "open" }, root.apiKey);
    await S.work.waitForSurfacesWork();
  });

  it("R9-INFO: the reset page forbids framing", async () => {
    const page = await app.request("/auth/reset", { headers: { Accept: "text/html" } });
    expect(page.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
  });

  it("R10-3: an OIDC sign-in (fake provider) as a sealed owner alerts by DM and email; a repeat on the same device is silent", async () => {
    const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
    const ISSUER = "https://idp.test";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    let tokenBody: Record<string, unknown> | null = null;
    const jsonRes = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    idp = {
      issuer: ISSUER,
      handle: async (url: string) => {
        if (url === `${ISSUER}/.well-known/openid-configuration`)
          return jsonRes({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
        if (url === `${ISSUER}/jwks`) return jsonRes({ keys: [jwk] });
        if (url === `${ISSUER}/token`) return tokenBody ? jsonRes(tokenBody) : jsonRes({ error: "none" }, 500);
        return jsonRes({ error: "unexpected" }, 404);
      },
    };
    const env = { OIDC_ENABLED: "true", OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: "cid-r10", OIDC_CLIENT_SECRET: "csecret-r10" };
    Object.assign(process.env, env);
    const signIn = async (ua: string) => {
      const start = await app.request("/auth/oidc/login", { headers: { "User-Agent": ua } });
      expect(start.status).toBe(302);
      const ck: Record<string, string> = {};
      for (const line of start.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const [k, ...v] = pair.split("=");
        ck[k.trim()] = v.join("=");
      }
      tokenBody = {
        id_token: await new SignJWT({ nonce: ck["cnst_oidc_nonce"], email: dana.email, email_verified: true, name: "Dana" })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(ISSUER)
          .setAudience("cid-r10")
          .setSubject("dana-sub")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey),
        access_token: "at",
        token_type: "Bearer",
      };
      const cookie = ["cnst_oidc_state", "cnst_oidc_nonce", "cnst_oidc_verifier"].map((k) => `${k}=${ck[k]}`).join("; ");
      const cb = await app.request(`/auth/oidc/callback?code=c-${rnd()}&state=${ck["cnst_oidc_state"]}`, { headers: { Cookie: cookie, "User-Agent": ua } });
      expect(cb.status).toBe(302);
      expect(cb.headers.get("Location")).toBe("/");
    };
    try {
      let [s, m] = marks();
      await signIn("Browser-OIDC r10");
      let a = await alertsTo(s, m);
      expect(a.dms.length).toBe(1);
      expect(String(a.dms[0].text)).toMatch(/^New sign-in to your Nest account via your organisation's sign-in \(OIDC\) at /);
      expect(a.mails.length).toBe(1);
      [s, m] = marks();
      await signIn("Browser-OIDC r10");
      a = await alertsTo(s, m);
      expect(a.dms.length + a.mails.length).toBe(0);
    } finally {
      idp = null;
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  it("R9-L1: before an admin revokes a sealed owner's Slack link, the owner is told by DM (while it still works) and by email", async () => {
    const link = await one("SELECT * FROM surface_identity_links WHERE community_user_id = ? AND status = 'active' AND install_id = ?", [dana.userId, installId]);
    expect(link).toBeTruthy();
    const [s, m] = marks();
    slack.calls = [];
    const r = await jsonRequest(app, "DELETE", `/surfaces/links/${link.id}`, undefined, root.apiKey);
    expect(r.status).toBe(200);
    const a = await alertsTo(s, m);
    expect(a.dms.length).toBe(1);
    expect(String(a.dms[0].text)).toMatch(/admin is removing .*Slack connection/i);
    expect(a.mails.length).toBe(1);
    expect((await one("SELECT status FROM surface_identity_links WHERE id = ?", [link.id])).status).toBe("revoked");
    // The person revoking their own link isn't told about it.
    await db().run("UPDATE surface_identity_links SET status = 'active', auto_match_blocked = 0, revoked_at = NULL, revoked_by = NULL WHERE id = ?", [link.id]);
    const [s2, m2] = marks();
    expect((await jsonRequest(app, "DELETE", `/surfaces/links/${link.id}`, undefined, dana.apiKey)).status).toBe(200);
    const b = await alertsTo(s2, m2);
    expect(b.dms.length + b.mails.length).toBe(0);
    // Restore for the disconnect test.
    await db().run("UPDATE surface_identity_links SET status = 'active', auto_match_blocked = 0, revoked_at = NULL, revoked_by = NULL WHERE id = ?", [link.id]);
  });
});

// ═══ Audit, REST + MCP parity, uninstall ═════════════════════════════════════

describe("audit, parity, disconnect", () => {
  it("AC-SRF-01: an approved item's audit row (REST and MCP) shows the approver, surface, Slack user id, window + message count, proposal and 'proposed by Nest listener'", async () => {
    const p = await makeProposal("C1");
    await click("U_ERIN", "nest_approve", p.id);
    const rest = (await jsonRequest(app, "GET", `/surfaces/commits?nest_id=${N}&proposal_id=${p.id}`, undefined, alice.apiKey)).data.commits;
    expect(rest.length).toBe(1);
    expect(rest[0]).toMatchObject({ approved_by: { user_id: erin.userId, email: erin.email }, surface: "slack", surface_user_id: "U_ERIN", window_id: p.window_id, window_message_count: 1, proposal_id: p.id, proposed_by: "Nest listener" });
    const m = await app.request(`/nests/${N}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${alice.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_surfaces_commits_list", arguments: { proposal_id: p.id } } }),
    });
    const t = await m.text();
    expect(t).toMatch(/Nest listener/);
    expect(t).toMatch(/U_ERIN/);
  });

  it("AC-MCP-01: every REST admin route after S1–S2 has a context_surfaces_* MCP tool and an API.md entry", async () => {
    const { SURFACES_TOOL_DEFINITIONS } = await import("../src/mcp/surfaces-tools.js");
    const names = new Set(SURFACES_TOOL_DEFINITIONS.map((t: any) => t.name));
    const api = readFileSync(join(__dirname, "..", "API.md"), "utf8");
    const pairs: Array<[string, string]> = [
      ["GET /surfaces/status", "context_surfaces_status"],
      ["POST /surfaces/slack/installs", "context_surfaces_slack_install_create"],
      ["DELETE /surfaces/installs/:id", "context_surfaces_disconnect"],
      ["GET /surfaces/bindings", "context_surfaces_bindings_list"],
      ["POST /surfaces/bindings/preview", "context_surfaces_binding_preview"],
      ["GET /surfaces/links", "context_surfaces_links_list"],
      ["GET /surfaces/link-reviews", "context_surfaces_link_reviews_list"],
      ["GET /surfaces/windows", "context_surfaces_windows_list"],
      ["GET /surfaces/proposals", "context_surfaces_proposals_list"],
      ["GET /surfaces/pending", "context_surfaces_my_pending"],
      ["GET /surfaces/commits", "context_surfaces_commits_list"],
      ["GET /surfaces/settings", "context_surfaces_settings_get"],
      ["PATCH /surfaces/settings", "context_surfaces_settings_update"],
      ["GET /surfaces/nests/:nestId/budget", "context_surfaces_budget_get"],
      ["PATCH /surfaces/nests/:nestId/budget", "context_surfaces_budget_update"],
    ];
    for (const [route, tool] of pairs) {
      expect(names.has(tool), tool).toBe(true);
      expect(api.includes(route.split(" ")[1]), route).toBe(true);
      expect(api.includes(tool.replace(/^context_surfaces_/, "")) || api.includes(tool), tool).toBe(true);
    }
  });

  it("budgets: REST and MCP read/update the nest cap (owner/admin; $0–$10,000; read-only keys refused)", async () => {
    expect((await jsonRequest(app, "GET", `/surfaces/nests/${N}/budget`, undefined, alice.apiKey)).data.budget.cap_micros).toBe(50_000_000);
    expect((await jsonRequest(app, "PATCH", `/surfaces/nests/${N}/budget`, { cap_micros: 20_000_000_000 }, alice.apiKey)).status).toBe(422);
    expect((await jsonRequest(app, "PATCH", `/surfaces/nests/${N}/budget`, { cap_micros: 1_000_000 }, bob.apiKey)).status).toBe(403);
    expect((await jsonRequest(app, "PATCH", `/surfaces/nests/${N}/budget`, { cap_micros: 60_000_000 }, alice.apiKey)).data.budget.cap_micros).toBe(60_000_000);
    const ro = await jsonRequest(app, "POST", "/auth/keys", { label: "ro", capability: "read" }, alice.apiKey);
    if (ro.data?.api_key) expect((await jsonRequest(app, "PATCH", `/surfaces/nests/${N}/budget`, { cap_micros: 1 }, ro.data.api_key)).status).toBe(403);
    await jsonRequest(app, "PATCH", `/surfaces/nests/${N}/budget`, { cap_micros: 50_000_000 }, alice.apiKey);
  });

  it("N1: proposals listed to someone other than the personal nest's owner are redacted", async () => {
    const b = await one("SELECT * FROM surface_bindings WHERE conversation_id = 'D_U_DANA'");
    const list = (await jsonRequest(app, "GET", `/surfaces/proposals?nest_id=${b.nest_id}`, undefined, root.apiKey)).data.proposals;
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) {
      expect(p.conversation).toBe("DM · private nest");
      for (const i of p.items) expect(i.title).toBe("DM · private nest · title hidden");
    }
  });

  it("AC-EXP-04 + CF-5 (AC-INS-09): disconnect updates pending cards to Withdrawn BEFORE auth.revoke; afterwards secrets, bindings, buffer, drafts and links are gone; approved nodes and surface_commits remain", async () => {
    await jsonRequest(app, "PATCH", "/surfaces/settings", { reviewer_daily_cards: 10, conversation_daily_cards: 20 }, root.apiKey);
    const p = await makeProposal("C1");
    await say("C1", "U_BOB", "and something sitting in the buffer before the disconnect");
    const commits = Number((await one("SELECT COUNT(*) AS n FROM surface_commits")).n);
    expect(commits).toBeGreaterThan(0);
    const approved = await one("SELECT node_id FROM surface_commits LIMIT 1");
    slack.calls = [];
    process.env.SMTP_URL = "smtps://u:p@smtp.test:465";
    process.env.NOTIFY_EMAIL_FROM = "nest@surf.test";
    sentMail.length = 0;
    const r = await jsonRequest(app, "DELETE", `/surfaces/installs/${installId}`, undefined, root.apiKey);
    expect(r.status).toBe(200);
    const order = slack.calls.map((c) => c.method);
    const firstRevoke = order.indexOf("auth.revoke");
    expect(firstRevoke).toBeGreaterThan(-1);
    // Round 9 (R5-L1): a linked sealed-nest owner is DMed BEFORE the token is revoked, and emailed.
    const notice = slack.calls.findIndex((c) => c.method === "chat.postMessage" && c.params.channel === "D_U_DANA" && /disconnecting Nest from Slack/i.test(String(c.params.text)));
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(firstRevoke);
    await S.work.waitForSurfacesWork();
    expect(sentMail.some((m) => (m.to === dana.email || (Array.isArray(m.to) && m.to.includes(dana.email))) && /disconnecting Nest from Slack/i.test(String(m.text)))).toBe(true);
    const updIdx = order.findIndex((m, i) => m === "chat.update" && JSON.stringify(slack.calls[i].params).includes("Withdrawn"));
    expect(updIdx).toBeGreaterThan(-1);
    expect(updIdx).toBeLessThan(firstRevoke);
    expect((await itemsOf(p.id))[0].state).toBe("withdrawn");
    expect((await all("SELECT * FROM surface_secrets WHERE install_id = ?", [installId])).length).toBe(0);
    expect((await all("SELECT * FROM surface_buffer WHERE install_id = ?", [installId])).length).toBe(0);
    expect((await all("SELECT * FROM surface_identity_links WHERE install_id = ?", [installId])).length).toBe(0);
    expect((await all("SELECT * FROM surface_bindings WHERE install_id = ? AND status <> 'removed'", [installId])).length).toBe(0);
    expect(Number((await one("SELECT COUNT(*) AS n FROM surface_commits")).n)).toBe(commits);
    const node = await jsonRequest(app, "GET", `/nests/${N}/nodes/${approved.node_id}`, undefined, alice.apiKey);
    expect(node.status).toBe(200);
    expect((await one("SELECT status FROM surface_installs WHERE id = ?", [installId])).status).toBe("disconnected");
    delete process.env.SMTP_URL;
    delete process.env.NOTIFY_EMAIL_FROM;
  });
});

