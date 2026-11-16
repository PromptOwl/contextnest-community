/**
 * po-1186 CR3 — the Control room setup's server side: the public member
 * explainer (GET /about/surfaces), the channel list the wizard offers
 * (GET /surfaces/slack/installs/:id/channels + its MCP twin), the setup fields
 * on /surfaces/status and /health, and the enable notice's link to the
 * explainer. Real routes, services and DB; Slack's Web API is a stubbed
 * global fetch (any other host fails the network guard).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const BASE = "https://nest.cr3.test";
const SIGNING = "cr3-signing-secret";

const slack = {
  calls: [] as Array<{ method: string; params: Record<string, string> }>,
  posted: [] as Array<Record<string, string>>,
  users: new Map<string, { id: string; team_id: string; email?: string; name?: string; is_bot?: boolean }>(),
  convs: new Map<string, { info: Record<string, unknown>; members: string[] }>(),
  /** What users.conversations answers (the bot's channels). */
  botChannels: [] as Array<Record<string, unknown>>,
  conversationsError: null as string | null,
  /** "endless": every page has a next cursor; "ratelimited": HTTP 429 with Retry-After. */
  conversationsMode: "normal" as "normal" | "endless" | "ratelimited",
  oauth: null as Record<string, unknown> | null,
};
const realFetch = globalThis.fetch;
async function fakeFetch(input: any, init?: any): Promise<Response> {
  const u = typeof input === "string" ? input : input.url;
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (!u.startsWith("https://slack.com/api/")) throw new Error(`network guard: ${u}`);
  const method = u.slice("https://slack.com/api/".length).split("?")[0];
  const params: Record<string, string> = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
  slack.calls.push({ method, params });
  switch (method) {
    case "oauth.v2.access":
      return json(slack.oauth ?? { ok: false, error: "invalid_code" });
    case "users.conversations":
      if (slack.conversationsError) return json({ ok: false, error: slack.conversationsError });
      if (slack.conversationsMode === "ratelimited") return new Response("", { status: 429, headers: { "retry-after": "17" } });
      if (slack.conversationsMode === "endless") {
        const n = Number(params.cursor || 0);
        return json({ ok: true, channels: [{ id: `C_P${n}`, name: `page-${String(n).padStart(2, "0")}`, is_private: false }], response_metadata: { next_cursor: String(n + 1) } });
      }
      return json({ ok: true, channels: slack.botChannels, response_metadata: { next_cursor: "" } });
    case "users.info": {
      const x = slack.users.get(params.user);
      if (!x) return json({ ok: false, error: "user_not_found" });
      return json({ ok: true, user: { id: x.id, team_id: x.team_id, name: x.name ?? x.id, deleted: false, is_bot: !!x.is_bot, is_restricted: false, is_ultra_restricted: false, is_email_confirmed: true, profile: { email: x.email, display_name: x.name ?? x.id } } });
    }
    case "conversations.info": {
      const c = slack.convs.get(params.channel);
      return json(c ? { ok: true, channel: c.info } : { ok: false, error: "channel_not_found" });
    }
    case "conversations.members": {
      const c = slack.convs.get(params.channel);
      return json(c ? { ok: true, members: c.members, response_metadata: { next_cursor: "" } } : { ok: false, error: "channel_not_found" });
    }
    case "chat.postMessage":
      slack.posted.push(params);
      return json({ ok: true, channel: params.channel, ts: `${Date.now()}.0001` });
    default:
      return json({ ok: true });
  }
}

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: Awaited<ReturnType<typeof registerUser>>;
let alice: Awaited<ReturnType<typeof registerUser>>;
let N: string;
let installId: string;

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
async function mcp(path: string, params: Record<string, unknown>, key: string) {
  const res = await app.request(path, { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) });
  const text = await res.text();
  const line = text.split("\n").find((l: string) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice("data: ".length)) : JSON.parse(text);
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  process.env.SURFACES_BUFFER_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.SURFACES_ORG_NAME = "Larkspur";
  vi.stubGlobal("fetch", fakeFetch);
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@cr3.test"], ownerEmail: "lic@cr3.test" });
  root = await registerUser(app, "root@cr3.test", "Root Admin");
  await resetAuthRateLimit();
  alice = await registerUser(app, "alice@cr3.test", "Alice Owner");
  await resetAuthRateLimit();
  N = (await jsonRequest(app, "POST", "/nests", { name: "Quartermaster Ledger" }, root.apiKey)).data.nest.id;

  slack.users.set("U_ROOT", { id: "U_ROOT", team_id: "T1", email: root.email, name: "Root" });
  slack.users.set("UBOT", { id: "UBOT", team_id: "T1", name: "nest", is_bot: true });
  slack.convs.set("C_OPS", { info: { id: "C_OPS", name: "zephyr-ops", is_private: false, is_ext_shared: false }, members: ["U_ROOT", "UBOT"] });
  slack.botChannels = [
    { id: "C_OPS", name: "zephyr-ops", is_private: false, num_members: 2 },
    { id: "G_PRIV", name: "acme-renewal", is_private: true, num_members: 7 },
    { id: "C_EXT", name: "acme-shared", is_private: false, is_ext_shared: true, num_members: 9 },
  ];

  const created = await jsonRequest(app, "POST", "/surfaces/slack/installs", { home_nest_id: N }, root.apiKey);
  installId = created.data.install_id;
  await jsonRequest(app, "PUT", `/surfaces/slack/installs/${installId}/credentials`, { client_id: "cid", client_secret: "cs", signing_secret: SIGNING }, root.apiKey);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
  for (const k of ["FEATURE_WORKFLOW_PLANE", "FEATURE_METACOGNITION", "FEATURE_SURFACES", "SURFACES_BUFFER_KEY", "PUBLIC_BASE_URL", "SURFACES_ORG_NAME"]) delete process.env[k];
  await env?.cleanup();
});

