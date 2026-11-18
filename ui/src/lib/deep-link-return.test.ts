/**
 * PO-1391: a nest or document link followed while signed out survives a
 * sign-in that leaves the page (PromptOwl, Google, single sign-on), which
 * comes back to Home. The link is parked in the tab and opened on return.
 */
import { describe, it, expect } from "vitest";
import { deepLinkToOpenOnReturn, parkDeepLink, safeDeepLink, takeParkedDeepLink, type LinkStore } from "./deep-link-return";

function store(): LinkStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("safeDeepLink: only a path inside this app that names a nest", () => {
  it("accepts nest and document links, with their query and hash", () => {
    for (const v of ["/nest/abc-123", "/nest/abc-123/board", "/nest/abc-123?doc=nodes%2Fpricing&thread=t1", "/nest/abc-123?tab=review#x", "/?nest=abc-123&doc=x"])
      expect(safeDeepLink(v)).toBe(v);
  });

  it("rejects anything that could leave the app (no open redirect)", () => {
    for (const v of [
      null,
      undefined,
      "",
      "https://evil.example/nest/abc",
      "//evil.example/nest/abc",
      "/\\evil.example/nest/abc",
      "/\\/evil.example/nest/abc",
      "\\\\evil.example/nest/abc",
      "javascript:alert(1)",
      "data:text/html,/nest/abc",
      "nest/abc",
      " /nest/abc",
      "/nest/abc\n//evil.example",
      "/nest/abc\t",
      "/nest/abc?next=\\evil.example",
    ])
      expect(safeDeepLink(v), String(v)).toBeNull();
  });

  it("rejects app paths that are not a nest, so sign-in never lands somewhere unexpected", () => {
    for (const v of ["/", "/my-work", "/settings?doc=x", "/oauth/authorize?client_id=1", "/auth/oidc/logout", "/nest/a/b/c"])
      expect(safeDeepLink(v), v).toBeNull();
  });
});

describe("parking the link across a sign-in that leaves the page", () => {
  const link = "/nest/abc-123?doc=nodes%2Fpricing";

  it("Given a link that did not open while signed out, When the person comes back signed in, Then it is taken once", () => {
    const s = store();
    parkDeepLink(link, s, 1_000);
    expect(takeParkedDeepLink(s, 60_000)).toBe(link);
    expect(takeParkedDeepLink(s, 60_000)).toBeNull();
  });

  it("does not park an unsafe link, and never returns one that was planted in storage", () => {
    const s = store();
    parkDeepLink("//evil.example/nest/abc", s, 1_000);
    expect(s.data.size).toBe(0);
    s.setItem("cnst_deep_link_return", JSON.stringify({ value: "https://evil.example/nest/abc", at: 1_000 }));
    expect(takeParkedDeepLink(s, 2_000)).toBeNull();
    expect(s.data.size).toBe(0);
    s.setItem("cnst_deep_link_return", "not json");
    expect(takeParkedDeepLink(s, 2_000)).toBeNull();
  });

  it("forgets a link the person walked away from", () => {
    const s = store();
    parkDeepLink(link, s, 0);
    expect(takeParkedDeepLink(s, 31 * 60_000)).toBeNull();
    expect(s.data.size).toBe(0);
  });

  it("survives storage that throws (private mode)", () => {
    const broken: LinkStore = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(() => parkDeepLink(link, broken, 0)).not.toThrow();
    expect(takeParkedDeepLink(broken, 0)).toBeNull();
  });
});

describe("deepLinkToOpenOnReturn: when the parked link is opened", () => {
  const base = { sessionKnown: true, signedIn: true, firstLook: true, probeStatus: "idle", pathname: "/", search: "" };

  it("Given the page loads on Home, signed in, right after an outside sign-in, Then the parked link is opened", () => {
    expect(deepLinkToOpenOnReturn(base)).toBe(true);
  });

  it("waits for the session, and does nothing for someone still signed out", () => {
    expect(deepLinkToOpenOnReturn({ ...base, sessionKnown: false })).toBe(false);
    expect(deepLinkToOpenOnReturn({ ...base, signedIn: false })).toBe(false);
  });

  it("only looks when the person becomes signed in, and never over another link or page the person opened", () => {
    expect(deepLinkToOpenOnReturn({ ...base, firstLook: false })).toBe(false);
    expect(deepLinkToOpenOnReturn({ ...base, probeStatus: "ok" })).toBe(false);
    expect(deepLinkToOpenOnReturn({ ...base, probeStatus: "loading" })).toBe(false);
    expect(deepLinkToOpenOnReturn({ ...base, pathname: "/my-work" })).toBe(false);
  });

  it("leaves a failed sign-in alone (the server came back with ?sso_error)", () => {
    expect(deepLinkToOpenOnReturn({ ...base, search: "?sso_error=expired" })).toBe(false);
  });
});
