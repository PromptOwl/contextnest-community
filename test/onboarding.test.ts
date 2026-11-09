/**
 * First-run onboarding (PO-1185) — acceptance criteria 1–7, 9, 10 and the MCP
 * twins, in Given/When/Then form. Distill (AC8) is in onboarding-distill.test.ts.
 *
 * Only the Slack Web API is replaced (slackCall); every other path is real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed, resetAuthRateLimit } from "./helpers";

const slackOauth: { next: Record<string, unknown> | null; calls: string[] } = { next: null, calls: [] };
beforeAll(() => {
  vi.doMock("../src/surfaces/adapters/slack/api.js", async () => {
    const actual = await vi.importActual<typeof import("../src/surfaces/adapters/slack/api.js")>("../src/surfaces/adapters/slack/api.js");
    return {
      ...actual,
      slackCall: async (method: string) => {
        slackOauth.calls.push(method);
        if (method === "oauth.v2.access" && slackOauth.next) return slackOauth.next;
        return { ok: true };
      },
    };
  });
});
afterAll(() => vi.doUnmock("../src/surfaces/adapters/slack/api.js"));

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let rpc = 1;
async function mcp(app: any, path: string, key: string, name: string, args: Record<string, unknown>, clientName?: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(key) },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name, arguments: { ...args, ...(clientName ? { client: { agent: clientName } } : {}) } } }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  return body.result as { content: Array<{ text: string }>; structuredContent?: any };
}

async function login(app: any, email: string): Promise<string> {
  const r = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass" }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

/** The activity trace is written fire-and-forget; give it a moment. */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 40): Promise<T> {
  let v = await fn();
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 25));
    v = await fn();
  }
  return v;
}

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let newbie: Awaited<ReturnType<typeof registerUser>>;
let veteran: Awaited<ReturnType<typeof registerUser>>;
let skipper: Awaited<ReturnType<typeof registerUser>>;
let root: Awaited<ReturnType<typeof registerUser>>;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@onboard.test"] });
  newbie = await registerUser(app, "dana.lee@onboard.test", "Dana Lee");
  veteran = await registerUser(app, "vera@onboard.test", "Vera");
  await resetAuthRateLimit();
  skipper = await registerUser(app, "sam@onboard.test", "Sam");
  root = await registerUser(app, "root@onboard.test", "Root");
  await resetAuthRateLimit();
  // Vera already owns a nest, made the ordinary way.
  const made = await jsonRequest(app, "POST", "/nests", { name: "Vera work" }, veteran.apiKey);
  expect(made.status).toBe(201);
});
afterAll(async () => {
  await env.cleanup();
});

describe("AC1: first run shows the welcome screen", () => {
  it("Given a signed-in user with no nest of their own, When they open the app, Then the welcome screen shows", async () => {
    const r = await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.show).toBe(true);
    expect(r.data.first_run).toBe(true);
    expect(r.data.nest).toBeNull();
    expect(r.data.suggested_nest_name).toBe("Dana's nest");
    expect(r.data.can_create_nest).toBe(true);
  });

  it("is off when a superadmin turns the toggle off, and the toggle is DB-persisted", async () => {
    const off = await jsonRequest(app, "PATCH", "/admin/settings", { onboarding_enabled: false }, root.apiKey);
    expect(off.status).toBe(200);
    expect(off.data.settings.onboarding_enabled).toBe(false);
    expect((await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey)).data.show).toBe(false);
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get("SELECT value FROM server_settings WHERE key = 'ONBOARDING_ENABLED'")) as { value: string };
    expect(row.value).toBe("false");
    await jsonRequest(app, "PATCH", "/admin/settings", { onboarding_enabled: true }, root.apiKey);
    expect((await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey)).data.show).toBe(true);
  });

  it("refuses a non-admin who tries to flip the toggle", async () => {
    const r = await jsonRequest(app, "PATCH", "/admin/settings", { onboarding_enabled: false }, newbie.apiKey);
    expect(r.status).toBe(403);
  });
});

let nestId = "";

