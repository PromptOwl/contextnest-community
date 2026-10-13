/**
 * OIDC SSO — GET /auth/oidc/login + /auth/oidc/callback and the OIDC_*
 * /admin/settings fields.
 *
 * The identity provider is a fully in-process mock: `vi.stubGlobal("fetch")`
 * intercepts every outbound request the server makes (discovery document,
 * JWKS, token endpoint), so no network and no real IdP. The test generates an
 * RSA keypair with jose, serves its public half from the mock JWKS endpoint,
 * and signs ID tokens with the private half — the server's jose verification
 * path (createRemoteJWKSet + jwtVerify) runs for real against those keys.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

const ISSUER = "https://idp.test";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const OWNER_EMAIL = "owner@example.com";

const OIDC_ENV = [
  "OIDC_ENABLED",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_ALLOWED_DOMAINS",
  "OIDC_AUTO_PROVISION",
  "OIDC_DEPARTMENT_TAGGING",
  "PUBLIC_BASE_URL",
  // The lockout-guard tests PATCH these; scrub them so a leaked value can't
  // bleed into other cases.
  "MANUAL_SIGN_IN",
  "PROMPTOWL_SIGN_IN_GATE",
];

let env: ReturnType<typeof setupTestEnv>;

beforeEach(() => {
  env = setupTestEnv();
  for (const k of OIDC_ENV) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of OIDC_ENV) delete process.env[k];
  env.cleanup();
});

function configureOidc(overrides: Record<string, string> = {}) {
  process.env.OIDC_ENABLED = "true";
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  Object.assign(process.env, overrides);
}

/** RSA signing key + its public JWKS document, once per suite run. */
async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

/**
 * Stub global fetch as the mock IdP. `tokenBody` controls what the token
 * endpoint returns (set it per test after minting an ID token); `captured`
 * records the last token-endpoint request body for asserting PKCE/secret.
 */
function installMockIssuer(
  jwks: object,
  opts: { discoveryIssuer?: string; endSessionEndpoint?: string } = {},
) {
  const state: {
    tokenBody: Record<string, unknown> | null;
    tokenStatus: number;
    lastTokenParams: URLSearchParams | null;
  } = { tokenBody: null, tokenStatus: 200, lastTokenParams: null };

  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = String(typeof input === "object" && input?.url ? input.url : input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        // Overridable so tests can serve a document that claims a DIFFERENT
        // issuer than the one asked for (issuer-mix-up guard).
        issuer: opts.discoveryIssuer ?? ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        // Only advertised when a test opts in (mirrors Entra/Okta/Keycloak;
        // Google omits it). Drives RP-initiated logout.
        ...(opts.endSessionEndpoint && {
          end_session_endpoint: opts.endSessionEndpoint,
        }),
      });
    }
    if (url === `${ISSUER}/jwks`) return json(jwks);
    if (url === `${ISSUER}/token`) {
      state.lastTokenParams = new URLSearchParams(String(init?.body ?? ""));
      if (!state.tokenBody) return json({ error: "no token configured" }, 500);
      return json(state.tokenBody, state.tokenStatus);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });

  return state;
}

async function signIdToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? CLIENT_ID)
    .setSubject("subject-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

/** Read a Set-Cookie value by name from a Response. */
function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, ...rest] = pair.split("=");
    out[name.trim()] = rest.join("=");
  }
  return out;
}

/** Kick off /auth/oidc/login and return the flow material a browser would hold. */
async function startLogin(app: any) {
  const res = await app.request("/auth/oidc/login");
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location")!);
  const cookies = cookiesOf(res);
  const cookieHeader = [
    `cnst_oidc_state=${cookies["cnst_oidc_state"]}`,
    `cnst_oidc_nonce=${cookies["cnst_oidc_nonce"]}`,
    `cnst_oidc_verifier=${cookies["cnst_oidc_verifier"]}`,
  ].join("; ");
  return {
    location,
    cookieHeader,
    state: cookies["cnst_oidc_state"],
    nonce: cookies["cnst_oidc_nonce"],
  };
}

function ssoError(res: Response): string | null {
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location")!;
  const url = new URL(loc, "http://localhost");
  return url.searchParams.get("sso_error");
}

