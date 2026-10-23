/**
 * Metacognition over MCP (CU-wdqcq05rqq), and metacognition as an owner/admin
 * feature end to end.
 *
 * The MCP tools (context_metacognition_list / _suggest / _configure / _run / _remove) wrap the same
 * service functions the REST routes call, so the gates, parseConfig's messages,
 * the 409s and the saved config are the REST ones. Every metacognition action
 * — list, view, stats, run, configure, remove, and pointing a schedule or hook
 * at an agent — takes the nest owner or an admin.
 *
 * No model key is configured, so a run that does start is recorded as skipped;
 * nothing here needs the model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const TOOLS = ["context_metacognition_list", "context_metacognition_suggest", "context_metacognition_configure", "context_metacognition_run", "context_metacognition_remove"];

let env: ReturnType<typeof setupTestEnv>;
let app: any;
type User = { apiKey: string; userId: string; email: string };
let owner: User;
let editor: User;
let admin: User;
let root: User;
let nestId: string;
let systemKey: string;
let systemUserId: string;

async function mcp(path: string, method: string, params: Record<string, unknown>, key: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  const line = text.split("\n").find((l: string) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice("data: ".length)) : { raw: text };
}
const text = (body: any): string => (body?.result?.content ?? []).map((p: any) => p?.text ?? "").join("");
const isError = (body: any): boolean => body?.error !== undefined || body?.result?.isError === true;
const listTools = async (key: string, path = `/nests/${nestId}/mcp`) =>
  ((await mcp(path, "tools/list", {}, key)).result?.tools ?? []) as Array<{ name: string; description: string; inputSchema: any }>;
const call = (name: string, args: Record<string, unknown>, key = owner.apiKey) =>
  mcp(`/nests/${nestId}/mcp`, "tools/call", { name, arguments: args }, key);
/** Dispatch straight into the shared seam, past the advertising filter. */
async function direct(name: string, args: Record<string, unknown>, user: { userId: string; email: string }) {
  const { handleToolCall } = await import("../src/mcp/tools.js");
  return (await handleToolCall(name, args, {
    nestId,
    userId: user.userId,
    userEmail: user.email,
    capability: "write",
  } as any)) as any;
}
const outText = (out: any): string => (typeof out === "string" ? out : out.text);

const CONFIG = {
  persona: { name: "Archivist", avatar: "🦉" },
  scope: { read: ["gtm", "ops"], propose: ["gtm"] },
  caps: { max_proposals: 3 },
};

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.METACOGNITION_STARTS_PER_HOUR = "1000";
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@meta-mcp.test"] });
  owner = await registerUser(app, "owner@meta-mcp.test", "Owner");
  editor = await registerUser(app, "editor@meta-mcp.test", "Editor");
  await resetAuthRateLimit();
  admin = await registerUser(app, "admin@meta-mcp.test", "Admin");
  await resetAuthRateLimit();
  root = await registerUser(app, "root@meta-mcp.test", "Root");
  await resetAuthRateLimit();

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Meta MCP" }, owner.apiKey)).data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: editor.email, permission: "write" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: admin.email, permission: "admin" }, owner.apiKey);
  for (const title of ["Archivist", "Scout"]) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `${title}: keep gtm current.`, type: "agent" }, owner.apiKey);
    expect(r.status).toBe(201);
  }
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Pricing", content: "$8", folder: "gtm" }, owner.apiKey);

  const sys = await jsonRequest(app, "POST", "/systems", { name: "Sync bot", capability: "write", nest_ids: [nestId] }, owner.apiKey);
  expect(sys.status).toBe(201);
  systemKey = sys.data.api_key;
  systemUserId = sys.data.id;
});

afterAll(async () => {
  const { waitForMetacognitionRuns } = await import("../src/metacognition/service.js");
  await waitForMetacognitionRuns();
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  delete process.env.METACOGNITION_STARTS_PER_HOUR;
  await env.cleanup();
});

