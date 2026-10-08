/**
 * Agent read log — "a record of what each agent read, and which version".
 *
 * #345 added node_access_events: reads, retrievals and exports per document.
 * This closes the gaps that kept it from answering "what did agent X read,
 * and exactly what did it see":
 *   - an agent's MCP `context_search` (its most common read) was never
 *     recorded — the hits come back under `results`, not `documents`;
 *   - REST reads never carried an agent (nothing attributed a GET), so a
 *     labeled key reading over REST showed as the person;
 *   - table queries and historical-version fetches weren't recorded;
 *   - no row said which VERSION was served, and there was no agent filter;
 *   - there was no way to turn it off for a nest.
 *
 * GET /nests/:nestId/activity-log?agent=<name> — reads (and changes) made
 * through one agent; read rows carry `version`.
 * PATCH /nests/:nestId/settings { access_log_enabled } — on by default; only
 * the owner (or server admin) may turn it off.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed } from "./helpers";
import {
  flushAccessLog,
  resetAccessThrottle,
  forgetAccessLogSetting,
} from "../src/governance/access-log.js";
import { getDb } from "../src/db/client.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
let rpcId = 1;

async function callTool(
  app: any,
  nestId: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(apiKey) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json")
    ? (await res.json()).result
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice("data: ".length),
      ).result;
}

/** A second API key for a user, with a label — what an agent's key looks like. */
async function labeledKey(app: any, email: string, label: string): Promise<string> {
  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass" }),
  });
  const cookie = login.headers.get("set-cookie") || "";
  const res = await app.request("/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ label }),
  });
  const data = await res.json();
  return data.api_key;
}