describe("setup facts the wizard reads", () => {
  it("/health says whether Surfaces is on, so the Control room page can hide", async () => {
    const h = await (await app.request("/health")).json();
    expect(h.surfaces_enabled).toBe(true);
  });

  it("/surfaces/status carries org_name and slack_hosted for the setup copy", async () => {
    const r = await jsonRequest(app, "GET", "/surfaces/status", undefined, root.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.org_name).toBe("Larkspur");
    expect(r.data.slack_hosted).toBe(false);
    expect(r.data.installs.map((i: any) => i.id)).toContain(installId);
  });

  it("the channel list refuses an install that isn't active yet (409)", async () => {
    const r = await jsonRequest(app, "GET", `/surfaces/slack/installs/${installId}/channels`, undefined, root.apiKey);
    expect(r.status).toBe(409);
  });

  it("finishing OAuth in a browser links back to the setup wizard", async () => {
    const login = await app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: root.email, password: "testpass" }) });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const start = await app.request(`/surfaces/slack/installs/${installId}/oauth/start`, { headers: { Cookie: cookie } });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    slack.oauth = { ok: true, access_token: "xoxb-T1", token_type: "bot", bot_user_id: "UBOT", team: { id: "T1" }, enterprise: null, is_enterprise_install: false, authed_user: { id: "U_ROOT" } };
    const cb = await app.request(`/surfaces/slack/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(cb.status).toBe(200);
    const html = await cb.text();
    expect(html).toMatch(/Nest is connected/);
    expect(html).toMatch(/Continue setup to choose the channels Nest listens in\./);
    expect(html).toContain('<a href="/control-room?section=setup">Continue setup</a>');
  });
});

describe("GET /surfaces/slack/installs/:id/channels", () => {
  it("lists only the channels the bot is in, with privacy, Slack Connect and member counts — never DMs or archived ones", async () => {
    slack.botChannels.push({ id: "D_X", is_im: true }, { id: "C_OLD", name: "old", is_archived: true });
    const r = await jsonRequest(app, "GET", `/surfaces/slack/installs/${installId}/channels`, undefined, root.apiKey);
    slack.botChannels = slack.botChannels.filter((c) => c.id !== "D_X" && c.id !== "C_OLD");
    expect(r.status).toBe(200);
    expect(r.data.truncated).toBe(false);
    expect(r.data.channels).toEqual([
      { id: "G_PRIV", name: "acme-renewal", is_private: true, is_ext_shared: false, num_members: 7, binding: null },
      { id: "C_EXT", name: "acme-shared", is_private: false, is_ext_shared: true, num_members: 9, binding: null },
      { id: "C_OPS", name: "zephyr-ops", is_private: false, is_ext_shared: false, num_members: 2, binding: null },
    ]);
    const call = slack.calls.filter((c) => c.method === "users.conversations").pop()!;
    expect(call.params.types).toBe("public_channel,private_channel");
    expect(call.params.exclude_archived).toBe("true");
  });

  it("is server-admin only: a nest owner, a nest-scoped read key and no credential are refused", async () => {
    expect((await jsonRequest(app, "GET", `/surfaces/slack/installs/${installId}/channels`, undefined, alice.apiKey)).status).toBe(403);
    const ro = await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: N, capability: "read" }, root.apiKey);
    expect(ro.status).toBe(201);
    expect((await jsonRequest(app, "GET", `/surfaces/slack/installs/${installId}/channels`, undefined, ro.data.api_key)).status).toBe(403);
    expect((await app.request(`/surfaces/slack/installs/${installId}/channels`)).status).toBe(401);
  });

  it("answers 502 with Slack's code, not a crash, when Slack refuses", async () => {
    slack.conversationsError = "missing_scope";
    const r = await jsonRequest(app, "GET", `/surfaces/slack/installs/${installId}/channels`, undefined, root.apiKey);
    slack.conversationsError = null;
    expect(r.status).toBe(502);
    expect(r.data.error).toMatch(/missing_scope/);
  });

  it("stops after MAX_CHANNEL_PAGES pages and says the list is truncated (REST and MCP)", async () => {
    const { MAX_CHANNEL_PAGES } = await import("../src/surfaces/adapters/slack/channels.js");
    slack.conversationsMode = "endless";
    const before = slack.calls.filter((c) => c.method === "users.conversations").length;
    try {
      const r = await jsonRequest(app, "GET", `/surfaces/slack/installs/${installId}/channels`, undefined, root.apiKey);
      expect(r.status).toBe(200);
      expect(r.data.truncated).toBe(true);
      expect(r.data.channels.length).toBe(MAX_CHANNEL_PAGES);
      expect(slack.calls.filter((c) => c.method === "users.conversations").length - before).toBe(MAX_CHANNEL_PAGES);
      const out = await mcp(`/nests/${N}/mcp`, { name: "context_surfaces_slack_channels_list", arguments: { install_id: installId } }, root.apiKey);
      expect(out.result?.content?.[0]?.text ?? "").toMatch(/more channels than this list shows/);
    } finally {
      slack.conversationsMode = "normal";
    }
  });

  it("answers 429 with Retry-After, not a 500, when Slack rate-limits the list", async () => {
    slack.conversationsMode = "ratelimited";
    try {
      const res = await app.request(`/surfaces/slack/installs/${installId}/channels`, { headers: { Authorization: `Bearer ${root.apiKey}` } });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("17");
      expect((await res.json()).error).toMatch(/try again in 17 seconds/i);
    } finally {
      slack.conversationsMode = "normal";
    }
  });

  it("answers 409 (save the bot token), not a 500, when an active install has no usable bot token", async () => {
    const { getDb } = await import("../src/db/client.js");
    const other = (await jsonRequest(app, "POST", "/surfaces/slack/installs", { home_nest_id: N }, root.apiKey)).data.install_id;
    await getDb().run("UPDATE surface_installs SET status = 'active' WHERE id = ?", [other]);
    const r = await jsonRequest(app, "GET", `/surfaces/slack/installs/${other}/channels`, undefined, root.apiKey);
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/bot token/i);
    const out = await mcp(`/nests/${N}/mcp`, { name: "context_surfaces_slack_channels_list", arguments: { install_id: other } }, root.apiKey);
    expect(out.result?.isError).toBe(true);
    expect(out.result?.content?.[0]?.text ?? "").toMatch(/bot token/i);
    await getDb().run("UPDATE surface_installs SET status = 'disconnected' WHERE id = ?", [other]);
  });

  it("the MCP twin context_surfaces_slack_channels_list returns the same rows", async () => {
    const out = await mcp(`/nests/${N}/mcp`, { name: "context_surfaces_slack_channels_list", arguments: { install_id: installId } }, root.apiKey);
    const data = out.result?.structuredContent ?? JSON.parse(out.result?.content?.[1]?.text ?? "null");
    const text = out.result?.content?.[0]?.text ?? "";
    expect(out.result?.isError).not.toBe(true);
    expect(text).toMatch(/G_PRIV acme-renewal/);
    if (data?.channels) expect(data.channels.map((c: any) => c.id)).toEqual(["G_PRIV", "C_EXT", "C_OPS"]);
  });

  it("API.md documents the route and its MCP twin (AC-MCP-01 parity)", () => {
    const api = readFileSync(join(__dirname, "..", "API.md"), "utf8");
    expect(api).toContain("/surfaces/slack/installs/:id/channels");
    expect(api).toContain("context_surfaces_slack_channels_list");
    expect(api).toContain("GET /about/surfaces");
    // The OAuth callback's JSON `next` field is documented too.
    expect(api).toMatch(/oauth\/callback`[^\n]*`next`/);
  });
});

