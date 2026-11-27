import { describe, expect, it } from "vitest";
import { nextFromSearch, parkNestReturn, safeNestReturn, signInAddress, takeNestReturn } from "./sign-in-return";

function store() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("AC-UX-01 a channel link opened signed out is kept for after sign-in", () => {
  const link = "/nest/n-1/channels?channel=ops&thread=t-1";

  it("parks the link and hands it back once", () => {
    const s = store();
    parkNestReturn(link, s, 1_000);
    expect(takeNestReturn(s, 2_000)).toBe(link);
    expect(takeNestReturn(s, 2_000)).toBeNull();
  });

  it("forgets a link after ten minutes", () => {
    const s = store();
    parkNestReturn(link, s, 0);
    expect(takeNestReturn(s, 10 * 60_000 + 1)).toBeNull();
  });

  it("follows only this app's own nest paths", () => {
    expect(safeNestReturn(link)).toBe(link);
    expect(safeNestReturn("/nest/n-1?doc=nodes%2Fplan")).toBe("/nest/n-1?doc=nodes%2Fplan");
    for (const bad of [
      "//evil.example/nest/x",
      "https://evil.example/nest/x",
      "/\\evil.example",
      "/nest/\\evil",
      "/nest/x/\\evil",
      "/nest/../admin",
      "/nest/x/../../admin",
      "/nest/./x",
      "/nest/x/%2e%2e/%2e%2e/admin",
      "/nest/x/%2E%2E/admin",
      "/nest/x/.%2e/admin",
      "/my-work",
      "/nest/",
      "",
      null,
    ]) {
      expect(safeNestReturn(bad)).toBeNull();
    }
    const s = store();
    parkNestReturn("//evil.example/nest/x", s, 0);
    expect(takeNestReturn(s, 1)).toBeNull();
  });

  it("ignores a stored value that was tampered with", () => {
    const s = store();
    s.setItem("cnst_nest_return", JSON.stringify({ value: "https://evil.example/", at: 5 }));
    expect(takeNestReturn(s, 6)).toBeNull();
    s.setItem("cnst_nest_return", "not json");
    expect(takeNestReturn(s, 6)).toBeNull();
  });
});

describe("AC-C3-20 the link stays in the address bar while signed out (?next=), so a reload, a new tab or a sign-in that leaves the page still returns to it", () => {
  const link = "/nest/n-1/chat?channel=general&thread=t-1";
  it("writes the sign-in address with the link as ?next= and reads it back", () => {
    const at = signInAddress(link);
    expect(at).toBe("/?next=%2Fnest%2Fn-1%2Fchat%3Fchannel%3Dgeneral%26thread%3Dt-1");
    expect(nextFromSearch(at.slice(1))).toBe(link);
  });
  it("follows only a same-origin path into a nest", () => {
    for (const bad of ["https://evil.test/nest/x", "//evil.test/nest/x", "/\\evil.test", "/settings", "/nest/x/../../admin", "javascript:alert(1)"]) {
      expect(nextFromSearch(`?next=${encodeURIComponent(bad)}`)).toBeNull();
    }
    expect(nextFromSearch("")).toBeNull();
    expect(nextFromSearch("?next=")).toBeNull();
  });
  it("leaves a link it would not follow out of the address", () => {
    expect(signInAddress("/settings")).toBe("/");
  });
});

describe("a chat-identity link page (/link/<token>) survives sign-in", () => {
  it("follows /link/<token> and nothing that escapes it", () => {
    expect(nextFromSearch(`?next=${encodeURIComponent("/link/abc_DEF-123")}`)).toBe("/link/abc_DEF-123");
    for (const bad of ["/link/", "/link/../admin", "/link/a/b", "/link/a?x=1", "//evil.example/link/a", "/link/%2e%2e"]) {
      expect(safeNestReturn(bad)).toBeNull();
    }
  });
});
