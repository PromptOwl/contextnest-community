/**
 * Agent entry point: /llms.txt (public manual), /index (person nest index),
 * and the server-level /mcp endpoint (nest_index + cross-nest read tools).
 * One URL + one key → see and read everything the key allows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let bob: { apiKey: string; userId: string; email: string };
let nestId: string;
let privateNestId: string;

const MCP_HEADERS = (key?: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  ...(key ? { Authorization: `Bearer ${key}` } : {}),
});

async function mcpCall(
  key: string,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): Promise<any> {
  const res = await app.request(`/mcp`, {
    method: "POST",
    headers: MCP_HEADERS(key),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected MCP response: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function callTool(
  key: string,
  name: string,
  args: Record<string, unknown> = {},
  id = 100,
): Promise<string> {
  const res = await mcpCall(key, "tools/call", { name, arguments: args }, id);
  expect(res.error).toBeUndefined();
  return res.result.content.map((c: any) => c.text).join("");
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  bob = await registerUser(app, "bob@acme.com", "Bob");

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Deal Brain" }, alice.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Win Loss Log", content: "# Log\n\nWhy we win.", tags: ["gtm"] },
    alice.apiKey,
  );

  const priv = await jsonRequest(app, "POST", "/nests", { name: "Bob Secrets" }, bob.apiKey);
  privateNestId = priv.data.nest.id;
});

afterAll(() => env.cleanup());

describe("GET /llms.txt — public agent manual", () => {
  it("serves the manual without auth and covers the interaction surface", async () => {
    const res = await app.request("/llms.txt");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Deterministic retrieval");
    expect(text).toContain("hops");
    expect(text).toContain("Skip logic");
    expect(text).toContain("/mcp");
    expect(text).toContain("ctx push");
    expect(text).toContain("@promptowl/contextnest-cli");
  });
});

describe("GET /index — person nest index", () => {
  it("requires credentials in key mode", async () => {
    const res = await app.request("/index");
    expect(res.status).toBe(401);
  });

  it("returns the caller's nests as markdown", async () => {
    const res = await app.request("/index", {
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Deal Brain");
    expect(text).toContain(nestId);
    // Bob's private nest must not appear in Alice's index.
    expect(text).not.toContain("Bob Secrets");
  });

  it("supports format=json with permission + document count", async () => {
    const res = await jsonRequest(app, "GET", "/index?format=json", undefined, alice.apiKey);
    expect(res.status).toBe(200);
    const mine = res.data.nests.find((n: any) => n.id === nestId);
    expect(mine.permission).toBe("owner");
    expect(mine.document_count).toBeGreaterThanOrEqual(1);
  });
});

describe("server-level /mcp — one connection, all nests", () => {
  it("lists nest_index and nest-parameterized read tools", async () => {
    const res = await mcpCall(alice.apiKey, "tools/list", {});
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("nest_index");
    expect(names).toContain("context_query");
    expect(names).toContain("context_get");
    expect(names).toContain("context_resolve");
    // Server-level endpoint is read-only — no write/governance tools.
    expect(names).not.toContain("context_create");
    expect(names).not.toContain("context_approve");
  });

  it("nest_index returns the grounded index", async () => {
    const text = await callTool(alice.apiKey, "nest_index");
    expect(text).toContain("Deal Brain");
    expect(text).toContain(nestId);
    expect(text).not.toContain("Bob Secrets");
  });

  it("context_get reads from a nest referenced by NAME", async () => {
    const text = await callTool(alice.apiKey, "context_get", {
      nest: "Deal Brain",
      title: "Win Loss Log",
    });
    expect(text).toContain("Why we win.");
  });

  it("denies inaccessible nests with the SAME message as unknown ones", async () => {
    // No existence oracle: no-access and nonexistent are indistinguishable.
    const denied = await callTool(alice.apiKey, "context_get", {
      nest: privateNestId,
      title: "anything",
    });
    const unknown = await callTool(alice.apiKey, "context_list", {
      nest: "no-such-nest",
    });
    expect(denied).toMatch(/not found or not accessible/i);
    expect(unknown).toMatch(/not found or not accessible/i);
    expect(denied.replace(privateNestId, "X")).toBe(
      unknown.replace("no-such-nest", "X"),
    );
  });

  it("resolves a colliding nest NAME to the caller's own nest", async () => {
    // Bob creates a nest with the SAME name as Alice's. Name/slug are unique
    // only per-owner, so a global lookup would now be ambiguous — Alice's
    // name-based resolution must still land on HER "Deal Brain", and Bob must
    // never reach Alice's content through the shared name.
    await jsonRequest(app, "POST", "/nests", { name: "Deal Brain" }, bob.apiKey);

    const aliceView = await callTool(alice.apiKey, "context_get", {
      nest: "Deal Brain",
      title: "Win Loss Log",
    });
    expect(aliceView).toContain("Why we win.");

    const bobView = await callTool(bob.apiKey, "context_get", {
      nest: "Deal Brain",
      title: "Win Loss Log",
    });
    // Bob's same-named nest is empty; he must not see Alice's node.
    expect(bobView).not.toContain("Why we win.");
  });
});

describe("nest-scoped API key — index and cross-nest calls stay scoped", () => {
  let carol: { apiKey: string; userId: string; email: string };
  let scopedKey: string;
  let scopedNestId: string;
  let otherNestId: string;

  beforeAll(async () => {
    carol = await registerUser(app, "carol@acme.com", "Carol");
    const a = await jsonRequest(app, "POST", "/nests", { name: "Carol Scoped" }, carol.apiKey);
    scopedNestId = a.data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${scopedNestId}/nodes`,
      { title: "Scoped Doc", content: "# Scoped\n\nInside scope." },
      carol.apiKey,
    );
    const b = await jsonRequest(app, "POST", "/nests", { name: "Carol Other" }, carol.apiKey);
    otherNestId = b.data.nest.id;

    // Rotate Carol's key so it is scoped to the first nest only.
    const rot = await jsonRequest(
      app,
      "POST",
      "/auth/keys/rotate",
      { nest_id: scopedNestId },
      carol.apiKey,
    );
    scopedKey = rot.data.api_key;
  });

  it("GET /index shows only the scoped nest", async () => {
    const res = await jsonRequest(app, "GET", "/index?format=json", undefined, scopedKey);
    expect(res.status).toBe(200);
    const ids = res.data.nests.map((n: any) => n.id);
    expect(ids).toContain(scopedNestId);
    expect(ids).not.toContain(otherNestId);
  });

  it("nest_index lists only the scoped nest", async () => {
    const text = await callTool(scopedKey, "nest_index");
    expect(text).toContain("Carol Scoped");
    expect(text).not.toContain("Carol Other");
  });

  it("can read the scoped nest but not another of its owner's nests", async () => {
    const inside = await callTool(scopedKey, "context_get", {
      nest: scopedNestId,
      title: "Scoped Doc",
    });
    expect(inside).toContain("Inside scope.");

    // Owned by the same user, but outside the key's scope — indistinguishable
    // from a missing nest, same as the cross-user denial.
    const outside = await callTool(scopedKey, "context_get", {
      nest: otherNestId,
      title: "Scoped Doc",
    });
    expect(outside).toMatch(/not found or not accessible/i);
  });
});
