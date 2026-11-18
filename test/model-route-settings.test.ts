/**
 * po-1419: the per-server fallback setting `model_fallback_promptowl`.
 * Default on; a server admin turns it off for byok servers that must not send
 * content to PromptOwl. REST (/admin/settings) and MCP (context_model_route_*)
 * read and write the same setting.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const ROOT = "root@route.test";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: { apiKey: string; userId: string; email: string };
let member: { apiKey: string; userId: string; email: string };
let nestId: string;
let readKey: string;

async function call(name: string, args: Record<string, unknown>, key: string) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(((await res.text()).split("\n").find((l: string) => l.startsWith("data: ")) ?? "data: {}").slice(6));
  return {
    isError: !!body?.result?.isError || !!body?.error,
    text: (body?.error?.message ?? (body?.result?.content ?? []).map((p: any) => p?.text ?? "").join("")) as string,
    data: body?.result?.structuredContent as any,
  };
}

beforeAll(async () => {
  env = setupTestEnv();
  delete process.env.MODEL_FALLBACK_PROMPTOWL;
  app = await createTestApp("key", {
    superAdmins: [ROOT],
    features: ["byok"],
    gateway: { baseUrl: "http://127.0.0.1:9", key: "sk-po", defaultModel: "default-claude/claude-sonnet-5" },
  });
  root = await registerUser(app, ROOT, "Root");
  member = await registerUser(app, "member@route.test", "Member");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Route" }, root.apiKey)).data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "member@route.test", permission: "admin" }, root.apiKey);
  const key = await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: nestId, capability: "read" }, root.apiKey);
  readKey = key.data.key ?? key.data.api_key ?? key.data.apiKey;
});
afterAll(() => {
  delete process.env.MODEL_FALLBACK_PROMPTOWL;
  env.cleanup();
});

describe("model_fallback_promptowl over REST", () => {
  it("defaults to on, with the licence gateway reported as available", async () => {
    const r = await jsonRequest(app, "GET", "/admin/settings", undefined, root.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.model_fallback_promptowl).toBe(true);
    expect(r.data.model_fallback_available).toBe(true);
  });

  it("a server admin turns it off and on; a bad value is refused field-keyed; a non-admin is refused", async () => {
    const off = await jsonRequest(app, "PATCH", "/admin/settings", { model_fallback_promptowl: false }, root.apiKey);
    expect(off.status).toBe(200);
    expect(off.data.settings?.model_fallback_promptowl ?? off.data.model_fallback_promptowl).toBe(false);
    expect(process.env.MODEL_FALLBACK_PROMPTOWL).toBe("false");
    const bad = await jsonRequest(app, "PATCH", "/admin/settings", { model_fallback_promptowl: "yes" }, root.apiKey);
    expect(bad.status).toBe(400);
    expect(bad.data.fieldErrors?.model_fallback_promptowl).toBeTruthy();
    const denied = await jsonRequest(app, "PATCH", "/admin/settings", { model_fallback_promptowl: true }, member.apiKey);
    expect(denied.status).toBe(403);
    expect(process.env.MODEL_FALLBACK_PROMPTOWL).toBe("false");
    const on = await jsonRequest(app, "PATCH", "/admin/settings", { model_fallback_promptowl: true }, root.apiKey);
    expect(on.status).toBe(200);
    expect(process.env.MODEL_FALLBACK_PROMPTOWL).toBe("true");
  });
});

describe("model_fallback_promptowl over MCP (parity)", () => {
  it("context_model_route_get / _update read and write the same setting REST shows", async () => {
    const got = await call("context_model_route_get", {}, root.apiKey);
    expect(got.isError, got.text).toBe(false);
    expect(got.data).toMatchObject({ model_fallback_promptowl: true, model_fallback_available: true });
    const off = await call("context_model_route_update", { model_fallback_promptowl: false }, root.apiKey);
    expect(off.isError, off.text).toBe(false);
    expect(off.data.model_fallback_promptowl).toBe(false);
    expect((await jsonRequest(app, "GET", "/admin/settings", undefined, root.apiKey)).data.model_fallback_promptowl).toBe(false);
    const bad = await call("context_model_route_update", { model_fallback_promptowl: "no" }, root.apiKey);
    expect(bad.isError).toBe(true);
    await call("context_model_route_update", { model_fallback_promptowl: true }, root.apiKey);
    expect((await jsonRequest(app, "GET", "/admin/settings", undefined, root.apiKey)).data.model_fallback_promptowl).toBe(true);
  });

  it("a nest admin who is not a server admin, and a read-only key, are refused", async () => {
    const nestAdmin = await call("context_model_route_update", { model_fallback_promptowl: false }, member.apiKey);
    expect(nestAdmin.isError).toBe(true);
    const ro = await call("context_model_route_update", { model_fallback_promptowl: false }, readKey);
    expect(ro.isError).toBe(true);
    expect(process.env.MODEL_FALLBACK_PROMPTOWL).toBe("true");
  });
});
