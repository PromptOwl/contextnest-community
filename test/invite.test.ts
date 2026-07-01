/**
 * POST /auth/invite — admin issues a teammate a temporary PASSWORD (not an API
 * key). Re-inviting a not-yet-claimed user refreshes the temp password, but once
 * the teammate has claimed their account by choosing their own password, a
 * re-invite must NOT clobber it (409). The "claim" is /auth/password setting
 * is_invited = 0 — the guard this test locks in.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let admin: { apiKey: string; userId: string; email: string };

beforeAll(async () => {
  env = setupTestEnv();
  // ownerEmail makes the registered admin the license admin (invite is gated).
  app = await createTestApp("open", { ownerEmail: "admin@co.com" });
  admin = await registerUser(app, "admin@co.com");
});

afterAll(() => env.cleanup());

/** Log in and return the session cookie the response set. */
async function loginForCookie(email: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie") || "";
}

describe("POST /auth/invite", () => {
  it("issues a temporary password a new teammate can log in with", async () => {
    const inv = await jsonRequest(
      app,
      "POST",
      "/auth/invite",
      { email: "bob@co.com" },
      admin.apiKey,
    );
    expect(inv.status).toBe(201);
    expect(typeof inv.data.temporary_password).toBe("string");
    expect(inv.data.temporary_password.length).toBeGreaterThan(0);

    const login = await jsonRequest(app, "POST", "/auth/login", {
      email: "bob@co.com",
      password: inv.data.temporary_password,
    });
    expect(login.status).toBe(200);
  });

  it("refreshes the temp password when re-inviting a not-yet-claimed user", async () => {
    const first = await jsonRequest(
      app,
      "POST",
      "/auth/invite",
      { email: "carol@co.com" },
      admin.apiKey,
    );
    const second = await jsonRequest(
      app,
      "POST",
      "/auth/invite",
      { email: "carol@co.com" },
      admin.apiKey,
    );
    expect(second.status).toBe(201);
    expect(second.data.temporary_password).not.toBe(first.data.temporary_password);

    // Old temp is dead; the refreshed one works.
    const stale = await jsonRequest(app, "POST", "/auth/login", {
      email: "carol@co.com",
      password: first.data.temporary_password,
    });
    expect(stale.status).toBe(401);
    const fresh = await jsonRequest(app, "POST", "/auth/login", {
      email: "carol@co.com",
      password: second.data.temporary_password,
    });
    expect(fresh.status).toBe(200);
  });

  it("clears is_invited on first login, so a later re-invite is refused (409)", async () => {
    const inv = await jsonRequest(
      app,
      "POST",
      "/auth/invite",
      { email: "erin@co.com" },
      admin.apiKey,
    );
    // A single successful login with the temp password claims the account.
    const login = await jsonRequest(app, "POST", "/auth/login", {
      email: "erin@co.com",
      password: inv.data.temporary_password,
    });
    expect(login.status).toBe(200);

    // Re-invite is now refused even though she never changed her password.
    const reinvite = await jsonRequest(
      app,
      "POST",
      "/auth/invite",
      { email: "erin@co.com" },
      admin.apiKey,
    );
    expect(reinvite.status).toBe(409);
  });

  it("does NOT clobber a claimed password on re-invite (409)", async () => {
    const inv = await jsonRequest(
      app,
      "POST",
      "/auth/invite",
      { email: "dave@co.com" },
      admin.apiKey,
    );
    const temp = inv.data.temporary_password;

    // Dave claims the account: log in with the temp password, then choose his own.
    const cookie = await loginForCookie("dave@co.com", temp);
    const change = await app.request("/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ current: temp, next: "daveChosenPass1" }),
    });
    expect(change.status).toBe(200);

    // Re-invite must refuse — Dave now owns a self-chosen credential.
    const reinvite = await jsonRequest(
      app,
      "POST",
      "/auth/invite",
      { email: "dave@co.com" },
      admin.apiKey,
    );
    expect(reinvite.status).toBe(409);

    // And his chosen password still works.
    const login = await jsonRequest(app, "POST", "/auth/login", {
      email: "dave@co.com",
      password: "daveChosenPass1",
    });
    expect(login.status).toBe(200);
  });
});
