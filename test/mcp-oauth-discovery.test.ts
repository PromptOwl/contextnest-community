/**
 * MCP OAuth — discovery documents and the 401 challenge (increment A).
 *
 * This is the handshake every MCP client starts with: hit the endpoint with no
 * token, read `WWW-Authenticate` for a pointer to the protected-resource
 * metadata (RFC 9728), follow that to the authorization server metadata
 * (RFC 8414). Get any of it subtly wrong and the client fails with no useful
 * error — so the shape is pinned here rather than discovered in production.
 *
 * The whole surface is behind MCP_OAUTH_ENABLED, default off. With it off the
 * server must behave exactly as it did before: `/.well-known/*` 404s as JSON,
 * and `/mcp` answers unauthenticated callers the way it always has.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";
import {
  protectedResourceMetadata,
  authorizationServerMetadata,
} from "../src/auth/oauth-metadata.js";

const BASE = "https://nest.example.com";

beforeEach(() => setupTestEnv());
afterEach(() => {
  delete process.env.MCP_OAUTH_ENABLED;
  delete process.env.PUBLIC_BASE_URL;
});

function enable() {
  process.env.MCP_OAUTH_ENABLED = "true";
  process.env.PUBLIC_BASE_URL = BASE;
}

// ─── The documents themselves (pure) ──────────────────────────────────────

describe("protected resource metadata (RFC 9728)", () => {
  it("names the MCP endpoint as the resource, exactly", () => {
    // Claude compares this against the URL the user typed. A trailing slash
    // or a bare origin here is a silent connection failure.
    const doc = protectedResourceMetadata(BASE);
    expect(doc.resource).toBe(`${BASE}/mcp`);
  });

  it("tolerates a trailing slash on the configured base URL", () => {
    expect(protectedResourceMetadata(`${BASE}/`).resource).toBe(`${BASE}/mcp`);
  });

  it("lists this server as the authorization server, first", () => {
    // Claude uses authorization_servers[0] and does NOT fall back to later
    // entries, so the primary issuer has to lead.
    const doc = protectedResourceMetadata(BASE);
    expect(doc.authorization_servers[0]).toBe(BASE);
  });

  it("advertises bearer in the header, never the query string", () => {
    const doc = protectedResourceMetadata(BASE);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });

  it("offers a least-privilege scope set that can be stepped up from", () => {
    const doc = protectedResourceMetadata(BASE);
    expect(doc.scopes_supported).toContain("nests:read");
    expect(doc.scopes_supported).toContain("nests:write");
  });
});

describe("authorization server metadata (RFC 8414)", () => {
  it("carries every field a client needs to start the flow", () => {
    const doc = authorizationServerMetadata(BASE);
    expect(doc.issuer).toBe(BASE);
    expect(doc.authorization_endpoint).toBe(`${BASE}/oauth/authorize`);
    expect(doc.token_endpoint).toBe(`${BASE}/oauth/token`);
    expect(doc.revocation_endpoint).toBe(`${BASE}/oauth/revoke`);
    expect(doc.response_types_supported).toEqual(["code"]);
  });

  /**
   * MCP clients MUST refuse to proceed when this is absent — it is the only
   * way they can verify PKCE support before starting.
   */
  it("advertises S256 PKCE", () => {
    expect(
      authorizationServerMetadata(BASE).code_challenge_methods_supported,
    ).toEqual(["S256"]);
  });

  /**
   * Claude picks CIMD when the metadata claims it (plus "none" auth). We have
   * not built CIMD yet, so claiming it would strand Claude on a client_id our
   * store cannot resolve. Until it lands, the claim must stay false so Claude
   * uses DCR (/oauth/register), which is implemented and tested.
   */
  it("does not claim CIMD support it cannot honour; offers public-client auth", () => {
    const doc = authorizationServerMetadata(BASE);
    expect(doc.client_id_metadata_document_supported).toBe(false);
    expect(doc.registration_endpoint).toBe(`${BASE}/oauth/register`);
    expect(doc.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("offers refresh tokens via offline_access", () => {
    const doc = authorizationServerMetadata(BASE);
    expect(doc.scopes_supported).toContain("offline_access");
    expect(doc.grant_types_supported).toContain("refresh_token");
    expect(doc.grant_types_supported).toContain("authorization_code");
  });

  it("tolerates a trailing slash on the configured base URL", () => {
    expect(authorizationServerMetadata(`${BASE}/`).issuer).toBe(BASE);
  });
});

// ─── Served over HTTP, gated on the flag ──────────────────────────────────

describe("discovery endpoints — flag off (the default)", () => {
  it("still 404s /.well-known/* as JSON", async () => {
    const app = await createTestApp("key");
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      // JSON, not the SPA shell — a discovery client JSON.parses this blind.
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
    }
  });
});

