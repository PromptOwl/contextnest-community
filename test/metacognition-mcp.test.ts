/**
 * Metacognition over MCP (CU-wdqcq05rqq), and metacognition as an owner/admin
 * feature end to end.
 *
 * The MCP tools (metacognition_list / _configure / _run / _remove) wrap the same
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

const TOOLS = ["metacognition_list", "metacognition_configure", "metacognition_run", "metacognition_remove"];

let env: ReturnType<typeof setupTestEnv>;
let app: any;
type User = { apiKey: string; userId: string; email: string };
let owner: User;
let editor: User;
let admin: User;
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
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@meta-mcp.test", "Owner");
  editor = await registerUser(app, "editor@meta-mcp.test", "Editor");
  await resetAuthRateLimit();
  admin = await registerUser(app, "admin@meta-mcp.test", "Admin");
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
        expect(isError(await call("metacognition_list", {}))).toBe(true);
        // Dispatched straight into the shared seam, it says why.
        const out = await direct("metacognition_list", {}, owner);
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
    const configure = (await listTools(owner.apiKey)).find((t) => t.name === "metacognition_configure")!;
    expect(configure.description).toMatch(/dry_run/);
    expect(configure.description).toMatch(/summary/i);
    expect(configure.description).toMatch(/type agent/i);
    expect(configure.description).toMatch(/approved/i);
    expect(configure.description).toContain('"persona"');
  });
});

describe("a writer who is not an owner or admin", () => {
  it("is refused metacognition_configure with REST's 403 message, and nothing is saved", async () => {
    const rest = await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/nodes/archivist`, CONFIG, editor.apiKey);
    expect(rest.status).toBe(403);
    // Not advertised, so over the transport it never runs…
    expect(isError(await call("metacognition_configure", { agent: "nodes/archivist", ...CONFIG }, editor.apiKey))).toBe(true);
    // …and dispatched directly the service refuses it in REST's words.
    const out = await direct("metacognition_configure", { agent: "nodes/archivist", ...CONFIG }, editor);
    expect(out.isError).toBe(true);
    expect(outText(out)).toBe(rest.data.error);
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/archivist`, undefined, owner.apiKey);
    expect(after.status).toBe(404);
  });

  it("is refused list, run and remove the same way", async () => {
    for (const [name, args] of [
      ["metacognition_list", {}],
      ["metacognition_run", { agent: "nodes/archivist" }],
      ["metacognition_remove", { agent: "nodes/archivist" }],
    ] as const) {
      const out = await direct(name, args, editor);
      expect(out.isError, name).toBe(true);
      expect(outText(out), name).toMatch(/owner or an admin/);
    }
  });
});

describe("metacognition_configure", () => {
  it("dry_run validates and summarizes without saving", async () => {
    const r = await call("metacognition_configure", { agent: "nodes/archivist", ...CONFIG, dry_run: true });
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
      const r = await call("metacognition_configure", { agent: "nodes/archivist", ...CONFIG, dry_run });
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
        const r = await call("metacognition_configure", { agent: "nodes/archivist", ...bad, dry_run });
        expect(r.result?.isError, JSON.stringify(bad)).toBe(true);
        expect(text(r)).toBe(rest.data.error);
      }
    }
    expect(text(await call("metacognition_configure", { agent: "nodes/archivist", ...CONFIG, scope: { read: ["gtm"], propose: ["ops"] } }))).toBe(
      'scope.propose "ops" is outside scope.read',
    );
  });

  it("refuses a document that isn't an agent, as REST does", async () => {
    const r = await call("metacognition_configure", { agent: "nodes/gtm/pricing", ...CONFIG, dry_run: true });
    expect(r.result?.isError).toBe(true);
    expect(text(r)).toMatch(/only an agent document can be a metacognition agent/);
  });

  it("a real save: REST GET returns the same config, and the response carries the summary", async () => {
    const r = await call("metacognition_configure", { agent: "nodes/archivist", ...CONFIG });
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
    const r = await call("metacognition_configure", { agent: "nodes/archivist", ...CONFIG, dry_run: true }, admin.apiKey);
    expect(isError(r)).toBe(false);
  });
});

describe("metacognition_list", () => {
  it("returns configured agents and the agent documents not yet configured, each with a summary", async () => {
    const r = await call("metacognition_list", {});
    expect(isError(r)).toBe(false);
    const data = r.result.structuredContent;
    expect(data.agents.map((a: any) => a.node_id)).toEqual(["nodes/archivist"]);
    expect(data.agents[0].summary).toContain("Archivist will read gtm and ops");
    expect(data.unconfigured.map((d: any) => d.node_id)).toEqual(["nodes/scout"]);
    expect(data.unconfigured[0].title).toBe("Scout");
    expect(data.unconfigured[0].summary).toMatch(/not a metacognition agent yet/i);
  });
});

describe("metacognition_run", () => {
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
      const r = await call("metacognition_run", { agent: "nodes/archivist" });
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
    const r = await call("metacognition_run", { agent: "nodes/archivist", inputs: { note: "check pricing" } });
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
    const missing = await mcp("/mcp", "tools/call", { name: "metacognition_list", arguments: {} }, owner.apiKey);
    expect(isError(missing)).toBe(true);
    const viaServer = await mcp("/mcp", "tools/call", { name: "metacognition_list", arguments: { nest: nestId } }, owner.apiKey);
    const viaNest = await call("metacognition_list", {});
    expect(isError(viaServer)).toBe(false);
    expect(viaServer.result.structuredContent).toEqual(viaNest.result.structuredContent);
    const dry = await mcp(
      "/mcp",
      "tools/call",
      { name: "metacognition_configure", arguments: { nest: "Meta MCP", agent: "nodes/scout", ...CONFIG, persona: { name: "Scout" }, dry_run: true } },
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
    const r = await mcp("/mcp", "tools/call", { name: "metacognition_list", arguments: { nest: nestId } }, editor.apiKey);
    expect(r.result?.isError).toBe(true);
    expect(text(r)).toMatch(/owner or an admin/);
    const own = await mcp("/mcp", "tools/call", { name: "metacognition_list", arguments: { nest: other } }, editor.apiKey);
    expect(isError(own)).toBe(false);
    await jsonRequest(app, "DELETE", `/nests/${other}`, undefined, editor.apiKey);
  });

  it("a writer doesn't see them and is refused a call naming the nest", async () => {
    const names = (await listTools(editor.apiKey, "/mcp")).map((t) => t.name);
    for (const t of TOOLS) expect(names).not.toContain(t);
    const r = await mcp("/mcp", "tools/call", { name: "metacognition_list", arguments: { nest: nestId } }, editor.apiKey);
    expect(isError(r)).toBe(true);
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
    const off = await call("metacognition_configure", { agent: "nodes/archivist", ...CONFIG, enabled: false });
    expect(isError(off)).toBe(false);
    try {
      const hook = await jsonRequest(app, "POST", `/nests/${nestId}/hooks`, { agent_node: "nodes/archivist" }, editor.apiKey);
      expect(hook.status).toBe(403);
    } finally {
      await call("metacognition_configure", { agent: "nodes/archivist", ...CONFIG, enabled: true });
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
  });
});

describe("metacognition_remove", () => {
  it("stops it being a metacognition agent; the document stays", async () => {
    const r = await call("metacognition_remove", { agent: "nodes/archivist" });
    expect(isError(r)).toBe(false);
    expect(r.result.structuredContent.removed).toBe(true);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/metacognition/nodes/archivist`, undefined, owner.apiKey)).status).toBe(404);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/archivist`, undefined, owner.apiKey)).status).toBe(200);
    const again = await call("metacognition_remove", { agent: "nodes/archivist" });
    expect(again.result?.isError).toBe(true);
    expect(text(again)).toBe("nodes/archivist is not a metacognition agent");
  });
});
