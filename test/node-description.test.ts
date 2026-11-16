/**
 * CU-wdqcq05raw — a node's frontmatter `description` (the one-line summary the
 * public docs site uses as a page's meta description) can be set and cleared
 * through REST PATCH and MCP context_update, per-nest and server-level.
 * Before this, no API surface could write it, so most docs pages fell back to
 * a description cut from the body.
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
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `# ${title}\n\nBody text.` }, owner.apiKey);
const read = async (id: string) =>
  (await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey)).data.node;
const raw = async (id: string) =>
  (await app.request(`http://localhost/nests/${nestId}/nodes/${id}?format=raw&frontmatter=1`, {
    headers: { Authorization: `Bearer ${owner.apiKey}` },
  })).text();

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@desc.test", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Describe Docs" }, owner.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

describe("node description", () => {
  it("REST PATCH sets it in frontmatter, leaves the body alone, and an empty string clears it", async () => {
    expect((await seed("Rest Desc")).status).toBe(201);
    const set = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/rest-desc`, { description: "  A short summary.  " }, owner.apiKey);
    expect(set.status, JSON.stringify(set.data)).toBe(200);
    expect(set.data.node.description).toBe("A short summary.");
    const node = await read("nodes/rest-desc");
    expect(node.description).toBe("A short summary.");
    expect(node.content).toContain("Body text.");
    expect(await raw("nodes/rest-desc")).toMatch(/^description: A short summary\.$/m);

    const cleared = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/rest-desc`, { description: "" }, owner.apiKey);
    expect(cleared.status).toBe(200);
    expect((await read("nodes/rest-desc")).description ?? null).toBeNull();
  });

  it("REST PATCH refuses a non-string or over-long description", async () => {
    expect((await seed("Bad Desc")).status).toBe(201);
    const num = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/bad-desc`, { description: 5 }, owner.apiKey);
    expect(num.status).toBe(400);
    const long = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/bad-desc`, { description: "x".repeat(501) }, owner.apiKey);
    expect(long.status).toBe(400);
    const multi = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/bad-desc`, { description: "one\ntwo" }, owner.apiKey);
    expect(multi.status).toBe(400);
    expect((await read("nodes/bad-desc")).description ?? null).toBeNull();
  });

  it("MCP context_update sets it on the per-nest and the server-level endpoint", async () => {
    expect((await seed("Mcp Desc")).status).toBe(201);
    const a = await callTool(`/nests/${nestId}/mcp`, "context_update", { id: "nodes/mcp-desc", description: "From MCP." });
    expect(a.isError, a.text).toBe(false);
    expect((await read("nodes/mcp-desc")).description).toBe("From MCP.");
    const b = await callTool("/mcp", "context_update", { nest: "Describe Docs", id: "nodes/mcp-desc", description: "From server MCP." });
    expect(b.isError, b.text).toBe(false);
    expect((await read("nodes/mcp-desc")).description).toBe("From server MCP.");
    const bad = await callTool(`/nests/${nestId}/mcp`, "context_update", { id: "nodes/mcp-desc", description: "x".repeat(501) });
    expect(bad.isError).toBe(true);
  });

  it("context_update advertises description in its input schema", async () => {
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${owner.apiKey}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
    const tool = body.result.tools.find((t: any) => t.name === "context_update");
    expect(tool.inputSchema.properties.description.type).toBe("string");
  });
});
