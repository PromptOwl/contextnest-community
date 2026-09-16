/**
 * OAuth "Connect" for plugins: consent redirect (signed state + PKCE),
 * callback (exchange, store refresh token write-only), token refresh before
 * every run, disconnect, and the failure modes a real provider produces.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const FIXTURE = resolve(__dirname, "fixtures/plugins/oauthy.mjs");

/** A fake OAuth provider: records the authorize hits it never sees (we only inspect the redirect) and serves /token. */
function fakeProvider() {
  const tokenCalls: Array<Record<string, string>> = [];
  let refreshShouldFail = false;
  let grants = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/token") {
        const p = Object.fromEntries(new URLSearchParams(body));
        tokenCalls.push(p);
        if (p.client_id !== "cid" || p.client_secret !== "csecret") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_client" })); }
        if (p.grant_type === "authorization_code") {
          if (p.code !== "good-code" || !p.code_verifier) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_grant" })); }
          grants++;
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ access_token: `at-${grants}`, refresh_token: "rt-secret", expires_in: 3600, scope: "read", token_type: "Bearer", id_token: undefined }));
        }
        if (p.grant_type === "refresh_token") {
          if (refreshShouldFail || p.refresh_token !== "rt-secret") { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_grant" })); }
          grants++;
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ access_token: `at-${grants}`, expires_in: 3600 }));
        }
      }
      if (req.url === "/me") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ email: "person@acme.com" })); }
      res.writeHead(404); res.end();
    });
  });
  return { server, tokenCalls, setRefreshFail: (v: boolean) => (refreshShouldFail = v), grants: () => grants };
}

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let editor: { apiKey: string; userId: string; email: string };
let viewer: { apiKey: string; userId: string; email: string };
let nestId: string;
let provider: ReturnType<typeof fakeProvider>;
let base: string;
let fixture: { state: { items: any[]; seenTokens: any[] } };

