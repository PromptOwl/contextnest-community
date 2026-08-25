/**
 * Integration tests for GET /auth/sso — the one-click PromptOwl SSO auto-login.
 *
 * Covers the domain lock (404 when the shared secret is unset), signature /
 * audience / replay / expiry rejection, the happy path (session + provisioning),
 * and the PROMPTOWL_SIGN_IN_GATE interaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomUUID } from "crypto";
import { setupTestEnv, createTestApp } from "./helpers";

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

function ticket(over: Record<string, unknown> = {}, secret = SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  return mint(
    {
      sub: "sso-user@example.com",
      name: "SSO User",
      aud: BASE_URL,
      jti: randomUUID(),
      iat: now,
      exp: now + 60,
      ...over,
    },
    secret,
  );
}

/** Pull the redirect target from a Hono Response. */
function location(res: Response): string {
  return res.headers.get("location") || "";
}

let env: ReturnType<typeof setupTestEnv>;
let app: any;

beforeAll(async () => {
  env = setupTestEnv();
  process.env.OFFICIAL_COMMUNITY_SSO_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = BASE_URL;
  delete process.env.PROMPTOWL_SIGN_IN_GATE;
  app = await createTestApp("open");
});

afterAll(() => {
  delete process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.PROMPTOWL_SIGN_IN_GATE;
  env.cleanup();
});

describe("GET /auth/sso", () => {
  it("redirects with ?sso_error=not_supported when the shared secret is unset (self-hosted = disabled)", async () => {
    const saved = process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
    delete process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
    const res = await app.request("/auth/sso?ticket=" + ticket(), {
      method: "GET",
    });
    expect(res.status).toBe(302);
    expect(location(res)).toContain("sso_error=not_supported");
    process.env.OFFICIAL_COMMUNITY_SSO_SECRET = saved;
  });

  it("redirects with ?sso_error=missing_ticket when no ticket", async () => {
    const res = await app.request("/auth/sso", { method: "GET" });
    expect(res.status).toBe(302);
    expect(location(res)).toContain("sso_error=missing_ticket");
  });

  it("rejects a bad signature → invalid_ticket", async () => {
    const res = await app.request(
      "/auth/sso?ticket=" + ticket({}, "wrong-secret"),
      { method: "GET" },
    );
    expect(location(res)).toContain("sso_error=invalid_ticket");
  });

  it("rejects an expired ticket → invalid_ticket", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await app.request(
      "/auth/sso?ticket=" + ticket({ exp: now - 300 }),
      { method: "GET" },
    );
    expect(location(res)).toContain("sso_error=invalid_ticket");
  });

  it("rejects a ticket minted for a different audience → bad_audience", async () => {
    const res = await app.request(
      "/auth/sso?ticket=" + ticket({ aud: "https://evil.test" }),
      { method: "GET" },
    );
    expect(location(res)).toContain("sso_error=bad_audience");
  });

  it("rejects a malformed (non-email) sub → invalid_ticket", async () => {
    // Distinct x-forwarded-for so these probes use their own rate-limit bucket
    // and don't drain the shared default-IP budget the other tests rely on.
    for (const badSub of [" ", "notanemail", "no@domain"]) {
      const res = await app.request(
        "/auth/sso?ticket=" + ticket({ sub: badSub }),
        { method: "GET", headers: { "x-forwarded-for": "203.0.113.7" } },
      );
      expect(location(res)).toContain("sso_error=invalid_ticket");
    }
  });

  it("signs the user in on a valid ticket (302 to /, sets session cookie, provisions user)", async () => {
    const res = await app.request(
      "/auth/sso?ticket=" + ticket({ sub: "fresh@example.com" }),
      { method: "GET" },
    );
    expect(res.status).toBe(302);
    expect(location(res)).toBe("/");
    expect(res.headers.get("set-cookie") || "").toContain("cnst_session");

    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get(
      "SELECT email FROM users WHERE LOWER(email) = ?",
      ["fresh@example.com"],
    )) as { email: string } | undefined;
    expect(row?.email).toBe("fresh@example.com");
  });

  it("rejects replay of an already-redeemed ticket → ticket_used", async () => {
    const t = ticket({ sub: "replay@example.com" });
    const first = await app.request("/auth/sso?ticket=" + t, { method: "GET" });
    expect(first.status).toBe(302);
    expect(location(first)).toBe("/");

    const second = await app.request("/auth/sso?ticket=" + t, { method: "GET" });
    expect(location(second)).toContain("sso_error=ticket_used");
  });

  it("honors PROMPTOWL_SIGN_IN_GATE=admin-only for a non-admin → sign_in_restricted", async () => {
    process.env.PROMPTOWL_SIGN_IN_GATE = "admin-only";
    try {
      const res = await app.request(
        "/auth/sso?ticket=" + ticket({ sub: "nonadmin@example.com" }),
        { method: "GET" },
      );
      expect(location(res)).toContain("sso_error=sign_in_restricted");
    } finally {
      delete process.env.PROMPTOWL_SIGN_IN_GATE;
    }
  });
});