// ─── /auth/oidc/login ─────────────────────────────────────────────────────

describe("GET /auth/oidc/login", () => {
  it("bounces with ?sso_error=disabled when OIDC is off", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const res = await app.request("/auth/oidc/login");
    expect(ssoError(res)).toBe("disabled");
  });

  it("bounces with ?sso_error=not_configured when enabled but incomplete", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    process.env.OIDC_ENABLED = "true";
    process.env.OIDC_ISSUER = ISSUER;
    // no client id / secret
    const res = await app.request("/auth/oidc/login");
    expect(ssoError(res)).toBe("not_configured");
  });

  it("302s to the authorization endpoint with state/nonce/PKCE cookies", async () => {
    const { jwks } = await makeKeys();
    installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const res = await app.request("/auth/oidc/login");
    expect(res.status).toBe(302);

    const loc = new URL(res.headers.get("Location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(loc.searchParams.get("redirect_uri")).toBe(
      "http://localhost/auth/oidc/callback",
    );

    // The state/nonce in the URL must match what the cookies carry.
    const cookies = cookiesOf(res);
    expect(cookies["cnst_oidc_state"]).toBe(loc.searchParams.get("state"));
    expect(cookies["cnst_oidc_nonce"]).toBe(loc.searchParams.get("nonce"));
    expect(cookies["cnst_oidc_verifier"]).toBeTruthy();

    // Flow cookies are httpOnly and scoped to the OIDC path.
    for (const line of res.headers.getSetCookie()) {
      expect(line).toMatch(/HttpOnly/);
      expect(line).toMatch(/Path=\/auth\/oidc/);
      expect(line).toMatch(/SameSite=Lax/);
    }
  });

  it("rejects a discovery document that claims a different issuer (mix-up guard)", async () => {
    const { jwks } = await makeKeys();
    installMockIssuer(jwks, { discoveryIssuer: "https://evil.example" });
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const res = await app.request("/auth/oidc/login");
    expect(ssoError(res)).toBe("discovery_failed");
  });
});

// ─── /auth/oidc/callback ──────────────────────────────────────────────────