describe("binding a channel: the one notice links the member explainer", () => {
  it("the enable notice ends with a link to /about/surfaces, and the channel list shows the binding", async () => {
    const before = slack.posted.length;
    const b = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C_OPS", nest_id: N }, root.apiKey);
    expect(b.status).toBe(201);
    // The create response says whether the one notice went out.
    expect(b.data.notice).toBe("posted");
    const notices = slack.posted.slice(before).filter((p) => p.channel === "C_OPS");
    expect(notices.length).toBe(1);
    expect(notices[0].text).toMatch(/^Nest is now listening here/);
    expect(notices[0].text).toContain(`<${BASE}/about/surfaces|How Nest handles your messages>`);
    const list = await jsonRequest(app, "GET", `/surfaces/slack/installs/${installId}/channels`, undefined, root.apiKey);
    const ops = list.data.channels.find((c: any) => c.id === "C_OPS");
    expect(ops.binding).toEqual({ id: b.data.binding.id, nest_id: N, status: "active" });
  });

  it("with no PUBLIC_BASE_URL the notice has no link (nothing to point at)", async () => {
    const { enableNotice } = await import("../src/surfaces/services/notice-service.js");
    expect(enableNotice("Revenue", null, 24)).not.toMatch(/about\/surfaces/);
    expect(enableNotice("Revenue", "https://x.test/about/surfaces", 24)).toMatch(/<https:\/\/x\.test\/about\/surfaces\|How Nest handles your messages>$/);
    const { aboutSurfacesUrl } = await import("../src/surfaces/about-page.js");
    delete process.env.PUBLIC_BASE_URL;
    try {
      expect(aboutSurfacesUrl()).toBeNull();
    } finally {
      process.env.PUBLIC_BASE_URL = BASE;
    }
  });

  it("the notice states the server's own buffer TTL, the same number the member page shows", async () => {
    const { enableNotice } = await import("../src/surfaces/services/notice-service.js");
    expect(enableNotice("Revenue", null, 24)).toMatch(/messages are cleared within 24 hours/);
    expect(enableNotice("Revenue", null, 12)).toMatch(/messages are cleared within 12 hours/);
    await jsonRequest(app, "PATCH", "/surfaces/settings", { buffer_ttl_hours: 12, window_max_age_hours: 6 }, root.apiKey);
    try {
      slack.convs.set("C_TTL", { info: { id: "C_TTL", name: "ttl-room", is_private: false, is_ext_shared: false }, members: ["U_ROOT", "UBOT"] });
      const before = slack.posted.length;
      const b = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C_TTL", nest_id: N }, root.apiKey);
      expect(b.status).toBe(201);
      const notice = slack.posted.slice(before).find((p) => p.channel === "C_TTL");
      expect(notice?.text).toMatch(/messages are cleared within 12 hours/);
    } finally {
      await jsonRequest(app, "PATCH", "/surfaces/settings", { buffer_ttl_hours: 24 }, root.apiKey);
    }
  });
});