describe("agent read log — ungoverned nest", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let admin: { apiKey: string };
  let editor: { apiKey: string };
  let nestId: string;
  let pricingId: string;
  let runbookId: string;

  const log = async (query = "", key = owner.apiKey) => {
    await flushAccessLog();
    return jsonRequest(app, "GET", `/nests/${nestId}/activity-log${query}`, undefined, key);
  };
  const nodeLog = (nodeId: string, extra = "") =>
    log(`?node=${encodeURIComponent(nodeId)}${extra}`);

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    admin = await registerUser(app, "admin@acme.com", "Admin");
    editor = await registerUser(app, "editor@acme.com", "Editor");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Agent Reads" }, owner.apiKey);
    nestId = data.nest.id;
    for (const [email, permission] of [
      ["admin@acme.com", "admin"],
      ["editor@acme.com", "write"],
    ]) {
      await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email, permission }, owner.apiKey);
    }
    const pricing = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Pricing", content: "# Pricing\n\nfalcon tier is 40 dollars", folder: "sales" },
      owner.apiKey,
    );
    pricingId = pricing.data.node.id;
    const runbook = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Runbook", content: "# Runbook\n\nrestart the heron service", folder: "ops" },
      owner.apiKey,
    );
    runbookId = runbook.data.node.id;
  });

  afterAll(() => env.cleanup());

  it("records an agent's MCP search — the hits, the agent, and the version served", async () => {
    resetAccessThrottle();
    const res = await callTool(app, nestId, editor.apiKey, "context_search", {
      query: "falcon",
      client: { agent: "claude-code" },
    });
    expect(res.isError).toBeFalsy();
    const { data } = await nodeLog(pricingId, "&type=retrieved");
    const row = data.items.find((i: any) => i.surface === "mcp");
    expect(row).toEqual(
      expect.objectContaining({
        type: "retrieved",
        actor: "editor@acme.com",
        agent: "claude-code",
        detail: "context_search",
        version: 1,
      }),
    );
    // The runbook didn't match the search, so it wasn't pulled.
    const other = await nodeLog(runbookId, "&type=retrieved");
    expect(other.data.items.filter((i: any) => i.surface === "mcp")).toEqual([]);
  });

  it("records the version an MCP read was served, and a new row when the version changes", async () => {
    resetAccessThrottle();
    await callTool(app, nestId, editor.apiKey, "context_get", { id: runbookId, client: { agent: "cursor" } });
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${runbookId}`,
      { content: "# Runbook\n\nrestart the heron service, then page ops" },
      owner.apiKey,
    );
    // Same agent, same document, inside the throttle window — but a new
    // version is a new fact, so it is recorded.
    await callTool(app, nestId, editor.apiKey, "context_get", { id: runbookId, client: { agent: "cursor" } });
    const { data } = await nodeLog(runbookId, "&type=read&agent=cursor");
    expect(data.items.map((i: any) => i.version)).toEqual([2, 1]);
    expect(data.items.every((i: any) => i.agent === "cursor" && i.surface === "mcp")).toBe(true);
  });

  it("records a REST read with the version and the agent named by the key's label", async () => {
    resetAccessThrottle();
    const agentKey = await labeledKey(app, "editor@acme.com", "Claude Desktop");
    expect(agentKey).toBeTruthy();
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pricingId}`, undefined, agentKey);
    expect(read.status).toBe(200);
    const { data } = await nodeLog(pricingId, "&type=read&agent=claude%20desktop");
    expect(data.items[0]).toEqual(
      expect.objectContaining({
        type: "read",
        surface: "api",
        actor: "editor@acme.com",
        agent: "Claude Desktop",
        version: read.data.node?.version ?? read.data.version ?? 1,
      }),
    );
  });

  it("records a historical version fetch as a read of that version", async () => {
    resetAccessThrottle();
    const res = await app.request(`/nests/${nestId}/nodes/${runbookId}/versions/1`, {
      headers: authed(admin.apiKey),
    });
    expect(res.status).toBe(200);
    const { data } = await nodeLog(runbookId, "&type=read&actor=admin@acme.com");
    expect(data.items[0]).toEqual(
      expect.objectContaining({ type: "read", version: 1, detail: "version" }),
    );
  });

  it("records a REST table query against the table it read", async () => {
    resetAccessThrottle();
    const table = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Price List",
        type: "table",
        content: "sku,region,price\nA1,EU,120\nB2,US,90\n",
        status: "published",
      },
      owner.apiKey,
    );
    const tableId = table.data.node.id;
    const q = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/table-query`,
      { table: tableId, query: 'where region = "EU"', include_drafts: true },
      editor.apiKey,
    );
    expect(q.status).toBe(200);
    const { data } = await nodeLog(tableId, "&type=retrieved");
    expect(data.items[0]).toEqual(
      expect.objectContaining({ type: "retrieved", detail: "table-query", actor: "editor@acme.com" }),
    );
    expect(data.items[0].version).toBe(q.data.version ?? undefined);
  });

  it("answers 'what did agent X read' across the nest, case-insensitively", async () => {
    resetAccessThrottle();
    await callTool(app, nestId, editor.apiKey, "context_get", { id: pricingId, client: { agent: "Hootie-Bot" } });
    await callTool(app, nestId, editor.apiKey, "context_get", { id: runbookId, client: { agent: "other-agent" } });
    const { status, data } = await log("?agent=hootie-bot&type=read,retrieved");
    expect(status).toBe(200);
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.every((i: any) => i.agent?.toLowerCase() === "hootie-bot")).toBe(true);
    expect(data.items.map((i: any) => i.nodeId)).toContain(pricingId);
    expect(data.items.map((i: any) => i.nodeId)).not.toContain(runbookId);
  });

  it("keeps the agent log for admins only", async () => {
    const asEditor = await log("?agent=claude-code", editor.apiKey);
    expect(asEditor.status).toBe(403);
    const asAdmin = await log("?agent=claude-code", admin.apiKey);
    expect(asAdmin.status).toBe(200);
    const tooLong = await log(`?agent=${"x".repeat(201)}`);
    expect(tooLong.status).toBe(400);
  });

  it("never fails or slows a read when recording fails", async () => {
    resetAccessThrottle();
    const db = getDb();
    await db.run("ALTER TABLE node_access_events RENAME TO node_access_events_off");
    try {
      const mcp = await callTool(app, nestId, editor.apiKey, "context_get", {
        id: pricingId,
        client: { agent: "claude-code" },
      });
      expect(mcp.isError).toBeFalsy();
      const rest = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pricingId}`, undefined, editor.apiKey);
      expect(rest.status).toBe(200);
      const search = await callTool(app, nestId, editor.apiKey, "context_search", { query: "falcon" });
      expect(search.isError).toBeFalsy();
      await flushAccessLog();
    } finally {
      await db.run("ALTER TABLE node_access_events_off RENAME TO node_access_events");
    }
    // The failed rows released their throttle keys, so the next read records.
    await callTool(app, nestId, editor.apiKey, "context_get", { id: pricingId, client: { agent: "claude-code" } });
    const { data } = await nodeLog(pricingId, "&type=read&agent=claude-code");
    expect(data.items.length).toBe(1);
  });

  it("is on by default; only the owner may turn it off, and off records nothing", async () => {
    const settings = await jsonRequest(app, "GET", `/nests/${nestId}/settings`, undefined, owner.apiKey);
    expect(settings.data.access_log_enabled).toBe(true);

    // An admin collaborator can't switch off the record of their own reads —
    // and the refusal applies nothing else in the same body.
    const denied = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { access_log_enabled: false, creator_is_reviewer: true },
      admin.apiKey,
    );
    expect(denied.status).toBe(403);
    expect(denied.data.field).toBe("access_log_enabled");
    const still = await jsonRequest(app, "GET", `/nests/${nestId}/settings`, undefined, owner.apiKey);
    expect(still.data.access_log_enabled).toBe(true);
    expect(still.data.creator_is_reviewer).toBe(false);

    const off = await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { access_log_enabled: false }, owner.apiKey);
    expect(off.status).toBe(200);
    expect(off.data.access_log_enabled).toBe(false);

    resetAccessThrottle();
    const before = (await log("?type=read,retrieved")).data.items.length;
    await callTool(app, nestId, editor.apiKey, "context_get", { id: runbookId, client: { agent: "quiet" } });
    await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${runbookId}`, undefined, editor.apiKey);
    await callTool(app, nestId, editor.apiKey, "context_search", { query: "heron" });
    const after = await log("?type=read,retrieved");
    expect(after.data.items.length).toBe(before);

    // An admin may turn it back on, and reads are recorded again at once.
    const on = await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { access_log_enabled: true }, admin.apiKey);
    expect(on.status).toBe(200);
    forgetAccessLogSetting();
    await callTool(app, nestId, editor.apiKey, "context_get", { id: runbookId, client: { agent: "quiet" } });
    const back = await log("?agent=quiet");
    expect(back.data.items.length).toBe(1);
  });

  it("stores ids and versions, never document content or what was searched", async () => {
    resetAccessThrottle();
    await callTool(app, nestId, editor.apiKey, "context_search", {
      query: "falcon secret plan",
      client: { agent: "claude-code" },
    });
    await flushAccessLog();
    const rows = (await getDb().all(
      "SELECT * FROM node_access_events WHERE nest_id = ?",
      [nestId],
    )) as any[];
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("secret plan");
    expect(dump).not.toContain("40 dollars");
    expect(dump).not.toContain("heron service");
  });
});

describe("agent read log — governed nest serves (and records) the approved version", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let dev: { apiKey: string };
  let lead: { apiKey: string };
  let nestId: string;
  const nodeId = "nodes/refund-policy";

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    lead = await registerUser(app, "lead@acme.com", "Lead");
    dev = await registerUser(app, "dev@acme.com", "Dev");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Governed Reads" }, lead.apiKey);
    nestId = data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "dev@acme.com", permission: "write" }, lead.apiKey);
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `version: 1
nest:
  - email: lead@acme.com, role: admin, can_approve: true
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, lead.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, lead.apiKey);

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Refund Policy", content: "# Refunds\n\n30 days" },
      dev.apiKey,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/submit-review`, { note: "v1" }, dev.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/approve`, { note: "ok" }, lead.apiKey);
    // A newer, unapproved draft on top: the AI must still get the approved one.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# Refunds\n\n90 days (draft, not approved)" },
      dev.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("records the approved version an agent was given, not the newer draft", async () => {
    const versions = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${nodeId}/versions`, undefined, lead.apiKey);
    const approved = versions.data.approvedVersion;
    expect(approved).toBeGreaterThan(0);
    expect(versions.data.versions[0].version).toBeGreaterThan(approved);

    resetAccessThrottle();
    const res = await callTool(app, nestId, dev.apiKey, "context_get", {
      id: nodeId,
      client: { agent: "support-agent" },
    });
    expect(res.isError).toBeFalsy();
    const text = res.content?.[0]?.text ?? "";
    expect(text).toContain("30 days");
    expect(text).not.toContain("90 days");

    await flushAccessLog();
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/activity-log?node=${encodeURIComponent(nodeId)}&agent=support-agent`,
      undefined,
      lead.apiKey,
    );
    expect(data.items[0]).toEqual(
      expect.objectContaining({ type: "read", agent: "support-agent", version: approved }),
    );
  });
});
