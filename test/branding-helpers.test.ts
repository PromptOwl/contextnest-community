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
  cssUrl,
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

  const NEST = "7f0c2a1e-1111-4222-8333-444455556666";
  const ASSET = `/nests/${NEST}/assets/0b0f5a4e-9d1c-4e8b-a1d2-3c4d5e6f7a8b.png`;

  it("parseStoredBranding tolerates garbage and re-validates the row", () => {
    expect(parseStoredBranding(null, NEST)).toBeNull();
    expect(parseStoredBranding("not json", NEST)).toBeNull();
    expect(parseStoredBranding(JSON.stringify({ accent_color: "red;x" }), NEST)).toBeNull();
    expect(parseStoredBranding(JSON.stringify({ site_title: "Acme" }), NEST)).toMatchObject({ site_title: "Acme" });
  });

  // Review finding (PR #321): the read path must defend URLs the way it
  // defends colors — a hand-edited row with a javascript: footer link would
  // otherwise become a clickable href on /p.
  it("parseStoredBranding drops stored URLs that break the write-time rules", () => {
    const row = JSON.stringify({
      site_title: "Acme",
      footer_link_url: "javascript:alert(1)",
      logo_url: "javascript:alert(1)",
      banner_url: `/nests/some-other-nest/assets/0b0f5a4e-9d1c-4e8b-a1d2-3c4d5e6f7a8b.png`,
      favicon_url: "http://cdn.example.com/x.png",
    });
    const b = parseStoredBranding(row, NEST)!;
    expect(b.site_title).toBe("Acme");
    expect(b).not.toHaveProperty("footer_link_url");
    expect(b).not.toHaveProperty("logo_url");
    expect(b).not.toHaveProperty("banner_url");
    expect(b).not.toHaveProperty("favicon_url");
    // Valid ones survive.
    const ok = parseStoredBranding(
      JSON.stringify({ logo_url: ASSET, banner_url: "https://cdn.example.com/b.jpg", footer_link_url: "https://acme.example.com/" }),
      NEST,
    )!;
    expect(ok).toMatchObject({ logo_url: ASSET, banner_url: "https://cdn.example.com/b.jpg", footer_link_url: "https://acme.example.com/" });
    // A row whose only content was a bad URL is unbranded.
    expect(parseStoredBranding(JSON.stringify({ footer_link_url: "javascript:x" }), NEST)).toBeNull();
  });

  // Review finding (PR #321, round 2): URLs interpolated into CSS url() must be
  // escaped by construction, not safe by coincidence of upstream normalisation.
  it("cssUrl quotes and escapes anything that could leave the url() token", () => {
    expect(cssUrl("https://cdn.example.com/b.jpg")).toBe('url("https://cdn.example.com/b.jpg")');
    const nasty = cssUrl(`https://x.test/a") ; background:red; x("\\\n'.png`);
    expect(nasty.startsWith('url("')).toBe(true);
    expect(nasty.endsWith('")')).toBe(true);
    const inner = nasty.slice(5, -2);
    expect(inner).not.toMatch(/["'\\\n\r()\s]/);
  });
});