describe("feature switches off", () => {
  it("advertises none of the tools, and a direct call says not enabled", async () => {
    for (const off of ["FEATURE_METACOGNITION", "FEATURE_WORKFLOW_PLANE"]) {
      process.env[off] = "false";
      try {
        const names = (await listTools(owner.apiKey)).map((t) => t.name);
        for (const t of TOOLS) expect(names, `${off}: ${t}`).not.toContain(t);
        const server = (await listTools(owner.apiKey, "/mcp")).map((t) => t.name);
        for (const t of TOOLS) expect(server, `${off} server-wide: ${t}`).not.toContain(t);
        // Over the transport an unadvertised tool is refused before it runs.
        expect(isError(await call("context_metacognition_list", {}))).toBe(true);
        // Dispatched straight into the shared seam, it says why.
        const out = await direct("context_metacognition_list", {}, owner);
        expect(out.isError).toBe(true);
        expect(outText(out)).toMatch(/not enabled on this server/);
      } finally {
        process.env[off] = "true";
      }
    }
  });
});

describe("who sees the tools", () => {
  it("the owner and an admin do; a writer and a system key don't", async () => {
    for (const k of [owner.apiKey, admin.apiKey]) {
      const names = (await listTools(k)).map((t) => t.name);
      for (const t of TOOLS) expect(names).toContain(t);
    }
    for (const k of [editor.apiKey, systemKey]) {
      const names = (await listTools(k)).map((t) => t.name);
      for (const t of TOOLS) expect(names).not.toContain(t);
    }
  });

  it("the configure description tells a harness to dry-run first and needs an approved agent document", async () => {
    const configure = (await listTools(owner.apiKey)).find((t) => t.name === "context_metacognition_configure")!;
    expect(configure.description).toMatch(/dry_run/);
    expect(configure.description).toMatch(/summary/i);
    expect(configure.description).toMatch(/type agent/i);
    expect(configure.description).toMatch(/approved/i);
    expect(configure.description).toContain('"persona"');
  });
});

describe("a writer who is not an owner or admin", () => {
  it("is refused context_metacognition_configure with REST's 403 message, and nothing is saved", async () => {
    const rest = await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/nodes/archivist`, CONFIG, editor.apiKey);
    expect(rest.status).toBe(403);
    // Not advertised, so over the transport it never runs…
    expect(isError(await call("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG }, editor.apiKey))).toBe(true);
    // …and dispatched directly the service refuses it in REST's words.
    const out = await direct("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG }, editor);
    expect(out.isError).toBe(true);
    expect(outText(out)).toBe(rest.data.error);
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/archivist`, undefined, owner.apiKey);
    expect(after.status).toBe(404);
  });

  it("is refused list, suggest, run and remove the same way", async () => {
    for (const [name, args] of [
      ["context_metacognition_list", {}],
      ["context_metacognition_suggest", { agent: "nodes/archivist" }],
      ["context_metacognition_run", { agent: "nodes/archivist" }],
      ["context_metacognition_remove", { agent: "nodes/archivist" }],
    ] as const) {
      const out = await direct(name, args, editor);
      expect(out.isError, name).toBe(true);
      expect(outText(out), name).toMatch(/owner or an admin/);
    }
  });
});

describe("context_metacognition_suggest", () => {
  it("returns REST's GET …/suggest result and saves nothing", async () => {
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/archivist/suggest`, undefined, owner.apiKey);
    expect(rest.status).toBe(200);
    const r = await call("context_metacognition_suggest", { agent: "nodes/archivist" });
    expect(isError(r)).toBe(false);
    expect(r.result.structuredContent.suggestion).toEqual(rest.data.suggestion);
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/archivist`, undefined, owner.apiKey);
    expect(after.status).toBe(404);
  });
});

