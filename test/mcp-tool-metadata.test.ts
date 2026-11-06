/**
 * What a person connecting a client reads: a plain title on every tool, a
 * useful description, and a description on every parameter, on every endpoint
 * and for every kind of key. A new tool or parameter without these fails here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";
import { SERVICE_VERSION } from "../src/shared/version.js";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

type Tool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: { title?: string };
  inputSchema: { properties?: Record<string, { description?: string }> };
};

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let ownerKey: string;
let readKey: string;
let headlessKey: string;
let nestId: string;

async function rpc(path: string, key: string, method: string, params: Record<string, unknown>) {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const line = raw.split("\n").find((l: string) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice("data: ".length) : raw).result;
}
const listTools = async (path: string, key: string): Promise<Tool[]> => (await rpc(path, key, "tools/list", {})).tools;

function endpoints(): Array<[string, string, string]> {
  return [
    ["owner, per-nest", `/nests/${nestId}/mcp`, ownerKey],
    ["owner, server-level", "/mcp", ownerKey],
    ["read-only key, per-nest", `/nests/${nestId}/mcp`, readKey],
    ["read-only key, server-level", "/mcp", readKey],
    ["headless key, per-nest", `/nests/${nestId}/mcp`, headlessKey],
    ["headless key, server-level", "/mcp", headlessKey],
  ];
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  env = setupTestEnv();
  app = await createTestApp("key");
  const owner = await registerUser(app, "owner@metadata.test", "Owner");
  await resetAuthRateLimit();
  ownerKey = owner.apiKey;
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Described" }, ownerKey)).data.nest.id;
  readKey = (await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: nestId, capability: "read" }, ownerKey)).data.api_key;
  expect(readKey).toBeTruthy();
  const { createHeadlessKey, setNestHeadless } = await import("../src/auth/headless.js");
  await setNestHeadless(nestId, true);
  headlessKey = ((await createHeadlessKey(nestId, "Buyer", owner.userId)) as any).apiKey;
  expect(headlessKey).toBeTruthy();
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  delete process.env.FEATURE_SURFACES;
  await env.cleanup();
});

describe("every listed tool", () => {
  it("covers every classified tool, so the checks below can't skip a flag-gated set", async () => {
    const { TOOL_CLASSIFICATION } = await import("../src/mcp/annotations.js");
    const listed = new Set([
      ...(await listTools(`/nests/${nestId}/mcp`, ownerKey)).map((t) => t.name),
      ...(await listTools("/mcp", ownerKey)).map((t) => t.name),
    ]);
    expect([...listed].sort()).toEqual(Object.keys(TOOL_CLASSIFICATION).sort());
  });

  it("has a plain 2-4 word title, at the top level and in annotations", async () => {
    for (const [label, path, key] of endpoints()) {
      const tools = await listTools(path, key);
      expect(tools.length, label).toBeGreaterThan(0);
      for (const t of tools) {
        const words = (t.title ?? "").trim().split(/\s+/).filter(Boolean).length;
        expect(words, `${label}: ${t.name} title "${t.title}"`).toBeGreaterThanOrEqual(2);
        expect(words, `${label}: ${t.name} title "${t.title}"`).toBeLessThanOrEqual(4);
        expect(t.title, `${label}: ${t.name}`).not.toMatch(/[_`]/);
        expect(t.annotations?.title, `${label}: ${t.name}`).toBe(t.title);
      }
    }
  });

  it("gives each tool its own title", async () => {
    const { TOOL_CLASSIFICATION } = await import("../src/mcp/annotations.js");
    const titles = Object.values(TOOL_CLASSIFICATION).map((c: any) => c.title);
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
  });

  it("has a description of at least 40 characters that opens with what it does", async () => {
    for (const [label, path, key] of endpoints()) {
      for (const t of await listTools(path, key)) {
        expect((t.description ?? "").length, `${label}: ${t.name}`).toBeGreaterThanOrEqual(40);
        // Opens with a verb, not a label like "Nest owners/admins:" or "The audit...".
        expect(t.description, `${label}: ${t.name}`).not.toMatch(/^(The|This|Your|Which|A|An|Full|History|Grounded|Nest owners|Proposals|Surfaces status|Deterministic)\b/);
      }
    }
  });

  it("describes every parameter", async () => {
    for (const [label, path, key] of endpoints()) {
      for (const t of await listTools(path, key)) {
        for (const [param, def] of Object.entries(t.inputSchema.properties ?? {})) {
          expect((def.description ?? "").trim(), `${label}: ${t.name}.${param}`).not.toBe("");
        }
      }
    }
  });
});

describe("confirm_billing", () => {
  // Written out, not read from the source, so widening the set is a decision.
  const CAN_RAISE_A_BILL = ["context_assign_steward", "context_grant", "context_resolve_access_request", "context_share_nest"];

  it("is offered only on the tools that can raise what someone is billed", async () => {
    for (const [label, path, key] of endpoints()) {
      for (const t of await listTools(path, key)) {
        const offered = "confirm_billing" in (t.inputSchema.properties ?? {});
        expect(offered, `${label}: ${t.name}`).toBe(CAN_RAISE_A_BILL.includes(t.name));
      }
    }
  });

  it("is still offered on each of those tools, for a nest owner", async () => {
    const tools = await listTools(`/nests/${nestId}/mcp`, ownerKey);
    for (const name of CAN_RAISE_A_BILL) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeTruthy();
      expect(tool!.inputSchema.properties?.confirm_billing?.description, name).toMatch(/billed/);
    }
  });

  it("is on no tool of the server-level endpoint, which has none of them", async () => {
    const tools = await listTools("/mcp", ownerKey);
    expect(tools.filter((t) => CAN_RAISE_A_BILL.includes(t.name))).toEqual([]);
    expect(tools.filter((t) => "confirm_billing" in (t.inputSchema.properties ?? {})).map((t) => t.name)).toEqual([]);
  });
});

describe("initialize", () => {
  it("names the server in words and reports its real version", async () => {
    for (const path of ["/mcp", `/nests/${nestId}/mcp`]) {
      const { serverInfo } = await rpc(path, ownerKey, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(serverInfo.title, path).toBe("ContextNest");
      expect(serverInfo.version, path).toBe(SERVICE_VERSION);
      expect(serverInfo.version, path).not.toBe("1.0.0");
    }
  });
});
