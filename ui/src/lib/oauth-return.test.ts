import { describe, it, expect } from "vitest";
import { isOAuthPath, safeOAuthReturn } from "./oauth-return";

describe("safeOAuthReturn", () => {
  it("accepts the authorize path", () => {
    const v = "/oauth/authorize?response_type=code&client_id=cnc_1";
    expect(safeOAuthReturn(v)).toBe(v);
  });

  it("rejects anything that could leave the app or the flow", () => {
    for (const v of [
      null,
      "",
      "https://evil.example/oauth/authorize?x",
      "//evil.example/oauth/authorize?x",
      "/\\evil.example",
      "/nests",
      "/oauth/authorize/decision",
      "javascript:alert(1)",
    ])
      expect(safeOAuthReturn(v)).toBeNull();
  });
});

describe("isOAuthPath", () => {
  it("matches only the OAuth surface", () => {
    expect(isOAuthPath("/oauth/authorize")).toBe(true);
    expect(isOAuthPath("/")).toBe(false);
    expect(isOAuthPath("/oauthx")).toBe(false);
  });
});
