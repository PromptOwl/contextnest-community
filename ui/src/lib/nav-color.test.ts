import { describe, expect, it } from "vitest";
import { contrastRatio, mixHex } from "./branding";
import { DEFAULT_NAV_COLOR, NAVY_RAIL_TOKENS, NAV_PALETTE, navRail, navColorError } from "./nav-color";

describe("navRail (PO-1430)", () => {
  it("unset → today's navy rail, token for token (no visual change by default)", () => {
    const r = navRail(null);
    expect(r.custom).toBe(false);
    expect(r.background).toBe("hsl(228 73% 24%)");
    expect(r.vars).toEqual(NAVY_RAIL_TOKENS);
    expect(r.vars["--foreground"]).toBe("0 0% 100%");
  });

  it("an invalid stored value falls back to the default", () => {
    expect(navRail("teal").custom).toBe(false);
    expect(navRail("").custom).toBe(false);
  });

  it("the default hex matches the navy the rail has always drawn", () => {
    expect(DEFAULT_NAV_COLOR).toBe("#11226a");
  });

  const samples = [
    ...NAV_PALETTE.filter((p) => p.hex).map((p) => p.hex as string),
    "#fde047", // yellow — the white-on-yellow trap
    "#ffffff",
    "#000000",
    "#808080", // mid grey: the hardest case for either text color
    "#ff00ff",
    "#22c55e",
    "#3b82f6",
  ];

  it.each(samples)("%s: every text color clears WCAG AA on the rail and its hover surface", (hex) => {
    const r = navRail(hex);
    expect(r.custom).toBe(true);
    expect(r.background).toBe(hex);
    const c = r.colors;
    for (const surface of [hex, c.hover]) {
      expect(contrastRatio(c.foreground, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.mutedForeground, surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(c.primaryForeground, c.primary)).toBeGreaterThanOrEqual(4.5);
    // Idle rows draw the text at --rail-idle opacity; it still clears AA.
    expect(contrastRatio(mixHex(c.foreground, hex, r.idleOpacity), hex)).toBeGreaterThanOrEqual(4.5);
    expect(r.vars["--rail-idle"]).toBe(String(r.idleOpacity));
    // Every color the rail reads is set, so nothing leaks from the page theme.
    for (const k of Object.keys(NAVY_RAIL_TOKENS)) expect(r.vars[k], k).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/);
  });

  it("a light color gets dark text, a dark color light text", () => {
    expect(navRail("#fde047").colors.foreground).not.toBe("#ffffff");
    expect(contrastRatio(navRail("#fde047").colors.foreground, "#000000")).toBeLessThan(2);
    expect(navRail("#0f766e").colors.foreground).toBe("#ffffff");
  });

  it("the palette leads with the default and carries light and dark choices", () => {
    expect(NAV_PALETTE[0]).toEqual({ name: "Navy", hex: null });
    expect(NAV_PALETTE.some((p) => p.hex && navRail(p.hex).colors.foreground !== "#ffffff")).toBe(true);
    expect(new Set(NAV_PALETTE.map((p) => p.name)).size).toBe(NAV_PALETTE.length);
  });
});

describe("navColorError", () => {
  it.each(["", "#0f766e", "#FFF", "  #abcdef "])("accepts %j", (v) => expect(navColorError(v)).toBeNull());
  it.each(["teal", "#12345", "0f766e", "url(x)", "#0f766e;x"])("refuses %j", (v) =>
    expect(navColorError(v)).toMatch(/hex color/i),
  );
});

describe("the default navy (regression)", () => {
  it("its text clears AA on the rail and the hover surface", () => {
    const c = navRail(null).colors;
    expect(c.hover).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(c.foreground, DEFAULT_NAV_COLOR)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.foreground, c.hover)).toBeGreaterThanOrEqual(4.5);
  });
});
