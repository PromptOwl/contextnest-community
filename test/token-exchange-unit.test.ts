import { describe, it, expect } from "vitest";
import { expectedIssuer } from "../src/auth/token-exchange";

// Pure issuer-derivation — the audience/signature checks need the app + a mock
// IdP (that's the CI integration test, test/token-exchange.test.ts). This pins
// the one piece of provider policy that's pure: the expected issuer string.
describe("expectedIssuer", () => {
  it("builds the tenant-scoped Entra v2 issuer", () => {
    expect(expectedIssuer("microsoft", "9188040d-tenant")).toBe(
      "https://login.microsoftonline.com/9188040d-tenant/v2.0",
    );
  });

  it("is empty for microsoft with no tenant (treated as not configured)", () => {
    expect(expectedIssuer("microsoft", "")).toBe("");
  });

  it("uses the fixed Google issuer regardless of tenant arg", () => {
    expect(expectedIssuer("google", "ignored")).toBe(
      "https://accounts.google.com",
    );
  });
});
