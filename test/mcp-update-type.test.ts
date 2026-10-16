/**
 * context_update accepts `type` — the MCP twin of REST PATCH `type` / the UI's
 * "Turn into". Re-typing keeps the node (and its version history); unknown
 * types are refused with a readable error. Both the per-nest and the
 * server-level /mcp endpoints.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string };
let nestId: string;

async function callTool(path: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${owner.apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  return { isError: !!body.result.isError, text: body.result.content.map((c: any) => c.text).join("") };
}

const seed = (title: string) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `# ${title}` }, owner.apiKey);
const read = async (id: string) =>
  (await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey)).data.node;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Retype" }, owner.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

describe("context_update type", () => {
  it("re-types in place on the per-nest endpoint, keeping content and history", async () => {
    expect((await seed("Per Nest Retype")).status).toBe(201);
    const versionsUrl = `/nests/${nestId}/nodes/nodes/per-nest-retype/versions`;
    const before = await jsonRequest(app, "GET", versionsUrl, undefined, owner.apiKey);
    const statusBefore = (await read("nodes/per-nest-retype")).status;
    const res = await callTool(`/nests/${nestId}/mcp`, "context_update", {
      title: "Per Nest Retype",
      type: "agent",
    });
    expect(res.isError).toBe(false);
    const node = await read("nodes/per-nest-retype");
    expect(node.type).toBe("agent");
    expect(node.content).toContain("# Per Nest Retype");
    // Governance: the re-type neither skips nor resets the node's status.
    expect(node.status).toBe(statusBefore);
    // History survives: earlier versions are still there, none dropped.
    const after = await jsonRequest(app, "GET", versionsUrl, undefined, owner.apiKey);
    expect(after.status).toBe(200);
    expect(after.data.versions.length).toBeGreaterThanOrEqual(before.data.versions.length);
  });

  it("re-types through the server-level /mcp endpoint with nest", async () => {
    expect((await seed("Server Retype")).status).toBe(201);
    const res = await callTool("/mcp", "context_update", { nest: "Retype", title: "Server Retype", type: "agent" });
    expect(res.isError).toBe(false);
    expect((await read("nodes/server-retype")).type).toBe("agent");
  });

  it("rejects an unknown type with a readable error and leaves the node alone", async () => {
    expect((await seed("Bad Retype")).status).toBe(201);
    const res = await callTool(`/nests/${nestId}/mcp`, "context_update", { title: "Bad Retype", type: "nonsense" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('unknown node type "nonsense"');
    expect((await read("nodes/bad-retype")).type).toBe("document");
  });
});