describe("GET /auth/oidc/callback", () => {
  it("happy path: JIT-provisions the user, sets a session cookie, redirects /", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "New.Person@Acme.com", // mixed case — must normalize
        name: "New Person",
      }),
      access_token: "at",
      token_type: "Bearer",
    };

    const res = await app.request(
      `/auth/oidc/callback?code=authcode-1&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");

    // Session cookie set exactly like a password login (opaque 64-hex id).
    const cookies = cookiesOf(res);
    expect(cookies["cnst_session"]).toMatch(/^[0-9a-f]{64}$/);
    // SSO marker set so the SPA routes logout through the IdP.
    expect(cookies["cnst_sso_session"]).toBe("1");
    // Flow cookies cleared.
    expect(cookies["cnst_oidc_state"]).toBe("");

    // Token exchange carried the secret AND the PKCE verifier.
    expect(issuer.lastTokenParams?.get("client_secret")).toBe(CLIENT_SECRET);
    expect(issuer.lastTokenParams?.get("code_verifier")).toBeTruthy();
    expect(issuer.lastTokenParams?.get("code")).toBe("authcode-1");
    expect(issuer.lastTokenParams?.get("grant_type")).toBe(
      "authorization_code",
    );

    // User row created with normalized email + name from the claim.
    const { getDb } = await import("../src/db/client.js");
    const user = (await getDb().get(
      "SELECT email, name FROM users WHERE LOWER(email) = ?",
      ["new.person@acme.com"],
    )) as { email: string; name: string } | undefined;
    expect(user).toBeTruthy();
    expect(user!.email).toBe("new.person@acme.com");
    expect(user!.name).toBe("New Person");
  });

  it("falls back to preferred_username when the email claim is absent (Entra)", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        preferred_username: "Upn.User@Corp.example",
      }),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(res.headers.get("Location")).toBe("/");

    const { getDb } = await import("../src/db/client.js");
    const user = await getDb().get(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      ["upn.user@corp.example"],
    );
    expect(user).toBeTruthy();
  });

  // email_verified policy: explicit false → refused (permissive IdPs like an
  // open Keycloak realm let anyone self-register an arbitrary address — an
  // attacker asserting an existing local user's email would otherwise sign
  // straight into that account). true → allowed. ABSENT → allowed (see the
  // happy-path tests above, which carry no email_verified claim at all) —
  // Entra v2 tokens frequently omit it; trust assumption documented in
  // CONFIGURATION.md.
  it("refuses an ID token with email_verified: false — no session, no user", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "attacker.asserted@acme.com",
        email_verified: false,
      }),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("email_not_verified");

    // No session cookie was set...
    expect(cookiesOf(res)["cnst_session"]).toBeUndefined();
    // ...and no user was provisioned.
    const { getDb } = await import("../src/db/client.js");
    const user = await getDb().get(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      ["attacker.asserted@acme.com"],
    );
    expect(user).toBeUndefined();
  });

  // Same refusal for the stringified claim. It's a boolean per spec, but
  // non-compliant IdPs emit "false", and treating that as "absent" would turn
  // an explicit refusal into a trust.
  it('refuses an ID token with email_verified: "false" (stringified)', async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "stringy.claim@acme.com",
        email_verified: "false",
      }),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("email_not_verified");
    expect(cookiesOf(res)["cnst_session"]).toBeUndefined();

    const { getDb } = await import("../src/db/client.js");
    const user = await getDb().get(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      ["stringy.claim@acme.com"],
    );
    expect(user).toBeUndefined();
  });

  it("accepts an ID token with email_verified: true", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "verified@acme.com",
        email_verified: true,
      }),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(res.headers.get("Location")).toBe("/");
    expect(cookiesOf(res)["cnst_session"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a state mismatch", async () => {
    const { jwks } = await makeKeys();
    installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    const res = await app.request(
      "/auth/oidc/callback?code=c&state=WRONG_STATE_VALUE_123",
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("state_mismatch");
  });

  it("rejects an ID token whose nonce doesn't match the flow cookie", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: "a-completely-different-nonce",
        email: "person@acme.com",
      }),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("invalid_token");
  });

  it("rejects an ID token minted for a different audience", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(
        privateKey,
        { nonce: flow.nonce, email: "person@acme.com" },
        { audience: "some-other-client" },
      ),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("invalid_token");
  });

  // The signature check itself: a token that is well-formed and carries every
  // correct claim (issuer, audience, nonce, expiry) but is signed by a key the
  // issuer's JWKS doesn't publish. The foreign key reuses the SAME kid, so
  // this exercises the cryptographic verification rather than key lookup —
  // i.e. an attacker who can mint tokens but can't sign as the IdP.
  it("rejects an ID token signed by a key outside the issuer's JWKS", async () => {
    const { jwks } = await makeKeys();
    const foreign = await makeKeys();
    const issuer = installMockIssuer(jwks); // serves the FIRST key only
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(foreign.privateKey, {
        nonce: flow.nonce,
        email: "forged@acme.com",
        email_verified: true,
      }),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("invalid_token");
    expect(cookiesOf(res)["cnst_session"]).toBeUndefined();

    const { getDb } = await import("../src/db/client.js");
    const user = await getDb().get(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      ["forged@acme.com"],
    );
    expect(user).toBeUndefined();
  });

  it("enforces the email-domain allowlist", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc({ OIDC_ALLOWED_DOMAINS: "acme.com, partner.example" });

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "intruder@evil.example",
      }),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("domain_not_allowed");

    const { getDb } = await import("../src/db/client.js");
    const user = await getDb().get(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      ["intruder@evil.example"],
    );
    expect(user).toBeUndefined();
  });

  it("bounces an unknown user with not_invited when auto-provision is off", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc({ OIDC_AUTO_PROVISION: "false" });

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "stranger@acme.com",
      }),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("not_invited");
  });

  it("signs an EXISTING user in even with auto-provision off", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const existing = await registerUser(app, "known@acme.com");
    configureOidc({ OIDC_AUTO_PROVISION: "false" });

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: existing.email,
      }),
    };

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(res.headers.get("Location")).toBe("/");
    expect(cookiesOf(res)["cnst_session"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("bounces with disabled when OIDC is turned off mid-flight", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "person@acme.com",
      }),
    };

    // Admin turns SSO off between the redirect out and the redirect back.
    process.env.OIDC_ENABLED = "false";

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("disabled");
  });

  it("bounces exchange_failed when the token endpoint refuses the code", async () => {
    const { jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = { error: "invalid_grant" };
    issuer.tokenStatus = 400;

    const res = await app.request(
      `/auth/oidc/callback?code=stale&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(ssoError(res)).toBe("exchange_failed");
  });

  // Two callbacks for the same brand-new email race; the loser's INSERT hits
  // the unique index on users.email. The flow must re-read the now-existing
  // row and sign the second request in, NOT bounce service_error. Simulated
  // by pre-creating the user between login and callback so the JIT INSERT
  // deterministically collides.
  it("signs in gracefully when JIT provisioning loses the unique-email race", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "raced@acme.com",
        name: "Raced User",
      }),
    };

    // The concurrent callback already created the row.
    const { getDb } = await import("../src/db/client.js");
    const { v4: uuid } = await import("uuid");
    const winnerId = uuid();
    await getDb().run(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
      [winnerId, "raced@acme.com", "Raced User", "x"],
    );

    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    // Signed in against the existing row — no service_error, no duplicate.
    expect(res.headers.get("Location")).toBe("/");
    expect(cookiesOf(res)["cnst_session"]).toMatch(/^[0-9a-f]{64}$/);
    const rows = (await getDb().all(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      ["raced@acme.com"],
    )) as unknown[];
    expect(rows.length).toBe(1);
  });
});

