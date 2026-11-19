/**
 * Pinned ("starred") nests over MCP (PO-1441): REST parity for the per-person
 * nest pin. `nest_index` reports `pinned` per nest (the list), `nest_pin`
 * pins or unpins (the write). A key pins for the person who owns it; the pin
 * stays private to that person, exactly as POST/DELETE /nests/:id/pin.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string };
let bob: { apiKey: string };
let dealId: string;
let notesId: string;
let bobsId: string;

const MCP_HEADERS = (key: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${key}`,
});

async function mcp(key: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: MCP_HEADERS(key),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line!.slice("data: ".length));
}

async function call(key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp(key, "tools/call", { name, arguments: args });
  expect(res.error).toBeUndefined();
  return {
    text: res.result.content.map((c: any) => c.text).join(""),
    data: res.result.structuredContent,
    isError: !!res.result.isError,
  };
}

const pinnedIn = async (key: string) => {
  const { data } = await call(key, "nest_index");
  return Object.fromEntries(data.nests.map((n: any) => [n.id, n.pinned]));
};

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  bob = await registerUser(app, "bob@acme.com", "Bob");
  dealId = (await jsonRequest(app, "POST", "/nests", { name: "Deal Brain" }, alice.apiKey)).data.nest.id;
  notesId = (await jsonRequest(app, "POST", "/nests", { name: "Field Notes" }, alice.apiKey)).data.nest.id;
  bobsId = (await jsonRequest(app, "POST", "/nests", { name: "Bob Secrets" }, bob.apiKey)).data.nest.id;
  // Bob reads Deal Brain, so the same nest is in both indexes.
  await jsonRequest(app, "POST", `/nests/${dealId}/collaborators`, { email: "bob@acme.com", permission: "read" }, alice.apiKey);
});

afterAll(() => env.cleanup());

describe("nest_pin / nest_index (PO-1441)", () => {
  it("advertises nest_pin with a generated schema", async () => {
    const res = await mcp(alice.apiKey, "tools/list");
    const tool = res.result.tools.find((t: any) => t.name === "nest_pin");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["nest"]);
    // Every tool also takes the optional attribution `client`.
    expect(Object.keys(tool.inputSchema.properties)).toEqual(expect.arrayContaining(["nest", "pinned"]));
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  it("nest_index reports pinned=false for every nest before anything is pinned", async () => {
    const pins = await pinnedIn(alice.apiKey);
    expect(pins[dealId]).toBe(false);
    expect(pins[notesId]).toBe(false);
  });

  it("pins by name, and REST and MCP agree", async () => {
    const res = await call(alice.apiKey, "nest_pin", { nest: "Field Notes" });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ nest: { id: notesId, name: "Field Notes" }, pinned: true });
    expect((await pinnedIn(alice.apiKey))[notesId]).toBe(true);
    const rest = await jsonRequest(app, "GET", "/nests", null, alice.apiKey);
    expect(rest.data.nests.find((n: any) => n.id === notesId).pinned).toBe(true);
    // The markdown index says so too, for chat clients.
    const { text } = await call(alice.apiKey, "nest_index");
    expect(text).toMatch(/## Field Notes\n\n- id: `[^`]+`\n- pinned: yes/);
    expect(text).not.toMatch(/## Deal Brain\n\n- id: `[^`]+`\n- pinned/);
  });

  it("unpins with pinned:false, idempotently", async () => {
    await call(alice.apiKey, "nest_pin", { nest: notesId, pinned: false });
    const again = await call(alice.apiKey, "nest_pin", { nest: notesId, pinned: false });
    expect(again.isError).toBe(false);
    expect(again.data.pinned).toBe(false);
    expect((await pinnedIn(alice.apiKey))[notesId]).toBe(false);
  });

  it("a pin set over REST shows in nest_index", async () => {
    await jsonRequest(app, "POST", `/nests/${dealId}/pin`, {}, alice.apiKey);
    expect((await pinnedIn(alice.apiKey))[dealId]).toBe(true);
  });

  it("is private to the key's owner", async () => {
    // Alice pinned Deal Brain above; Bob reads it but has not pinned it.
    expect((await pinnedIn(bob.apiKey))[dealId]).toBe(false);
    await call(bob.apiKey, "nest_pin", { nest: dealId });
    expect((await pinnedIn(bob.apiKey))[dealId]).toBe(true);
    await call(bob.apiKey, "nest_pin", { nest: dealId, pinned: false });
    expect((await pinnedIn(alice.apiKey))[dealId]).toBe(true);
  });

  it("refuses a nest the caller cannot read, without confirming it exists", async () => {
    const res = await call(alice.apiKey, "nest_pin", { nest: bobsId });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found/i);
    expect((await pinnedIn(bob.apiKey))[bobsId]).toBe(false);
  });

  it("refuses a read-only key", async () => {
    const ro = await jsonRequest(app, "POST", "/auth/keys", { label: "ro-pin", nest_id: notesId, capability: "read" }, alice.apiKey);
    expect(ro.status).toBeLessThan(300);
    // A read-only key is not even offered the tool; calling it anyway fails.
    const listed = await mcp(ro.data.api_key, "tools/list");
    expect(listed.result.tools.map((t: any) => t.name)).not.toContain("nest_pin");
    const res = await call(ro.data.api_key, "nest_pin", { nest: notesId });
    expect(res.isError).toBe(true);
    expect((await pinnedIn(alice.apiKey))[notesId]).toBe(false);
  });

  it("a nest-scoped key pins only its own nest", async () => {
    const scoped = await jsonRequest(app, "POST", "/auth/keys", { label: "scoped-pin", nest_id: dealId }, alice.apiKey);
    expect(scoped.status).toBeLessThan(300);
    const other = await call(scoped.data.api_key, "nest_pin", { nest: notesId });
    expect(other.isError).toBe(true);
    expect((await pinnedIn(alice.apiKey))[notesId]).toBe(false);
    const own = await call(scoped.data.api_key, "nest_pin", { nest: dealId, pinned: false });
    expect(own.isError).toBe(false);
    expect((await pinnedIn(alice.apiKey))[dealId]).toBe(false);
  });
});
