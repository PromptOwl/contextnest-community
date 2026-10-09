/**
 * The MCP OAuth flow end to end: register → authorize → consent → code →
 * token → use it on /mcp → refresh → revoke.
 *
 * The point of the whole build is the assertion in "reads as the person who
 * signed in": a token minted for one user must see that user's nests, not the
 * nests of whoever happens to own an API key. Everything else here exists to
 * make that reachable safely.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, randomBytes } from "crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

const BASE = "https://nest.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

beforeEach(() => setupTestEnv());
afterEach(() => {
  delete process.env.MCP_OAUTH_ENABLED;
  delete process.env.PUBLIC_BASE_URL;
});

function enable() {
  process.env.MCP_OAUTH_ENABLED = "true";
  process.env.PUBLIC_BASE_URL = BASE;
}

function pkce() {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(app: any, redirectUris = [REDIRECT]) {
  const res = await app.request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).client_id as string;
}

/** Sign in and return the raw session cookie to replay on later requests. */
async function signIn(app: any, email: string, password: string) {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

function form(fields: Record<string, string>) {
  return new URLSearchParams(fields).toString();
}

/** Walk authorize → consent → code, returning the authorization code. */
async function getCode(
  app: any,
  clientId: string,
  cookie: string,
  challenge: string,
  scope = "nests:read",
) {
  const authz = await app.request(
    `/oauth/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(scope)}` +
      `&state=xyz&code_challenge=${challenge}&code_challenge_method=S256` +
      `&resource=${encodeURIComponent(`${BASE}/mcp`)}`,
    { headers: { Cookie: cookie } },
  );
  expect(authz.status).toBe(200);
  const html = await authz.text();
  expect(html).toContain("Connect Claude?");
  const csrf = html.match(/name="csrf" value="([0-9a-f]{64})"/)?.[1];
  expect(csrf).toBeTruthy();

  const decision = await app.request("/oauth/authorize/decision", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form({
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope,
      state: "xyz",
      code_challenge: challenge,
      resource: `${BASE}/mcp`,
      csrf: csrf!,
      decision: "allow",
    }),
  });
  expect(decision.status).toBe(302);
  const loc = new URL(decision.headers.get("location")!);
  expect(loc.searchParams.get("state")).toBe("xyz");
  const code = loc.searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

async function exchange(
  app: any,
  clientId: string,
  code: string,
  verifier: string,
) {
  return app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
}

// ─── The happy path ───────────────────────────────────────────────────────

describe("MCP OAuth — end to end", () => {
  it("reads as the person who signed in, not as a key owner", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const bob = await registerUser(app, "bob@example.com");

    // Each owns a nest the other cannot see.
    await jsonRequest(app, "POST", "/nests", { name: "Alice Private" }, alice.apiKey);
    await jsonRequest(app, "POST", "/nests", { name: "Bob Private" }, bob.apiKey);

    const clientId = await register(app);
    const { verifier, challenge } = pkce();
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const code = await getCode(app, clientId, cookie, challenge);

    const tokenRes = await exchange(app, clientId, code, verifier);
    expect(tokenRes.status).toBe(200);
    const tok = await tokenRes.json();
    expect(tok.token_type).toBe("Bearer");
    expect(tok.access_token).toMatch(/^[0-9a-f]{64}$/);

    // The whole point: this token sees Alice's nests.
    const index = await app.request("/index", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    expect(index.status).toBe(200);
    const body = await index.text();
    expect(body).toContain("Alice Private");
    expect(body).not.toContain("Bob Private");
  });

  it("issues a refresh token only when offline_access was granted", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");

    const a = pkce();
    const codeA = await getCode(app, clientId, cookie, a.challenge, "nests:read");
    const noRefresh = await (await exchange(app, clientId, codeA, a.verifier)).json();
    expect(noRefresh.refresh_token).toBeUndefined();

    const b = pkce();
    const codeB = await getCode(
      app, clientId, cookie, b.challenge, "nests:read offline_access",
    );
    const withRefresh = await (await exchange(app, clientId, codeB, b.verifier)).json();
    expect(withRefresh.refresh_token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rotates the refresh token and kills the old one", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { verifier, challenge } = pkce();
    const code = await getCode(
      app, clientId, cookie, challenge, "nests:read offline_access",
    );
    const first = await (await exchange(app, clientId, code, verifier)).json();

    const refreshed = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: clientId,
      }),
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next.refresh_token).not.toBe(first.refresh_token);

    // OAuth 2.1 requires rotation for public clients: the replaced token must
    // stop working, or rotation buys nothing.
    const reuse = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: clientId,
      }),
    });
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error).toBe("invalid_grant");
  });
});

