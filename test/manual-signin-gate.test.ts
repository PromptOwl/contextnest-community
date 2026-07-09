/**
 * MANUAL_SIGN_IN — the email/password sign-in mode (open | invite-only |
 * disabled). Independent of PROMPTOWL_SIGN_IN_GATE.
 *
 *   open        — anyone may log in and self-register a NEW account.
 *   invite-only — existing/invited users may log in; brand-new self-registration
 *                 is refused (403). Admins provision accounts and share the
 *                 password (Invite / Reset); users log in and change it.
 *   disabled    — no email/password login or registration at all (403).
 *
 * Security: /auth/register never sets the password on an already-provisioned
 * (invited) account — there's no email verification, so that would be account
 * takeover. Such an attempt is refused (409) in every mode.
 *
 * /health surfaces the mode so the login page can adapt.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;

beforeEach(() => {
  env = setupTestEnv();
  delete process.env.MANUAL_SIGN_IN;
});

afterEach(() => {
  delete process.env.MANUAL_SIGN_IN;
  env.cleanup();
});

describe("manual sign-in gate", () => {
  it("open (default): allows self-register + login", async () => {
    const app = await createTestApp("key");

    const reg = await jsonRequest(app, "POST", "/auth/register", {
      email: "a@example.com",
      password: "testpass",
      name: "A",
    });
    expect(reg.status).toBe(201);

    const login = await jsonRequest(app, "POST", "/auth/login", {
      email: "a@example.com",
      password: "testpass",
    });
    expect(login.status).toBe(200);

    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.manual_sign_in).toBe("open");
  });

  it("never lets self-register set the password on an invited account (409)", async () => {
    const app = await createTestApp("key");
    const { getDb } = await import("../src/db/client.js");

    // An admin-provisioned placeholder (invite / share / steward).
    await getDb().run(
      "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
      [randomUUID(), "invited@example.com", null, "x"],
    );

    // A stranger who knows the email must NOT be able to claim it by registering.
    const res = await jsonRequest(app, "POST", "/auth/register", {
      email: "invited@example.com",
      password: "attacker-chosen",
      name: "Mallory",
    });
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/invited/i);
  });

  it("disabled: blocks register + login with 403", async () => {
    process.env.MANUAL_SIGN_IN = "disabled";
    const app = await createTestApp("key");

    const reg = await jsonRequest(app, "POST", "/auth/register", {
      email: "b@example.com",
      password: "testpass",
      name: "B",
    });
    expect(reg.status).toBe(403);

    const login = await jsonRequest(app, "POST", "/auth/login", {
      email: "b@example.com",
      password: "testpass",
    });
    expect(login.status).toBe(403);

    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.manual_sign_in).toBe("disabled");
  });

  it("invite-only: blocks new self-register but existing users can still log in", async () => {
    const app = await createTestApp("key");

    // Create an account while open, then switch to invite-only (config getters
    // read process.env live, so no new app instance is needed).
    const reg = await jsonRequest(app, "POST", "/auth/register", {
      email: "u@example.com",
      password: "testpass",
      name: "U",
    });
    expect(reg.status).toBe(201);

    process.env.MANUAL_SIGN_IN = "invite-only";

    // Brand-new self-registration is refused.
    const newReg = await jsonRequest(app, "POST", "/auth/register", {
      email: "new@example.com",
      password: "testpass",
      name: "N",
    });
    expect(newReg.status).toBe(403);
    expect(newReg.data.error).toMatch(/self-registration is disabled/i);

    // The existing user can still log in (invite-only only restricts sign-up).
    const login = await jsonRequest(app, "POST", "/auth/login", {
      email: "u@example.com",
      password: "testpass",
    });
    expect(login.status).toBe(200);

    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.manual_sign_in).toBe("invite-only");
  });
});
