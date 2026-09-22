/**
 * Multi-nest writes (Stacey's partner-nest bug): update/delete must work on
 * EVERY nest the caller can write, not just the first one — through the
 * per-nest endpoint and the server-level /mcp endpoint alike.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let stacey: { apiKey: string };
const nests: Record<string, string> = {};

async function callTool(path: string, key: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  if (body.error) return { isError: true, text: JSON.stringify(body.error) };
  return { isError: !!body.result.isError, text: body.result.content.map((c: any) => c.text).join("") };
}

async function seed(nestId: string, key: string, title: string) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: "# v1\n\nOriginal.", tags: ["old"] }, key);
  expect(r.status).toBeLessThan(300);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  stacey = await registerUser(app, "stacey@acme.com", "Stacey");
  const partner = await registerUser(app, "partner@acme.com", "Partner");

  for (const name of ["Strategy", "Partner Alpha", "Partner Beta"]) {
    const r = await jsonRequest(app, "POST", "/nests", { name }, stacey.apiKey);
    nests[name] = r.data.nest.id;
  }
  // A nest someone else owns, shared to Stacey with write.
  const shared = await jsonRequest(app, "POST", "/nests", { name: "Partner Shared" }, partner.apiKey);
  nests["Partner Shared"] = shared.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nests["Partner Shared"]}/collaborators`, { email: "stacey@acme.com", permission: "write" }, partner.apiKey);
});

afterAll(() => env.cleanup());

describe.each(["Strategy", "Partner Alpha", "Partner Beta", "Partner Shared"])("nest %s", (name) => {
  it("per-nest /nests/:id/mcp — update then delete", async () => {
    const id = nests[name];
    const key = stacey.apiKey;
    await seed(id, key, "Per Nest Doc");
    const up = await callTool(`/nests/${id}/mcp`, key, "context_update", { title: "Per Nest Doc", content: "# v2\n\nChanged." });
    expect(up.isError).toBe(false);
    const del = await callTool(`/nests/${id}/mcp`, key, "context_delete", { title: "Per Nest Doc" });
    expect(del.isError).toBe(false);
  });

  it("server-level /mcp with nest=<name> — update then delete", async () => {
    const id = nests[name];
    await seed(id, stacey.apiKey, "Server Doc");
    const up = await callTool("/mcp", stacey.apiKey, "context_update", { nest: name, title: "Server Doc", content: "# v2\n\nChanged." });
    expect(up.text).not.toMatch(/not found|not accessible|requires/i);
    const del = await callTool("/mcp", stacey.apiKey, "context_delete", { nest: name, title: "Server Doc" });
    expect(del.text).not.toMatch(/not found|not accessible|requires/i);
  });
});
