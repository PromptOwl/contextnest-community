/** CU-wdqcq05jhm: the public site form never drops what the owner typed. */
import { describe, it, expect } from "vitest";
import { parseRedirects, toDraft, toSettings } from "./public-site";

describe("public site form", () => {
  it("reads one redirect per line and skips blank lines", () => {
    expect(parseRedirects("/old /new\n\n  /a   https://docs.example.com/b  \n")).toEqual({
      redirects: [
        { from: "/old", to: "/new" },
        { from: "/a", to: "https://docs.example.com/b" },
      ],
      bad: [],
    });
  });

  it("reports a line it can't read instead of dropping it", () => {
    const d = toDraft({});
    d.redirects = "/ok /fine\n/only-one\n/a /b /c";
    const out = toSettings(d);
    expect("error" in out && out.error).toBe(
      'Each redirect needs an old path and a new path, separated by a space. Fix: "/only-one", "/a /b /c"',
    );
  });

  it("round-trips settings through the draft", () => {
    const settings = {
      title: "Acme",
      public_url: "https://example.com/docs",
      same_as: ["https://github.com/acme", "https://x.com/acme"],
      ai_training: false,
      noindex: true,
      redirects: [{ from: "/old", to: "/new" }],
    };
    expect(toSettings(toDraft(settings))).toEqual({ settings });
  });

  it("leaves out empty fields and default toggles", () => {
    const d = toDraft({});
    d.title = "   ";
    expect(toSettings(d)).toEqual({ settings: {} });
  });
});
