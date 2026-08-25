/**
 * Superadmin activity trace: API requests and MCP tool calls land as rows in
 * api_events; GET /admin/trace exposes them to the server admin only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { handleToolCall } from "../src/mcp/tools.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let admin: { apiKey: string; userId: string; email: string };
let user: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["admin@acme.com"] });
  admin = await registerUser(app, "admin@acme.com", "Admin");
  user = await registerUser(app, "user@acme.com", "User");

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Traced" }, user.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Doc", content: "# Doc" },
    user.apiKey,
  );

  // One MCP tool call so a kind=mcp row exists.
  await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${user.apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_overview", arguments: {} },
    }),
  });
});

afterAll(() => env.cleanup());

describe("GET /admin/trace", () => {
  it("is server-admin only", async () => {
    const res = await jsonRequest(app, "GET", "/admin/trace", undefined, user.apiKey);
    expect(res.status).toBe(403);
  });

  it("returns API rows with method, path, nest, status, duration", async () => {
    const res = await jsonRequest(app, "GET", "/admin/trace", undefined, admin.apiKey);
    expect(res.status).toBe(200);
    const apiRow = res.data.events.find(
      (e: any) => e.kind === "api" && e.path === `/nests/${nestId}/nodes` && e.method === "POST",
    );
    expect(apiRow).toBeTruthy();
    expect(apiRow.nest_id).toBe(nestId);
    expect(apiRow.status).toBe(201);
    expect(apiRow.caller).toBe(user.email);
    expect(typeof apiRow.duration_ms).toBe("number");
  });

  it("returns MCP tool rows and supports kind filtering", async () => {
    const res = await jsonRequest(app, "GET", "/admin/trace?kind=mcp", undefined, admin.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.events.length).toBeGreaterThan(0);
    expect(res.data.events.every((e: any) => e.kind === "mcp")).toBe(true);
    const toolRow = res.data.events.find((e: any) => e.tool === "context_overview");
    expect(toolRow).toBeTruthy();
    expect(toolRow.nest_id).toBe(nestId);
    expect(toolRow.caller).toBe(user.email);
    // Successful tool call records status 200 (logged inside handleToolCall).
    expect(toolRow.status).toBe(200);
  });

  it("audits a throwing tool call with status 500", async () => {
    // A tool that throws (rather than returning an error string) must still
    // land an audit row — handleToolCall logs in a finally block.
    const throwingCtx = {
      storage: {
        discoverDocuments: async () => {
          throw new Error("boom");
        },
      },
      queryEngine: {},
      versionManager: {},
      nestId: "throw-nest",
      userId: user.userId,
      userEmail: user.email,
    } as any;
    // context_search, because it still reads ctx.storage directly — which is
    // what the injected throw above hooks. context_overview used to and no
    // longer does; the tool here is only a vehicle for "a tool threw".
    await expect(
      handleToolCall("context_search", { query: "anything" }, throwingCtx),
    ).rejects.toThrow("boom");
    // Trace write is fire-and-forget — let the microtask/insert flush.
    await new Promise((r) => setTimeout(r, 100));
    const res = await jsonRequest(app, "GET", "/admin/trace?kind=mcp", undefined, admin.apiKey);
    const row = res.data.events.find((e: any) => e.nest_id === "throw-nest");
    expect(row).toBeTruthy();
    expect(row.tool).toBe("context_search");
    expect(row.status).toBe(500);
  });

  it("clamps a malformed ?limit instead of 500ing", async () => {
    const res = await jsonRequest(app, "GET", "/admin/trace?limit=abc", undefined, admin.apiKey);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.events)).toBe(true);
  });

  it("paginates with limit/offset and reports a total", async () => {
    const p1 = await jsonRequest(app, "GET", "/admin/trace?limit=1&offset=0", undefined, admin.apiKey);
    expect(p1.status).toBe(200);
    expect(p1.data.events.length).toBe(1); // page capped to the limit
    expect(p1.data.limit).toBe(1);
    expect(p1.data.offset).toBe(0);
    // More than one row exists (setup made several API + MCP calls), so total
    // exceeds a single page. (Each GET /admin/trace also self-logs a row, so
    // cross-request row identity isn't stable — assert on offset bounds only.)
    expect(p1.data.total).toBeGreaterThan(1);

    // An offset past the end returns an empty page but still the full total,
    // which proves OFFSET is applied to the query.
    const beyond = await jsonRequest(app, "GET", "/admin/trace?limit=5&offset=100000", undefined, admin.apiKey);
    expect(beyond.status).toBe(200);
    expect(beyond.data.events.length).toBe(0);
    expect(beyond.data.total).toBeGreaterThan(1);
  });

  it("filters by user", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/admin/trace?user=${encodeURIComponent(user.email)}`,
      undefined,
      admin.apiKey,
    );
    expect(res.data.events.length).toBeGreaterThan(0);
    expect(res.data.events.every((e: any) => e.caller === user.email)).toBe(true);
  });
});