// ─── Department claim capture (CU-wdqcpzwf2p) ─────────────────────────────
// The optional string `department` claim is upserted to users.department on
// EVERY login: value present → stored (trimmed, whitespace collapsed, capped),
// absent → cleared, so a directory move propagates on the next sign-in.

describe("OIDC callback — department claim", () => {
  /** Full login round-trip with the given extra ID-token claims. */
  async function ssoLogin(
    app: any,
    issuer: ReturnType<typeof installMockIssuer>,
    privateKey: CryptoKey,
    claims: Record<string, unknown>,
  ) {
    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, { nonce: flow.nonce, ...claims }),
    };
    const res = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    expect(res.headers.get("Location")).toBe("/");
    return res;
  }

  async function storedDepartment(email: string): Promise<string | null> {
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get(
      "SELECT department FROM users WHERE LOWER(email) = ?",
      [email],
    )) as { department: string | null } | undefined;
    expect(row).toBeTruthy();
    return row!.department;
  }

  it("stores the department on login (whitespace trimmed + collapsed), refreshes it on a new value, and clears it when the claim disappears", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    // First login: JIT-provisioned WITH the department. Messy whitespace must
    // normalize (trim + inner collapse).
    await ssoLogin(app, issuer, privateKey, {
      email: "mover@acme.com",
      department: "  Customer   Success ",
    });
    expect(await storedDepartment("mover@acme.com")).toBe("Customer Success");

    // Second login with a new value: the directory move propagates.
    await ssoLogin(app, issuer, privateKey, {
      email: "mover@acme.com",
      department: "Engineering",
    });
    expect(await storedDepartment("mover@acme.com")).toBe("Engineering");

    // Third login WITHOUT the claim: the stored value is cleared, not kept.
    await ssoLogin(app, issuer, privateKey, { email: "mover@acme.com" });
    expect(await storedDepartment("mover@acme.com")).toBeNull();
  });

  it("ignores a non-string department claim and caps an overlong one", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    // Non-string claim (an IdP emitting an array/object) → treated as absent.
    await ssoLogin(app, issuer, privateKey, {
      email: "odd.claims@acme.com",
      department: ["Engineering", "Platform"],
    });
    expect(await storedDepartment("odd.claims@acme.com")).toBeNull();

    // Overlong value → stored capped at 120 chars, never unbounded.
    await ssoLogin(app, issuer, privateKey, {
      email: "odd.claims@acme.com",
      department: "x".repeat(500),
    });
    expect(await storedDepartment("odd.claims@acme.com")).toBe("x".repeat(120));
  });

  // The upsert is best-effort: it sits in its own try/catch, so a transient
  // DB failure on this ancillary write degrades to "department not captured
  // this login" instead of bouncing a fully valid sign-in to service_error.
  it("still signs the user in when the department write fails", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    const realRun = db.run.bind(db);
    const spy = vi
      .spyOn(db, "run")
      .mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes("SET department")) {
          throw new Error("disk I/O error (simulated)");
        }
        return realRun(sql, params as any[]);
      });

    try {
      const res = await ssoLogin(app, issuer, privateKey, {
        email: "resilient@acme.com",
        department: "Engineering",
      });
      // Login succeeded exactly like normal: redirect home + session cookie.
      expect(cookiesOf(res)["cnst_session"]).toMatch(/^[0-9a-f]{64}$/);
      // The write really was attempted and really did throw.
      expect(
        spy.mock.calls.some(([sql]) => String(sql).includes("SET department")),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // The failed write left no department behind — captured on a later login.
    expect(await storedDepartment("resilient@acme.com")).toBeNull();
  });

  it("captures the department for an EXISTING (password-registered) user too", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks);
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const existing = await registerUser(app, "known@acme.com");
    configureOidc();

    await ssoLogin(app, issuer, privateKey, {
      email: existing.email,
      department: "Legal",
    });
    expect(await storedDepartment("known@acme.com")).toBe("Legal");
  });
});

