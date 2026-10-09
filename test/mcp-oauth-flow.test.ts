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

/** The consent page's hidden inputs (name → value), HTML entities decoded. */
function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g))
    out[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return out;
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
  const fields = hiddenFields(html);
  expect(fields.csrf).toMatch(/^[0-9a-f]{64}$/);

  // Submit exactly what the page holds, as a browser would.
  const decision = await app.request("/oauth/authorize/decision", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form({ ...fields, decision: "allow" }),
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

  it("answers a signed-out browser with the app shell, URL unchanged", async () => {
    enable();
    const app = await createTestApp("key");
    await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const { challenge } = pkce();
    const res = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html" } },
    );
    // No redirect: the login page renders at this URL. (The shell itself is
    // only there when the UI is built, so assert on what never changes.)
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).not.toContain("Connect Claude?");
  });
});

describe("MCP OAuth — open mode", () => {
  it("explains instead of looping through the login page", async () => {
    enable();
    const app = await createTestApp("open");
    const clientId = await register(app);
    const { challenge } = pkce();
    const res = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("AUTH_MODE=key");
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
    for (const n of ["nest_index", "context_search", "context_get", "context_versions"])
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

// ─── Security hardening (review of #367) ──────────────────────────────────

describe("MCP OAuth — hardening", () => {
  /** Sign in, register a client, and walk consent → token for `scope`. */
  async function connect(app: any, scope = "nests:read") {
    const alice = await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const p = pkce();
    const code = await getCode(app, clientId, cookie, p.challenge, scope);
    const tok = await (await exchange(app, clientId, code, p.verifier)).json();
    return { alice, clientId, cookie, tok };
  }
  const index = (app: any, token: string) =>
    app.request("/index", { headers: { Authorization: `Bearer ${token}` } });
  const refresh = (app: any, clientId: string, refreshToken: string) =>
    app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
    });
  const db = async () => (await import("../src/db/client.js")).getDb();

  it("answers an expired or revoked token with an invalid_token challenge", async () => {
    enable();
    const app = await createTestApp("key");
    const { tok } = await connect(app);
    await (await db()).run("UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00.000Z'");
    for (const path of ["/mcp", "/index"]) {
      const res = await app.request(path, {
        method: path === "/mcp" ? "POST" : "GET",
        headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
        body: path === "/mcp" ? "{}" : undefined,
      });
      expect(res.status).toBe(401);
      const h = res.headers.get("www-authenticate") || "";
      expect(h).toContain('error="invalid_token"');
      expect(h).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    }
  });

  it("refuses a token whose user was removed, even without the FK cascade", async () => {
    enable();
    const app = await createTestApp("key");
    const { alice, tok } = await connect(app);
    const d = await db();
    await d.run("PRAGMA foreign_keys = OFF");
    await d.run("DELETE FROM users WHERE id = ?", [alice.userId]);
    await d.run("PRAGMA foreign_keys = ON");
    expect((await index(app, tok.access_token)).status).toBe(401);
  });

  it("revokes OAuth grants when the user changes their password", async () => {
    enable();
    const app = await createTestApp("key");
    const { cookie, tok } = await connect(app, "nests:read offline_access");
    expect((await index(app, tok.access_token)).status).toBe(200);
    const res = await app.request("/auth/password", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ current: "testpass", next: "newpass123" }),
    });
    expect(res.status).toBe(200);
    expect((await index(app, tok.access_token)).status).toBe(401);
    // The 60-day refresh token is dead too.
    expect((await refresh(app, "unused", tok.refresh_token)).status).toBe(400);
  });

  it("does not let a bad exchange burn the code or revoke the grant", async () => {
    enable();
    const app = await createTestApp("key");
    await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const otherClient = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const p = pkce();
    const code = await getCode(app, clientId, cookie, p.challenge);
    // Someone who only saw the code: wrong verifier, then the wrong client.
    expect((await exchange(app, clientId, code, pkce().verifier)).status).toBe(400);
    expect((await exchange(app, otherClient, code, p.verifier)).status).toBe(400);
    // The real client still redeems it, and its token works.
    const res = await exchange(app, clientId, code, p.verifier);
    expect(res.status).toBe(200);
    expect((await index(app, (await res.json()).access_token)).status).toBe(200);
  });

  it("does not count an expired code presented twice as a replay", async () => {
    enable();
    const app = await createTestApp("key");
    const { clientId, cookie, tok } = await connect(app);
    const p = pkce();
    const code = await getCode(app, clientId, cookie, p.challenge);
    await (await db()).run(
      "UPDATE oauth_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL",
    );
    expect((await exchange(app, clientId, code, p.verifier)).status).toBe(400);
    expect((await exchange(app, clientId, code, p.verifier)).status).toBe(400);
    // The earlier, unrelated grant is untouched.
    expect((await index(app, tok.access_token)).status).toBe(200);
  });

  it("revokes the grant when a rotated refresh token is presented again", async () => {
    enable();
    const app = await createTestApp("key");
    const { clientId, tok } = await connect(app, "nests:read offline_access");
    const r1 = await (await refresh(app, clientId, tok.refresh_token)).json();
    expect(r1.access_token).toBeTruthy();
    // The old refresh token again: theft, per OAuth 2.1 §4.3.1.
    expect((await refresh(app, clientId, tok.refresh_token)).status).toBe(400);
    expect((await index(app, r1.access_token)).status).toBe(401);
    expect((await refresh(app, clientId, r1.refresh_token)).status).toBe(400);
  });

  it("serves one winner when the same refresh token is used concurrently", async () => {
    enable();
    const app = await createTestApp("key");
    const { clientId, tok } = await connect(app, "nests:read offline_access");
    const results = await Promise.all([
      refresh(app, clientId, tok.refresh_token),
      refresh(app, clientId, tok.refresh_token),
    ]);
    expect(results.map((r: Response) => r.status).sort()).toEqual([200, 400]);
  });

  it("refuses an approval whose scope differs from the consent page", async () => {
    enable();
    const app = await createTestApp("key");
    await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const { challenge } = pkce();
    const page = await app.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=nests%3Aread` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { headers: { Cookie: cookie } },
    );
    const fields = hiddenFields(await page.text());
    for (const forged of [
      { scope: "nests:read nests:write offline_access" },
      { code_challenge: pkce().challenge },
      { state: "other" },
    ]) {
      const res = await app.request("/oauth/authorize/decision", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ ...fields, ...forged, decision: "allow" }),
      });
      expect(res.status).toBe(403);
    }
  });

  it("enforces read scope on /index", async () => {
    enable();
    const app = await createTestApp("key");
    const { tok } = await connect(app, "offline_access");
    const res = await index(app, tok.access_token);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("insufficient_scope");
  });

  it("forbids framing and caching of the consent page and token responses", async () => {
    enable();
    process.env.FRAME_ANCESTORS = "*";
    try {
      const app = await createTestApp("key");
      await registerUser(app, "alice@example.com");
      const clientId = await register(app);
      const cookie = await signIn(app, "alice@example.com", "testpass");
      const p = pkce();
      const page = await app.request(
        `/oauth/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
          `&code_challenge=${p.challenge}&code_challenge_method=S256`,
        { headers: { Cookie: cookie } },
      );
      expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(page.headers.get("cache-control")).toBe("no-store");
      const code = await getCode(app, clientId, cookie, p.challenge);
      const tok = await exchange(app, clientId, code, p.verifier);
      expect(tok.status).toBe(200);
      expect(tok.headers.get("cache-control")).toBe("no-store");
      expect(tok.headers.get("pragma")).toBe("no-cache");
    } finally {
      delete process.env.FRAME_ANCESTORS;
    }
  });

  it("validates resource and the PKCE value shapes", async () => {
    enable();
    const app = await createTestApp("key");
    await registerUser(app, "alice@example.com");
    const clientId = await register(app);
    const cookie = await signIn(app, "alice@example.com", "testpass");
    const authz = (q: string) =>
      app.request(
        `/oauth/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge_method=S256${q}`,
        { headers: { Cookie: cookie } },
      );
    const errorOf = (res: Response) =>
      new URL(res.headers.get("location")!).searchParams.get("error");
    const good = pkce();
    expect(errorOf(await authz(`&code_challenge=x`))).toBe("invalid_request");
    expect(
      errorOf(await authz(`&code_challenge=${good.challenge}&resource=${encodeURIComponent("https://other.example/mcp")}`)),
    ).toBe("invalid_target");
    // A trailing slash on the right resource is fine.
    expect((await authz(`&code_challenge=${good.challenge}&resource=${encodeURIComponent(`${BASE}/mcp/`)}`)).status).toBe(200);
    // A verifier shorter than RFC 7636's 43 characters is refused, even if it hashes right.
    const short = "a".repeat(42);
    const shortChallenge = createHash("sha256").update(short).digest("base64url");
    const code = await getCode(app, clientId, cookie, shortChallenge);
    expect((await exchange(app, clientId, code, short)).status).toBe(400);
  });

  it("strips control and bidi characters from client_name", async () => {
    enable();
    const app = await createTestApp("key");
    const res = await app.request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Clau‮de​\u0007", redirect_uris: [REDIRECT] }),
    });
    expect((await res.json()).client_name).toBe("Claude");
  });

  it("purges clients that never connected, and keeps ones that did", async () => {
    enable();
    const app = await createTestApp("key");
    const { clientId } = await connect(app);
    const idle = await register(app);
    const d = await db();
    await d.run("UPDATE oauth_clients SET created_at = '2000-01-01 00:00:00'");
    const { purgeExpired } = await import("../src/auth/oauth-store.js");
    await purgeExpired();
    const left = (await d.all("SELECT client_id FROM oauth_clients")) as Array<{ client_id: string }>;
    expect(left.map((r) => r.client_id)).toEqual([clientId]);
    expect(left.map((r) => r.client_id)).not.toContain(idle);
  });
});