describe("context_metacognition_configure", () => {
  it("passes notify through to parseConfig, as the PUT body does", async () => {
    const notify = { recipients: ["owner"], channels: ["connectors"], max_per_run: 2 };
    const r = await call("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG, notify, dry_run: true });
    expect(isError(r)).toBe(false);
    expect(r.result.structuredContent.config.notify).toEqual(notify);
  });

  it("dry_run validates and summarizes without saving", async () => {
    const r = await call("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG, dry_run: true });
    expect(isError(r)).toBe(false);
    const data = r.result.structuredContent;
    expect(data.dry_run).toBe(true);
    expect(data.saved).toBe(false);
    // The normalized config: defaults filled in, caps clamped.
    expect(data.config.persona).toEqual({ name: "Archivist", avatar: "🦉" });
    expect(data.config.scope).toEqual({ read: ["gtm", "ops"], propose: ["gtm"] });
    expect(data.config.caps.max_proposals).toBe(3);
    expect(data.config.caps.max_steps).toBe(12);
    expect(data.summary).toContain("Archivist will read gtm and ops, may suggest edits in gtm, up to 3 per run");
    expect(data.summary).toContain("It never publishes; every change goes to a reviewer.");
    expect(text(r)).toContain(data.summary);
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/archivist`, undefined, owner.apiKey);
    expect(after.status).toBe(404);
  });

  it("dry_run that isn't a boolean is refused, never treated as a save", async () => {
    for (const dry_run of ["true", 1, "yes", null]) {
      const r = await call("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG, dry_run });
      expect(r.result?.isError, JSON.stringify(dry_run)).toBe(true);
      expect(text(r)).toBe("dry_run must be true or false");
    }
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/archivist`, undefined, owner.apiKey);
    expect(after.status).toBe(404);
  });

  it("an invalid body fails with parseConfig's message, verbatim, as REST does", async () => {
    for (const bad of [
      { ...CONFIG, scope: { read: ["gtm"], propose: ["ops"] } },
      { ...CONFIG, persona: { name: "Archivist", avatar: "https://x.example/a.png" } },
      { ...CONFIG, feeds: [{ name: "news", url: "http://feeds.example.com/a" }] },
    ]) {
      const rest = await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/nodes/archivist`, bad, owner.apiKey);
      expect(rest.status).toBe(400);
      for (const dry_run of [true, false]) {
        const r = await call("context_metacognition_configure", { agent: "nodes/archivist", ...bad, dry_run });
        expect(r.result?.isError, JSON.stringify(bad)).toBe(true);
        expect(text(r)).toBe(rest.data.error);
      }
    }
    expect(text(await call("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG, scope: { read: ["gtm"], propose: ["ops"] } }))).toBe(
      'scope.propose "ops" is outside scope.read',
    );
  });

  it("refuses a document that isn't an agent, as REST does", async () => {
    const r = await call("context_metacognition_configure", { agent: "nodes/gtm/pricing", ...CONFIG, dry_run: true });
    expect(r.result?.isError).toBe(true);
    expect(text(r)).toMatch(/only an agent document can be a metacognition agent/);
  });

  it("a real save: REST GET returns the same config, and the response carries the summary", async () => {
    const r = await call("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG });
    expect(isError(r)).toBe(false);
    const data = r.result.structuredContent;
    expect(data.saved).toBe(true);
    expect(data.summary).toContain("Archivist will read gtm and ops");
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/archivist`, undefined, owner.apiKey);
    expect(rest.status).toBe(200);
    const { owner_changed: _o, ...agent } = data.agent;
    expect(agent).toEqual(rest.data.agent);
    expect(rest.data.agent.configured_by).toBe(owner.email);
  });

  it("an admin collaborator may configure one too", async () => {
    const r = await call("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG, dry_run: true }, admin.apiKey);
    expect(isError(r)).toBe(false);
  });
});

describe("context_metacognition_list", () => {
  it("returns configured agents and the agent documents not yet configured, each with a summary", async () => {
    const r = await call("context_metacognition_list", {});
    expect(isError(r)).toBe(false);
    const data = r.result.structuredContent;
    expect(data.agents.map((a: any) => a.node_id)).toEqual(["nodes/archivist"]);
    expect(data.agents[0].summary).toContain("Archivist will read gtm and ops");
    expect(data.unconfigured.map((d: any) => d.node_id)).toEqual(["nodes/scout"]);
    expect(data.unconfigured[0].title).toBe("Scout");
    expect(data.unconfigured[0].summary).toMatch(/not a metacognition agent yet/i);
  });
});

describe("context_metacognition_run", () => {
  it("is refused while a run is in progress, with REST's 409 message", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { SERVER_CLAIM } = await import("../src/metacognition/store.js");
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, inputs, started_at, parent_run_id, depth, claimed_by, claimed_at)
       VALUES ('run_busy_fixture', ?, 'nodes/archivist', ?, 'running', NULL, ?, NULL, 0, ?, ?)`,
      [nestId, owner.email, now, SERVER_CLAIM, now],
    );
    try {
      const rest = await jsonRequest(app, "POST", `/nests/${nestId}/metacognition/nodes/archivist/run`, {}, owner.apiKey);
      expect(rest.status).toBe(409);
      const r = await call("context_metacognition_run", { agent: "nodes/archivist" });
      expect(r.result?.isError).toBe(true);
      expect(text(r)).toBe(rest.data.error);
      expect(r.result.structuredContent.http_status).toBe(409);
      // "Try again later", not "fix your input".
      expect(r.result.structuredContent.code).toBe("CONFLICT");
    } finally {
      await getDb().run("UPDATE runs SET status = 'cancelled' WHERE id = 'run_busy_fixture'");
    }
  });

  it("starts a run and returns its run_id", async () => {
    const r = await call("context_metacognition_run", { agent: "nodes/archivist", inputs: { note: "check pricing" } });
    expect(isError(r)).toBe(false);
    expect(r.result.structuredContent.run_id).toMatch(/^run_/);
    expect(r.result.structuredContent.executes).toBe("server");
  });
});

describe("system keys", () => {
  it("are refused every metacognition tool, as REST refuses them", async () => {
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition`, undefined, systemKey);
    expect(rest.status).toBe(403);
    for (const name of TOOLS) {
      const out = await direct(name, { agent: "nodes/archivist", ...CONFIG, dry_run: true }, { userId: systemUserId, email: "sys" });
      expect(out.isError, name).toBe(true);
      expect(outText(out), name).toBe(rest.data.error);
    }
  });
});

