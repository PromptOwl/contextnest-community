/**
 * Nest Plugins, Slice A (CU-wdqcq05raz; parent CU-wdqcq024u0) — the Community
 * host: per-nest registry, settings with secrets in the nest env store, run-now
 * through a governed writer that acts as the plugin's own system identity, and
 * MCP at REST parity. Behind FEATURE_PLUGINS.
 *
 * Out of scope here (own tickets): schedules + webhooks (Slice B), live search,
 * promote and OAuth (Slice C).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const FIXTURE = resolve(__dirname, "fixtures/plugins/memo.mjs");
type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let editor: User;
let viewer: User;
let nestId: string;
let fixture: { state: { items: any[]; fail: boolean; seen: any[]; gate: Promise<void> | null } };

const item = (id: string, title: string, body = "memo body", hash = "h1") => ({
  externalId: id,
  kind: "document",
  title,
  occurredAt: "2026-09-15T10:00:00Z",
  body,
  provenance: { url: "https://memo.example/" + id, fetchedAt: "2026-09-15T11:00:00Z", hash },
});

async function mcp(nest: string, method: string, params: Record<string, unknown>, key: string): Promise<any> {
  const res = await app.request(`/nests/${nest}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const line = (await res.text()).split("\n").find((l: string) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : null;
}
const toolNames = async (nest: string, key: string): Promise<string[]> =>
  ((await mcp(nest, "tools/list", {}, key))?.result?.tools ?? []).map((t: any) => t.name);
const callTool = async (nest: string, name: string, args: Record<string, unknown>, key: string) => {
  const body = await mcp(nest, "tools/call", { name, arguments: args }, key);
  const r = body?.result ?? {};
  return {
    isError: !!r.isError || !!body?.error,
    text: (r.content ?? []).map((c: any) => c.text).join("") || body?.error?.message || "",
    data: r.structuredContent,
  };
};

describe("FEATURE_PLUGINS off (regression)", () => {
  beforeAll(async () => {
    delete process.env.FEATURE_PLUGINS;
    delete process.env.PLUGINS;
    env = setupTestEnv();
    app = await createTestApp("key", { ownerEmail: "owner@acme.com" });
    owner = await registerUser(app, "owner@acme.com", "Owner");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Off" }, owner.apiKey)).data.nest.id;
  });
  afterAll(() => env.cleanup());

  it("plugin routes 404 and MCP does not advertise the plugin tools", async () => {
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, owner.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, owner.apiKey)).status).toBe(404);
    const names = await toolNames(nestId, owner.apiKey);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => n.startsWith("context_plugin"))).toEqual([]);
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
    await resetAuthRateLimit(); // registration is capped per IP
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Plugged" }, owner.apiKey)).data.nest.id;
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
    fixture.state.fail = false;
    fixture.state.seen = [];
    fixture.state.gate = null;
  });

  it("lists loaded plugins with their settings schema and secret keys, unconfigured for this nest", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey);
    expect(r.status).toBe(200);
    const memo = r.data.plugins.find((p: any) => p.name === "memo");
    expect(memo).toMatchObject({ displayName: "Memo", capabilities: ["pull"], secretKeys: ["token"], configured: false, enabled: false, system: null });
    expect(memo.settingsSchema.properties.prefix.title).toBe("Prefix");
  });

  it("only a nest owner/admin configures; secrets go to the nest env store encrypted and come back masked", async () => {
    const asViewer = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { enabled: true, settings: { prefix: "Memo", token: "sekrit" } }, viewer.apiKey);
    expect(asViewer.status).toBe(403);
    const asEditor = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { enabled: true, settings: { prefix: "Memo", token: "sekrit" } }, editor.apiKey);
    expect(asEditor.status).toBe(403);

    const ok = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { enabled: true, mode: "raw", folder: "inbox/memo", settings: { prefix: "Memo", token: "sekrit" } }, owner.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.plugin).toMatchObject({ name: "memo", enabled: true, mode: "raw", folder: "inbox/memo", configured: true });
    expect(ok.data.plugin.settings).toEqual({ prefix: "Memo", token: "••••" });
    expect(JSON.stringify(ok.data)).not.toContain("sekrit");

    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get("SELECT key, value FROM nest_env WHERE nest_id = ? AND key = ?", [nestId, "PLUGIN__MEMO__TOKEN"])) as any;
    expect(row).toBeTruthy();
    expect(row.value).toMatch(/^enc\.v1\./); // shared/secret-box, never plaintext
    const plugRow = (await getDb().get("SELECT settings_json FROM nest_plugins WHERE nest_id = ? AND plugin = 'memo'", [nestId])) as any;
    expect(plugRow.settings_json).not.toContain("sekrit");

    // A later save without the secret keeps it.
    const keep = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { settings: { prefix: "Memo2" } }, owner.apiKey);
    expect(keep.status).toBe(200);
    expect(keep.data.plugin.settings.token).toBe("••••");
  });

  it("enabling provisions the plugin's own system identity: a write collaborator on this nest only", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, owner.apiKey);
    const memo = r.data.plugins.find((p: any) => p.name === "memo");
    expect(memo.system).toMatchObject({ name: "Plugin: Memo", capability: "write" });
    expect(memo.system.email).toMatch(/@system\.contextnest\.invalid$/);
    const systems = await jsonRequest(app, "GET", `/nests/${nestId}/systems`, undefined, owner.apiKey);
    expect(systems.status, JSON.stringify(systems.data)).toBe(200);
    expect(systems.data.systems.map((s: any) => s.id)).toContain(memo.system.id);
  });

  it("plugin secrets are kept out of the workflow runner's env bundle", async () => {
    const { envValues, storedEnvValues } = await import("../src/workflow/env-routes.js");
    expect(Object.keys(await envValues(nestId))).not.toContain("PLUGIN__MEMO__TOKEN");
    expect(Object.keys(await storedEnvValues(nestId))).not.toContain("PLUGIN__MEMO__TOKEN");
  });

  it("the /env route lists plugin secrets masked but cannot overwrite or delete them", async () => {
    process.env.FEATURE_WORKFLOW_PLANE = "true";
    try {
      const list = await jsonRequest(app, "GET", `/nests/${nestId}/env`, undefined, owner.apiKey);
      expect(list.status).toBe(200);
      expect(list.data.env.find((e: any) => e.key === "PLUGIN__MEMO__TOKEN")?.value_masked).toMatch(/^••••/);
      expect(JSON.stringify(list.data)).not.toContain("sekrit");
      const put = await jsonRequest(app, "PUT", `/nests/${nestId}/env`, { key: "PLUGIN__MEMO__TOKEN", value: "hijack" }, editor.apiKey);
      expect(put.status).toBe(400);
      const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/env/PLUGIN__MEMO__TOKEN`, undefined, owner.apiKey);
      expect(del.status).toBe(400);
    } finally {
      delete process.env.FEATURE_WORKFLOW_PLANE;
    }
  });

  it("rejects settings the plugin refuses, settings it doesn't declare, and an unknown plugin", async () => {
    const bad = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { settings: { prefix: "" } }, owner.apiKey);
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/prefix/);
    const unknown = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { settings: { nope: 1 } }, owner.apiKey);
    expect(unknown.status).toBe(400);
    expect(unknown.data.error).toMatch(/nope/);
    expect((await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/missing`, { enabled: true }, owner.apiKey)).status).toBe(404);
  });

  it("health resolves the stored secret", async () => {
    const h = await jsonRequest(app, "GET", `/nests/${nestId}/plugins/memo/health`, undefined, editor.apiKey);
    expect(h.status).toBe(200);
    expect(h.data.ok).toBe(true);
  });

  it("run-now (editor) ingests through the nest's write path as the plugin's system identity; cursor advances on a clean run", async () => {
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, viewer.apiKey)).status).toBe(403);
    fixture.state.items = [item("m1", "First")];
    const run = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(run.status, JSON.stringify(run.data)).toBe(200);
    expect(run.data.run).toMatchObject({ created: 1, updated: 0, unchanged: 0, clean: true, status: "clean", triggered_by: `manual:${editor.email}` });
    expect(fixture.state.seen[0].settings.token).toBe("sekrit");
    const id = run.data.run.results[0].id;
    expect(id).toMatch(/^nodes\/inbox\/memo\//);

    const node = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, viewer.apiKey);
    expect(node.status).toBe(200);
    expect(node.data.node.title).toBe("Memo2 First");
    expect(node.data.node.status).toBe("published"); // ungoverned nest
    expect(node.data.node.provenance).toMatchObject({ plugin: "memo", externalId: "m1", hash: "h1", mode: "raw" });

    const sys = (await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, owner.apiKey)).data.plugins.find((p: any) => p.name === "memo").system;
    const versions = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}/versions`, undefined, viewer.apiKey);
    expect(versions.status).toBe(200);
    expect(versions.data.versions[0].editedBy).toBe(sys.email); // the system, never the human who clicked Run

    const state = (await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey)).data.plugins.find((p: any) => p.name === "memo");
    expect(state.cursor).toEqual({ n: 1 });
    expect(state.last_status).toBe("clean");
    const runs = await jsonRequest(app, "GET", `/nests/${nestId}/plugins/memo/runs`, undefined, viewer.apiKey);
    expect(runs.data.runs[0]).toMatchObject({ created: 1, status: "clean" });
  });

  it("re-running the same item is a no-op; a human edit is never overwritten and is reported", async () => {
    fixture.state.items = [item("m1", "First")];
    const again = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(again.data.run).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const id = again.data.run.results[0].id;
    expect((await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "memo body\n\nHuman note." }, editor.apiKey)).status).toBe(200);
    fixture.state.items = [item("m1", "First", "upstream changed", "h2")];
    const conflict = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(conflict.data.run.conflicts).toEqual([{ externalId: "m1", id }]);
    expect(conflict.data.run.clean).toBe(false);
    const node = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, viewer.apiKey);
    expect(node.data.node.content).toContain("Human note.");
    const memo = (await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey)).data.plugins.find((p: any) => p.name === "memo");
    expect(memo.cursor).toEqual({ n: 2 });
    expect(memo.last_status).toBe("conflicts");
  });

  it("a failing pull is a failed run; the error text reaches editors, never viewers", async () => {
    fixture.state.fail = true;
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.run.status).toBe("failed");
    const v = await jsonRequest(app, "GET", `/nests/${nestId}/plugins/memo/runs`, undefined, viewer.apiKey);
    expect(v.data.runs[0].status).toBe("failed");
    expect(JSON.stringify(v.data.runs[0])).not.toContain("exploded");
    const e = await jsonRequest(app, "GET", `/nests/${nestId}/plugins/memo/runs`, undefined, editor.apiKey);
    expect(JSON.stringify(e.data.runs[0])).toContain("exploded");
  });

  it("governed nest: plugin writes land pending_review, authored by the system — and an update after approval re-enters review", async () => {
    const gid = (await jsonRequest(app, "POST", "/nests", { name: "Governed" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${gid}/settings`, { stewardship_enabled: true }, owner.apiKey);
    const nestPath = join(env.dataDir, "nests", gid);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(join(nestPath, "stewards.yaml"), `version: 1\nnest:\n  - email: ${owner.email}, role: reviewer, can_approve: true\n`);
    await jsonRequest(app, "POST", `/nests/${gid}/stewards/sync`, {}, owner.apiKey);
    const cfg = await jsonRequest(app, "PUT", `/nests/${gid}/plugins/memo`, { enabled: true, settings: { prefix: "G", token: "sekrit" } }, owner.apiKey);
    expect(cfg.status, JSON.stringify(cfg.data)).toBe(200);

    fixture.state.items = [item("g1", "Governed item")];
    const run = await jsonRequest(app, "POST", `/nests/${gid}/plugins/memo/run`, {}, owner.apiKey);
    expect(run.data.run.created, JSON.stringify(run.data)).toBe(1);
    const id = run.data.run.results[0].id;
    const node = await jsonRequest(app, "GET", `/nests/${gid}/nodes/${id}`, undefined, owner.apiKey);
    expect(node.data.node.status).toBe("pending_review"); // not self-approved on the owner's say-so

    const approved = await jsonRequest(app, "POST", `/nests/${gid}/nodes/${id}/approve`, { note: "ok" }, owner.apiKey);
    expect(approved.status, JSON.stringify(approved.data)).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${gid}/nodes/${id}`, undefined, owner.apiKey)).data.node.status).toBe("published");
    fixture.state.items = [item("g1", "Governed item", "upstream changed", "h2")];
    const again = await jsonRequest(app, "POST", `/nests/${gid}/plugins/memo/run`, {}, owner.apiKey);
    expect(again.data.run.updated, JSON.stringify(again.data)).toBe(1);
    expect((await jsonRequest(app, "GET", `/nests/${gid}/nodes/${id}`, undefined, owner.apiKey)).data.node.status).toBe("pending_review");
    const queue = await jsonRequest(app, "GET", `/nests/${gid}/review-queue`, undefined, owner.apiKey);
    expect(JSON.stringify(queue.data)).toContain(id);
  });

  it("enforced structure rules apply to plugin writes: a refused item fails naming the rule, and nothing lands", async () => {
    const sid = (await jsonRequest(app, "POST", "/nests", { name: "Structured" }, owner.apiKey)).data.nest.id;
    const rules = { structure: { enforce: true, closed: true }, folders: { "clients/{client}": { types: ["document"] } } };
    const saved = await jsonRequest(app, "PUT", `/nests/${sid}/structure`, rules, owner.apiKey);
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    await jsonRequest(app, "PUT", `/nests/${sid}/plugins/memo`, { enabled: true, settings: { prefix: "S", token: "sekrit" } }, owner.apiKey);
    fixture.state.items = [item("s1", "Structured item")];
    const run = await jsonRequest(app, "POST", `/nests/${sid}/plugins/memo/run`, {}, owner.apiKey);
    expect(run.status).toBe(200);
    expect(run.data.run.created).toBe(0);
    expect(run.data.run.failed).toEqual([{ externalId: "s1", error: expect.stringMatching(/not an allowed folder/) }]);
    expect(existsSync(join(env.dataDir, "nests", sid, "nodes", "inbox"))).toBe(false);
  });

  it("a revoked system identity stops the plugin; re-enabling provisions a new one", async () => {
    const rid = (await jsonRequest(app, "POST", "/nests", { name: "Revoked" }, owner.apiKey)).data.nest.id;
    const cfg = await jsonRequest(app, "PUT", `/nests/${rid}/plugins/memo`, { enabled: true, settings: { prefix: "R", token: "sekrit" } }, owner.apiKey);
    const sysId = cfg.data.plugin.system.id;
    expect((await jsonRequest(app, "DELETE", `/systems/${sysId}`, undefined, owner.apiKey)).status).toBe(200);
    fixture.state.items = [item("r1", "Revoked item")];
    const run = await jsonRequest(app, "POST", `/nests/${rid}/plugins/memo/run`, {}, owner.apiKey);
    expect(run.status).toBe(409);
    expect(run.data.error).toMatch(/system/i);
    const again = await jsonRequest(app, "PUT", `/nests/${rid}/plugins/memo`, { enabled: true }, owner.apiKey);
    expect(again.data.plugin.system.id).not.toBe(sysId);
    expect((await jsonRequest(app, "POST", `/nests/${rid}/plugins/memo/run`, {}, owner.apiKey)).data.run.created).toBe(1);
  });

  it("a second run while one is in flight is refused", async () => {
    let release!: () => void;
    fixture.state.gate = new Promise<void>((r) => (release = r));
    fixture.state.items = [item("slow", "Slow")];
    const first = jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    await new Promise((r) => setTimeout(r, 50));
    const second = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey);
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  describe("MCP parity", () => {
    it("context_plugins lists what REST lists, at the viewer tier", async () => {
      const rest = (await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey)).data.plugins;
      const r = await callTool(nestId, "context_plugins", {}, viewer.apiKey);
      expect(r.isError, r.text).toBe(false);
      expect(r.data.plugins.map((p: any) => [p.name, p.enabled, p.settings])).toEqual(rest.map((p: any) => [p.name, p.enabled, p.settings]));
      const runs = await callTool(nestId, "context_plugins", { action: "runs", plugin: "memo" }, viewer.apiKey);
      expect(runs.data.runs.length).toBeGreaterThan(0);
      expect(JSON.stringify(runs.data)).not.toContain("exploded");
    });

    it("context_plugin_run runs for an editor and is refused for a viewer", async () => {
      fixture.state.items = [item("mcp1", "Via MCP")];
      const denied = await callTool(nestId, "context_plugin_run", { plugin: "memo" }, viewer.apiKey);
      expect(denied.isError).toBe(true);
      const r = await callTool(nestId, "context_plugin_run", { plugin: "memo" }, editor.apiKey);
      expect(r.isError, r.text).toBe(false);
      expect(r.data.run).toMatchObject({ created: 1, status: "clean" });
    });

    it("context_plugin_configure is advertised only to nest admins and saves exactly what PUT saves", async () => {
      expect(await toolNames(nestId, editor.apiKey)).not.toContain("context_plugin_configure");
      expect(await toolNames(nestId, owner.apiKey)).toContain("context_plugin_configure");
      const refused = await callTool(nestId, "context_plugin_configure", { action: "configure", plugin: "memo", settings: { prefix: "X" } }, editor.apiKey);
      expect(refused.isError).toBe(true);
      const r = await callTool(nestId, "context_plugin_configure", { action: "configure", plugin: "memo", settings: { prefix: "ViaMcp" }, mode: "raw" }, owner.apiKey);
      expect(r.isError, r.text).toBe(false);
      expect(r.data.plugin.settings).toEqual({ prefix: "ViaMcp", token: "••••" });
      const rest = (await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, owner.apiKey)).data.plugins.find((p: any) => p.name === "memo");
      expect(rest.settings.prefix).toBe("ViaMcp");
    });

    it("a read-only key may list but not run", async () => {
      const ro = (await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: nestId, capability: "read" }, editor.apiKey)).data.api_key;
      const names = await toolNames(nestId, ro);
      expect(names).toContain("context_plugins");
      expect(names).not.toContain("context_plugin_run");
      expect((await callTool(nestId, "context_plugin_run", { plugin: "memo" }, ro)).isError).toBe(true);
    });
  });

  it("disabling stops run-now but keeps nodes; removing forgets config, secrets and the system identity", async () => {
    const off = await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/memo`, { enabled: false }, owner.apiKey);
    expect(off.status).toBe(200);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/plugins/memo/run`, {}, editor.apiKey)).status).toBe(409);
    const sysId = off.data.plugin.system.id;

    expect((await jsonRequest(app, "DELETE", `/nests/${nestId}/plugins/memo`, undefined, editor.apiKey)).status).toBe(403);
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/plugins/memo`, undefined, owner.apiKey);
    expect(del.status).toBe(200);
    const { getDb } = await import("../src/db/client.js");
    expect(await getDb().get("SELECT 1 AS hit FROM nest_env WHERE nest_id = ? AND key LIKE 'PLUGIN\\_\\_%' ESCAPE '\\'", [nestId])).toBeFalsy();
    expect(await getDb().get("SELECT 1 AS hit FROM system_accounts WHERE user_id = ?", [sysId])).toBeFalsy();
    const memo = (await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, owner.apiKey)).data.plugins.find((p: any) => p.name === "memo");
    expect(memo).toMatchObject({ configured: false, system: null });
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes?limit=100`, undefined, viewer.apiKey);
    expect(JSON.stringify(list.data)).toContain("Memo2 First");
  });

  it("secret env keys are injective and fit the env store's key shape", async () => {
    const { envKeyFor } = await import("../src/plugins/registry.js");
    const keys = [envKeyFor("a-b", "c"), envKeyFor("a", "b_c"), envKeyFor("a", "b-c"), envKeyFor("a", "bc"), envKeyFor("memo", "apiKey"), envKeyFor("memo", "apikey")];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
  });

  it("admin settings expose plugins_enabled + plugins_packages and the loaded plugin list", async () => {
    const s = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
    expect(s.data.plugins_enabled).toBe(true);
    expect(s.data.plugins_packages).toBe(FIXTURE);
    expect(s.data.plugins_loaded).toEqual([expect.objectContaining({ name: "memo", version: "0.0.1" })]);
  });
});