// ─── Department auto-tagging on node create (CU-wdqcpzwf2p) ───────────────
// When the oidc_department_tagging toggle is on and the creating user has a
// stored department, node CREATE appends `#dept:<slugified-department>` to the
// node's tags — deduped against user-supplied tags. Toggle off, or no
// department, → untagged and never an error. The department is written
// straight to users.department here (the claim-capture path is covered above)
// so these tests exercise the tagging seam in isolation.

describe("department auto-tagging on node create", () => {
  async function setDepartment(email: string, department: string | null) {
    const { getDb } = await import("../src/db/client.js");
    await getDb().run(
      "UPDATE users SET department = ? WHERE LOWER(email) = ?",
      [department, email.toLowerCase()],
    );
  }

  async function makeNest(app: any, apiKey: string): Promise<string> {
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Docs" }, apiKey);
    expect(nest.status).toBe(201);
    return nest.data.nest.id as string;
  }

  it("toggle off → node create is untagged even when the user has a department", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const user = await registerUser(app, "writer@acme.com");
    await setDepartment(user.email, "Engineering");
    const nestId = await makeNest(app, user.apiKey);

    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Plain Doc", content: "# Plain", tags: ["notes"] },
      user.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.tags).toEqual(["#notes"]);
  });

  it("toggle on + department → dept:<slug> appended alongside user tags, deduped", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const user = await registerUser(app, "writer@acme.com");
    await setDepartment(user.email, "Customer Success");
    process.env.OIDC_DEPARTMENT_TAGGING = "true";
    const nestId = await makeNest(app, user.apiKey);

    // Spaces → dashes, lowercase; user tags kept.
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Tagged Doc", content: "# Tagged", tags: ["notes"] },
      user.apiKey,
    );
    expect(created.status).toBe(201);
    expect(created.data.node.tags).toEqual(["#notes", "#dept:customer-success"]);

    // Deduped when the user already supplied the same dept tag themselves.
    const dup = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Dup Doc",
        content: "# Dup",
        tags: ["dept:customer-success", "notes"],
      },
      user.apiKey,
    );
    expect(dup.status).toBe(201);
    expect(dup.data.node.tags).toEqual(["#dept:customer-success", "#notes"]);

    // Dedupe is case-INSENSITIVE: a cased variant must suppress the auto tag
    // rather than landing both on the node. Tags store folded to lower case,
    // so the cased spelling is the same tag, not a second one.
    const cased = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Cased Doc",
        content: "# Cased",
        tags: ["Dept:Customer-Success", "notes"],
      },
      user.apiKey,
    );
    expect(cased.status).toBe(201);
    expect(cased.data.node.tags).toEqual(["#dept:customer-success", "#notes"]);

    // Create-only: an update never adds the tag to a node created without it.
    process.env.OIDC_DEPARTMENT_TAGGING = "false";
    const plain = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Pre Toggle", content: "# Pre" },
      user.apiKey,
    );
    process.env.OIDC_DEPARTMENT_TAGGING = "true";
    const updated = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${plain.data.node.id}`,
      { content: "# Pre (edited)" },
      user.apiKey,
    );
    expect(updated.status).toBe(200);
    expect(updated.data.node.tags ?? []).toEqual([]);
  });

  it("toggle on + no department → untagged, no error", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const user = await registerUser(app, "nodept@acme.com");
    process.env.OIDC_DEPARTMENT_TAGGING = "true";
    const nestId = await makeNest(app, user.apiKey);

    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "No Dept", content: "# No dept", tags: ["notes"] },
      user.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.tags).toEqual(["#notes"]);
  });

  // The tagging lives in createNode, which both REST and MCP call — smoke the
  // MCP surface too so the "covers REST + MCP creates" claim stays tested.
  it("tags a document created via the MCP context_create tool", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const user = await registerUser(app, "writer@acme.com");
    await setDepartment(user.email, "Engineering");
    process.env.OIDC_DEPARTMENT_TAGGING = "true";
    const nestId = await makeNest(app, user.apiKey);

    const rpc = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${user.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "context_create",
          arguments: { title: "MCP Doc", content: "# Via MCP", tags: ["notes"] },
        },
      }),
    });
    expect(rpc.status).toBe(200);

    const node = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/mcp-doc`,
      undefined,
      user.apiKey,
    );
    expect(node.status).toBe(200);
    expect(node.data.node.tags).toEqual(["#notes", "#dept:engineering"]);
  });

  it("round-trips the oidc_department_tagging toggle through /admin/settings", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const before = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(before.data.oidc_department_tagging).toBe(false); // default OFF

    const on = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_department_tagging: true },
      admin.apiKey,
    );
    expect(on.status).toBe(200);
    expect(on.data.settings.oidc_department_tagging).toBe(true);

    const off = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_department_tagging: false },
      admin.apiKey,
    );
    expect(off.status).toBe(200);
    expect(off.data.settings.oidc_department_tagging).toBe(false);
  });
});