beforeAll(async () => {
  provider = fakeProvider();
  await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(provider.server.address() as AddressInfo).port}`;
  process.env.FAKE_OAUTH_BASE = base;
  process.env.FEATURE_PLUGINS = "true";
  process.env.PLUGINS = FIXTURE;
  process.env.PLUGIN_OAUTH_OAUTHY_CLIENT_ID = "cid";
  process.env.PLUGIN_OAUTH_OAUTHY_CLIENT_SECRET = "csecret";
  process.env.OAUTH_ALLOW_INSECURE = "true";
  process.env.PUBLIC_BASE_URL = "https://nest.example.com";
  env = setupTestEnv();
  app = await createTestApp("key", { ownerEmail: "owner@acme.com" });
  fixture = await import(FIXTURE);
  owner = await registerUser(app, "owner@acme.com", "Owner");
  editor = await registerUser(app, "editor@acme.com", "Editor");
  viewer = await registerUser(app, "viewer@acme.com", "Viewer");
  await resetAuthRateLimit();
  const nest = await jsonRequest(app, "POST", "/nests", { name: "OAuth" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: editor.email, permission: "write" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: viewer.email, permission: "read" }, owner.apiKey);
});
afterAll(async () => {
  for (const k of ["FEATURE_PLUGINS", "PLUGINS", "PLUGIN_OAUTH_OAUTHY_CLIENT_ID", "PLUGIN_OAUTH_OAUTHY_CLIENT_SECRET", "OAUTH_ALLOW_INSECURE", "PUBLIC_BASE_URL", "FAKE_OAUTH_BASE"]) delete process.env[k];
  await new Promise<void>((r) => provider.server.close(() => r()));
  env.cleanup();
});
beforeEach(() => { fixture.state.items = []; fixture.state.seenTokens = []; provider.setRefreshFail(false); });

describe("plugin OAuth connect", () => {
  it("the plugin list says it needs a connection and is not connected; run-now is refused until then", async () => {
    await jsonRequest(app, "PUT", `/nests/${nestId}/plugins/oauthy`, { enabled: true, settings: { folder: "x" } }, editor.apiKey);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, editor.apiKey);
    const p = list.data.plugins.find((x: any) => x.name === "oauthy");
    expect(p.oauth).toMatchObject({ provider: "custom", connected: false });
    expect(p.secretKeys).not.toContain("accessToken");
    const run = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/oauthy/run`, {}, editor.apiKey);
    expect(run.status).toBe(409);
    expect(run.data.error).toMatch(/connect/i);
  });

  it("viewers cannot start a connection; editors get a 302 to the provider with PKCE + a signed state", async () => {
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/plugins/oauthy/connect`, undefined, viewer.apiKey)).status).toBe(403);
    const res = await app.request(`/nests/${nestId}/plugins/oauthy/connect`, { headers: { authorization: `Bearer ${editor.apiKey}` }, redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`${base}/authorize`);
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("scope")).toBe("read");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://nest.example.com/auth/plugins/callback");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(loc.searchParams.get("access_type")).toBe("offline");
  });

  it("callback: a tampered or unknown state is refused and stores nothing; a good code stores the refresh token write-only and redirects to the Plugins tab", async () => {
    const start = await app.request(`/nests/${nestId}/plugins/oauthy/connect`, { headers: { authorization: `Bearer ${editor.apiKey}` }, redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const bad = await app.request(`/auth/plugins/callback?code=good-code&state=${state}x`, { redirect: "manual" });
    expect(bad.status).toBe(400);
    const denied = await app.request(`/auth/plugins/callback?error=access_denied&state=${state}`, { redirect: "manual" });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("connect_error=access_denied");
    // a denial consumes nothing? no — the state is single-use either way; start again
    const start2 = await app.request(`/nests/${nestId}/plugins/oauthy/connect`, { headers: { authorization: `Bearer ${editor.apiKey}` }, redirect: "manual" });
    const state2 = new URL(start2.headers.get("location")!).searchParams.get("state")!;
    const ok = await app.request(`/auth/plugins/callback?code=good-code&state=${state2}`, { redirect: "manual" });
    expect(ok.status).toBe(302);
    const to = new URL(ok.headers.get("location")!);
    expect(to.pathname + to.search).toMatch(new RegExp(`/nest/${nestId}.*tab=plugins.*connected=oauthy`));
    const exchange = provider.tokenCalls.find((c) => c.grant_type === "authorization_code")!;
    expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(exchange.redirect_uri).toBe("https://nest.example.com/auth/plugins/callback");
    // replay is refused
    expect((await app.request(`/auth/plugins/callback?code=good-code&state=${state2}`, { redirect: "manual" })).status).toBe(400);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, viewer.apiKey);
    const p = list.data.plugins.find((x: any) => x.name === "oauthy");
    expect(p.oauth).toMatchObject({ provider: "custom", connected: true, connected_by: editor.email });
    expect(JSON.stringify(list.data)).not.toContain("rt-secret");
  });

  it("a run exchanges the refresh token for a fresh access token and injects it; the plugin never sees the refresh token", async () => {
    fixture.state.items = [{ externalId: "o1", kind: "document", title: "Connected item", occurredAt: "2026-09-16T00:00:00Z", body: "hi", provenance: { fetchedAt: "2026-09-16T00:00:00Z", hash: "1" } }];
    const before = provider.grants();
    const run = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/oauthy/run`, {}, editor.apiKey);
    expect(run.status).toBe(200);
    expect(run.data.run.created).toBe(1);
    expect(fixture.state.seenTokens[0]).toMatch(/^at-\d+$/);
    expect(provider.grants()).toBe(before + 1);
    const refresh = provider.tokenCalls.filter((c) => c.grant_type === "refresh_token").pop()!;
    expect(refresh.refresh_token).toBe("rt-secret");
    // second run inside the token's lifetime reuses the cached access token
    await jsonRequest(app, "POST", `/nests/${nestId}/plugins/oauthy/run`, {}, editor.apiKey);
    expect(provider.grants()).toBe(before + 1);
  });

  it("a revoked refresh token fails the run with a reconnect message and the plugin shows disconnected", async () => {
    provider.setRefreshFail(true);
    const { invalidateTokenCache } = await import("../src/plugins/oauth.js");
    invalidateTokenCache();
    const run = await jsonRequest(app, "POST", `/nests/${nestId}/plugins/oauthy/run`, {}, editor.apiKey);
    expect(run.status).toBe(409);
    expect(run.data.error).toMatch(/reconnect/i);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, editor.apiKey);
    expect(list.data.plugins.find((x: any) => x.name === "oauthy").oauth.connected).toBe(false);
  });

  it("disconnect forgets the tokens (editor only)", async () => {
    // reconnect first
    const start = await app.request(`/nests/${nestId}/plugins/oauthy/connect`, { headers: { authorization: `Bearer ${editor.apiKey}` }, redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    await app.request(`/auth/plugins/callback?code=good-code&state=${state}`, { redirect: "manual" });
    expect((await jsonRequest(app, "DELETE", `/nests/${nestId}/plugins/oauthy/connection`, undefined, viewer.apiKey)).status).toBe(403);
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/plugins/oauthy/connection`, undefined, editor.apiKey);
    expect(del.status).toBe(200);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/plugins`, undefined, editor.apiKey);
    expect(list.data.plugins.find((x: any) => x.name === "oauthy").oauth.connected).toBe(false);
  });

  it("with no OAuth client configured for the provider, connect is a 409 that names the setting", async () => {
    const saved = process.env.PLUGIN_OAUTH_OAUTHY_CLIENT_ID;
    delete process.env.PLUGIN_OAUTH_OAUTHY_CLIENT_ID;
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/plugins/oauthy/connect`, undefined, editor.apiKey);
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("PLUGIN_OAUTH_OAUTHY_CLIENT_ID");
    process.env.PLUGIN_OAUTH_OAUTHY_CLIENT_ID = saved;
  });
});