describe("the notice never states a default retention it can't confirm", () => {
  it("when the settings can't be read, no notice is posted (its claim is released, as when Slack refuses the post)", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { postEnableNotice } = await import("../src/surfaces/services/notice-service.js");
    slack.convs.set("C_NOSET", { info: { id: "C_NOSET", name: "noset-room", is_private: false, is_ext_shared: false }, members: ["U_ROOT", "UBOT"] });
    const b = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C_NOSET", nest_id: N }, root.apiKey);
    expect(b.status).toBe(201);
    // Reset the claim so the notice can be attempted again, then hide the settings table.
    await getDb().run("UPDATE surface_bindings SET notice_posted_at = NULL WHERE id = ?", [b.data.binding.id]);
    const before = slack.posted.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await getDb().run("ALTER TABLE surface_settings RENAME TO surface_settings_cr3_hidden");
    try {
      expect(await postEnableNotice(b.data.binding.id)).toBe("failed");
    } finally {
      await getDb().run("ALTER TABLE surface_settings_cr3_hidden RENAME TO surface_settings");
    }
    expect(slack.posted.slice(before).filter((p) => p.channel === "C_NOSET")).toEqual([]);
    expect(warn.mock.calls.some((a) => /enable notice not posted/.test(String(a[0])))).toBe(true);
    warn.mockRestore();
    const row = (await getDb().get("SELECT notice_posted_at FROM surface_bindings WHERE id = ?", [b.data.binding.id])) as { notice_posted_at: string | null };
    expect(row.notice_posted_at).toBeNull();
    // Once the settings read again, the notice goes out.
    expect(await postEnableNotice(b.data.binding.id)).toBe("posted");
    expect(await postEnableNotice(b.data.binding.id)).toBe("already_posted");
  });

  it("re-binding a channel whose notice already went out says already_posted, not a failure (REST and MCP)", async () => {
    slack.convs.set("C_AGAIN", { info: { id: "C_AGAIN", name: "again-room", is_private: false, is_ext_shared: false }, members: ["U_ROOT", "UBOT"] });
    const first = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C_AGAIN", nest_id: N }, root.apiKey);
    expect(first.data.notice).toBe("posted");
    expect((await jsonRequest(app, "DELETE", `/surfaces/bindings/${first.data.binding.id}`, undefined, root.apiKey)).status).toBeLessThan(300);
    const again = await jsonRequest(app, "POST", "/surfaces/bindings", { install_id: installId, conversation_id: "C_AGAIN", nest_id: N }, root.apiKey);
    expect(again.status).toBe(201);
    expect(again.data.notice).toBe("already_posted");
    await jsonRequest(app, "DELETE", `/surfaces/bindings/${again.data.binding.id}`, undefined, root.apiKey);
    const viaMcp = await mcp(`/nests/${N}/mcp`, { name: "context_surfaces_binding_create", arguments: { install_id: installId, conversation_id: "C_AGAIN" } }, root.apiKey);
    const text = viaMcp.result?.content?.[0]?.text ?? "";
    expect(viaMcp.result?.isError, text).not.toBe(true);
    expect(text).not.toMatch(/haven't been told/);
  });
});

