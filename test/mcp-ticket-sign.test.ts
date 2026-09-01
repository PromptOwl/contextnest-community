import { describe, it, expect } from "vitest";
import {
  signMcpTicket,
  verifySsoTicket,
  SsoTokenError,
} from "../src/auth/sso-token";

// The token-exchange mints an MCP ticket that the SAME acceptor
// (flexAuthWithPromptowlTicket) must accept. These pin the mint↔verify
// invariant: scope "mcp", no jti, exp honoured, secret-bound.
const SECRET = "test-mcp-signing-secret-0123456789abcdef";

describe("signMcpTicket", () => {
  it("round-trips: a minted ticket verifies under the same secret", () => {
    const t = signMcpTicket(
      { sub: "user@example.com", aud: "https://x.ai", ttlSeconds: 300 },
      SECRET,
      1000,
    );
    const claims = verifySsoTicket(t, SECRET, 1000);
    expect(claims.sub).toBe("user@example.com");
    expect(claims.scope).toBe("mcp");
    expect(claims.aud).toBe("https://x.ai");
    expect(claims.exp).toBe(1300);
    expect(claims.jti).toBeUndefined();
  });

  it("always sets scope=mcp and never a jti (the acceptor invariant)", () => {
    const claims = verifySsoTicket(
      signMcpTicket({ sub: "a@b.co", ttlSeconds: 60 }, SECRET, 0),
      SECRET,
      0,
    );
    expect(claims.scope).toBe("mcp");
    expect(claims.jti).toBeUndefined();
  });

  it("a ticket minted with one secret fails under another (no cross-trust)", () => {
    const t = signMcpTicket({ sub: "a@b.co", ttlSeconds: 60 }, SECRET, 0);
    expect(() => verifySsoTicket(t, "a-different-secret", 0)).toThrow(
      SsoTokenError,
    );
  });

  it("rejects a non-email subject and clamps the TTL", () => {
    expect(() =>
      signMcpTicket({ sub: "not-an-email", ttlSeconds: 60 }, SECRET),
    ).toThrow(SsoTokenError);
    // 999999s asked → clamped to the 1h ceiling.
    const t = signMcpTicket({ sub: "a@b.co", ttlSeconds: 999999 }, SECRET, 0);
    expect(verifySsoTicket(t, SECRET, 0).exp).toBe(3600);
  });

  it("refuses to mint without a secret", () => {
    expect(() => signMcpTicket({ sub: "a@b.co", ttlSeconds: 60 }, "")).toThrow(
      SsoTokenError,
    );
  });

  it("the minted ticket expires (verifier enforces exp)", () => {
    const t = signMcpTicket({ sub: "a@b.co", ttlSeconds: 60 }, SECRET, 1000);
    expect(() => verifySsoTicket(t, SECRET, 1000 + 60 + 31)).toThrow(/expired/i);
  });
});