// ─── The refusals that matter ─────────────────────────────────────────────

describe("MCP OAuth — refusals", () => {
  it("refuses a code without the matching PKCE verifier", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { challenge } = pkce();
    const code = await getCode(app, clientId, cookie, challenge);

    const res = await exchange(app, clientId, code, randomBytes(32).toString("hex"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  /**
   * A code presented twice has leaked. Refusing only the second exchange
   * leaves whatever the first one minted alive, so the whole grant goes.
   */
  it("revokes the whole grant when a code is replayed", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { verifier, challenge } = pkce();
    const code = await getCode(app, clientId, cookie, challenge);

    const first = await (await exchange(app, clientId, code, verifier)).json();
    const live = await app.request("/index", {
      headers: { Authorization: `Bearer ${first.access_token}` },
    });
    expect(live.status).toBe(200);

    const replay = await exchange(app, clientId, code, verifier);
    expect(replay.status).toBe(400);

    // The token minted by the first, legitimate-looking exchange is gone too.
    const after = await app.request("/index", {
      headers: { Authorization: `Bearer ${first.access_token}` },
    });
    expect(after.status).toBe(401);
  });

  it("refuses a redirect_uri the client never registered", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { challenge } = pkce();

    const res = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent("https://evil.example/cb")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { headers: { Cookie: cookie } },
    );
    // Shown to the USER, never redirected — redirecting an unvalidated URI is
    // the open redirect this check exists to prevent.
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a decision POST that swaps in another redirect", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { challenge } = pkce();

    const res = await app.request("/oauth/authorize/decision", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form({
        client_id: clientId,
        redirect_uri: "https://evil.example/cb",
        scope: "nests:read",
        code_challenge: challenge,
        decision: "allow",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses an approval without the consent page's CSRF token", async () => {
    enable();
    const app = await createTestApp("key");
    await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { challenge } = pkce();

    for (const csrf of [undefined, "0".repeat(64)]) {
      const res = await app.request("/oauth/authorize/decision", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form({
          client_id: clientId,
          redirect_uri: REDIRECT,
          scope: "nests:read",
          code_challenge: challenge,
          decision: "allow",
          ...(csrf ? { csrf } : {}),
        }),
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("rejects loopback redirect URIs with a non-http scheme", async () => {
    enable();
    const app = await createTestApp("key");
    for (const uri of ["javascript://localhost/%0aalert(1)", "myapp://127.0.0.1/cb"]) {
      const res = await app.request("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("caps the redirect_uris a registration may carry", async () => {
    enable();
    const app = await createTestApp("key");
    const tooMany = Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`);
    const tooLong = [`https://a.example/${"x".repeat(2048)}`];
    for (const uris of [tooMany, tooLong]) {
      const res = await app.request("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: uris }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("requires S256 PKCE, redirecting the error to the client", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");

    const res = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=x` +
        `&code_challenge_method=plain&state=s1`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("s1");
  });

  it("refuses a code redeemed by a different client", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientA = await register(app);
    const clientB = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { verifier, challenge } = pkce();
    const code = await getCode(app, clientA, cookie, challenge);

    const res = await exchange(app, clientB, code, verifier);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("denies cleanly when the user cancels", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { challenge } = pkce();

    const res = await app.request("/oauth/authorize/decision", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form({
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: "nests:read",
        state: "s9",
        code_challenge: challenge,
        decision: "deny",
      }),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("shows a sign-in page rather than leaking that a client is valid", async () => {
    enable();
    const app = await createTestApp("key");
    await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const { challenge } = pkce();
    const res = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sign in");
  });
});

// ─── Revocation ───────────────────────────────────────────────────────────

describe("MCP OAuth — revocation", () => {
  it("stops a revoked access token working, and always 200s", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { verifier, challenge } = pkce();
    const code = await getCode(app, clientId, cookie, challenge);
    const tok = await (await exchange(app, clientId, code, verifier)).json();

    const revoke = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ token: tok.access_token }),
    });
    expect(revoke.status).toBe(200);

    const after = await app.request("/index", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    expect(after.status).toBe(401);

    // RFC 7009: an unknown token is still a 200, so this is not an oracle.
    const unknown = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ token: randomBytes(32).toString("hex") }),
    });
    expect(unknown.status).toBe(200);
  });
});

// ─── The flag ─────────────────────────────────────────────────────────────

describe("MCP OAuth — flag off", () => {
  it("404s every endpoint", async () => {
    const app = await createTestApp("key");
    for (const [path, method] of [
      ["/oauth/register", "POST"],
      ["/oauth/authorize", "GET"],
      ["/oauth/token", "POST"],
      ["/oauth/revoke", "POST"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, path).toBe(404);
    }
  });
});

// ─── Review findings ──────────────────────────────────────────────────────

describe("MCP OAuth — scope is a real boundary", () => {
  /**
   * The consent screen says "Read the nests you have access to" for a
   * nests:read grant. If write tools still work, that sentence is a lie and
   * the scope split is decoration. Write access must require nests:write.
   */
  it("refuses a write tool on a read-only grant", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { verifier, challenge } = pkce();
    const code = await getCode(app, clientId, cookie, challenge, "nests:read");
    const tok = await (await exchange(app, clientId, code, verifier)).json();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "nest_create", arguments: { name: "Sneaky" } },
      }),
    });
    const text = await res.text();
    expect(text).toMatch(/nests:write|insufficient/i);
    expect(text).not.toMatch(/Sneaky/);
  });

  it("allows the same write tool once nests:write was granted", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { verifier, challenge } = pkce();
    const code = await getCode(
      app, clientId, cookie, challenge, "nests:read nests:write",
    );
    const tok = await (await exchange(app, clientId, code, verifier)).json();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "nest_create", arguments: { name: "Allowed" } },
      }),
    });
    expect(await res.text()).not.toMatch(/nests:write required/i);
  });

  /** A cnst_ key is not an OAuth grant and must not be narrowed by this. */
  it("leaves API-key callers unrestricted", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const res = await jsonRequest(
      app, "POST", "/nests", { name: "Key Nest" }, alice.apiKey,
    );
    expect(res.status).toBe(201);
  });
});

describe("MCP OAuth — consent names where the code is going", () => {
  /**
   * Registration is open (RFC 7591 DCR), so anyone can mint a client called
   * "Claude" pointing at their own redirect. The only thing that lets a person
   * notice is seeing the destination.
   */
  it("shows the redirect origin on the consent page", async () => {
    enable();
    const app = await createTestApp("key");
    await registerUser(app, "alice@example.com");
    const clientId = await register(app, ["https://evil.example/cb"]);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { challenge } = pkce();

    const res = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent("https://evil.example/cb")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Must be VISIBLE, not merely present in a hidden round-trip field —
    // that would satisfy a naive substring check while showing the person
    // nothing.
    const visible = html.replace(/<input[^>]*type="hidden"[^>]*>/g, "");
    expect(visible).toContain("evil.example");
  });
});

describe("MCP OAuth — single use is atomic", () => {
  /**
   * The check used to be SELECT-then-UPDATE, which two concurrent exchanges
   * can both pass before either write lands. On Postgres that is a real race,
   * and both callers would receive a full token pair.
   */
  it("mints one token pair when the same code is exchanged concurrently", async () => {
    enable();
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { verifier, challenge } = pkce();
    const code = await getCode(app, clientId, cookie, challenge);

    const results = await Promise.all([
      exchange(app, clientId, code, verifier),
      exchange(app, clientId, code, verifier),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
  });
});

describe("scope classification", () => {
  /**
   * The read-only set is an allow-list, so a tool added later defaults to
   * requiring nests:write. This asserts that the classification is a real
   * decision for every tool rather than an accident of which list it landed
   * in — if a genuinely read-only tool is added, it must be added to the set
   * deliberately, and this test is where that shows up.
   */
  it("classifies every server tool, defaulting new ones to write", async () => {
    const { SERVER_TOOL_DEFINITIONS, serverToolNeedsWrite } = await import(
      "../src/mcp/server-routes.js"
    );
    const names = SERVER_TOOL_DEFINITIONS.map((t: any) => t.name);
    expect(names.length).toBeGreaterThan(0);
    // Reads we expect to stay reads.
    for (const n of ["nest_index", "context_search", "context_get"])
      expect(serverToolNeedsWrite(n)).toBe(false);
    // Writes, including anything unrecognised.
    for (const n of ["nest_create", "context_update", "context_delete", "made_up_tool"])
      expect(serverToolNeedsWrite(n)).toBe(true);
  });
});

describe("MCP OAuth — read scope is enforced too", () => {
  /**
   * The mirror of the write check. `nests:write` alone was grantable, and
   * nothing required `nests:read` for a read tool — so a grant whose consent
   * screen listed only "Create and edit documents" could still read
   * everything. Write implies read (a write grant that cannot read is
   * useless), so the fix is to say so explicitly and show it on the consent
   * screen rather than leave it implied.
   */
  it("grants read alongside write, and says so on the consent page", async () => {
    enable();
    const app = await createTestApp("key");
    await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { verifier, challenge } = pkce();

    const authz = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=nests%3Awrite` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { headers: { Cookie: cookie } },
    );
    const html = await authz.text();
    // The person is told it can read, because it can.
    expect(html).toContain("Read the nests you have access to");

    const code = await getCode(
      app, clientId, cookie, challenge, "nests:write",
    );
    const tok = await (await exchange(app, clientId, code, verifier)).json();
    expect(tok.scope.split(" ")).toContain("nests:read");
  });

  /** A token carrying neither read nor write must reach no tool at all. */
  it("refuses read tools to a grant with no read scope", async () => {
    const { serverToolNeedsWrite } = await import("../src/mcp/server-routes.js");
    // Sanity: the classifier still calls these reads...
    expect(serverToolNeedsWrite("nest_index")).toBe(false);
    // ...and the dispatch gate is what must also require read scope.
    const { scopeAllows } = await import("../src/mcp/server-routes.js");
    expect(scopeAllows(["offline_access"], "nest_index")).toBe(false);
    expect(scopeAllows(["nests:read"], "nest_index")).toBe(true);
    expect(scopeAllows(["nests:write"], "nest_index")).toBe(true);
    expect(scopeAllows(["nests:read"], "nest_create")).toBe(false);
    expect(scopeAllows(["nests:write"], "nest_create")).toBe(true);
  });
});

describe("MCP OAuth — purge", () => {
  it("deletes dead tokens and keeps live ones", async () => {
    const app = await createTestApp("key");
    const alice = await registerUser(app, "alice@example.com");
    // After createTestApp: it resets modules, and the store must share its db.
    const { issueTokens, purgeExpired, resolveAccessToken } = await import("../src/auth/oauth-store.js");
    const { getDb } = await import("../src/db/client.js");
    const grant = (withRefresh: boolean) =>
      issueTokens({ userId: alice.userId, clientId: "c", clientName: "C", scope: "nests:read", resource: null, withRefresh });
    const live = await grant(true);
    const dead = await grant(false);
    await getDb().run(
      "UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE refresh_token_hash IS NULL",
    );
    await purgeExpired();
    const rows = (await getDb().all("SELECT refresh_token_hash FROM oauth_tokens")) as unknown[];
    expect(rows).toHaveLength(1);
    expect(await resolveAccessToken(live.accessToken)).not.toBeNull();
    expect(await resolveAccessToken(dead.accessToken)).toBeNull();
  });
});
