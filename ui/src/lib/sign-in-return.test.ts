import { describe, expect, it } from "vitest";
import { parkNestReturn, safeNestReturn, takeNestReturn } from "./sign-in-return";

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
    for (const bad of ["//evil.example/nest/x", "https://evil.example/nest/x", "/\\evil.example", "/nest/\\evil", "/my-work", "/nest/", "", null]) {
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
