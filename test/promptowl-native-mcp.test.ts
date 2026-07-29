/**
 * PromptOwl native MCP auth — /index and /mcp accept a short-lived HS256
 * service ticket (scope: "mcp") signed with OFFICIAL_COMMUNITY_SSO_SECRET,
 * resolved to an EXISTING account by email (no auto-provisioning). Login
 * tickets, bad signatures, wrong audiences, and unknown emails are refused,
 * and plain cnst_ keys keep working.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomUUID } from "crypto";
import { setupTestEnv, createTestApp, registerUser } from "./helpers";

const SECRET = "official-sso-secret-abcdef";
const BASE_URL = "https://community.test";

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function mint(payload: Record<string, unknown>, secret = SECRET): string {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

function serviceTicket(
  over: Record<string, unknown> = {},
  secret = SECRET,
): string {
  const now = Math.floor(Date.now() / 1000);
  return mint(
    {
      sub: "alice@example.com",
      aud: BASE_URL,
      scope: "mcp",
      iat: now,
      exp: now + 300,
      ...over,
    },
    secret,
  );
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };

beforeAll(async () => {
  env = setupTestEnv();
  process.env.OFFICIAL_COMMUNITY_SSO_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = BASE_URL;
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@example.com");
});

afterAll(() => {
  delete process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  env.cleanup();
});

describe("PromptOwl service ticket on /index and /mcp", () => {
  it("authenticates an existing user via a valid service ticket", async () => {
    const res = await app.request("/index", {
      headers: bearer(serviceTicket()),
    });
    expect(res.status).toBe(200);
  });

  it("404s when no account exists for the ticket email (no auto-provision)", async () => {
    const res = await app.request("/index", {
      headers: bearer(serviceTicket({ sub: "stranger@example.com" })),
    });
    expect(res.status).toBe(404);
    const db = await import("../src/db/client.js");
    const row = await db
      .getDb()
      .get("SELECT id FROM users WHERE email = ?", ["stranger@example.com"]);
    expect(row).toBeFalsy();
  });

  it("rejects a login-style SSO ticket (jti, no mcp scope)", async () => {
    const res = await app.request("/index", {
      headers: bearer(
        serviceTicket({ scope: undefined, jti: randomUUID() }),
      ),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a bad signature", async () => {
    const res = await app.request("/index", {
      headers: bearer(serviceTicket({}, "wrong-secret")),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a ticket minted for another server (audience)", async () => {
    const res = await app.request("/index", {
      headers: bearer(serviceTicket({ aud: "https://evil.test" })),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an expired ticket", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await app.request("/index", {
      headers: bearer(serviceTicket({ exp: now - 300 })),
    });
    expect(res.status).toBe(401);
  });

  it("still accepts plain cnst_ API keys (regression)", async () => {
    const res = await app.request("/index", {
      headers: bearer(alice.apiKey),
    });
    expect(res.status).toBe(200);
  });

  it("works on the /mcp transport too", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        ...bearer(serviceTicket()),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("falls through to normal auth (401) when the secret is unset", async () => {
    const saved = process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
    delete process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
    const res = await app.request("/index", {
      headers: bearer(serviceTicket()),
    });
    expect(res.status).toBe(401);
    process.env.OFFICIAL_COMMUNITY_SSO_SECRET = saved;
  });
});

// ─── Server-level MCP bootstrap writes (nest_create / context_create) ─────

async function callTool(
  name: string,
  args: Record<string, unknown>,
  id = 1,
): Promise<string> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      ...bearer(serviceTicket()),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  expect(body.error).toBeUndefined();
  return body.result.content.map((c: any) => c.text).join("");
}

describe("PromptOwl ticket can bootstrap content via server-level /mcp", () => {
  it("nest_create then context_create with a folder path", async () => {
    const created = await callTool("nest_create", { name: "from PO" }, 10);
    expect(created).toContain('Created nest "from PO"');
    const nestId = created.match(/id: ([^)]+)\)/)?.[1];
    expect(nestId).toBeTruthy();

    const doc = await callTool(
      "context_create",
      {
        nest: nestId,
        title: "First Note",
        content: "# Hello\n\nWritten from PromptOwl.",
        folder: "gtm/deals",
      },
      11,
    );
    expect(doc.toLowerCase()).not.toContain("permission");

    const got = await callTool(
      "context_get",
      { nest: nestId, title: "First Note" },
      12,
    );
    expect(got).toContain("Written from PromptOwl");
  });

  it("rejects duplicate nest names with a friendly message, not a crash", async () => {
    const dup = await callTool("nest_create", { name: "from PO" }, 13);
    expect(dup).toContain("already have a nest with this name");
  });

  it("ticket reads per-nest /context and /nodes, but cannot write via REST", async () => {
    // Nest + doc created earlier in this suite via the MCP bootstrap tools.
    const index = await app.request("/index?format=json", {
      headers: bearer(serviceTicket()),
    });
    const nestId = (await index.json()).nests.find(
      (n: any) => n.name === "from PO",
    )?.id;
    expect(nestId).toBeTruthy();

    // Read: deterministic retrieval with a ticket.
    const ctx = await app.request(`/nests/${nestId}/context`, {
      method: "POST",
      headers: {
        ...bearer(serviceTicket()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ selector: "[[First Note]]", hops: 0 }),
    });
    expect(ctx.status).toBe(200);
    expect((await ctx.json()).context).toContain("Written from PromptOwl");

    // Read: doc listing for the picker.
    const nodes = await app.request(`/nests/${nestId}/nodes`, {
      headers: bearer(serviceTicket()),
    });
    expect(nodes.status).toBe(200);
    expect(
      (await nodes.json()).nodes.some(
        (n: any) => n.frontmatter?.title === "First Note" || n.title === "First Note",
      ),
    ).toBe(true);

    // Write via REST stays ticket-proof (only /mcp bootstrap writes exist).
    const write = await app.request(`/nests/${nestId}/nodes`, {
      method: "POST",
      headers: {
        ...bearer(serviceTicket()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Sneaky REST", content: "nope" }),
    });
    expect(write.status).toBe(401);
  });

  it("context_create into another user's private nest stays inaccessible", async () => {
    const bob = await registerUser(app, "bob@example.com");
    const res = await app.request("/nests", {
      method: "POST",
      headers: {
        ...bearer(bob.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Bob Secrets" }),
    });
    const nest = ((await res.json()) as any).nest;

    const out = await callTool(
      "context_create",
      { nest: nest.id, title: "Sneaky", content: "nope" },
      14,
    );
    expect(out).toContain("not found or not accessible");
  });
});

// ─── Per-nest MCP with a service ticket (read & write nest data sources) ──

async function callNestTool(
  nestId: string,
  name: string,
  args: Record<string, unknown>,
  id = 1,
): Promise<{ status: number; text: string }> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      ...bearer(serviceTicket()),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (res.status !== 200) return { status: res.status, text: await res.text() };
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  expect(body.error).toBeUndefined();
  return {
    status: res.status,
    text: body.result.content.map((c: any) => c.text).join(""),
  };
}

describe("PromptOwl ticket on the per-nest /mcp transport", () => {
  it("reaches write tools (create + update) on the caller's own nest", async () => {
    const index = await app.request("/index?format=json", {
      headers: bearer(serviceTicket()),
    });
    const nestId = (await index.json()).nests.find(
      (n: any) => n.name === "from PO",
    )?.id;
    expect(nestId).toBeTruthy();

    const created = await callNestTool(nestId, "context_create", {
      title: "Block Note",
      content: "written via per-nest mcp",
    });
    expect(created.status).toBe(200);
    expect(created.text.toLowerCase()).not.toContain("permission");

    const updated = await callNestTool(
      nestId,
      "context_update",
      { title: "Block Note", append: "appended line" },
      2,
    );
    expect(updated.status).toBe(200);

    const got = await callNestTool(
      nestId,
      "context_get",
      { title: "Block Note" },
      3,
    );
    expect(got.text).toContain("appended line");
  });

  it("is refused on a nest the ticket user has no access to", async () => {
    // Bob's private nest from the previous suite.
    const bobKey = (await registerUser(app, "carol@example.com")).apiKey;
    const res = await app.request("/nests", {
      method: "POST",
      headers: { ...bearer(bobKey), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Carol Secrets" }),
    });
    const nest = ((await res.json()) as any).nest;

    const denied = await callNestTool(nest.id, "context_create", {
      title: "Sneaky",
      content: "nope",
    });
    expect(denied.status).toBe(404);
  });
});