describe("the server-wide /mcp", () => {
  it("advertises the tools with a required nest argument", async () => {
    const tools = await listTools(owner.apiKey, "/mcp");
    for (const t of TOOLS) {
      const def = tools.find((x) => x.name === t);
      expect(def, t).toBeTruthy();
      expect(def!.inputSchema.required).toContain("nest");
    }
  });

  it("without nest it is a validation error; with nest it behaves as the per-nest endpoint", async () => {
    const missing = await mcp("/mcp", "tools/call", { name: "context_metacognition_list", arguments: {} }, owner.apiKey);
    expect(isError(missing)).toBe(true);
    const viaServer = await mcp("/mcp", "tools/call", { name: "context_metacognition_list", arguments: { nest: nestId } }, owner.apiKey);
    const viaNest = await call("context_metacognition_list", {});
    expect(isError(viaServer)).toBe(false);
    expect(viaServer.result.structuredContent).toEqual(viaNest.result.structuredContent);
    const suggestServer = await mcp(
      "/mcp",
      "tools/call",
      { name: "context_metacognition_suggest", arguments: { nest: nestId, agent: "nodes/scout" } },
      owner.apiKey,
    );
    const suggestNest = await call("context_metacognition_suggest", { agent: "nodes/scout" });
    expect(isError(suggestServer)).toBe(false);
    expect(suggestServer.result.structuredContent).toEqual(suggestNest.result.structuredContent);
    const dry = await mcp(
      "/mcp",
      "tools/call",
      { name: "context_metacognition_configure", arguments: { nest: "Meta MCP", agent: "nodes/scout", ...CONFIG, persona: { name: "Scout" }, dry_run: true } },
      owner.apiKey,
    );
    expect(isError(dry)).toBe(false);
    expect(dry.result.structuredContent.summary).toContain("Scout will read gtm and ops");
  });

  it("an admin of another nest sees them but is refused on a nest where they only write", async () => {
    const other = (await jsonRequest(app, "POST", "/nests", { name: "Editor Own" }, editor.apiKey)).data.nest?.id;
    expect(other).toBeTruthy();
    const names = (await listTools(editor.apiKey, "/mcp")).map((t) => t.name);
    for (const t of TOOLS) expect(names).toContain(t);
    const r = await mcp("/mcp", "tools/call", { name: "context_metacognition_list", arguments: { nest: nestId } }, editor.apiKey);
    expect(r.result?.isError).toBe(true);
    expect(text(r)).toMatch(/owner or an admin/);
    const own = await mcp("/mcp", "tools/call", { name: "context_metacognition_list", arguments: { nest: other } }, editor.apiKey);
    expect(isError(own)).toBe(false);
    await jsonRequest(app, "DELETE", `/nests/${other}`, undefined, editor.apiKey);
  });

  it("a writer doesn't see them and is refused a call naming the nest", async () => {
    const names = (await listTools(editor.apiKey, "/mcp")).map((t) => t.name);
    for (const t of TOOLS) expect(names).not.toContain(t);
    for (const [name, args] of [
      ["context_metacognition_list", { nest: nestId }],
      ["context_metacognition_suggest", { nest: nestId, agent: "nodes/scout" }],
    ] as const) {
      const r = await mcp("/mcp", "tools/call", { name, arguments: args }, editor.apiKey);
      expect(isError(r), name).toBe(true);
    }
  });
});