describe("AC-CR-16: GET /about/surfaces", () => {
  it("AC-CR-16: an anonymous visitor gets the page with the never list and '@Nest skip me', and no nest, channel or user names", async () => {
    const res = await app.request("/about/surfaces");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const html = await res.text();
    expect(html).toContain("How Nest handles your messages");
    expect(html).toContain("@Nest skip me");
    for (const t of [
      "Read DMs between people, or channels it isn't in",
      "Import channel history",
      "Post recaps or summaries in the channel",
      "Propose pay, health, performance or personal matters",
      "Keep message text longer than 24 hours",
    ]) expect(html).toContain(t.replace("'", "&#39;"));
    // Server branding is allowed; nothing from a nest, a channel or a person.
    expect(html).toContain("Larkspur");
    for (const leak of ["Quartermaster", "zephyr-ops", "acme-renewal", "C_OPS", "root@cr3.test", "Root Admin", "Alice", N, installId]) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it("states the server's own settings (quiet window, text held) and mentions DMs only while DM capture is on", async () => {
    let html = await (await app.request("/about/surfaces")).text();
    expect(html).toContain("quiet for 20 minutes");
    expect(html).not.toMatch(/direct messages people start/);
    await jsonRequest(app, "PATCH", "/surfaces/settings", { quiet_minutes: 30, buffer_ttl_hours: 12, window_max_age_hours: 6, dm_capture: true }, root.apiKey);
    html = await (await app.request("/about/surfaces")).text();
    expect(html).toContain("quiet for 30 minutes");
    expect(html).toContain("deleted within 12 hours");
    expect(html).toContain("Keep message text longer than 12 hours");
    expect(html).toMatch(/direct messages people start with Nest themselves/);
    await jsonRequest(app, "PATCH", "/surfaces/settings", { quiet_minutes: 20, buffer_ttl_hours: 24, dm_capture: false }, root.apiKey);
  });

  it("is never cached publicly: a settings change shows on the next load, and an http:// logo isn't blocked by the CSP", async () => {
    const res = await app.request("/about/surfaces");
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toMatch(/no-cache/);
    expect(cc).not.toMatch(/public|max-age=[1-9]/);
    expect(res.headers.get("content-security-policy")).toMatch(/img-src https: http: data:/);
  });

  it("answers 503 with no-store, not default numbers, when the settings can't be read", async () => {
    const { getDb } = await import("../src/db/client.js");
    await getDb().run("ALTER TABLE surface_settings RENAME TO surface_settings_cr3_hidden");
    try {
      const res = await app.request("/about/surfaces");
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.text();
      expect(body).not.toMatch(/quiet for \d+ minutes/);
    } finally {
      await getDb().run("ALTER TABLE surface_settings_cr3_hidden RENAME TO surface_settings");
    }
    expect((await app.request("/about/surfaces")).status).toBe(200);
  });

  it("is rate-limited per client IP (public and unauthenticated), answering 429 with Retry-After", async () => {
    const { ABOUT_SURFACES_LIMIT } = await import("../src/surfaces/about-page.js");
    const from = (ip: string) => app.request("/about/surfaces", { headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < ABOUT_SURFACES_LIMIT.max; i++) expect((await from("203.0.113.7")).status).toBe(200);
    const limited = await from("203.0.113.7");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    // Another client is unaffected.
    expect((await from("203.0.113.8")).status).toBe(200);
  });

  it("escapes the org name it shows", async () => {
    const { renderAboutSurfaces } = await import("../src/surfaces/about-page.js");
    const { DEFAULT_SETTINGS } = await import("../src/surfaces/core/settings.js");
    const html = renderAboutSurfaces({ orgName: `<script>alert(1)</script>`, logoUrl: `https://x.test/l.png" onerror="x`, settings: DEFAULT_SETTINGS });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain(`" onerror="x`);
  });

  it("404s while Surfaces is off, like every other Surfaces route", async () => {
    process.env.FEATURE_SURFACES = "false";
    try {
      expect((await app.request("/about/surfaces")).status).toBe(404);
      expect((await (await app.request("/health")).json()).surfaces_enabled).toBe(false);
    } finally {
      process.env.FEATURE_SURFACES = "true";
    }
  });
});

describe("resuming the install step", () => {
  it("GET /surfaces/slack/installs/:id hands a manifest install its manifest again, with credentials as booleans only", async () => {
    const r = await jsonRequest(app, "GET", `/surfaces/slack/installs/${installId}`, undefined, root.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.install.credentials).toMatchObject({ client_id: true, client_secret: true, signing_secret: true });
    expect(JSON.stringify(r.data)).not.toContain(SIGNING);
    expect(JSON.stringify(r.data)).not.toContain("xoxb-T1");
    expect(r.data.manifest?.settings?.event_subscriptions?.request_url).toBe(`${BASE}/surfaces/slack/${installId}/events`);
  });
});