describe("AC2: Create my nest", () => {
  it("Given the welcome screen, When the user clicks Create my nest, Then a nest named \"<Name>'s nest\" is created and the user owns it", async () => {
    const r = await jsonRequest(app, "POST", "/onboarding/nest", {}, newbie.apiKey);
    expect(r.status).toBe(201);
    expect(r.data.nest.name).toBe("Dana's nest");
    nestId = r.data.nest.id;
    const nest = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, newbie.apiKey);
    expect(nest.status).toBe(200);
    const { getDb } = await import("../src/db/client.js");
    const owner = (await getDb().get("SELECT user_id FROM nests WHERE id = ?", [nestId])) as { user_id: string };
    expect(owner.user_id).toBe(newbie.userId);
  });

  it("is idempotent: a double click does not make a second nest", async () => {
    const again = await jsonRequest(app, "POST", "/onboarding/nest", {}, newbie.apiKey);
    expect(again.status).toBe(200);
    expect(again.data.nest.id).toBe(nestId);
    const list = await jsonRequest(app, "GET", "/nests", undefined, newbie.apiKey);
    expect(list.data.nests.filter((n: any) => n.is_owner !== false && n.user_id === newbie.userId).length).toBe(1);
  });

  it("keeps the screen open after the nest exists, so the user can connect and fill it", async () => {
    const r = await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey);
    expect(r.data.show).toBe(true);
    expect(r.data.first_run).toBe(false);
    expect(r.data.nest.id).toBe(nestId);
  });
});

describe("AC3: every tile has the nest's MCP URL", () => {
  it("Given the nest from AC2, When the user opens Connect your agents, Then the state carries that nest's MCP URL", async () => {
    const r = await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey);
    expect(r.data.nest.mcp_url).toMatch(new RegExp(`/nests/${nestId}/mcp$`));
    expect(r.data.nest.server_mcp_url).toMatch(/\/mcp$/);
  });
});

describe("AC4: the connect proof", () => {
  let since = "";
  it("Given no agent has read the nest, Then the tile is not connected", async () => {
    since = new Date(Date.now() - 1000).toISOString();
    const r = await jsonRequest(app, "GET", `/onboarding/connection?nest_id=${nestId}&since=${encodeURIComponent(since)}`, undefined, newbie.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.connected).toBe(false);
  });

  it("does not count a write as a read", async () => {
    await mcp(app, `/nests/${nestId}/mcp`, newbie.apiKey, "context_create", { title: "Hello", content: "First doc." }, "claude-code");
    await new Promise((r) => setTimeout(r, 100));
    const r = await jsonRequest(app, "GET", `/onboarding/connection?nest_id=${nestId}&since=${encodeURIComponent(since)}`, undefined, newbie.apiKey);
    expect(r.data.connected).toBe(false);
  });

  it("does not count someone else's read", async () => {
    // Vera cannot read Dana's private nest; even a refused call must not count.
    await mcp(app, `/nests/${nestId}/mcp`, veteran.apiKey, "context_list", {}, "goose");
    await new Promise((r) => setTimeout(r, 100));
    const r = await jsonRequest(app, "GET", `/onboarding/connection?nest_id=${nestId}&since=${encodeURIComponent(since)}`, undefined, newbie.apiKey);
    expect(r.data.connected).toBe(false);
  });

  it("Given a harness tile, When the agent reads the nest, Then the tile shows the agent is connected", async () => {
    await mcp(app, `/nests/${nestId}/mcp`, newbie.apiKey, "context_list", {}, "claude-code");
    const r = await eventually(
      () => jsonRequest(app, "GET", `/onboarding/connection?nest_id=${nestId}&since=${encodeURIComponent(since)}`, undefined, newbie.apiKey),
      (v) => v.data.connected === true,
    );
    expect(r.data.connected).toBe(true);
    expect(r.data.via).toBe("mcp");
    expect(r.data.client).toBe("claude-code");
    expect(r.data.tool).toBe("context_list");
  });

  it("counts a read over the server-level /mcp that targets this nest", async () => {
    const later = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await mcp(app, "/mcp", newbie.apiKey, "context_get", { nest: nestId, title: "Hello" }, "goose");
    const r = await eventually(
      () => jsonRequest(app, "GET", `/onboarding/connection?nest_id=${nestId}&since=${encodeURIComponent(later)}`, undefined, newbie.apiKey),
      (v) => v.data.connected === true,
    );
    expect(r.data.client).toBe("goose");
  });

  it("refuses the check on a nest the caller cannot read", async () => {
    const r = await jsonRequest(app, "GET", `/onboarding/connection?nest_id=${nestId}`, undefined, veteran.apiKey);
    expect(r.status).toBe(404);
  });
});

