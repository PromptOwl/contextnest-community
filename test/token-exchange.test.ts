/**
 * POST /auth/token-exchange — verify an IdP (Google/Entra) ID token → mint a
 * scoped MCP bearer, and prove that bearer is accepted by /index.
 *
 * The IdP is a fully in-process mock (same approach as oidc.test.ts): fetch is
 * stubbed to serve a discovery doc + JWKS from a generated RS256 keypair, and
 * subject_tokens are signed with the private half so the server's real
 * createRemoteJWKSet + jwtVerify path runs. DB-backed, so this runs in CI (the
 * dev host's data/ dir is root-owned and the harness can't create its test dir).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { setupTestEnv, createTestApp, registerUser } from "./helpers";
import { signMcpTicket } from "../src/auth/sso-token";

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_CLIENT = "google-client.apps.googleusercontent.com";
const BASE = "https://nest.example.test";
const MCP_SECRET = "test-mcp-signing-secret-0123456789abcdef";
const MS_TENANT = "11111111-2222-3333-4444-555555555555";
const MS_ISSUER = `https://login.microsoftonline.com/${MS_TENANT}/v2.0`;
const MS_CLIENT = "entra-client-id";

const TX_ENV = [
  "SSO_TOKEN_EXCHANGE_ENABLED",
  "MCP_SIGNING_SECRET",
  "GOOGLE_TOKEN_EXCHANGE_ENABLED",
  "GOOGLE_CLIENT_ID",
  "MS_TOKEN_EXCHANGE_ENABLED",
  "MS_CLIENT_ID",
  "MS_TENANT_ID",
  "OIDC_ALLOWED_DOMAINS",
  "OIDC_AUTO_PROVISION",
  "PUBLIC_BASE_URL",
  "MCP_TOKEN_TTL_SECONDS",
  "OFFICIAL_COMMUNITY_SSO_SECRET",
];

let env: ReturnType<typeof setupTestEnv>;
beforeEach(() => {
  env = setupTestEnv();
  for (const k of TX_ENV) delete process.env[k];
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of TX_ENV) delete process.env[k];
  env.cleanup();
});

function enableGoogle(overrides: Record<string, string> = {}) {
  process.env.SSO_TOKEN_EXCHANGE_ENABLED = "true";
  process.env.MCP_SIGNING_SECRET = MCP_SECRET;
  process.env.GOOGLE_TOKEN_EXCHANGE_ENABLED = "true";
  process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT;
  process.env.PUBLIC_BASE_URL = BASE;
  Object.assign(process.env, overrides);
}

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

function installMockIdp(issuer: string, jwks: object) {
  vi.stubGlobal("fetch", async (input: any) => {
    const url = String(typeof input === "object" && input?.url ? input.url : input);
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), {
        status: s,
        headers: { "content-type": "application/json" },
      });
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (url === `${issuer}/jwks`) return json(jwks);
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

async function signSubject(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; exp?: string | number } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.issuer ?? GOOGLE_ISSUER)
    .setAudience(opts.audience ?? GOOGLE_CLIENT)
    .setSubject("google-sub-1")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

async function exchange(app: any, body: Record<string, unknown>) {
  const res = await app.request("/auth/token-exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
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

describe("POST /auth/token-exchange", () => {
  it("mints an MCP bearer that /index accepts (happy path, JIT user)", async () => {
    // An allowlist is REQUIRED for JIT here (fail-closed) — see the
    // no_account test below.
    enableGoogle({ OIDC_ALLOWED_DOMAINS: "example.com" });
    const { privateKey, jwks } = await makeKeys();
    installMockIdp(GOOGLE_ISSUER, jwks);
    const app = await createTestApp("key");

    const subject = await signSubject(privateKey, {
      email: "user@example.com",
      email_verified: true,
      name: "Test User",
    });
    const { status, data } = await exchange(app, {
      provider: "google",
      subject_token: subject,
    });
    expect(status).toBe(200);
    expect(data.token_type).toBe("Bearer");
    expect(typeof data.access_token).toBe("string");
    expect(data.expires_in).toBeGreaterThan(0);

    // The minted token must be accepted by the MCP acceptor.
    const idx = await app.request("/index", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    expect(idx.status).toBe(200);
  });

  it("404 when the feature flag is off", async () => {
    // No enableGoogle() → SSO_TOKEN_EXCHANGE_ENABLED unset.
    const app = await createTestApp("key");
    const { status, data } = await exchange(app, {
      provider: "google",
      subject_token: "x.y.z",
    });
    expect(status).toBe(404);
    expect(data.code).toBe("disabled");
  });

  it("400 provider_disabled when that provider isn't enabled", async () => {
    enableGoogle();
    delete process.env.GOOGLE_TOKEN_EXCHANGE_ENABLED;
    const app = await createTestApp("key");
    const { status, data } = await exchange(app, {
      provider: "google",
      subject_token: "x.y.z",
    });
    expect(status).toBe(400);
    expect(data.code).toBe("provider_disabled");
  });

  it("401 on a token signed by an untrusted key (forged signature)", async () => {
    enableGoogle();
    const { jwks } = await makeKeys(); // JWKS the server trusts
    const other = await makeKeys(); // attacker signs with a DIFFERENT key
    installMockIdp(GOOGLE_ISSUER, jwks);
    const app = await createTestApp("key");
    const subject = await signSubject(other.privateKey, {
      email: "user@example.com",
      email_verified: true,
    });
    const { status, data } = await exchange(app, {
      provider: "google",
      subject_token: subject,
    });
    expect(status).toBe(401);
    expect(data.code).toBe("invalid_subject_token");
  });

  it("401 on wrong audience (token minted for another app = replay)", async () => {
    enableGoogle();
    const { privateKey, jwks } = await makeKeys();
    installMockIdp(GOOGLE_ISSUER, jwks);
    const app = await createTestApp("key");
    const subject = await signSubject(
      privateKey,
      { email: "user@example.com", email_verified: true },
      { audience: "some-other-client-id" },
    );
    const { status } = await exchange(app, {
      provider: "google",
      subject_token: subject,
    });
    expect(status).toBe(401);
  });

  it("401 on an expired subject_token", async () => {
    enableGoogle();
    const { privateKey, jwks } = await makeKeys();
    installMockIdp(GOOGLE_ISSUER, jwks);
    const app = await createTestApp("key");
    const subject = await signSubject(
      privateKey,
      { email: "user@example.com", email_verified: true },
      { exp: Math.floor(Date.now() / 1000) - 120 },
    );
    const { status } = await exchange(app, {
      provider: "google",
      subject_token: subject,
    });
    expect(status).toBe(401);
  });

  it("403 email_not_verified when the claim is explicitly false", async () => {
    enableGoogle();
    const { privateKey, jwks } = await makeKeys();
    installMockIdp(GOOGLE_ISSUER, jwks);
    const app = await createTestApp("key");
    const subject = await signSubject(privateKey, {
      email: "user@example.com",
      email_verified: false,
    });
    const { status, data } = await exchange(app, {
      provider: "google",
      subject_token: subject,
    });
    expect(status).toBe(403);
    expect(data.code).toBe("email_not_verified");
  });

  it("403 domain_not_allowed when the email is outside the allowlist", async () => {
    enableGoogle({ OIDC_ALLOWED_DOMAINS: "allowed.com" });
    const { privateKey, jwks } = await makeKeys();
    installMockIdp(GOOGLE_ISSUER, jwks);
    const app = await createTestApp("key");
    const subject = await signSubject(privateKey, {
      email: "user@example.com",
      email_verified: true,
    });
    const { status, data } = await exchange(app, {
      provider: "google",
      subject_token: subject,
    });
    expect(status).toBe(403);
    expect(data.code).toBe("domain_not_allowed");
  });

  it("403 no_account when auto-provision is off and the user is unknown", async () => {
    enableGoogle({ OIDC_AUTO_PROVISION: "false" });
    const { privateKey, jwks } = await makeKeys();
    installMockIdp(GOOGLE_ISSUER, jwks);
    const app = await createTestApp("key");
    const subject = await signSubject(privateKey, {
      email: "nobody@example.com",
      email_verified: true,
    });
    const { status, data } = await exchange(app, {
      provider: "google",
      subject_token: subject,
    });
    expect(status).toBe(403);
    expect(data.code).toBe("no_account");
  });

  it("403 no_account when auto-provision has no domain allowlist (fail closed)", async () => {
    // Auto-provision defaults ON and the allowlist defaults empty — the
    // combination that would let ANY account at a public IdP self-provision.
    enableGoogle();
    const { privateKey, jwks } = await makeKeys();
    installMockIdp(GOOGLE_ISSUER, jwks);
    const app = await createTestApp("key");
    const subject = await signSubject(privateKey, {
      email: "stranger@anywhere.com",
      email_verified: true,
    });
    const { status, data } = await exchange(app, {
      provider: "google",
      subject_token: subject,
    });
    expect(status).toBe(403);
    expect(data.code).toBe("no_account");
  });

  it("400 on an unknown provider", async () => {
    enableGoogle();
    const app = await createTestApp("key");
    const { status } = await exchange(app, {
      provider: "okta",
      subject_token: "x.y.z",
    });
    expect(status).toBe(400);
  });

  it("404 when the flag is on but no signing secret is set", async () => {
    enableGoogle();
    delete process.env.MCP_SIGNING_SECRET;
    const app = await createTestApp("key");
    const { status, data } = await exchange(app, {
      provider: "google",
      subject_token: "x.y.z",
    });
    expect(status).toBe(404);
    expect(data.code).toBe("disabled");
  });

  it("400 (not 500) on wrongly-typed or non-object bodies", async () => {
    enableGoogle();
    const app = await createTestApp("key");
    // subject_token must be a string — a number used to hit .trim().
    expect(
      (await exchange(app, { provider: "google", subject_token: 123 })).status,
    ).toBe(400);
    // A bare JSON null used to hit body.provider on null.
    const res = await app.request("/auth/token-exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  it("400 provider_misconfigured when discovery fails (e.g. wrong tenant id)", async () => {
    enableGoogle({
      MS_TOKEN_EXCHANGE_ENABLED: "true",
      MS_CLIENT_ID: MS_CLIENT,
      MS_TENANT_ID: MS_TENANT,
    });
    const { jwks } = await makeKeys();
    installMockIdp(GOOGLE_ISSUER, jwks); // nothing served for the Entra issuer
    const app = await createTestApp("key");
    const { status, data } = await exchange(app, {
      provider: "microsoft",
      subject_token: "x.y.z",
    });
    expect(status).toBe(400);
    expect(data.code).toBe("provider_misconfigured");
  });
});

describe("POST /auth/token-exchange — Microsoft Entra", () => {
  it("verifies a tenant-scoped token and takes the email from preferred_username", async () => {
    enableGoogle({
      MS_TOKEN_EXCHANGE_ENABLED: "true",
      MS_CLIENT_ID: MS_CLIENT,
      MS_TENANT_ID: MS_TENANT,
      OIDC_ALLOWED_DOMAINS: "example.com",
    });
    const { privateKey, jwks } = await makeKeys();
    installMockIdp(MS_ISSUER, jwks);
    const app = await createTestApp("key");

    // Entra v2: no `email`, no `email_verified` — the address rides in
    // preferred_username and an absent email_verified is trusted.
    const subject = await signSubject(
      privateKey,
      { preferred_username: "entra.user@example.com", name: "Entra User" },
      { issuer: MS_ISSUER, audience: MS_CLIENT },
    );
    const { status, data } = await exchange(app, {
      provider: "microsoft",
      subject_token: subject,
    });
    expect(status).toBe(200);

    const idx = await app.request("/index", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    expect(idx.status).toBe(200);
  });

  it("401 on an Entra token minted for another tenant's issuer", async () => {
    enableGoogle({
      MS_TOKEN_EXCHANGE_ENABLED: "true",
      MS_CLIENT_ID: MS_CLIENT,
      MS_TENANT_ID: MS_TENANT,
    });
    const { privateKey, jwks } = await makeKeys();
    installMockIdp(MS_ISSUER, jwks);
    const app = await createTestApp("key");
    const subject = await signSubject(
      privateKey,
      { preferred_username: "guest@example.com" },
      {
        issuer: "https://login.microsoftonline.com/other-tenant/v2.0",
        audience: MS_CLIENT,
      },
    );
    const { status } = await exchange(app, {
      provider: "microsoft",
      subject_token: subject,
    });
    expect(status).toBe(401);
  });
});

describe("POST /auth/token-exchange — two providers at once", () => {
  it("serves both issuers without refetching discovery on every alternation", async () => {
    enableGoogle({
      MS_TOKEN_EXCHANGE_ENABLED: "true",
      MS_CLIENT_ID: MS_CLIENT,
      MS_TENANT_ID: MS_TENANT,
      OIDC_ALLOWED_DOMAINS: "example.com",
    });
    const { privateKey, jwks } = await makeKeys();

    // One mock IdP serving BOTH issuers, counting discovery hits: the cache
    // holds an entry per issuer, so alternating providers must not evict.
    const discoveryHits: Record<string, number> = {};
    vi.stubGlobal("fetch", async (input: any) => {
      const url = String(
        typeof input === "object" && input?.url ? input.url : input,
      );
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      for (const issuer of [GOOGLE_ISSUER, MS_ISSUER]) {
        if (url === `${issuer}/.well-known/openid-configuration`) {
          discoveryHits[issuer] = (discoveryHits[issuer] ?? 0) + 1;
          return json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
          });
        }
        if (url === `${issuer}/jwks`) return json(jwks);
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    const app = await createTestApp("key");

    for (let i = 0; i < 2; i++) {
      const google = await exchange(app, {
        provider: "google",
        subject_token: await signSubject(privateKey, {
          email: "user@example.com",
          email_verified: true,
        }),
      });
      expect(google.status).toBe(200);

      const microsoft = await exchange(app, {
        provider: "microsoft",
        subject_token: await signSubject(
          privateKey,
          { preferred_username: "entra.user@example.com" },
          { issuer: MS_ISSUER, audience: MS_CLIENT },
        ),
      });
      expect(microsoft.status).toBe(200);
    }

    // One discovery fetch per issuer for the whole run — a single-slot cache
    // would evict on every alternation and fetch four times.
    expect(discoveryHits[GOOGLE_ISSUER]).toBe(1);
    expect(discoveryHits[MS_ISSUER]).toBe(1);
  });
});

describe("MCP bearer acceptor — either signing secret", () => {
  // /index + /mcp accept a ticket signed by the PromptOwl shared secret OR by
  // this server's own MCP_SIGNING_SECRET, and nothing else.
  const OFFICIAL = "official-community-sso-secret-0123456789";

  async function indexWith(app: any, secret: string, email: string) {
    const ticket = signMcpTicket(
      { sub: email, aud: BASE, ttlSeconds: 300 },
      secret,
    );
    const res = await app.request("/index", {
      headers: { Authorization: `Bearer ${ticket}` },
    });
    return res.status;
  }

  it("accepts a ticket signed by either secret and rejects any other", async () => {
    process.env.MCP_SIGNING_SECRET = MCP_SECRET;
    process.env.OFFICIAL_COMMUNITY_SSO_SECRET = OFFICIAL;
    process.env.PUBLIC_BASE_URL = BASE;
    const app = await createTestApp("key");
    const user = await registerUser(app, "acceptor@example.com");
    expect(user.apiKey).toBeTruthy();

    expect(await indexWith(app, MCP_SECRET, "acceptor@example.com")).toBe(200);
    expect(await indexWith(app, OFFICIAL, "acceptor@example.com")).toBe(200);
    expect(
      await indexWith(app, "neither-of-the-two-secrets", "acceptor@example.com"),
    ).toBe(401);
  });
});
