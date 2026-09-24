/**
 * POST /auth/invite — admin issues a teammate a temporary PASSWORD (not an API
 * key). Re-inviting any existing email is refused (409) and never overwrites
 * credentials — signed in or not. Re-issuing a password is Reset password.
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

  it("refuses re-inviting a not-yet-signed-in user (409) and keeps their first password", async () => {
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
    expect(second.status).toBe(409);
    expect(second.data.error).toMatch(/already invited.*Reset password/);
    expect(second.data.temporary_password).toBeUndefined();

    // The password she was first sent still works.
    const login = await jsonRequest(app, "POST", "/auth/login", {
      email: "carol@co.com",
      password: first.data.temporary_password,
    });
    expect(login.status).toBe(200);
  });

  it("refuses inviting someone a nest was already shared with — no overwrite", async () => {
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Shared" }, admin.apiKey);
    await jsonRequest(
      app,
      "POST",
      `/nests/${nest.data.nest.id}/collaborators`,
      { email: "frank@co.com", permission: "read" },
      admin.apiKey,
    );
    const inv = await jsonRequest(
      app,
      "POST",
      "/auth/invite",
      { email: "frank@co.com" },
      admin.apiKey,
    );
    expect(inv.status).toBe(409);
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
    expect(reinvite.data.error).toMatch(/already a member/);
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
