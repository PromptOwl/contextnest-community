/**
 * Superadmin activity trace: API requests and MCP tool calls land as rows in
 * api_events; GET /admin/trace exposes them to the server admin only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

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
