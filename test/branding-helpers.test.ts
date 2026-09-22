/**
 * Server-side branding helpers (src/shared/branding.ts) — the half the `/p`
 * renderer uses. Mirrors ui/src/lib/branding.test.ts: the UI keeps its own copy
 * of the color math (the repo mirrors, rather than shares, src ↔ ui code), so
 * each side carries its own test.
 */
import { describe, it, expect } from "vitest";
import {
  contrastRatio,
  ensureContrast,
  normalizeHex,
  readableForeground,
  publishBrandCssVars,
  parseStoredBranding,
} from "../src/shared/branding.js";

describe("server branding helpers", () => {
  it("normalizeHex is strict", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    for (const bad of ["red", "#fff;", "red; background:url(x)", "#12345", "expression(1)"]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });

  it("readableForeground meets AA on every accent in a sweep", () => {
    for (let r = 0; r < 256; r += 17)
      for (let g = 0; g < 256; g += 17)
        for (let b = 0; b < 256; b += 17) {
          const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
          expect(contrastRatio(readableForeground(hex), hex)).toBeGreaterThanOrEqual(4.5);
        }
  });

  it("ensureContrast makes a light accent readable as link text on white", () => {
    expect(contrastRatio(ensureContrast("#ffd700", "#ffffff"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("publishBrandCssVars is empty for no branding and hex-only otherwise", () => {
    expect(publishBrandCssVars(null)).toBe("");
    const css = publishBrandCssVars({ accent_color: "#ffd700", header_bg_color: "#0f172a" } as any);
    expect(css).toContain("--cn-accent:#ffd700");
    expect(css).toContain("--cn-accent-fg:#000000");
    expect(css).toContain("--cn-header-bg:#0f172a");
    expect(css).toContain("--cn-header-fg:#ffffff");
    // Defense in depth: even a hand-edited row with an injection string emits nothing for it.
    expect(publishBrandCssVars({ accent_color: "red;}body{display:none" } as any)).toBe("");
  });

  it("parseStoredBranding tolerates garbage and re-validates the row", () => {
    expect(parseStoredBranding(null)).toBeNull();
    expect(parseStoredBranding("not json")).toBeNull();
    expect(parseStoredBranding(JSON.stringify({ accent_color: "red;x" }))).toBeNull();
    expect(parseStoredBranding(JSON.stringify({ site_title: "Acme" }))).toMatchObject({ site_title: "Acme" });
  });
});
