/**
 * Navigation rail color (PO-1430): a server-wide setting a server admin
 * changes in Server settings → Basic, readable by anyone (GET /health,
 * MCP context_appearance) and writable only by a server admin (PATCH
 * /admin/settings, MCP context_appearance_update). Unset = the built-in navy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed } from "./helpers.js";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let rpc = 1;
async function mcp(app: any, key: string, name: string, args: Record<string, unknown>) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(key) },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  return body.result as { content: Array<{ text: string }>; structuredContent?: any; isError?: boolean };
}

async function toolsList(app: any, key: string): Promise<Array<{ name: string; inputSchema: any; annotations?: any }>> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(key) },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/list", params: {} }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  return body.result.tools;
}

const health = async (app: any) => (await app.request("/health")).json();

let app: any;
let admin: { apiKey: string };
let member: { apiKey: string };

beforeEach(async () => {
  setupTestEnv();
  delete process.env.NAV_COLOR;
  app = await createTestApp("key", { ownerEmail: "admin@acme.com" });
  admin = await registerUser(app, "admin@acme.com");
  member = await registerUser(app, "member@acme.com");
});
afterEach(() => {
  delete process.env.NAV_COLOR;
});

describe("nav color over REST", () => {
  it("is unset on a fresh server: /health and /admin/settings report the default", async () => {
    expect((await health(app)).nav_color).toBeNull();
    const s = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(s.status).toBe(200);
    expect(s.data.nav_color).toBe("");
  });

  it("a server admin sets it; it is normalized, and everyone reads it from /health", async () => {
    const r = await jsonRequest(app, "PATCH", "/admin/settings", { nav_color: "#0F766E" }, admin.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.settings.nav_color).toBe("#0f766e");
    expect((await health(app)).nav_color).toBe("#0f766e");
    // A 3-digit hex expands.
    await jsonRequest(app, "PATCH", "/admin/settings", { nav_color: "#fd0" }, admin.apiKey);
    expect((await health(app)).nav_color).toBe("#ffdd00");
  });

  it("an empty value restores the default", async () => {
    await jsonRequest(app, "PATCH", "/admin/settings", { nav_color: "#7c3aed" }, admin.apiKey);
    const r = await jsonRequest(app, "PATCH", "/admin/settings", { nav_color: "" }, admin.apiKey);
    expect(r.status).toBe(200);
    expect((await health(app)).nav_color).toBeNull();
  });

  it.each(["teal", "#12345", "url(x)", "#0f766e; color: red", 42])(
    "refuses %s with a field error and stores nothing",
    async (bad) => {
      const r = await jsonRequest(app, "PATCH", "/admin/settings", { nav_color: bad, community_name: "Acme" }, admin.apiKey);
      expect(r.status).toBe(400);
      expect(r.data.fieldErrors?.nav_color).toMatch(/hex color/i);
      expect(process.env.NAV_COLOR).toBeUndefined();
      // The batch is all-or-nothing: the valid field alongside isn't saved either.
      expect(process.env.COMMUNITY_NAME).toBeUndefined();
    },
  );

  it("a non-admin cannot change it", async () => {
    const r = await jsonRequest(app, "PATCH", "/admin/settings", { nav_color: "#0f766e" }, member.apiKey);
    expect(r.status).toBe(403);
    expect((await health(app)).nav_color).toBeNull();
  });

  it("a hand-edited invalid env value reads as unset", async () => {
    process.env.NAV_COLOR = "javascript:alert(1)";
    expect((await health(app)).nav_color).toBeNull();
  });
});

describe("nav color over MCP (server-level /mcp)", () => {
  it("context_appearance reads it for any caller, a read-only key included", async () => {
    // A read-only key is always scoped to one nest; the server-level read still answers.
    const nest = await jsonRequest(app, "POST", "/nests", { name: "N" }, member.apiKey);
    const ro = await jsonRequest(app, "POST", "/auth/keys", { label: "ro", capability: "read", nest_id: nest.data.nest.id }, member.apiKey);
    expect(ro.status, JSON.stringify(ro.data)).toBeLessThan(300);
    const roKey = ro.data.key ?? ro.data.apiKey ?? ro.data.api_key;

    const before = await mcp(app, roKey, "context_appearance", {});
    expect(before.isError).toBeFalsy();
    expect(before.structuredContent).toMatchObject({
      nav_color: null,
      default_nav_color: "#11226a",
      effective_nav_color: "#11226a",
      foreground: "#ffffff",
    });

    process.env.NAV_COLOR = "#fde047";
    const after = await mcp(app, member.apiKey, "context_appearance", {});
    expect(after.structuredContent).toMatchObject({ nav_color: "#fde047", effective_nav_color: "#fde047", foreground: "#000000" });
  });

  it("context_appearance_update: a server admin writes it, the same as REST", async () => {
    const r = await mcp(app, admin.apiKey, "context_appearance_update", { nav_color: "#7C3AED" });
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    expect(r.structuredContent.nav_color).toBe("#7c3aed");
    expect((await health(app)).nav_color).toBe("#7c3aed");

    const reset = await mcp(app, admin.apiKey, "context_appearance_update", { nav_color: "" });
    expect(reset.structuredContent.nav_color).toBeNull();
    expect((await health(app)).nav_color).toBeNull();
  });

  it("context_appearance_update refuses an invalid color and a non-admin", async () => {
    const bad = await mcp(app, admin.apiKey, "context_appearance_update", { nav_color: "teal" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/hex color/i);
    expect(process.env.NAV_COLOR).toBeUndefined();

    const denied = await mcp(app, member.apiKey, "context_appearance_update", { nav_color: "#0f766e" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/server admin/i);
    expect((await health(app)).nav_color).toBeNull();
  });

  it("advertises both tools with generated schemas and the right hints", async () => {
    const tools = await toolsList(app, admin.apiKey);
    const read = tools.find((t) => t.name === "context_appearance");
    const write = tools.find((t) => t.name === "context_appearance_update");
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(write?.annotations?.readOnlyHint).toBe(false);
    expect(write?.inputSchema?.properties?.nav_color?.type).toBe("string");
    expect(write?.inputSchema?.required).toContain("nav_color");
  });
});