// ─── /auth/oidc/logout (RP-initiated logout) ──────────────────────────────

describe("GET /auth/oidc/logout", () => {
  it("redirects through the IdP end_session_endpoint and kills the session", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks, {
      endSessionEndpoint: `${ISSUER}/logout`,
    });
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "member@acme.com",
      }),
    };
    const cb = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    const sid = cookiesOf(cb)["cnst_session"];
    expect(sid).toMatch(/^[0-9a-f]{64}$/);

    const res = await app.request("/auth/oidc/logout", {
      headers: { Cookie: `cnst_session=${sid}` },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(`${ISSUER}/logout`);
    expect(loc.searchParams.get("post_logout_redirect_uri")).toContain(
      "/",
    );
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);

    // Session gone; both cookies cleared.
    const cookies = cookiesOf(res);
    expect(cookies["cnst_session"]).toBe("");
    expect(cookies["cnst_sso_session"]).toBe("");
    const { getDb } = await import("../src/db/client.js");
    const row = await getDb().get("SELECT id FROM sessions WHERE id = ?", [sid]);
    expect(row).toBeUndefined();
  });

  it("falls back to a local logout when the IdP has no end_session_endpoint (Google)", async () => {
    const { privateKey, jwks } = await makeKeys();
    const issuer = installMockIssuer(jwks); // no endSessionEndpoint
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    configureOidc();

    const flow = await startLogin(app);
    issuer.tokenBody = {
      id_token: await signIdToken(privateKey, {
        nonce: flow.nonce,
        email: "member@acme.com",
      }),
    };
    const cb = await app.request(
      `/auth/oidc/callback?code=c&state=${flow.state}`,
      { headers: { Cookie: flow.cookieHeader } },
    );
    const sid = cookiesOf(cb)["cnst_session"];

    const res = await app.request("/auth/oidc/logout", {
      headers: { Cookie: `cnst_session=${sid}` },
    });
    expect(res.status).toBe(302);
    // Straight home, not to any IdP endpoint.
    expect(new URL(res.headers.get("Location")!).pathname).toBe("/");
    expect(cookiesOf(res)["cnst_session"]).toBe("");
    expect(cookiesOf(res)["cnst_sso_session"]).toBe("");
    const { getDb } = await import("../src/db/client.js");
    const row = await getDb().get("SELECT id FROM sessions WHERE id = ?", [sid]);
    expect(row).toBeUndefined();
  });
});

