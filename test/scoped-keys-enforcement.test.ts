/**
 * Scoped + permissioned API keys — server-side enforcement (MF-3 security fix).
 *
 * The Connect UI has long offered "scoped to this nest" / "read-only" keys, but
 * historically ANY valid user key reached ALL of that user's nests with full
 * write + governance. These tests pin the enforcement that makes those badges
 * true:
 *
 *   (a) a nest-scoped key is DENIED against a different nest (REST + MCP);
 *   (b) a read-only key is DENIED on every write / governance mutation
 *       (REST + MCP), while still being allowed to read.
 *
 * Backward-compat controls prove that an account-level read-write key (the
 * historic default, capability = 'write', nest_id = NULL) keeps full access.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("scoped + permissioned API keys — server-side enforcement", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let nestA: string;
  let nestB: string;
  // Keys minted for the tests.
  let scopedToA: string; // nest_id = A, capability = write
  let readonlyA: string; // nest_id = A, capability = read
  let accountKey: string; // nest_id = NULL, capability = write (backward-compat)

  /** POST /nests/:id/mcp tools/call — returns { httpStatus, jsonrpc } so a
   *  scope/permission denial (403 JSON-RPC envelope) and a tool-level refusal
   *  (200 with a prose result) are both inspectable. */
  async function mcpToolCall(
    nestId: string,
    name: string,
    args: Record<string, unknown>,
    key: string,
  ): Promise<{ httpStatus: number; body: any }> {
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const ct = res.headers.get("content-type") || "";
    let body: any = null;
    if (ct.includes("application/json")) {
      body = await res.json();
    } else {
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data: "));
      body = line ? JSON.parse(line.slice("data: ".length)) : { raw: text };
    }
    return { httpStatus: res.status, body };
  }

  const resultText = (body: any): string =>
    (body?.result?.content ?? [])
      .map((p: any) => p?.text ?? "")
      .join("");

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@scoped.test", "Owner");
    accountKey = owner.apiKey; // registerUser mints an unscoped read-write key

    nestA = (await jsonRequest(app, "POST", "/nests", { name: "Alpha" }, accountKey))
      .data.nest.id;
    nestB = (await jsonRequest(app, "POST", "/nests", { name: "Beta" }, accountKey))
      .data.nest.id;

    scopedToA = (
      await jsonRequest(
        app,
        "POST",
        "/auth/keys",
        { label: "scoped-A", nest_id: nestA },
        accountKey,
      )
    ).data.api_key;

    readonlyA = (
      await jsonRequest(
        app,
        "POST",
        "/auth/keys",
        { label: "readonly-A", nest_id: nestA, capability: "read" },
        accountKey,
      )
    ).data.api_key;
  });

  afterAll(() => env.cleanup());

  // ── (a) nest scope is hard-enforced ──────────────────────────────────────

  it("(a) a nest-scoped key can read its OWN nest", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, scopedToA);
    expect(r.status).toBe(200);
  });

  it("(a) a nest-scoped key is DENIED reading a DIFFERENT nest (REST)", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestB}/nodes`, undefined, scopedToA);
    expect(r.status).toBe(403);
  });

  it("(a) a nest-scoped key is DENIED against a different nest over MCP", async () => {
    const { httpStatus } = await mcpToolCall(
      nestB,
      "context_list",
      { nest: nestB },
      scopedToA,
    );
    expect(httpStatus).toBe(403);
  });

  // ── (b) read-only capability is hard-enforced ────────────────────────────

  it("(b) a read-only key CAN read its nest", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, readonlyA);
    expect(r.status).toBe(200);
  });

  it("(b) a read-only key is DENIED creating a node (REST write)", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestA}/nodes`,
      { title: "Should Fail", content: "nope" },
      readonlyA,
    );
    expect(r.status).toBe(403);
  });

  it("(b) a read-only key is DENIED creating a node over MCP", async () => {
    const { body } = await mcpToolCall(
      nestA,
      "context_create",
      { title: "Should Fail MCP", content: "nope" },
      readonlyA,
    );
    // A read key is never even advertised the write tools, so the SDK refuses
    // the unknown name (JSON-RPC error / isError result); runTool's own prose
    // refusal ("read-only") is the backstop. Either way: refused, not written.
    const refusal = `${body?.error?.message ?? ""} ${resultText(body)}`.toLowerCase();
    expect(refusal).toMatch(/read-only|not permitted|cannot|not found/);

    // Prove nothing was written: the owner sees no such node.
    const list = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, accountKey);
    const titles = (list.data.nodes ?? []).map((n: any) => n.title ?? n?.frontmatter?.title);
    expect(titles).not.toContain("Should Fail MCP");
  });

  // ── backward compatibility ───────────────────────────────────────────────

  it("(compat) an account-level read-write key still writes to any nest", async () => {
    const a = await jsonRequest(
      app,
      "POST",
      `/nests/${nestA}/nodes`,
      { title: "Account Write A", content: "ok" },
      accountKey,
    );
    const b = await jsonRequest(
      app,
      "POST",
      `/nests/${nestB}/nodes`,
      { title: "Account Write B", content: "ok" },
      accountKey,
    );
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("(compat) a nest-scoped read-write key writes to its own nest", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestA}/nodes`,
      { title: "Scoped Write A", content: "ok" },
      scopedToA,
    );
    expect(r.status).toBe(201);
  });
});
