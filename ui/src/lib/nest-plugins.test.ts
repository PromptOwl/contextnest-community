/**
 * Nest Plugins page, the client half (community-nest-plugins-page-to-turn-on-
 * github-markdown-sync-from-the-ui): who may do what, the settings form built
 * from a plugin's schema, the PUT body it sends (secrets write-only), and the
 * wire calls against mocked /nests/:id/plugins responses.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildConfigureBody,
  draftFromPlugin,
  pluginFields,
  pluginRole,
  roleAllows,
  runCounts,
  runTrigger,
} from "./nest-plugins";
import {
  configureNestPlugin,
  listNestPluginRuns,
  listNestPlugins,
  nestPluginHealth,
  removeNestPlugin,
  runNestPlugin,
  type NestPlugin,
} from "./api";
import { githubMarkdown, memoConfigured, pluginsResponse } from "./nest-plugins.fixtures";

describe("pluginRole", () => {
  it("owner and admin configure, write runs, read only reads", () => {
    expect(pluginRole("owner")).toBe("admin");
    expect(pluginRole("admin")).toBe("admin");
    expect(pluginRole("write")).toBe("editor");
    expect(pluginRole("read")).toBe("viewer");
    expect(pluginRole(null)).toBe("viewer");
    expect(pluginRole(undefined)).toBe("viewer");
  });

  it("an archived nest is read-only for everyone", () => {
    expect(pluginRole("owner", { isArchived: true })).toBe("viewer");
  });

  it("roleAllows: configure is admin-only, run is admin or editor", () => {
    expect(roleAllows("admin", "configure")).toBe(true);
    expect(roleAllows("editor", "configure")).toBe(false);
    expect(roleAllows("viewer", "configure")).toBe(false);
    expect(roleAllows("admin", "run")).toBe(true);
    expect(roleAllows("editor", "run")).toBe(true);
    expect(roleAllows("viewer", "run")).toBe(false);
  });
});

describe("pluginFields (form from the settings schema)", () => {
  it("github-markdown: one field per property, in schema order, typed", () => {
    const f = pluginFields(githubMarkdown);
    expect(f.map((x) => x.key)).toEqual(["repo", "token", "branch", "mode", "path", "folder", "maxFiles"]);
    const by = Object.fromEntries(f.map((x) => [x.key, x]));
    expect(by.repo).toMatchObject({ kind: "text", title: "Repository", required: true, pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" });
    expect(by.token).toMatchObject({ kind: "secret", title: "Personal access token", required: false });
    expect(by.mode).toMatchObject({ kind: "select", options: ["all-markdown", "single-file"], defaultValue: "all-markdown" });
    expect(by.maxFiles).toMatchObject({ kind: "integer", min: 1, defaultValue: 500 });
    expect(by.branch.description).toBe("Defaults to the repository's default branch.");
  });

  it("a key named in secretKeys is a secret even without x-secret in the schema", () => {
    const p: NestPlugin = {
      ...githubMarkdown,
      settingsSchema: { type: "object", properties: { apiKey: { type: "string" } } },
      secretKeys: ["apiKey"],
    };
    expect(pluginFields(p)[0]).toMatchObject({ key: "apiKey", kind: "secret", title: "apiKey" });
  });

  it("booleans and numbers get their own kinds", () => {
    const p: NestPlugin = {
      ...githubMarkdown,
      settingsSchema: { type: "object", properties: { on: { type: "boolean" }, ratio: { type: "number" } } },
      secretKeys: [],
    };
    expect(pluginFields(p).map((x) => x.kind)).toEqual(["boolean", "number"]);
  });
});

describe("draftFromPlugin", () => {
  it("fills stored plain values and never puts the mask into a field", () => {
    const d = draftFromPlugin(memoConfigured);
    expect(d.values).toEqual({ prefix: "Memo", token: "" });
    expect(d.folder).toBe("");
    expect(d.clear).toEqual({});
  });

  it("an unconfigured plugin starts empty (defaults stay placeholders)", () => {
    const d = draftFromPlugin(githubMarkdown);
    expect(d.values.repo).toBe("");
    expect(d.values.mode).toBe("");
    expect(d.values.token).toBe("");
  });
});

describe("buildConfigureBody", () => {
  it("first enable: plain settings, typed integers, the secret, enabled:true", () => {
    const d = draftFromPlugin(githubMarkdown);
    d.values = { ...d.values, repo: "PromptOwl/context-nest-spec", token: "ghp_abc", maxFiles: "50", mode: "all-markdown" };
    d.folder = "engineering/spec";
    const r = buildConfigureBody(githubMarkdown, d, { enabled: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toEqual({
      enabled: true,
      folder: "engineering/spec",
      settings: { repo: "PromptOwl/context-nest-spec", token: "ghp_abc", mode: "all-markdown", maxFiles: 50 },
    });
  });

  it("an untouched secret is left out, so the stored one stays", () => {
    const d = draftFromPlugin(memoConfigured);
    d.values.prefix = "Note";
    const r = buildConfigureBody(memoConfigured, d);
    expect(r.ok && r.body.settings).toEqual({ prefix: "Note" });
    expect(r.ok && "token" in (r.body.settings as object)).toBe(false);
  });

  it("the mask itself is never sent back as a value", () => {
    const d = draftFromPlugin(memoConfigured);
    d.values.token = "••••";
    const r = buildConfigureBody(memoConfigured, d);
    expect(r.ok && (r.body.settings as Record<string, unknown>).token).toBeUndefined();
  });

  it("Clear on a stored secret sends null", () => {
    const d = draftFromPlugin(memoConfigured);
    d.clear = { token: true };
    const r = buildConfigureBody(memoConfigured, d);
    expect(r.ok && (r.body.settings as Record<string, unknown>).token).toBeNull();
  });

  it("emptying a stored plain setting sends null; an empty never-set one is omitted", () => {
    const p: NestPlugin = { ...githubMarkdown, configured: true, enabled: true, settings: { repo: "a/b", branch: "dev" } };
    const d = draftFromPlugin(p);
    d.values.branch = "";
    const r = buildConfigureBody(p, d);
    expect(r.ok && r.body.settings).toEqual({ repo: "a/b", branch: null });
  });

  it("a required field left empty is an error on that field, and nothing is sent", () => {
    const d = draftFromPlugin(githubMarkdown);
    const r = buildConfigureBody(githubMarkdown, d, { enabled: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.repo).toMatch(/required/i);
  });

  it("a required secret that is already stored is satisfied", () => {
    const p: NestPlugin = {
      ...memoConfigured,
      settingsSchema: { ...memoConfigured.settingsSchema, required: ["prefix", "token"] },
    };
    const r = buildConfigureBody(p, draftFromPlugin(p));
    expect(r.ok).toBe(true);
  });

  it("checks the schema pattern and integer bounds before the server does", () => {
    const d = draftFromPlugin(githubMarkdown);
    d.values.repo = "not a repo";
    d.values.maxFiles = "0";
    const r = buildConfigureBody(githubMarkdown, d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.repo).toMatch(/owner\/name|format/i);
    expect(r.errors.maxFiles).toMatch(/at least 1/);
    d.values.maxFiles = "2.5";
    d.values.repo = "a/b";
    const r2 = buildConfigureBody(githubMarkdown, d);
    expect(!r2.ok && r2.errors.maxFiles).toMatch(/whole number/);
  });

  it("an empty target folder clears it (null)", () => {
    const p: NestPlugin = { ...memoConfigured, folder: "inbox/old" };
    const d = draftFromPlugin(p);
    d.folder = "  ";
    const r = buildConfigureBody(p, d);
    expect(r.ok && r.body.folder).toBeNull();
  });
});

describe("run summaries", () => {
  it("counts read as words, with conflicts and failures only when present", () => {
    const run = pluginsResponse.plugins[0].runs[0];
    expect(runCounts(run)).toBe("3 created · 1 updated · 12 unchanged");
    expect(runCounts({ ...run, conflicts: [{ externalId: "x", id: "nodes/x" }], failed: [{ externalId: "y", error: "no" }] })).toBe(
      "3 created · 1 updated · 12 unchanged · 1 kept (edited here) · 1 failed",
    );
  });

  it("who started it", () => {
    expect(runTrigger("manual:owner@acme.dev")).toBe("owner@acme.dev");
    expect(runTrigger("schedule")).toBe("schedule");
  });
});

describe("plugins API client (mocked responses)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const mock = (body: unknown, status = 200) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const call = (m: ReturnType<typeof mock>) => m.mock.calls[0] as unknown as [string, RequestInit];

  it("lists a nest's plugins", async () => {
    const m = mock(pluginsResponse);
    const r = await listNestPlugins("n1");
    expect(call(m)[0]).toBe("/nests/n1/plugins");
    expect(r.plugins.map((p) => p.name)).toEqual(["github-markdown", "memo"]);
  });

  it("configures with PUT /plugins/:name and the body as given", async () => {
    const m = mock({ plugin: memoConfigured });
    await configureNestPlugin("n1", "memo", { enabled: true, settings: { prefix: "Memo", token: "sekrit" } });
    const [url, init] = call(m);
    expect(url).toBe("/nests/n1/plugins/memo");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true, settings: { prefix: "Memo", token: "sekrit" } });
  });

  it("encodes the plugin name in every path", async () => {
    const m = mock({ deleted: true });
    await removeNestPlugin("n1", "@acme/wiki");
    expect(call(m)[0]).toBe("/nests/n1/plugins/%40acme%2Fwiki");
    expect(call(m)[1].method).toBe("DELETE");
  });

  it("runs now with POST /run", async () => {
    const m = mock({ run: { ...pluginsResponse.plugins[0].runs[0], plugin: "github-markdown", skipped: 0, results: [], clean: true } });
    const r = await runNestPlugin("n1", "github-markdown");
    expect(call(m)[0]).toBe("/nests/n1/plugins/github-markdown/run");
    expect(call(m)[1].method).toBe("POST");
    expect(r.run.created).toBe(3);
  });

  it("reads runs (with a limit) and health", async () => {
    let m = mock({ runs: [] });
    await listNestPluginRuns("n1", "memo", 50);
    expect(call(m)[0]).toBe("/nests/n1/plugins/memo/runs?limit=50");
    vi.unstubAllGlobals();
    m = mock({ ok: false, detail: "GitHub returned HTTP 404 for a/b" });
    const h = await nestPluginHealth("n1", "github-markdown");
    expect(call(m)[0]).toBe("/nests/n1/plugins/github-markdown/health");
    expect(h).toEqual({ ok: false, detail: "GitHub returned HTTP 404 for a/b" });
  });

  it("a refused configure surfaces the server's words", async () => {
    mock({ error: "Only a nest owner or admin can configure plugins on this nest." }, 403);
    await expect(configureNestPlugin("n1", "memo", { enabled: true })).rejects.toThrow(/owner or admin/);
  });
});
