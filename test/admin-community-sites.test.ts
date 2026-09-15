/**
 * DB-backed official community site management (CU-wdqcq0247t).
 *
 * /admin/community-sites lets a server admin configure MULTIPLE official
 * community sites trusted for one-click SSO auto-login, each with its own
 * name/url/secret and an active flag — replacing the single
 * OFFICIAL_COMMUNITY_SSO_SECRET/PUBLIC_BASE_URL env-var pair (which keeps
 * working as an implicit extra "legacy" site — see sso-route.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomUUID } from "crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: { apiKey: string; userId: string; email: string };
let alice: { apiKey: string; userId: string; email: string };

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
  root = await registerUser(app, "root@acme.com", "Root");
  alice = await registerUser(app, "alice@acme.com", "Alice");
});

afterAll(() => env.cleanup());

describe("GET /admin/community-sites", () => {
  it("is superadmin-only", async () => {
    const res = await jsonRequest(app, "GET", "/admin/community-sites", undefined, alice.apiKey);
    expect(res.status).toBe(403);
  });

  it("starts empty", async () => {
    const res = await jsonRequest(app, "GET", "/admin/community-sites", undefined, root.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.community_sites).toEqual([]);
  });
});

describe("POST /admin/community-sites", () => {
  it("a non-superadmin cannot add a site", async () => {
    const res = await jsonRequest(
      app, "POST", "/admin/community-sites",
      { name: "Main", url: "https://community.example.com", secret: "s".repeat(20) },
      alice.apiKey,
    );
    expect(res.status).toBe(403);
  });

  it("400s a missing name", async () => {
    const res = await jsonRequest(
      app, "POST", "/admin/community-sites",
      { url: "https://community.example.com", secret: "s".repeat(20) },
      root.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("400s an invalid url", async () => {
    const res = await jsonRequest(
      app, "POST", "/admin/community-sites",
      { name: "Main", url: "not-a-url", secret: "s".repeat(20) },
      root.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("400s a short secret", async () => {
    const res = await jsonRequest(
      app, "POST", "/admin/community-sites",
      { name: "Main", url: "https://community.example.com", secret: "short" },
      root.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("creates a site, defaulting is_active to true and never echoing the secret", async () => {
    const res = await jsonRequest(
      app, "POST", "/admin/community-sites",
      { name: "Main", url: "https://community.example.com/", secret: "s".repeat(20) },
      root.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.name).toBe("Main");
    expect(res.data.url).toBe("https://community.example.com"); // trailing slash stripped
    expect(res.data.is_active).toBe(true);
    expect(res.data.secret_set).toBe(true);
    expect(res.data.secret).toBeUndefined();

    const list = await jsonRequest(app, "GET", "/admin/community-sites", undefined, root.apiKey);
    expect(list.data.community_sites).toHaveLength(1);
  });

  it("409s a duplicate url", async () => {
    const res = await jsonRequest(
      app, "POST", "/admin/community-sites",
      { name: "Dup", url: "https://community.example.com", secret: "t".repeat(20) },
      root.apiKey,
    );
    expect(res.status).toBe(409);
  });
});

describe("PATCH /admin/community-sites/:id", () => {
  it("toggles is_active without requiring a new secret", async () => {
    const list = await jsonRequest(app, "GET", "/admin/community-sites", undefined, root.apiKey);
    const site = list.data.community_sites[0];

    const res = await jsonRequest(
      app, "PATCH", `/admin/community-sites/${site.id}`, { is_active: false }, root.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.is_active).toBe(false);
    expect(res.data.name).toBe(site.name);
  });

  it("404s an unknown id", async () => {
    const res = await jsonRequest(
      app, "PATCH", "/admin/community-sites/does-not-exist", { name: "X" }, root.apiKey,
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/community-sites/:id", () => {
  it("404s an unknown id", async () => {
    const res = await jsonRequest(
      app, "DELETE", "/admin/community-sites/does-not-exist", undefined, root.apiKey,
    );
    expect(res.status).toBe(404);
  });

  it("removes a site", async () => {
    const list = await jsonRequest(app, "GET", "/admin/community-sites", undefined, root.apiKey);
    const site = list.data.community_sites[0];
    const res = await jsonRequest(
      app, "DELETE", `/admin/community-sites/${site.id}`, undefined, root.apiKey,
    );
    expect(res.status).toBe(200);

    const after = await jsonRequest(app, "GET", "/admin/community-sites", undefined, root.apiKey);
    expect(after.data.community_sites).toHaveLength(0);
  });
});

describe("SSO handshake against a DB-configured site", () => {
  const SECRET = "db-site-secret-0123456789";
  const URL = "https://db-configured.example.com";

  function b64url(input: string | Buffer): string {
    return Buffer.from(input)
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }
  function ticket(over: Record<string, unknown> = {}, secret = SECRET): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "site-user@example.com",
      name: "Site User",
      aud: URL,
      jti: randomUUID(),
      iat: now,
      exp: now + 60,
      ...over,
    };
    const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const p = b64url(JSON.stringify(payload));
    const sig = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
    return `${h}.${p}.${sig}`;
  }
  function location(res: Response): string {
    return res.headers.get("location") || "";
  }

  it("no configured sites and no legacy env vars → not_supported", async () => {
    delete process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
    delete process.env.PUBLIC_BASE_URL;
    const res = await app.request("/auth/sso?ticket=" + ticket(), { method: "GET" });
    expect(location(res)).toContain("sso_error=not_supported");
  });

  it("an inactive site's secret is not accepted", async () => {
    const created = await jsonRequest(
      app, "POST", "/admin/community-sites",
      { name: "DB Site", url: URL, secret: SECRET, is_active: false },
      root.apiKey,
    );
    expect(created.status).toBe(201);

    const res = await app.request("/auth/sso?ticket=" + ticket(), { method: "GET" });
    expect(location(res)).toContain("sso_error=not_supported"); // still no active candidate
  });

  it("activating the site lets its ticket sign a user in", async () => {
    const list = await jsonRequest(app, "GET", "/admin/community-sites", undefined, root.apiKey);
    const site = list.data.community_sites.find((s: any) => s.url === URL);
    const activate = await jsonRequest(
      app, "PATCH", `/admin/community-sites/${site.id}`, { is_active: true }, root.apiKey,
    );
    expect(activate.data.is_active).toBe(true);

    const res = await app.request(
      "/auth/sso?ticket=" + ticket({ sub: "db-user@example.com" }),
      { method: "GET" },
    );
    expect(res.status).toBe(302);
    expect(location(res)).toBe("/");

    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get(
      "SELECT email FROM users WHERE LOWER(email) = ?",
      ["db-user@example.com"],
    )) as { email: string } | undefined;
    expect(row?.email).toBe("db-user@example.com");
  });

  it("a ticket minted for a different site's audience is rejected (bad_audience)", async () => {
    const res = await app.request(
      "/auth/sso?ticket=" + ticket({ sub: "other@example.com", aud: "https://not-this-site.example.com" }),
      { method: "GET" },
    );
    expect(location(res)).toContain("sso_error=bad_audience");
  });

  it("a second, unrelated site's ticket is rejected as invalid (secret doesn't match any candidate)", async () => {
    const res = await app.request(
      "/auth/sso?ticket=" + ticket({ sub: "stranger@example.com" }, "totally-different-secret"),
      { method: "GET" },
    );
    expect(location(res)).toContain("sso_error=invalid_ticket");
  });
});