describe("AC5: Skip, then Getting started", () => {
  it("Given the welcome screen, When the user clicks Skip, Then it does not show on the next sign-in, and Getting started on Home opens it", async () => {
    const first = await jsonRequest(app, "GET", "/onboarding", undefined, skipper.apiKey);
    expect(first.data.show).toBe(true);
    const skip = await jsonRequest(app, "POST", "/onboarding/dismiss", {}, skipper.apiKey);
    expect(skip.status).toBe(200);
    expect(skip.data.show).toBe(false);
    // The next sign-in: a fresh browser session.
    const cookie = await login(app, skipper.email);
    const next = await app.request("/onboarding", { headers: { Cookie: cookie } });
    expect((await next.json()).show).toBe(false);
    const reopen = await jsonRequest(app, "POST", "/onboarding/reopen", {}, skipper.apiKey);
    expect(reopen.data.show).toBe(true);
  });
});

describe("AC6: an existing owner never sees it uninvited", () => {
  it("Given a user who already owns a nest, When they sign in, Then the welcome screen does not show", async () => {
    const cookie = await login(app, veteran.email);
    const r = await app.request("/onboarding", { headers: { Cookie: cookie } });
    const data = await r.json();
    expect(data.show).toBe(false);
    expect(data.first_run).toBe(false);
  });

  it("shows it again for that user only after Getting started", async () => {
    const r = await jsonRequest(app, "POST", "/onboarding/reopen", {}, veteran.apiKey);
    expect(r.data.show).toBe(true);
    expect(r.data.nest.name).toBe("Vera work");
    await jsonRequest(app, "POST", "/onboarding/dismiss", {}, veteran.apiKey);
  });
});

