/**
 * Message log over MCP — `message_log_search` / `message_log_get` on the
 * server-level /mcp endpoint. Same rule as REST /admin/messages:
 *   - superadmin only: unlisted AND refused for a nest admin; never in open mode
 *   - every call by a superadmin writes a message_log_views row (via: "mcp")
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const MCP_HEADERS = (key?: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  ...(key ? { Authorization: `Bearer ${key}` } : {}),
});

async function rpc(app: any, key: string | undefined, method: string, params: Record<string, unknown> = {}) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: MCP_HEADERS(key),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  const line = text.split("\n").find((l: string) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : { status: res.status, text };
}

const toolNames = (body: any): string[] => (body?.result?.tools ?? []).map((t: any) => t.name);
const refused = (body: any) =>
  !!body?.error || body?.result?.isError === true || body?.status >= 400;

async function viewRows() {
  const { getDb } = await import("../src/db/client.js");
  return (await getDb().all("SELECT action, filters_json, message_id FROM message_log_views ORDER BY at")) as Array<{
    action: string;
    filters_json: string | null;
    message_id: string | null;
  }>;
}

describe("message log over MCP (key mode)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let root: { apiKey: string; userId: string; email: string };
  let owner: { apiKey: string; userId: string; email: string };
  let admin: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let messageId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
    root = await registerUser(app, "root@acme.com", "Root");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    admin = await registerUser(app, "admin@acme.com", "Admin");
    await resetAuthRateLimit();
    const created = await jsonRequest(app, "POST", "/nests", { name: "Ops" }, owner.apiKey);
    nestId = created.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: admin.email, permission: "admin" }, owner.apiKey);
    const { insertNotification } = await import("../src/notify/inbox.js");
    await insertNotification(
      { nestId, userEmail: admin.email, kind: "assigned", subjectId: "nodes/plan", message: 'owner assigned you "Plan"' },
      { from: owner.email, nodeId: "nodes/plan" },
    );
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get("SELECT id FROM outbound_messages WHERE subject = 'assigned'")) as { id: string };
    messageId = row.id;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("lists the tools to a superadmin only", async () => {
    expect(toolNames(await rpc(app, root.apiKey, "tools/list"))).toEqual(
      expect.arrayContaining(["message_log_search", "message_log_get"]),
    );
    for (const who of [owner, admin]) {
      const names = toolNames(await rpc(app, who.apiKey, "tools/list"));
      expect(names).toContain("nest_index");
      expect(names).not.toContain("message_log_search");
      expect(names).not.toContain("message_log_get");
    }
  });

  it("refuses a nest admin who calls them anyway, and leaves no audit row", async () => {
    const before = (await viewRows()).length;
    for (const [name, args] of [
      ["message_log_search", {}],
      ["message_log_get", { id: messageId }],
    ] as const) {
      const body = await rpc(app, admin.apiKey, "tools/call", { name, arguments: args });
      expect(refused(body)).toBe(true);
      expect(JSON.stringify(body)).not.toContain("Plan");
    }
    expect((await viewRows()).length).toBe(before);
  });

  it("serves a superadmin and audits each call as mcp", async () => {
    const before = (await viewRows()).length;
    const search = await rpc(app, root.apiKey, "tools/call", {
      name: "message_log_search",
      arguments: { channel: "inbox", q: "admin@acme.com" },
    });
    expect(search.result.isError).toBeFalsy();
    const found = search.result.structuredContent.messages.find((m: any) => m.id === messageId);
    expect(found).toMatchObject({ channel: "inbox", sender: owner.email, recipients: [admin.email] });
    expect(found.body).toBeUndefined();

    const one = await rpc(app, root.apiKey, "tools/call", { name: "message_log_get", arguments: { id: messageId } });
    expect(one.result.structuredContent.message.body).toBe('owner assigned you "Plan"');

    const rows = (await viewRows()).slice(before);
    expect(rows.map((r) => r.action)).toEqual(["list", "detail"]);
    expect(JSON.parse(rows[0].filters_json!)).toMatchObject({ via: "mcp", channel: "inbox" });
    expect(rows[1].message_id).toBe(messageId);
  });
});

describe("message log over MCP (open mode)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("is never offered or served, though every caller is admin there", async () => {
    expect(toolNames(await rpc(app, undefined, "tools/list"))).not.toContain("message_log_search");
    const body = await rpc(app, undefined, "tools/call", { name: "message_log_search", arguments: {} });
    expect(refused(body)).toBe(true);
    expect((await viewRows()).length).toBe(0);
  });
});