// ─── /admin/settings — OIDC fields ────────────────────────────────────────

describe("/admin/settings — OIDC", () => {
  it("is superadmin-only (403 for a non-admin)", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const stranger = await registerUser(app, "stranger@example.com");
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_issuer: ISSUER },
      stranger.apiKey,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a non-https issuer", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_issuer: "http://idp.test" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.fieldErrors).toHaveProperty("oidc_issuer");
  });

  it("rejects a malformed allowed-domains entry", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_allowed_domains: "acme.com, someone@acme.com" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.fieldErrors).toHaveProperty("oidc_allowed_domains");
  });

  it("refuses to enable OIDC while issuer/client/secret are missing", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_enabled: true },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.fieldErrors).toHaveProperty("oidc_enabled");
  });

  it("round-trips full config; the secret is write-only and null clears it", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const patch = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      {
        oidc_enabled: true,
        oidc_issuer: `${ISSUER}/`, // trailing slash must be stripped
        oidc_client_id: CLIENT_ID,
        oidc_client_secret: CLIENT_SECRET,
        oidc_allowed_domains: "Acme.com, partner.example",
        oidc_auto_provision: false,
      },
      admin.apiKey,
    );
    expect(patch.status).toBe(200);
    expect(patch.data.settings.oidc_enabled).toBe(true);
    expect(patch.data.settings.oidc_issuer).toBe(ISSUER);
    expect(patch.data.settings.oidc_client_id).toBe(CLIENT_ID);
    expect(patch.data.settings.oidc_allowed_domains).toBe(
      "acme.com, partner.example", // normalized to lowercase
    );
    expect(patch.data.settings.oidc_auto_provision).toBe(false);
    // Write-only: presence flag only, never the value.
    expect(patch.data.settings.oidc_client_secret_set).toBe(true);
    expect(patch.data.settings).not.toHaveProperty("oidc_client_secret");

    const get = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(get.data.oidc_client_secret_set).toBe(true);
    expect(JSON.stringify(get.data)).not.toContain(CLIENT_SECRET);

    // /health now advertises the ready flow (issuer included for labeling).
    const health = await app.request("/health");
    const healthData = await health.json();
    expect(healthData.oidc_enabled).toBe(true);
    expect(healthData.oidc_issuer).toBe(ISSUER);

    // null clears the secret — flow no longer configured, so enabled must be
    // turned off in the same PATCH (the dependency guard enforces it).
    const both = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_client_secret: null, oidc_enabled: false },
      admin.apiKey,
    );
    expect(both.status).toBe(200);
    expect(both.data.settings.oidc_client_secret_set).toBe(false);
    expect(both.data.settings.oidc_enabled).toBe(false);

    // And clearing the secret while trying to KEEP it enabled is refused.
    const setup = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_client_secret: CLIENT_SECRET, oidc_enabled: true },
      admin.apiKey,
    );
    expect(setup.status).toBe(200);
    const invalid = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_client_secret: null },
      admin.apiKey,
    );
    // Clearing only the secret leaves enabled=true with a broken flow — the
    // guard fires only when oidc_enabled is in the body, so this PASSES (the
    // login endpoint itself falls back to not_configured). Assert that
    // fallback instead of a validation error.
    expect(invalid.status).toBe(200);
    // GET reflects the dead flow: still enabled, no longer ready.
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.oidc_enabled).toBe(true);
    expect(after.data.oidc_ready).toBe(false);
    const login = await app.request("/auth/oidc/login");
    expect(login.status).toBe(302);
    expect(login.headers.get("Location")).toContain("sso_error=not_configured");
  });

  // ── Total-lockout guard × OIDC ──────────────────────────────────────────
  // SSO-only servers are supported: the "can't disable both manual and
  // PromptOwl sign-in" rule passes when the post-PATCH OIDC flow is
  // enabled+configured, and symmetrically refuses killing OIDC when it's the
  // only remaining way in.

  it("allows an SSO-only server: both classic methods off while OIDC is ready", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      {
        manual_sign_in: "disabled",
        promptowl_sign_in_gate: "disabled",
        oidc_enabled: true,
        oidc_issuer: ISSUER,
        oidc_client_id: CLIENT_ID,
        oidc_client_secret: CLIENT_SECRET,
      },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.settings.manual_sign_in).toBe("disabled");
    expect(res.data.settings.promptowl_sign_in_gate).toBe("disabled");
    expect(res.data.settings.oidc_enabled).toBe(true);
    expect(res.data.settings.oidc_ready).toBe(true);
  });

  it("still rejects disabling both classic methods when OIDC is off or unready", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    // OIDC entirely off.
    const off = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { manual_sign_in: "disabled", promptowl_sign_in_gate: "disabled" },
      admin.apiKey,
    );
    expect(off.status).toBe(400);
    expect(off.data.error).toMatch(/SSO \(OIDC\)/i);
    expect(off.data.fieldErrors).toHaveProperty("manual_sign_in");

    // OIDC enabled but UNREADY (no secret) in the same request — still a
    // lockout: an enabled-but-dead flow can't sign anyone in.
    const unready = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      {
        manual_sign_in: "disabled",
        promptowl_sign_in_gate: "disabled",
        oidc_enabled: true,
        oidc_issuer: ISSUER,
        oidc_client_id: CLIENT_ID,
        // no oidc_client_secret
      },
      admin.apiKey,
    );
    expect(unready.status).toBe(400);

    // Nothing applied.
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.manual_sign_in).toBe("open");
  });

  it("rejects turning OIDC off — or clearing its secret — when it's the only sign-in path", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    // Establish an SSO-only server (config getters read env live).
    configureOidc();
    process.env.MANUAL_SIGN_IN = "disabled";
    process.env.PROMPTOWL_SIGN_IN_GATE = "disabled";

    // Turning the flow off would lock everyone out.
    const disable = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_enabled: false },
      admin.apiKey,
    );
    expect(disable.status).toBe(400);
    // Keyed to the SSO field (the body only touched OIDC) so the client
    // focuses the Single sign-on tab.
    expect(disable.data.fieldErrors).toHaveProperty("oidc_enabled");
    expect(disable.data.error).toMatch(/SSO \(OIDC\)/i);

    // Clearing the secret kills the flow just as dead — same refusal.
    const clearSecret = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_client_secret: null },
      admin.apiKey,
    );
    expect(clearSecret.status).toBe(400);
    expect(clearSecret.data.fieldErrors).toHaveProperty("oidc_enabled");

    // Nothing applied — the flow is still live.
    const health = await app.request("/health");
    expect((await health.json()).oidc_enabled).toBe(true);

    // Re-opening a classic method in the SAME patch makes it legal.
    const swap = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_enabled: false, manual_sign_in: "open" },
      admin.apiKey,
    );
    expect(swap.status).toBe(200);
    expect(swap.data.settings.oidc_enabled).toBe(false);
    expect(swap.data.settings.manual_sign_in).toBe("open");
  });
});

describe("OIDC × manual sign-in default", () => {
  it("turning SSO on closes password self-registration unless open was chosen, and flags an explicit open", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const on = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { oidc_enabled: true, oidc_issuer: ISSUER, oidc_client_id: CLIENT_ID, oidc_client_secret: CLIENT_SECRET },
      admin.apiKey,
    );
    expect(on.status).toBe(200);
    expect(on.data.settings.manual_sign_in).toBe("invite-only");
    expect(on.data.settings.manual_sign_in_open_with_sso).toBe(false);

    const open = await jsonRequest(app, "PATCH", "/admin/settings", { manual_sign_in: "open" }, admin.apiKey);
    expect(open.status).toBe(200);
    expect(open.data.settings.manual_sign_in).toBe("open");
    expect(open.data.settings.manual_sign_in_open_with_sso).toBe(true);
  });
});