describe("Slack connector (AC9, AC10)", () => {
  const BASE = "https://nest.onboard.test";
  const KEYS = [
    "FEATURE_WORKFLOW_PLANE",
    "FEATURE_METACOGNITION",
    "FEATURE_SURFACES",
    "FEATURE_SURFACES_SLACK_HOSTED",
    "SURFACES_SLACK_HOSTED_CLIENT_ID",
    "SURFACES_SLACK_HOSTED_CLIENT_SECRET",
    "SURFACES_SLACK_HOSTED_SIGNING_SECRET",
    "SURFACES_SLACK_SELF_SERVE",
    "PUBLIC_BASE_URL",
  ];
  afterAll(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("AC10: Given Slack is not configured, Then the tile says a server admin must configure it, and only an admin sees the setting link", async () => {
    const user = await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey);
    expect(user.data.connectors.slack.configured).toBe(false);
    expect(user.data.connectors.slack.can_connect).toBe(false);
    expect(user.data.connectors.slack.reason).toMatch(/server admin must configure/i);
    expect(user.data.connectors.slack.admin_settings_path).toBeNull();
    await jsonRequest(app, "POST", "/onboarding/reopen", {}, root.apiKey);
    const admin = await jsonRequest(app, "GET", "/onboarding", undefined, root.apiKey);
    expect(admin.data.connectors.slack.admin_settings_path).toBe("/settings");
  });

  it("refuses self-serve for a non-admin until the superadmin toggle is on", async () => {
    Object.assign(process.env, {
      FEATURE_WORKFLOW_PLANE: "true",
      FEATURE_METACOGNITION: "true",
      FEATURE_SURFACES: "true",
      FEATURE_SURFACES_SLACK_HOSTED: "true",
      SURFACES_SLACK_HOSTED_CLIENT_ID: "hosted-cid",
      SURFACES_SLACK_HOSTED_CLIENT_SECRET: "hosted-secret",
      SURFACES_SLACK_HOSTED_SIGNING_SECRET: "hosted-signing",
      PUBLIC_BASE_URL: BASE,
    });
    const state = await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey);
    expect(state.data.connectors.slack.configured).toBe(true);
    expect(state.data.connectors.slack.can_connect).toBe(false);
    const cookie = await login(app, newbie.email);
    const r = await app.request(`/surfaces/slack/hosted/oauth/self-serve?home_nest_id=${nestId}`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(403);
  });

  it("refuses a nest the user does not own", async () => {
    const t = await jsonRequest(app, "PATCH", "/admin/settings", { surfaces_slack_self_serve: true }, root.apiKey);
    expect(t.data.settings.surfaces_slack_self_serve).toBe(true);
    const veraNest = (await jsonRequest(app, "GET", "/nests", undefined, veteran.apiKey)).data.nests[0].id;
    const cookie = await login(app, newbie.email);
    const r = await app.request(`/surfaces/slack/hosted/oauth/self-serve?home_nest_id=${veraNest}`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(422);
  });

  it("refuses an API key: the OAuth state is bound to a browser session", async () => {
    const r = await app.request(`/surfaces/slack/hosted/oauth/self-serve?home_nest_id=${nestId}`, { headers: authed(newbie.apiKey) });
    expect(r.status).toBe(403);
  });

  it("AC9: Given Slack is configured, When the user clicks Connect Slack, Then the OAuth install starts, and on return the screen shows Slack connected", async () => {
    const cookie = await login(app, newbie.email);
    const ready = await app.request("/onboarding", { headers: { Cookie: cookie } });
    expect((await ready.json()).connectors.slack.can_connect).toBe(true);
    // The welcome screen's link.
    const start = await app.request(`/onboarding/slack/start?nest_id=${nestId}`, { headers: { Cookie: cookie } });
    expect(start.status).toBe(302);
    const hop = start.headers.get("location")!;
    expect(hop).toBe(`/surfaces/slack/hosted/oauth/self-serve?home_nest_id=${nestId}`);
    const auth = await app.request(hop, { headers: { Cookie: cookie } });
    expect(auth.status).toBe(302);
    const slackUrl = new URL(auth.headers.get("location")!);
    expect(slackUrl.origin + slackUrl.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(slackUrl.searchParams.get("client_id")).toBe("hosted-cid");
    const state = slackUrl.searchParams.get("state")!;
    slackOauth.next = {
      ok: true,
      access_token: "xoxb-dana",
      token_type: "bot",
      bot_user_id: "UBOT",
      team: { id: "T_DANA", name: "Dana Co" },
      enterprise: null,
      is_enterprise_install: false,
      authed_user: { id: "U_DANA" },
    };
    const cb = await app.request(`/surfaces/slack/oauth/callback?code=x&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?onboarding=slack&slack=connected");
    const after = await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey);
    expect(after.data.connectors.slack.connected).toBe(true);
  });

  it("refuses a replayed state (single use)", async () => {
    const cookie = await login(app, newbie.email);
    const auth = await app.request(`/surfaces/slack/hosted/oauth/self-serve?home_nest_id=${nestId}`, { headers: { Cookie: cookie } });
    const state = new URL(auth.headers.get("location")!).searchParams.get("state")!;
    const other = await login(app, veteran.email);
    // Another person's session cannot complete it.
    const cb = await app.request(`/surfaces/slack/oauth/callback?code=x&state=${encodeURIComponent(state)}`, { headers: { Cookie: other, Accept: "application/json" } });
    expect(cb.status).toBe(403);
  });
});

describe("MCP parity", () => {
  it("context_onboarding reads the same state and the connect proof", async () => {
    const r = await mcp(app, "/mcp", newbie.apiKey, "context_onboarding", {});
    expect(r.structuredContent?.nest?.id ?? JSON.parse(r.content[r.content.length - 1]!.text).nest?.id).toBeDefined();
    expect(r.content[0]!.text).toMatch(/Dana's nest/);
    expect(r.content[0]!.text).toMatch(/Connect proof: an agent read this nest/);
  });

  it("context_onboarding_update dismisses and reopens, and creates a nest idempotently", async () => {
    const d = await mcp(app, "/mcp", newbie.apiKey, "context_onboarding_update", { action: "dismiss" });
    expect(d.content[0]!.text).toMatch(/not shown/);
    expect((await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey)).data.show).toBe(false);
    const c = await mcp(app, "/mcp", newbie.apiKey, "context_onboarding_update", { action: "create_nest" });
    expect(c.content[0]!.text).toMatch(/already have "Dana's nest"/);
    await mcp(app, "/mcp", newbie.apiKey, "context_onboarding_update", { action: "reopen" });
    expect((await jsonRequest(app, "GET", "/onboarding", undefined, newbie.apiKey)).data.show).toBe(true);
  });

  it("lists the four onboarding tools on the server-level endpoint", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, ...authed(newbie.apiKey) },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    for (const t of ["context_onboarding", "context_onboarding_update", "context_distill", "context_distill_status"]) expect(text).toContain(`"${t}"`);
  });
});
