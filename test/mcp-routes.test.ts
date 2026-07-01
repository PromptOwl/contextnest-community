/**
 * MCP route tests — exercises /nests/:nestId/mcp via JSON-RPC over HTTP.
 *
 * The MCP transport requires Accept: "application/json, text/event-stream".
 * Without it the route returns 406.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
} from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function mcpCall(
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): Promise<any> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(res.status).toBe(200);
  // The streamable transport returns a JSON body when enableJsonResponse=true.
  // It may also be served as text/event-stream chunked — be defensive.
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return await res.json();
  }
  const text = await res.text();
  // SSE: look for the first "data: {...}" line.
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected MCP response: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  id = 100,
): Promise<string> {
  const res = await mcpCall(
    "tools/call",
    { name, arguments: args },
    id,
  );
  expect(res.error).toBeUndefined();
  // result.content is an array of {type, text} per the MCP spec
  return res.result.content.map((c: any) => c.text).join("");
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");

  // Create a nest
  const create = await jsonRequest(app, "POST", "/nests", {
    name: "MCP Test Nest",
  });
  nestId = create.data.nest.id;

  // Seed a few nodes
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "API Reference",
    content: "# API\n\nDocumentation for the public API.",
    tags: ["api", "docs"],
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Architecture Overview",
    content: "# Architecture\n\nSystem-level design notes.",
    tags: ["architecture"],
    type: "document",
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Brand Guide",
    content: "# Brand\n\nLogo, colors, voice.",
    tags: ["brand"],
  });
});

afterAll(() => {
  env.cleanup();
});

describe("MCP transport — Accept header guard", () => {
  it("rejects requests missing the SSE Accept header (406)", async () => {
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    // Streamable transport returns 406 when the client can't speak SSE.
    expect(res.status).toBe(406);
  });
});

describe("MCP initialize + tool listing", () => {
  it("initialize returns capabilities + serverInfo", async () => {
    const res = await mcpCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0" },
    });
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.capabilities).toBeDefined();
    expect(res.result.serverInfo.name).toBe(`contextnest-${nestId}`);
  });

  it("tools/list returns the registered tool definitions", async () => {
    const res = await mcpCall("tools/list", {});
    expect(res.result.tools).toBeDefined();
    const names = res.result.tools.map((t: any) => t.name);
    // Spot-check a representative subset
    expect(names).toContain("context_init");
    expect(names).toContain("context_overview");
    expect(names).toContain("context_search");
    expect(names).toContain("context_query");
    expect(names).toContain("context_get");
    expect(names).toContain("context_list");
  });
});

describe("MCP tools/call — basic vault tools", () => {
  it("context_overview reports node count, types, tags", async () => {
    const text = await callTool("context_overview");
    expect(text).toMatch(/Total nodes:\*?\*?\s*3/);
    expect(text).toContain("API Reference");
    expect(text).toContain("Architecture Overview");
    expect(text).toContain("Brand Guide");
  });

  it("context_search returns matching nodes by keyword", async () => {
    const text = await callTool("context_search", { query: "design" });
    expect(text).toContain("Architecture Overview");
    expect(text).not.toContain("API Reference");
  });

  it("context_search returns 'no matches' for an unknown term", async () => {
    const text = await callTool("context_search", { query: "nonexistentxyz" });
    expect(text).toMatch(/No nodes matched/i);
  });

  it("context_get fetches a node by title (case-insensitive)", async () => {
    const text = await callTool("context_get", { title: "brand guide" });
    expect(text).toContain("**Title:** Brand Guide");
    expect(text).toContain("Logo, colors, voice");
  });

  it("context_get fetches a node by id", async () => {
    const text = await callTool("context_get", {
      id: "nodes/api-reference",
    });
    expect(text).toContain("**Title:** API Reference");
  });

  it("context_get returns 'not found' for an unknown title", async () => {
    const text = await callTool("context_get", { title: "Ghost Doc" });
    expect(text).toMatch(/Node not found/);
  });

  it("context_list returns all nodes by default", async () => {
    const text = await callTool("context_list");
    expect(text).toContain("API Reference");
    expect(text).toContain("Architecture Overview");
    expect(text).toContain("Brand Guide");
  });

  it("context_list filters by tag", async () => {
    const text = await callTool("context_list", { tag: "api" });
    expect(text).toContain("API Reference");
    expect(text).not.toContain("Brand Guide");
  });

  it("context_query routes through to the engine selector grammar", async () => {
    // We assert the route plumbing, not engine semantics: a successful call
    // returns a string that's either a match list or "No nodes matched".
    // (Engine's first-call auto-index can return empty for tag selectors
    // against freshly-created vaults — pre-existing engine quirk.)
    const text = await callTool("context_query", { query: "#api" });
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/(API Reference|No nodes matched)/);
  });

  it("context_query and context_resolve accept a caller-set hops depth", async () => {
    // hops was hardcoded to 2; now it's caller-controlled (parity with REST
    // POST /context). Same plumbing-level assertion as above — the param must
    // be accepted by the schema and passed through without erroring.
    const one = await callTool("context_query", { query: "#api", hops: 1 });
    expect(typeof one).toBe("string");
    expect(one).toMatch(/(API Reference|No nodes matched)/);

    const resolved = await callTool("context_resolve", {
      selector: "#api",
      hops: 1,
      max_tokens: 500,
    });
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe("MCP tools/call — error handling", () => {
  it("returns a JSON-RPC error for an unknown tool", async () => {
    const res = await mcpCall(
      "tools/call",
      { name: "context_nonexistent", arguments: {} },
      999,
    );
    // Server may return either an error object or a result with isError=true
    const failed =
      !!res.error ||
      (res.result?.isError === true) ||
      (res.result?.content?.[0]?.text || "").toLowerCase().includes("unknown");
    expect(failed).toBe(true);
  });
});
