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
