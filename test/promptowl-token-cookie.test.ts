/**
 * The PromptOwl token cookie, at the login/logout ends.
 *
 * Signing in with PromptOwl is the ONE moment the token can be captured —
 * PromptOwl hands it over exactly once, at device approval. We park it in an
 * httpOnly cookie so team import can call PromptOwl later without another
 * approval, and so nothing PromptOwl is ever written to this server's database.
 *
 * The device request must also ask PromptOwl to scope the token to reads, so a
 * stolen cookie can't act as the user.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestEnv, createTestApp, resetAuthRateLimit } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let fetchCalls: Array<{ url: string; body: any }>;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");

  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    fetchCalls.push({
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (u.includes("/api/auth/device")) {
      return new Response(
        JSON.stringify({
          deviceCode: "DEV",
          clientSecret: "SEC",
          verificationUrl: "/device?code=DEV",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // /api/user/me — the identity round-trip of POST /auth/promptowl
    return new Response(
      JSON.stringify({ user: { name: "Owner", email: "owner@acme.com" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
});

beforeEach(async () => {
  fetchCalls = [];
  await resetAuthRateLimit();
});

afterAll(() => {
  vi.unstubAllGlobals();
  env.cleanup();
});

const poCookie = (res: Response) =>
  res.headers.getSetCookie().find((c: string) => c.startsWith("cnst_po_token="));

const poMarker = (res: Response) =>
  res.headers.getSetCookie().find((c: string) => c.startsWith("cnst_po_session="));

describe("device request", () => {
  it("accepts a request with no body — every field has a default", async () => {
    const res = await app.request("/auth/device", { method: "POST" });
    expect(res.status).toBe(200);
    expect(fetchCalls[0].body.deviceName).toBe("ContextNest Community");
    expect(fetchCalls[0].body.scopes).toEqual(["user:read", "teams:read"]);
  });

  it("asks PromptOwl to scope the token to reads", async () => {
    const res = await app.request("/auth/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    // The least this server can work with: identify the user, read their teams.
    // Anything wider would hand us a token that could chat as them or spend
    // their credits — and that token ends up in their browser cookie.
    expect(fetchCalls[0].body.scopes).toEqual(["user:read", "teams:read"]);
  });
});

describe("sign-in with PromptOwl", () => {
  it("parks the approval token in an httpOnly, team-scoped cookie", async () => {
    const res = await app.request("/auth/promptowl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "po_device_login" }),
    });
    expect(res.status).toBe(200);

    const cookie = poCookie(res);
    expect(cookie).toContain("po_device_login");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/teams");
  });

  it("still sets the session cookie alongside it", async () => {
    const res = await app.request("/auth/promptowl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "po_device_login" }),
    });
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c: string) => c.startsWith("cnst_session="))).toBe(true);
    expect(cookies.some((c: string) => c.startsWith("cnst_po_token="))).toBe(true);
  });

  it("sets a readable marker so the UI can offer the PromptOwl tab", async () => {
    const res = await app.request("/auth/promptowl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "po_device_login" }),
    });
    const marker = poMarker(res);
    expect(marker).toBeDefined();
    // Carries no secret — the token itself stays httpOnly and Path=/teams.
    expect(marker).toContain("cnst_po_session=1");
    expect(marker).not.toContain("HttpOnly");
    expect(marker).toContain("Path=/");
  });
});

describe("logout", () => {
  it("clears the PromptOwl token cookie with the session", async () => {
    const login = await app.request("/auth/promptowl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "po_device_login" }),
    });
    const session = login.headers
      .getSetCookie()
      .find((c: string) => c.startsWith("cnst_session="))!
      .split(";")[0];

    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: session },
    });
    expect(res.status).toBe(200);

    // Otherwise the next person on a shared browser inherits PromptOwl access.
    const cleared = poCookie(res);
    expect(cleared).toBeDefined();
    expect(cleared).toContain("Max-Age=0");
    // The marker goes too, or the UI keeps offering a tab that can't work.
    expect(poMarker(res)).toContain("Max-Age=0");
  });
});