describe("metacognition is owner/admin only on REST too", () => {
  it("a writer gets 403 listing, viewing, reading stats or running an agent", async () => {
    for (const [method, path] of [
      ["GET", `/nests/${nestId}/metacognition`],
      ["GET", `/nests/${nestId}/metacognition/nodes/archivist`],
      ["GET", `/nests/${nestId}/metacognition/nodes/archivist/stats`],
      ["POST", `/nests/${nestId}/metacognition/nodes/archivist/run`],
      ["POST", `/nests/${nestId}/run/nodes/archivist`],
    ] as const) {
      const r = await jsonRequest(app, method, path, method === "POST" ? {} : undefined, editor.apiKey);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.data.error, `${method} ${path}`).toMatch(/owner or an admin/);
    }
  });

  it("an admin collaborator may list, view and read stats", async () => {
    for (const path of [
      `/nests/${nestId}/metacognition`,
      `/nests/${nestId}/metacognition/nodes/archivist`,
      `/nests/${nestId}/metacognition/nodes/archivist/stats`,
    ]) {
      const r = await jsonRequest(app, "GET", path, undefined, admin.apiKey);
      expect(r.status, path).toBe(200);
    }
  });

  it("the generic run trigger still runs an ordinary agent for a writer", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/run/nodes/scout`, {}, editor.apiKey);
    expect(r.status).toBe(201);
  });

  it("workflow_runs_list agent_stats needs owner/admin", async () => {
    // Workflow tools throw their refusals; the transport turns that into an error result.
    await expect(direct("workflow_runs_list", { agent: "nodes/archivist", agent_stats: true }, editor)).rejects.toThrow(
      /owner or an admin/,
    );
    const viaMcp = await call("workflow_runs_list", { agent: "nodes/archivist", agent_stats: true }, editor.apiKey);
    expect(isError(viaMcp)).toBe(true);
    expect(text(viaMcp)).toMatch(/owner or an admin/);
    const ok = await call("workflow_runs_list", { agent: "nodes/archivist", agent_stats: true });
    expect(isError(ok)).toBe(false);
    expect(text(ok)).toContain('"stats"');
  });

  it("a writer can't point a schedule or a hook at a metacognition agent", async () => {
    const sch = await jsonRequest(app, "POST", `/nests/${nestId}/schedules`, { agent_node: "nodes/archivist", every_minutes: 60 }, editor.apiKey);
    expect(sch.status).toBe(403);
    const hook = await jsonRequest(app, "POST", `/nests/${nestId}/hooks`, { agent_node: "nodes/archivist" }, editor.apiKey);
    expect(hook.status).toBe(403);
    // An ordinary agent is unchanged.
    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/schedules`, { agent_node: "nodes/scout", every_minutes: 60 }, editor.apiKey);
    expect(ok.status).toBe(201);
  });

  it("a switched-off metacognition agent is still gated: a writer can't schedule it to come back", async () => {
    const off = await call("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG, enabled: false });
    expect(isError(off)).toBe(false);
    try {
      const hook = await jsonRequest(app, "POST", `/nests/${nestId}/hooks`, { agent_node: "nodes/archivist" }, editor.apiKey);
      expect(hook.status).toBe(403);
    } finally {
      await call("context_metacognition_configure", { agent: "nodes/archivist", ...CONFIG, enabled: true });
    }
  });

  it("a writer can't retune or switch on an owner's schedule of a metacognition agent", async () => {
    const created = await jsonRequest(app, "POST", `/nests/${nestId}/schedules`, { agent_node: "nodes/archivist", every_minutes: 60, enabled: false }, owner.apiKey);
    expect(created.status).toBe(201);
    const id = created.data.schedule.id;
    const patch = await jsonRequest(app, "PATCH", `/nests/${nestId}/schedules/${id}`, { enabled: true, every_minutes: 5 }, editor.apiKey);
    expect(patch.status).toBe(403);
    const byOwner = await jsonRequest(app, "PATCH", `/nests/${nestId}/schedules/${id}`, { every_minutes: 120 }, owner.apiKey);
    expect(byOwner.status).toBe(200);
    // Stopping spend stays at write: a writer may still delete it.
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/schedules/${id}`, undefined, editor.apiKey);
    expect(del.status).toBe(200);
  });
});

describe("which requests on the server-level /mcp consider the metacognition tools", () => {
  it("tools/list and metacognition calls do, batched or not; other calls and junk don't", async () => {
    const { requestMayUseMetacognition } = await import("../src/mcp/metacognition-tools.js");
    const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });
    expect(requestMayUseMetacognition({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(true);
    expect(requestMayUseMetacognition(call("context_metacognition_run"))).toBe(true);
    expect(requestMayUseMetacognition(call("context_get"))).toBe(false);
    expect(requestMayUseMetacognition([call("context_get"), call("context_metacognition_list")])).toBe(true);
    expect(requestMayUseMetacognition([call("context_get")])).toBe(false);
    expect(requestMayUseMetacognition([{ jsonrpc: "2.0", id: 2, method: "tools/list" }])).toBe(true);
    expect(requestMayUseMetacognition(null)).toBe(false);
    expect(requestMayUseMetacognition("tools/list")).toBe(false);
  });

  it("a body with no content-length (chunked) is still read, but only up to its cap", async () => {
    const send = (payload: string) => {
      const bytes = new TextEncoder().encode(payload);
      const body = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(bytes);
          ctrl.close();
        },
      });
      return app.request("/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${owner.apiKey}` },
        body,
        duplex: "half",
      } as any);
    };
    const names = async (res: Response) => {
      const ct = res.headers.get("content-type") || "";
      const j = ct.includes("application/json")
        ? await res.json()
        : JSON.parse((await res.text()).split("\n").find((l) => l.startsWith("data: "))!.slice(6));
      return (j.result?.tools ?? []).map((t: any) => t.name) as string[];
    };
    const small = await names(await send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })));
    expect(small).toContain("context_metacognition_list");
    // Past the cap the peek gives up (the request itself is still served).
    const big = await names(
      await send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { pad: "x".repeat(70 * 1024) } } })),
    );
    expect(big).toContain("nest_index");
    expect(big).not.toContain("context_metacognition_list");
  });

  it("a server admin who owns no nest is offered them, and may use them on any nest", async () => {
    const names = (await listTools(root.apiKey, "/mcp")).map((t) => t.name);
    expect(names).toContain("context_metacognition_list");
    const r = await mcp("/mcp", "tools/call", { name: "context_metacognition_list", arguments: { nest: nestId } }, root.apiKey);
    expect(isError(r)).toBe(false);
  });

  it("a key scoped to a nest the caller only writes in isn't offered them, though they own another", async () => {
    const own = (await jsonRequest(app, "POST", "/nests", { name: "Editor Scoped" }, editor.apiKey)).data.nest.id;
    const minted = await jsonRequest(app, "POST", "/auth/keys", { label: "scoped", nest_id: nestId }, editor.apiKey);
    expect(minted.status).toBe(201);
    const names = (await listTools(minted.data.api_key, "/mcp")).map((t) => t.name);
    expect(names).not.toContain("context_metacognition_list");
    // Unscoped, the same person (owner of `own`) is offered them.
    expect((await listTools(editor.apiKey, "/mcp")).map((t) => t.name)).toContain("context_metacognition_list");
    await jsonRequest(app, "DELETE", `/nests/${own}`, undefined, editor.apiKey);
  });
});