describe("discovery endpoints — flag on", () => {
  it("serves the protected resource metadata at the path-suffixed location", async () => {
    enable();
    const app = await createTestApp("key");
    const res = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.resource).toBe(`${BASE}/mcp`);
    expect(doc.authorization_servers).toEqual([BASE]);
  });

  it("serves the authorization server metadata", async () => {
    enable();
    const app = await createTestApp("key");
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.issuer).toBe(BASE);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
  });

  /**
   * Without PUBLIC_BASE_URL there is no canonical URL to put in `resource`,
   * and a guessed one silently fails the client's exact-match check. Refuse
   * to serve a document that can't be correct.
   */
  it("503s rather than guessing when PUBLIC_BASE_URL is unset", async () => {
    process.env.MCP_OAUTH_ENABLED = "true";
    delete process.env.PUBLIC_BASE_URL;
    const app = await createTestApp("key");
    const res = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(503);
  });

  it("leaves unrelated /.well-known paths 404ing", async () => {
    enable();
    const app = await createTestApp("key");
    const res = await app.request("/.well-known/openid-configuration");
    expect(res.status).toBe(404);
  });
});

// ─── The 401 challenge on /mcp ────────────────────────────────────────────

describe("/mcp challenge", () => {
  /**
   * Claude does not honour WWW-Authenticate on a 200, and treats a tool error
   * as a tool error. The 401 with a resource_metadata pointer is the only
   * thing that starts the flow.
   */
  it("401s an unauthenticated caller with a resource_metadata pointer", async () => {
    enable();
    const app = await createTestApp("key");
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    const header = res.headers.get("www-authenticate") || "";
    expect(header).toMatch(/^Bearer /);
    expect(header).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  // The 405 for GET (no SSE stream) sits behind auth: an anonymous GET still
  // gets the challenge, so a client probing GET first starts the OAuth flow.
  it("401s an anonymous GET too, on both endpoints, before the 405", async () => {
    enable();
    const app = await createTestApp("key");
    for (const path of ["/mcp", "/nests/00000000-0000-0000-0000-000000000000/mcp"]) {
      const res = await app.request(path, { method: "GET", headers: { Accept: "text/event-stream" } });
      expect(res.status).toBe(401);
    }
  });

  /**
   * Clients request exactly these, so a connected agent can write and stays
   * signed in (refresh token) without a second consent.
   */
  it("names the scopes the client should request", async () => {
    enable();
    const app = await createTestApp("key");
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.headers.get("www-authenticate")).toContain(
      'scope="nests:read nests:write offline_access"',
    );
  });

  it("sends no challenge header at all while the flag is off", async () => {
    const app = await createTestApp("key");
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("does not challenge a caller who already presented a credential", async () => {
    enable();
    const app = await createTestApp("key");
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer cnst_notarealkey" },
    });
    // Still rejected — but as a bad credential, not as "you need to log in",
    // so a client with a stale token doesn't loop through the consent flow.
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});

// ─── The superadmin toggle ────────────────────────────────────────────────

describe("/admin/settings — mcp_oauth_enabled", () => {
  const OWNER = "owner@example.com";

  it("is off by default and reports through /health", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER });
    const health = await app.request("/health");
    expect((await health.json()).mcp_oauth_enabled).toBe(false);
  });

  it("turns on at runtime and starts serving discovery", async () => {
    process.env.PUBLIC_BASE_URL = BASE;
    const app = await createTestApp("key", { ownerEmail: OWNER });
    const admin = await registerUser(app, OWNER);

    const before = await app.request("/.well-known/oauth-authorization-server");
    expect(before.status).toBe(404);

    const patch = await jsonRequest(
      app, "PATCH", "/admin/settings", { mcp_oauth_enabled: true }, admin.apiKey,
    );
    expect(patch.status).toBe(200);

    const after = await app.request("/.well-known/oauth-authorization-server");
    expect(after.status).toBe(200);
    expect((await app.request("/health").then((r) => r.json())).mcp_oauth_enabled).toBe(true);
  });

  /**
   * Without a canonical base URL the metadata cannot be correct, so the
   * feature would be on and broken. The server refuses the combination with a
   * reason rather than letting an admin turn on something that silently fails.
   */
  it("refuses to turn on while PUBLIC_BASE_URL is unset", async () => {
    delete process.env.PUBLIC_BASE_URL;
    const app = await createTestApp("key", { ownerEmail: OWNER });
    const admin = await registerUser(app, OWNER);
    const patch = await jsonRequest(
      app, "PATCH", "/admin/settings", { mcp_oauth_enabled: true }, admin.apiKey,
    );
    expect(patch.status).toBe(400);
    expect(patch.data.fieldErrors).toHaveProperty("mcp_oauth_enabled");
  });

  it("accepts it in the same PATCH that sets the base URL", async () => {
    delete process.env.PUBLIC_BASE_URL;
    const app = await createTestApp("key", { ownerEmail: OWNER });
    const admin = await registerUser(app, OWNER);
    const patch = await jsonRequest(
      app, "PATCH", "/admin/settings",
      { public_base_url: BASE, mcp_oauth_enabled: true }, admin.apiKey,
    );
    expect(patch.status).toBe(200);
  });
});
