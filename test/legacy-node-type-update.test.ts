/**
 * Updating a node whose stored frontmatter `type` is one this server no longer
 * accepts (a "legacy" type, e.g. `policy`, written before the create-time gate
 * existed) used to die inside the engine write — `assertValid` rejects the
 * frontmatter — and surface as the generic 500 "Couldn't save your changes".
 * Even a no-op PATCH echoing the node's current content failed.
 *
 * Now the service refuses the write up front with a 400 that names the legacy
 * type and says how to migrate it (send an accepted `type` in the same PATCH),
 * and that migrating PATCH goes through. Accepted types are unaffected.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Legacy" }, owner.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env?.cleanup?.());

const create = (title: string, extra: Record<string, unknown> = {}) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `# ${title}`, ...extra }, owner.apiKey);
const patch = (id: string, body: Record<string, unknown>) =>
  jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, body, owner.apiKey);
const read = async (id: string) => {
  const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
  expect(res.status).toBe(200);
  return res.data.node ?? res.data;
};

/** Plant a legacy-typed node the way old data got there: create normally,
 *  then rewrite the frontmatter `type` straight through storage, bypassing
 *  the create-time type gate. */
async function plantLegacyNode(title: string, type: string): Promise<string> {
  expect((await create(title)).status).toBe(201);
  const id = `nodes/${title.toLowerCase().replace(/\s+/g, "-")}`;
  const { engineCache } = await import("../src/nodes/engine.js");
  const { serializeDocument } = await import("@promptowl/contextnest-engine");
  const { storage } = await engineCache.get(nestId);
  const node = await storage.readDocument(id);
  await storage.writeDocument(
    id,
    serializeDocument({ ...node, frontmatter: { ...node.frontmatter, type: type as any } }),
  );
  expect((await read(id)).type).toBe(type);
  return id;
}

describe("updating a node with a legacy (no longer accepted) type", () => {
  it("content-only PATCH → 400 naming the legacy type and the migration, not a 500", async () => {
    const id = await plantLegacyNode("Trust Injection Defense", "policy");
    // Before the guard this reached the engine and logged
    //   "updateNode failed (…): ContextNestError: Document validation failed:
    //    Invalid enum value. Expected 'document' | … | 'table', received 'policy'"
    // — the write must now be refused before any engine fault is logged.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const current = (await read(id)).content;
    const res = await patch(id, { content: current });
    const engineFaults = errors.mock.calls.filter((c) => /updateNode failed/.test(String(c[0])));
    errors.mockRestore();
    expect(engineFaults).toEqual([]);
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/legacy type "policy"/);
    expect(String(res.data.error)).toMatch(/"type": "<accepted type>"/);
    expect(String(res.data.error)).toMatch(/allowed: .*document/);
    // The node is untouched.
    expect((await read(id)).type).toBe("policy");
  });

  it("append-only PATCH is refused the same way", async () => {
    const id = await plantLegacyNode("Legacy Append", "policy");
    const res = await patch(id, { append: "more" });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/legacy type "policy"/);
  });

  it("PATCH carrying an accepted type migrates the node and saves the content", async () => {
    const id = await plantLegacyNode("Legacy Migrate", "policy");
    const res = await patch(id, { content: "# Legacy Migrate\n\nmigrated", type: "document" });
    expect(res.status).toBe(200);
    const node = await read(id);
    expect(node.type).toBe("document");
    expect(node.content).toContain("migrated");
    // And from here on ordinary saves work again.
    expect((await patch(id, { content: "# Legacy Migrate\n\nagain" })).status).toBe(200);
  });

  it("PATCH echoing the legacy type back is not a migration → same 400", async () => {
    const id = await plantLegacyNode("Legacy Echo", "policy");
    const res = await patch(id, { content: "# Legacy Echo\n\nx", type: "policy" });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/legacy type "policy"/);
    expect((await read(id)).type).toBe("policy");
  });

  it("PATCH re-typing a legacy node to another unknown type is still a 400 (unknown node type)", async () => {
    const id = await plantLegacyNode("Legacy Bogus", "policy");
    const res = await patch(id, { type: "spreadsheet" });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/unknown node type/i);
    expect((await read(id)).type).toBe("policy");
  });

  it("MCP context_update goes through the same guard and answers with the message", async () => {
    const id = await plantLegacyNode("Legacy Mcp", "policy");
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${owner.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "context_update", arguments: { id, content: "# Legacy Mcp\n\nvia mcp" } },
      }),
    });
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("application/json")
      ? await res.json()
      : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
    expect(body.result.isError).toBe(true);
    const text = body.result.content.map((c: any) => c.text ?? "").join("\n");
    expect(text).toMatch(/legacy type "policy"/);
    expect(text).not.toMatch(/Couldn't save your changes/);
    expect((await read(id)).type).toBe("policy");
  });

  it("an accepted type is unaffected", async () => {
    expect((await create("Plain Doc")).status).toBe(201);
    const res = await patch("nodes/plain-doc", { content: "# Plain Doc\n\nedited" });
    expect(res.status).toBe(200);
    expect((await read("nodes/plain-doc")).content).toContain("edited");
  });
});