describe("tool errors", () => {
  it("map an operation's status to a code: 403, 404, 409, 400, and a server-side failure is INTERNAL", async () => {
    const { metacognitionRefusal } = await import("../src/mcp/metacognition-tools.js");
    const { AppError } = await import("../src/shared/errors.js");
    const code = (status: number) => (metacognitionRefusal(new AppError(status, "x")) as any).data.code;
    expect(code(403)).toBe("UNAUTHORIZED_ACTION");
    expect(code(404)).toBe("DOCUMENT_NOT_FOUND");
    expect(code(409)).toBe("CONFLICT");
    expect(code(400)).toBe("VALIDATION_FAILED");
    expect(code(500)).toBe("INTERNAL");
    expect(code(503)).toBe("INTERNAL");
  });
});

describe("approval state in context_metacognition_list", () => {
  it("says whether each agent document has approved instructions, so a harness can warn before setting up one that would never run", async () => {
    const gov = (await jsonRequest(app, "POST", "/nests", { name: "Governed Meta" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${gov}/nodes`, { title: "Ready", content: "Approved instructions.", type: "agent" }, owner.apiKey);
    const steward = await jsonRequest(app, "POST", `/nests/${gov}/stewards`, { scope: "nest", users: [{ email: admin.email, role: "reviewer" }] }, owner.apiKey);
    expect(steward.status).toBe(201);
    // Created once the nest is governed: a draft until a reviewer approves it.
    await jsonRequest(app, "POST", `/nests/${gov}/nodes`, { title: "Pending", content: "Not yet reviewed.", type: "agent" }, owner.apiKey);
    const r = await mcp(`/nests/${gov}/mcp`, "tools/call", { name: "context_metacognition_list", arguments: {} }, owner.apiKey);
    expect(isError(r)).toBe(false);
    const byId = Object.fromEntries(r.result.structuredContent.unconfigured.map((d: any) => [d.node_id, d]));
    expect(byId["nodes/ready"].instructions_approved).toBe(true);
    expect(byId["nodes/pending"].instructions_approved).toBe(false);
    expect(byId["nodes/pending"].summary).toMatch(/no approved version/i);
    expect(text(r)).toMatch(/Pending \(nodes\/pending\).*not approved/i);
  });
});

describe("context_metacognition_remove", () => {
  it("stops it being a metacognition agent; the document stays", async () => {
    const r = await call("context_metacognition_remove", { agent: "nodes/archivist" });
    expect(isError(r)).toBe(false);
    expect(r.result.structuredContent.removed).toBe(true);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/archivist`, undefined, owner.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/archivist`, undefined, owner.apiKey)).status).toBe(200);
    const again = await call("context_metacognition_remove", { agent: "nodes/archivist" });
    expect(again.result?.isError).toBe(true);
    expect(text(again)).toBe("nodes/archivist is not a metacognition agent");
  });
});
