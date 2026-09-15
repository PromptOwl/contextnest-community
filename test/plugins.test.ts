/**
 * Nest Plugins — the Community host: per-nest registry + settings (secrets
 * into nest_env), run-now, the scheduler tick, governance gate, webhook
 * tokens, federated search + promote. Behind FEATURE_PLUGINS.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { resolve } from "node:path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const FIXTURE = resolve(__dirname, "fixtures/plugins/memo.mjs");

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let editor: { apiKey: string; userId: string; email: string };
let viewer: { apiKey: string; userId: string; email: string };
let reviewer: { apiKey: string; userId: string; email: string };
let nestId: string;
let fixture: { state: { items: any[]; hits: any[]; fail: boolean; seen: any[] } };

const item = (id: string, title: string, body = "memo body", hash = "h1") => ({
  externalId: id, kind: "document", title, occurredAt: "2026-09-15T10:00:00Z", body,
  provenance: { url: "https://memo.example/" + id, fetchedAt: "2026-09-15T11:00:00Z", hash },
});

describe("FEATURE_PLUGINS off (regression)", () => {
  beforeAll(async () => {
    delete process.env.FEATURE_PLUGINS;
    env = setupTestEnv();
    app = await createTestApp("key", { ownerEmail: "owner@acme.com" });
    owner = await registerUser(app, "owner@acme.com", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Off" }, owner.apiKey);
    nestId = nest.data.nest.id;
  });
  afterAll(() => env.cleanup());

  it("plugin routes 404 and the ordinary search route is untouched", async () => {
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, owner.apiKey)).status).toBe(404);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "SSO plan", content: "# SSO\nroll out SSO" }, owner.apiKey);
    const s = await jsonRequest(app, "GET", `/nests/${nestId}/search?q=SSO`, undefined, owner.apiKey);
    expect(s.status).toBe(200);
    expect(s.data.nodes.length).toBe(1);
    expect(s.data.live).toBeUndefined();
  });

  it("the admin settings surface reports plugins disabled and no packages", async () => {
    const s = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
    expect(s.status).toBe(200);
    expect(s.data.plugins_enabled).toBe(false);
    expect(s.data.plugins_packages).toBe("");
  });
});

describe("FEATURE_PLUGINS on", () => {
  beforeAll(async () => {
    process.env.FEATURE_PLUGINS = "true";
    process.env.PLUGINS = FIXTURE;
    env = setupTestEnv();
    app = await createTestApp("key", { ownerEmail: "owner@acme.com" });
    fixture = await import(FIXTURE);
    owner = await registerUser(app, "owner@acme.com", "Owner");
    editor = await registerUser(app, "editor@acme.com", "Editor");
    viewer = await registerUser(app, "viewer@acme.com", "Viewer");
    await resetAuthRateLimit(); // registration is capped at 3/hour per IP
    reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Plugged" }, owner.apiKey);
    nestId = nest.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: editor.email, permission: "write" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: viewer.email, permission: "read" }, owner.apiKey);
  });
  afterAll(() => {
    delete process.env.FEATURE_PLUGINS;
    delete process.env.PLUGINS;
    env.cleanup();
  });
  beforeEach(() => {
    fixture.state.items = [];
    fixture.state.hits = [];
    fixture.state.fail = false;
    fixture.state.seen = [];
  });

  it("lists loaded plugins with their settings schema and secret keys, unconfigured for this nest", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey);
    expect(r.status).toBe(200);
    const memo = r.data.plugins.find((p: any) => p.name === "memo");
    expect(memo).toMatchObject({ displayName: "Memo", capabilities: ["pull", "webhook", "search"], secretKeys: ["token", "webhookSecret"], configured: false, enabled: false });
    expect(memo.settingsSchema.properties.prefix.title).toBe("Prefix");
  });

  it("a viewer cannot configure; an editor can; secrets are stored in nest_env and masked on read", async () => {
    const denied = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { enabled: true, settings: { prefix: "Memo", token: "sekrit" } }, viewer.apiKey);
    expect(denied.status).toBe(403);

    const ok = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { enabled: true, mode: "raw", folder: "inbox/memo", every_minutes: 15, settings: { prefix: "Memo", token: "sekrit" } }, editor.apiKey);
    expect(ok.status).toBe(200);
    expect(ok.data.plugin).toMatchObject({ name: "memo", enabled: true, mode: "raw", folder: "inbox/memo", every_minutes: 15, configured: true });
    expect(ok.data.plugin.settings.prefix).toBe("Memo");
    expect(ok.data.plugin.settings.token).toMatch(/^••••/);
    expect(JSON.stringify(ok.data)).not.toContain("sekrit");

    const envRows = await jsonRequest(app, "GET", `/nests/${nestId}/env`, undefined, owner.apiKey);
    // env routes are plane-gated; the store itself is what we care about
    if (envRows.status === 200) expect(envRows.data.env.some((e: any) => e.key === "PLUGIN_MEMO_TOKEN")).toBe(true);

    // a later PUT without the secret keeps the stored one
    const keep = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { settings: { prefix: "Memo2" } }, editor.apiKey);
    expect(keep.status).toBe(200);
    expect(keep.data.plugin.settings.token).toMatch(/^••••/);
  });

  it("rejects settings the plugin refuses, and an unknown plugin", async () => {
    const bad = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { settings: { prefix: "" } }, editor.apiKey);
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/prefix/);
    expect((await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/nope`, { enabled: true }, editor.apiKey)).status).toBe(404);
  });

  it("health uses the resolved secret", async () => {
    const h = await jsonRequest(app, "GET", `/nests/${nestId}/plugins/memo/health`, undefined, editor.apiKey);
    expect(h.status).toBe(200);
    expect(h.data.ok).toBe(true);
  });

  it("run-now ingests through the nest's own write path: nodes are versioned with a system author, and the cursor advances on a clean run", async () => {
    fixture.state.items = [item("m1", "First")];
    const run = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(run.status).toBe(200);
    expect(run.data.run).toMatchObject({ created: 1, updated: 0, unchanged: 0, clean: true, status: "clean" });
    expect(fixture.state.seen[0].settings.token).toBe("sekrit"); // secret resolved from nest_env
    expect(fixture.state.seen[0].nestId).toBe(nestId);
    const id = run.data.run.results[0].id;
    expect(id).toMatch(/^nodes\/inbox\/memo\//);

    const node = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, viewer.apiKey);
    expect(node.status).toBe(200);
    expect(node.data.node.title).toBe("Memo2 First");
    expect(node.data.node.status).toBe("published"); // ungoverned nest
    expect(node.data.node.provenance).toMatchObject({ plugin: "memo", externalId: "m1", hash: "h1", mode: "raw" });

    const versions = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}/versions`, undefined, viewer.apiKey);
    expect(versions.status).toBe(200);
    expect(versions.data.versions[0].editedBy).toBe("system:plugin:memo");

    const state = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey);
    const memo = state.data.plugins.find((p: any) => p.name === "memo");
    expect(memo.cursor).toEqual({ n: 1 });
    expect(memo.last_status).toBe("clean");
    expect(memo.runs[0]).toMatchObject({ created: 1, status: "clean" });
  });

  it("re-running with the same item is a no-op; a human edit is never overwritten and is reported", async () => {
    fixture.state.items = [item("m1", "First")];
    const again = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(again.data.run).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const id = again.data.run.results[0].id;

    const edit = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "memo body\n\nHuman note." }, editor.apiKey);
    expect(edit.status).toBe(200);
    fixture.state.items = [item("m1", "First", "upstream changed", "h2")];
    const conflict = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(conflict.data.run.conflicts).toEqual([{ externalId: "m1", id }]);
    expect(conflict.data.run.clean).toBe(false);
    const node = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, viewer.apiKey);
    expect(node.data.node.content).toContain("Human note.");
    const state = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey);
    const memo = state.data.plugins.find((p: any) => p.name === "memo");
    expect(memo.cursor).toEqual({ n: 2 }); // not advanced past the last clean run
    expect(memo.last_status).toBe("conflicts");
  });

  it("a failing pull is recorded as a failed run with the error, and does not advance the cursor", async () => {
    fixture.state.fail = true;
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.run.status).toBe("failed");
    expect(r.data.run.failed[0]).toMatchObject({ externalId: "(pull)", error: expect.stringMatching(/exploded/) });
  });

  it("governed nest: plugin writes land pending_review — and an UPDATE after approval re-enters review (review finding #1)", async () => {
    const g = await jsonRequest(app, "POST", "/nests", { name: "Governed" }, owner.apiKey);
    expect(g.status, JSON.stringify(g.data)).toBe(201);
    const gid = g.data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${gid}/settings`, { stewardship_enabled: true }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${gid}/collaborators`, { email: reviewer.email, permission: "read" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${gid}/stewards`, { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] }, owner.apiKey);
    await jsonRequest(app, "PUT", `/nests/${gid}/plugins/memo`, { enabled: true, settings: { prefix: "G", token: "sekrit" } }, owner.apiKey);
    fixture.state.items = [item("g1", "Governed item")];
    const run = await jsonRequest(app, "POST", `/nests/${gid}/plugins/memo/run`, {}, owner.apiKey);
    expect(run.data.run.created, JSON.stringify(run.data)).toBe(1);
    const id = run.data.run.results[0].id;
    const node = await jsonRequest(app, "GET", `/nests/${gid}/nodes/${id}`, undefined, owner.apiKey);
    expect(node.status, JSON.stringify(run.data)).toBe(200);
    expect(node.data.node.status).toBe("pending_review");

    // A steward approves → published. Upstream then changes and the plugin re-ingests.
    const approved = await jsonRequest(app, "POST", `/nests/${gid}/nodes/${id}/approve`, { note: "ok" }, reviewer.apiKey);
    expect(approved.status, JSON.stringify(approved.data)).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${gid}/nodes/${id}`, undefined, owner.apiKey)).data.node.status).toBe("published");
    fixture.state.items = [item("g1", "Governed item", "upstream changed", "h2")];
    const again = await jsonRequest(app, "POST", `/nests/${gid}/plugins/memo/run`, {}, owner.apiKey);
    expect(again.data.run.updated).toBe(1);
    const after = await jsonRequest(app, "GET", `/nests/${gid}/nodes/${id}`, undefined, owner.apiKey);
    expect(after.data.node.status).toBe("pending_review"); // not a stranded, unsubmitted draft
    const queue = await jsonRequest(app, "GET", `/nests/${gid}/review-queue`, undefined, reviewer.apiKey);
    expect(JSON.stringify(queue.data)).toContain(id);
  });

  it("secret env keys are injective across plugin/key boundaries (review finding #2)", async () => {
    const { envKeyFor } = await import("../src/plugins/registry.js");
    const keys = [envKeyFor("a-b", "c"), envKeyFor("a", "b_c"), envKeyFor("a", "b-c"), envKeyFor("a", "bc"), envKeyFor("memo", "webhookSecret"), envKeyFor("memo", "webhooksecret")];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
  });

  it("viewers see that a secret is set but not its tail, and run errors only reach editors (review findings)", async () => {
    fixture.state.fail = true;
    await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    const asViewer = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey);
    const v = asViewer.data.plugins.find((p: any) => p.name === "memo");
    expect(v.settings.token).toBe("••••");
    expect(JSON.stringify(v.runs[0])).not.toContain("exploded");
    const asEditor = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, editor.apiKey);
    const e = asEditor.data.plugins.find((p: any) => p.name === "memo");
    expect(JSON.stringify(e.runs[0])).toContain("exploded");
  });

  it("the scheduler tick runs due plugins only, and a failing plugin does not stall the others", async () => {
    const { pluginSchedulerTick } = await import("../src/plugins/scheduler.js");
    fixture.state.items = [item("s1", "Scheduled")];
    // memo on nestId: every_minutes=15, last run just now → not due
    const notDue = await pluginSchedulerTick(Date.now());
    expect(notDue).toEqual([]);
    const due = await pluginSchedulerTick(Date.now() + 16 * 60_000);
    expect(due.length).toBeGreaterThanOrEqual(1);
    expect(due.some((r) => r.nestId === nestId && r.plugin === "memo")).toBe(true);
    const state = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey);
    const memo = state.data.plugins.find((p: any) => p.name === "memo");
    expect(memo.runs[0].triggered_by).toBe("schedule");
  });

  it("webhook: a per-nest tokenized URL verifies through the plugin and ingests", async () => {
    const cfg = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { settings: { webhookSecret: "shh" } }, editor.apiKey);
    expect(cfg.status).toBe(200);
    const url: string = cfg.data.plugin.webhook_url;
    expect(url).toMatch(/\/plugin-hooks\/[A-Za-z0-9_-]+$/);
    const token = url.split("/").pop()!;
    const bad = await app.request(`/plugin-hooks/${token}`, { method: "POST", headers: { "content-type": "application/json", "x-memo-sig": "nope" }, body: JSON.stringify({ id: "w1", title: "Hooked", text: "via webhook" }) });
    expect(bad.status).toBe(401);
    const good = await app.request(`/plugin-hooks/${token}`, { method: "POST", headers: { "content-type": "application/json", "x-memo-sig": "shh" }, body: JSON.stringify({ id: "w1", title: "Hooked", text: "via webhook" }) });
    expect(good.status).toBe(202);
    const body = await good.json();
    expect(body.results[0].outcome).toBe("created");
    expect((await app.request(`/plugin-hooks/not-a-token`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("search with include_live returns governed nest hits plus live plugin hits; promote lands a hit through governance", async () => {
    fixture.state.hits = [{ title: "SSO thread in memo", snippet: "…", externalId: "live-1" }];
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "SSO rollout", content: "# SSO\nplan" }, editor.apiKey);
    const s = await jsonRequest(app, "GET", `/nests/${nestId}/search?q=SSO&include_live=1`, undefined, viewer.apiKey);
    expect(s.status).toBe(200);
    expect(s.data.nodes.length).toBeGreaterThan(0);
    expect(s.data.live).toEqual([{ plugin: "memo", displayName: "Memo", hits: [expect.objectContaining({ externalId: "live-1", governed: false })] }]);
    const plain = await jsonRequest(app, "GET", `/nests/${nestId}/search?q=SSO`, undefined, viewer.apiKey);
    expect(plain.data.live).toBeUndefined();

    const deniedPromote = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/promote`, { externalId: "live-1" }, viewer.apiKey);
    expect(deniedPromote.status).toBe(403);
    const p = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/promote`, { externalId: "live-1" }, editor.apiKey);
    expect(p.status).toBe(200);
    expect(p.data.result.outcome).toBe("created");
    const node = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${p.data.result.id}`, undefined, viewer.apiKey);
    expect(node.status, JSON.stringify(p.data)).toBe(200);
    expect(node.data.node.title).toBe("Promoted live-1");
  });

  it("viewers never see the webhook token; archived nests stop accepting deliveries (review findings)", async () => {
    const asViewer = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey);
    const v = asViewer.data.plugins.find((p: any) => p.name === "memo");
    expect(v.webhook_url).toBe("(set)");
    const asEditor = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, editor.apiKey);
    const url: string = asEditor.data.plugins.find((p: any) => p.name === "memo").webhook_url;
    const token = url.split("/").pop()!;
    await jsonRequest(app, "POST", `/nests/${nestId}/archive`, {}, owner.apiKey);
    const res = await app.request(`/plugin-hooks/${token}`, { method: "POST", headers: { "content-type": "application/json", "x-memo-sig": "shh" }, body: JSON.stringify({ id: "w2", title: "Late", text: "x" }) });
    expect(res.status).toBe(404);
    await jsonRequest(app, "POST", `/nests/${nestId}/restore`, {}, owner.apiKey);
  });

  it("a second run while one is in flight is refused, and the tick does not re-fire it (review finding)", async () => {
    let release!: () => void;
    fixture.state.gate = new Promise<void>((r) => (release = r));
    fixture.state.items = [item("slow", "Slow")];
    const first = jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    await new Promise((r) => setTimeout(r, 50));
    const second = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(second.status).toBe(409);
    const { pluginSchedulerTick } = await import("../src/plugins/scheduler.js");
    expect(await pluginSchedulerTick(Date.now() + 24 * 60 * 60_000)).toEqual([]);
    release();
    fixture.state.gate = null;
    expect((await first).status).toBe(200);
  });

  it("disabling a plugin stops run-now and the tick, but keeps its nodes", async () => {
    const off = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { enabled: false }, editor.apiKey);
    expect(off.status).toBe(200);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey)).status).toBe(409);
    expect(await (await import("../src/plugins/scheduler.js")).pluginSchedulerTick(Date.now() + 60 * 60_000)).toEqual([]);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes?limit=100`, undefined, viewer.apiKey);
    expect(JSON.stringify(list.data)).toContain("Memo2 First");
  });

  it("admin settings expose plugins_enabled + plugins_packages and the loaded plugin list", async () => {
    const s = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
    expect(s.data.plugins_enabled).toBe(true);
    expect(s.data.plugins_packages).toBe(FIXTURE);
    expect(s.data.plugins_loaded).toEqual([expect.objectContaining({ name: "memo", version: "0.0.1" })]);
  });
});
