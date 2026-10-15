/**
 * Read-only, nest-scoped keys end to end (CU-wdqcq01afw).
 *
 *   1. POST /auth/keys accepts `capability` ('read' | 'write', default 'write'),
 *      persists it, reports it, refuses an unscoped read key, and refuses to
 *      mint anything for a caller that is itself on a read-only key.
 *   2. POST /auth/keys/exchange trades a PromptOwl MCP service ticket for a
 *      nest-scoped key, only when the user holds the asked-for permission on
 *      that nest, capped at MAX_EXCHANGE_KEYS_PER_NEST live keys (429 after).
 *   3. The MCP transport honours read keys: tools/list advertises only read
 *      tools, and a write tool call is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomUUID } from "crypto";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import { MAX_EXCHANGE_KEYS_PER_NEST } from "../src/auth/keys.js";

const SECRET = "exchange-sso-secret-abcdef";
const BASE_URL = "https://community.test";
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function ticket(over: Record<string, unknown> = {}, secret = SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(
    JSON.stringify({
      sub: "owner@exchange.test",
      aud: BASE_URL,
      scope: "mcp",
      iat: now,
      exp: now + 300,
      ...over,
    }),
  );
  const sig = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let reader: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let nestA: string;
let nestB: string;

async function exchange(token: string, body: Record<string, unknown>) {
  const res = await app.request("/auth/keys/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

async function mcp(
  path: string,
  method: string,
  params: Record<string, unknown>,
  key: string,
): Promise<{ httpStatus: number; body: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return { httpStatus: res.status, body: await res.json() };
  const text = await res.text();
  const line = text.split("\n").find((l: string) => l.startsWith("data: "));
  return {
    httpStatus: res.status,
    body: line ? JSON.parse(line.slice("data: ".length)) : { raw: text },
  };
}

const toolText = (body: any): string =>
  (body?.result?.content ?? []).map((p: any) => p?.text ?? "").join("");

beforeAll(async () => {
  env = setupTestEnv();
  process.env.OFFICIAL_COMMUNITY_SSO_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = BASE_URL;
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@exchange.test", "Owner");
  reader = await registerUser(app, "reader@exchange.test", "Reader");
  outsider = await registerUser(app, "outsider@exchange.test", "Outsider");
  await resetAuthRateLimit();

  nestA = (await jsonRequest(app, "POST", "/nests", { name: "Alpha" }, owner.apiKey)).data
    .nest.id;
  nestB = (await jsonRequest(app, "POST", "/nests", { name: "Beta" }, owner.apiKey)).data
    .nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestA}/collaborators`,
    { email: reader.email, permission: "read" },
    owner.apiKey,
  );
});

afterAll(() => {
  delete process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  env.cleanup();
});

// ── 1. POST /auth/keys capability ───────────────────────────────────────────

describe("POST /auth/keys — capability", () => {
  it("defaults to a write key and reports it", async () => {
    const r = await jsonRequest(app, "POST", "/auth/keys", { label: "default-cap" }, owner.apiKey);
    expect(r.status).toBe(201);
    expect(r.data.capability).toBe("write");
    expect(r.data.nest_id).toBeNull();
  });

  it("mints a nest-scoped read key, persists it, and lists it", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "ro-A", nest_id: nestA, capability: "read" },
      owner.apiKey,
    );
    expect(r.status).toBe(201);
    expect(r.data.capability).toBe("read");
    expect(r.data.nest_id).toBe(nestA);

    const list = await jsonRequest(app, "GET", "/auth/keys", undefined, owner.apiKey);
    const row = list.data.keys.find((k: any) => k.id === r.data.id);
    expect(row.capability).toBe("read");
    expect(row.nest_id).toBe(nestA);
  });

  it("refuses an unscoped read key (400)", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "ro-unscoped", capability: "read" },
      owner.apiKey,
    );
    expect(r.status).toBe(400);
  });

  it("refuses an unknown capability value instead of silently minting a write key", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "typo-cap", nest_id: nestA, capability: "readonly" },
      owner.apiKey,
    );
    expect(r.status).toBe(400);
  });

  it("a caller on a read-only key cannot mint or rotate any key (403)", async () => {
    const ro = (
      await jsonRequest(
        app,
        "POST",
        "/auth/keys",
        { label: "ro-minter", nest_id: nestA, capability: "read" },
        owner.apiKey,
      )
    ).data.api_key;

    const mintRead = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "from-ro-1", nest_id: nestA, capability: "read" },
      ro,
    );
    const mintWrite = await jsonRequest(app, "POST", "/auth/keys", { label: "from-ro-2" }, ro);
    const rotate = await jsonRequest(app, "POST", "/auth/keys/rotate", {}, ro);
    expect(mintRead.status).toBe(403);
    expect(mintWrite.status).toBe(403);
    expect(rotate.status).toBe(403);
  });

  it("rotating a read key keeps it read-only", async () => {
    const made = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "ro-rotate", nest_id: nestA, capability: "read" },
      owner.apiKey,
    );
    const rot = await jsonRequest(
      app,
      "POST",
      "/auth/keys/rotate",
      { key_id: made.data.id },
      owner.apiKey,
    );
    expect(rot.status).toBe(200);
    expect(rot.data.capability).toBe("read");
    const w = await jsonRequest(
      app,
      "POST",
      `/nests/${nestA}/nodes`,
      { title: "Rotated RO write", content: "nope" },
      rot.data.api_key,
    );
    expect(w.status).toBe(403);
  });
});

// ── 2. POST /auth/keys/exchange ─────────────────────────────────────────────

describe("POST /auth/keys/exchange", () => {
  it("mints a read key for a reader of the nest and returns the MCP URL", async () => {
    const r = await exchange(ticket({ sub: reader.email }), { nest_id: nestA });
    expect(r.status).toBe(201);
    expect(r.data.key).toMatch(/^cnst_/);
    expect(r.data.id).toBeTruthy();
    expect(r.data.nest_id).toBe(nestA);
    expect(r.data.capability).toBe("read");
    expect(r.data.mcp_url).toBe(`${BASE_URL}/nests/${nestA}/mcp`);

    const read = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, r.data.key);
    expect(read.status).toBe(200);
    const write = await jsonRequest(
      app,
      "POST",
      `/nests/${nestA}/nodes`,
      { title: "Exchanged write", content: "nope" },
      r.data.key,
    );
    expect(write.status).toBe(403);
    const other = await jsonRequest(app, "GET", `/nests/${nestB}/nodes`, undefined, r.data.key);
    expect(other.status).toBe(403);
  });

  it("the minted key belongs to the ticket's user and shows up in their key list", async () => {
    const r = await exchange(ticket({ sub: reader.email }), { nest_id: nestA, label: "TheOwl A" });
    expect(r.status).toBe(201);
    const list = await jsonRequest(app, "GET", "/auth/keys", undefined, reader.apiKey);
    const row = list.data.keys.find((k: any) => k.id === r.data.id);
    expect(row).toBeTruthy();
    expect(row.label).toBe("TheOwl A");
    expect(row.capability).toBe("read");
  });

  it("403s when the user has no access to the nest", async () => {
    const r = await exchange(ticket({ sub: outsider.email }), { nest_id: nestA });
    expect(r.status).toBe(403);
    const r2 = await exchange(ticket({ sub: reader.email }), { nest_id: nestB });
    expect(r2.status).toBe(403);
  });

  it("403s a write key for a read-only collaborator; owner gets one", async () => {
    const denied = await exchange(ticket({ sub: reader.email }), {
      nest_id: nestA,
      capability: "write",
    });
    expect(denied.status).toBe(403);

    const ok = await exchange(ticket(), { nest_id: nestA, capability: "write" });
    expect(ok.status).toBe(201);
    expect(ok.data.capability).toBe("write");
    const write = await jsonRequest(
      app,
      "POST",
      `/nests/${nestA}/nodes`,
      { title: "Exchanged owner write", content: "ok" },
      ok.data.key,
    );
    expect(write.status).toBe(201);
  });

  it("400s without nest_id or with a bad capability", async () => {
    expect((await exchange(ticket(), {})).status).toBe(400);
    expect((await exchange(ticket(), { nest_id: nestA, capability: "admin" })).status).toBe(400);
  });

  it("403s an unknown nest", async () => {
    expect((await exchange(ticket(), { nest_id: randomUUID() })).status).toBe(403);
  });

  it("rejects anything that is not a valid MCP service ticket (401)", async () => {
    expect((await exchange(owner.apiKey, { nest_id: nestA })).status).toBe(401);
    expect((await exchange(ticket({}, "wrong-secret"), { nest_id: nestA })).status).toBe(401);
    expect((await exchange(ticket({ scope: undefined }), { nest_id: nestA })).status).toBe(401);
    expect((await exchange(ticket({ jti: randomUUID() }), { nest_id: nestA })).status).toBe(401);
    expect(
      (await exchange(ticket({ aud: "https://other.test" }), { nest_id: nestA })).status,
    ).toBe(401);
    expect(
      (await exchange(ticket({ exp: Math.floor(Date.now() / 1000) - 3600 }), { nest_id: nestA }))
        .status,
    ).toBe(401);
    const res = await app.request("/auth/keys/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nest_id: nestA }),
    });
    expect(res.status).toBe(401);
  });

  it("404s when the ticket's email has no account (no auto-provision)", async () => {
    expect((await exchange(ticket({ sub: "ghost@exchange.test" }), { nest_id: nestA })).status).toBe(
      404,
    );
  });

  it(`caps live exchange keys per user per nest at ${MAX_EXCHANGE_KEYS_PER_NEST} (429)`, async () => {
    const t = ticket();
    const before = await jsonRequest(app, "GET", "/auth/keys", undefined, owner.apiKey);
    const already = before.data.keys.filter(
      (k: any) => k.nest_id === nestB && k.origin === "exchange",
    ).length;
    for (let i = already; i < MAX_EXCHANGE_KEYS_PER_NEST; i++) {
      const r = await exchange(t, { nest_id: nestB });
      expect(r.status).toBe(201);
    }
    const over = await exchange(t, { nest_id: nestB });
    expect(over.status).toBe(429);

    // The cap is per nest: another nest still mints…
    expect((await exchange(t, { nest_id: nestA })).status).toBe(201);
    // …and exchange keys don't eat the user's manual key budget.
    const manual = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "manual-after-cap" },
      owner.apiKey,
    );
    expect(manual.status).toBe(201);
  });
});

// ── 3. MCP transport honours read keys ──────────────────────────────────────

describe("MCP transport with a read key", () => {
  let roKey: string;

  beforeAll(async () => {
    roKey = (await exchange(ticket({ sub: reader.email }), { nest_id: nestA })).data.key;
  });

  it("per-nest tools/list advertises only read tools", async () => {
    const { httpStatus, body } = await mcp(`/nests/${nestA}/mcp`, "tools/list", {}, roKey);
    expect(httpStatus).toBe(200);
    const names: string[] = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("context_get");
    expect(names).toContain("context_search");
    expect(names).not.toContain("context_create");
    expect(names).not.toContain("context_update");
    expect(names).not.toContain("context_approve");
  });

  it("per-nest tools/list for a write key still includes write tools", async () => {
    const { body } = await mcp(`/nests/${nestA}/mcp`, "tools/list", {}, owner.apiKey);
    const names: string[] = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("context_create");
  });

  it("calling a write tool with a read key errors and writes nothing", async () => {
    const { body } = await mcp(
      `/nests/${nestA}/mcp`,
      "tools/call",
      { name: "context_create", arguments: { title: "RO MCP write", content: "nope" } },
      roKey,
    );
    const failed =
      !!body.error ||
      body.result?.isError === true ||
      /read-only|not found|unknown tool/i.test(toolText(body));
    expect(failed).toBe(true);
    const list = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, owner.apiKey);
    const titles = (list.data.nodes ?? []).map((n: any) => n.title ?? n?.frontmatter?.title);
    expect(titles).not.toContain("RO MCP write");
  });

  it("server-level /mcp tools/list hides nest_create and context_create for a read key", async () => {
    const { body } = await mcp("/mcp", "tools/list", {}, roKey);
    const names: string[] = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("nest_index");
    expect(names).not.toContain("nest_create");
    expect(names).not.toContain("context_create");
  });
});
