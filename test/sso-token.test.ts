/**
 * Unit tests for the HS256 SSO ticket verifier (src/auth/sso-token.ts).
 * Pure crypto/structure checks — no app, no DB.
 */
import { describe, it, expect } from "vitest";
import { createHmac, randomUUID } from "crypto";
import { verifySsoTicket, SsoTokenError } from "../src/auth/sso-token.js";

const SECRET = "test-shared-secret-0123456789";

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Mint a JWT the way PromptOwl does, with overridable header/payload. */
function mint(
  payload: Record<string, unknown>,
  secret = SECRET,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

const now = Math.floor(Date.now() / 1000);
const goodClaims = () => ({
  sub: "user@example.com",
  name: "User",
  aud: "https://community.test",
  jti: randomUUID(),
  iat: now,
  exp: now + 60,
});

describe("verifySsoTicket @unit", () => {
  it("returns claims for a valid ticket", () => {
    const claims = goodClaims();
    const out = verifySsoTicket(mint(claims), SECRET, now);
    expect(out.sub).toBe("user@example.com");
    expect(out.aud).toBe("https://community.test");
    expect(out.jti).toBe(claims.jti);
  });

  it("throws when secret is empty", () => {
    expect(() => verifySsoTicket(mint(goodClaims()), "", now)).toThrow(
      SsoTokenError,
    );
  });

  it("rejects a tampered/ bad signature", () => {
    // Signed with a different secret → signature won't verify.
    const forged = mint(goodClaims(), "wrong-secret");
    expect(() => verifySsoTicket(forged, SECRET, now)).toThrow(/signature/i);
  });

  it("rejects a non-HS256 alg (no algorithm downgrade)", () => {
    const t = mint(goodClaims(), SECRET, { alg: "none", typ: "JWT" });
    expect(() => verifySsoTicket(t, SECRET, now)).toThrow(/alg/i);
  });

  it("rejects an expired ticket (beyond leeway)", () => {
    const claims = { ...goodClaims(), exp: now - 120 };
    expect(() => verifySsoTicket(mint(claims), SECRET, now)).toThrow(/expired/i);
  });

  it("accepts a ticket within clock-skew leeway", () => {
    const claims = { ...goodClaims(), exp: now - 10 }; // 10s ago, leeway 30s
    expect(() => verifySsoTicket(mint(claims), SECRET, now)).not.toThrow();
  });

  it("rejects a ticket with no exp", () => {
    const { exp, ...noExp } = goodClaims();
    expect(() => verifySsoTicket(mint(noExp), SECRET, now)).toThrow(/exp/i);
  });

  it("rejects a ticket with no sub", () => {
    const { sub, ...noSub } = goodClaims();
    expect(() => verifySsoTicket(mint(noSub), SECRET, now)).toThrow(/sub/i);
  });

  it("rejects a malformed (non-3-part) token", () => {
    expect(() => verifySsoTicket("not.a.jwt.really", SECRET, now)).toThrow(
      /malformed/i,
    );
    expect(() => verifySsoTicket("", SECRET, now)).toThrow(SsoTokenError);
  });
});
