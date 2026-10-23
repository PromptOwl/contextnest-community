/**
 * Metacognition over MCP in open mode (CU-wdqcq05rqq): with no auth, the
 * anonymous caller is the owner everywhere, so the server-level /mcp offers
 * the metacognition tools and they work on a named nest.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;

async function mcp(method: string, params: Record<string, unknown>) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const line = (await res.text()).split("\n").find((l: string) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : {};
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  env = setupTestEnv();
  app = await createTestApp("open");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Open Meta" })).data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Archivist", content: "Keep gtm current.", type: "agent" });
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  await env.cleanup();
});

describe("open mode, server-level /mcp", () => {
  it("offers the metacognition tools and serves them on a named nest", async () => {
    const names = ((await mcp("tools/list", {})).result?.tools ?? []).map((t: any) => t.name);
    expect(names).toContain("context_metacognition_configure");
    const r = await mcp("tools/call", {
      name: "context_metacognition_configure",
      arguments: { nest: nestId, agent: "nodes/archivist", persona: { name: "Archivist" }, dry_run: true },
    });
    expect(r.result?.isError).not.toBe(true);
    expect(r.result.structuredContent.summary).toContain("Archivist will read the whole nest");
  });
});
