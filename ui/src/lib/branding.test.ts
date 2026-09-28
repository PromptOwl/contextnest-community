/**
 * Per-nest reader branding — the pure color/validation logic (CU-wdqcq02ptm).
 *
 * The regression guarantee lives here: an unbranded nest produces NO css
 * variables, so the reader renders exactly as it did before branding existed.
 * The accessibility guarantee too: whatever accent an owner picks, the text
 * drawn on it (and the accent drawn as text) meets WCAG AA 4.5:1.
 */
import { describe, it, expect } from "vitest";
import {
  brandingToCssVars,
  contrastRatio,
  ensureContrast,
  hexToHslTriplet,
  isAllowedImageUrl,
  isBranded,
  normalizeHex,
  readableForeground,
  relativeLuminance,
  validateBrandingDraft,
  brandedDocumentTitle,
  cssUrl,
} from "./branding";

const NEST = "7f0c2a1e-1111-4222-8333-444455556666";
const ASSET = `/nests/${NEST}/assets/0b0f5a4e-9d1c-4e8b-a1d2-3c4d5e6f7a8b.png`;

describe("unbranded = unchanged", () => {
  it("null / undefined / empty branding yields no css vars in either theme", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(brandingToCssVars(null, theme)).toEqual({});
      expect(brandingToCssVars(undefined, theme)).toEqual({});
      expect(brandingToCssVars({}, theme)).toEqual({});
    }
  });
  it("isBranded is false for null, {} and all-empty fields", () => {
    expect(isBranded(null)).toBe(false);
    expect(isBranded({})).toBe(false);
    expect(isBranded({ site_title: "", accent_color: null, hide_powered_by: false } as any)).toBe(false);
    expect(isBranded({ site_title: "Acme" })).toBe(true);
  });
  it("text-only branding (no colors) sets no css vars", () => {
    expect(brandingToCssVars({ site_title: "Acme", footer_text: "hi" }, "light")).toEqual({});
  });
});

describe("normalizeHex", () => {
  it("accepts #rgb and #rrggbb, lowercases and expands", () => {
    expect(normalizeHex("#FFF")).toBe("#ffffff");
    expect(normalizeHex("#E11D48")).toBe("#e11d48");
  });
  it("rejects everything else, including CSS-injection strings", () => {
    for (const bad of ["red", "#12345", "#ggg", "#fff;", "red; background:url(x)", "var(--x)", "#ffffff00", " #fff", "", null, undefined, 42]) {
      expect(normalizeHex(bad as any)).toBeNull();
    }
  });
});

describe("WCAG contrast", () => {
  it("relative luminance endpoints", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });
  it("black on white is 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
  it("readableForeground picks black on light, white on dark", () => {
    expect(readableForeground("#ffd700")).toBe("#000000");
    expect(readableForeground("#ffffff")).toBe("#000000");
    expect(readableForeground("#142a80")).toBe("#ffffff");
    expect(readableForeground("#000000")).toBe("#ffffff");
  });
  it("the chosen foreground meets AA (4.5:1) on every accent in a sweep", () => {
    for (let r = 0; r < 256; r += 17)
      for (let g = 0; g < 256; g += 17)
        for (let b = 0; b < 256; b += 17) {
          const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
          expect(contrastRatio(readableForeground(hex), hex)).toBeGreaterThanOrEqual(4.5);
        }
  });
  it("ensureContrast darkens a light accent for use as text on white", () => {
    const text = ensureContrast("#ffd700", "#ffffff");
    expect(contrastRatio(text, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
  it("ensureContrast lightens a dark accent for use as text on a dark page", () => {
    const text = ensureContrast("#142a80", "#09090b");
    expect(contrastRatio(text, "#09090b")).toBeGreaterThanOrEqual(4.5);
  });
  it("ensureContrast leaves an already-readable accent alone", () => {
    expect(ensureContrast("#142a80", "#ffffff")).toBe("#142a80");
  });
});

describe("brandingToCssVars", () => {
  it("maps the accent onto the theme tokens with readable foregrounds", () => {
    const vars = brandingToCssVars({ accent_color: "#ffd700" }, "light");
    expect(vars["--reader-accent"]).toBe("#ffd700");
    expect(vars["--reader-accent-fg"]).toBe("#000000");
    // --primary is used as text (links) AND as a button fill: contrast-safe on white.
    const primaryText = vars["--reader-accent-text"];
    expect(contrastRatio(primaryText, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(vars["--primary"]).toBe(hexToHslTriplet(primaryText));
    expect(vars["--ring"]).toBe(vars["--primary"]);
    expect(vars["--primary-foreground"]).toBeDefined();
  });
  it("dark theme gets a lighter accent text than light theme", () => {
    const light = brandingToCssVars({ accent_color: "#1e3a8a" }, "light");
    const dark = brandingToCssVars({ accent_color: "#1e3a8a" }, "dark");
    expect(contrastRatio(dark["--reader-accent-text"], "#09090b")).toBeGreaterThanOrEqual(4.5);
    expect(relativeLuminance(dark["--reader-accent-text"])).toBeGreaterThan(relativeLuminance(light["--reader-accent-text"]));
  });
  it("header color gets an auto-contrast foreground", () => {
    const vars = brandingToCssVars({ header_bg_color: "#0f172a" }, "light");
    expect(vars["--reader-header-bg"]).toBe("#0f172a");
    expect(vars["--reader-header-fg"]).toBe("#ffffff");
  });
  it("page tint is a gentle mix into the page background, never the raw color", () => {
    const vars = brandingToCssVars({ page_tint_color: "#ff0000" }, "light");
    expect(vars["--background"]).toBeDefined();
    expect(vars["--background"]).not.toBe(hexToHslTriplet("#ff0000"));
    // Body text (the default foreground, near-black) stays AA on the tinted page.
    expect(contrastRatio("#0a0a0b", vars["--reader-page-bg"])).toBeGreaterThanOrEqual(4.5);
  });
  it("ignores an invalid color rather than emitting it", () => {
    const vars = brandingToCssVars({ accent_color: "red; background:url(x)" as any }, "light");
    expect(vars).toEqual({});
  });
});

describe("isAllowedImageUrl", () => {
  it("accepts this nest's image asset and https image URLs", () => {
    expect(isAllowedImageUrl(ASSET, NEST)).toBe(true);
    expect(isAllowedImageUrl("https://cdn.example.com/a/logo.webp", NEST)).toBe(true);
    expect(isAllowedImageUrl("https://cdn.example.com/a/logo.PNG?v=2", NEST)).toBe(true);
  });
  it("rejects scripts, data:, http, svg, non-images, other nests, videos", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "http://cdn.example.com/logo.png",
      "https://cdn.example.com/logo.svg",
      "https://cdn.example.com/page.html",
      "//cdn.example.com/logo.png",
      "https://u:p@cdn.example.com/logo.png",
      `/nests/other-nest/assets/0b0f5a4e-9d1c-4e8b-a1d2-3c4d5e6f7a8b.png`,
      `/nests/${NEST}/assets/0b0f5a4e-9d1c-4e8b-a1d2-3c4d5e6f7a8b.mp4`,
      `/nests/${NEST}/assets/../../x.png`,
    ]) {
      expect(isAllowedImageUrl(bad, NEST)).toBe(false);
    }
  });
});

describe("validateBrandingDraft", () => {
  it("passes a clean draft", () => {
    expect(validateBrandingDraft({ accent_color: "#e11d48", logo_url: ASSET, footer_link_url: "https://acme.example.com" }, NEST)).toEqual({});
  });
  it("flags each bad field by name", () => {
    const errs = validateBrandingDraft(
      { accent_color: "red", logo_url: "javascript:alert(1)", footer_link_url: "ftp://x", site_title: "x".repeat(200) },
      NEST,
    );
    expect(Object.keys(errs).sort()).toEqual(["accent_color", "footer_link_url", "logo_url", "site_title"]);
  });
});

describe("brandedDocumentTitle", () => {
  it("falls back to the nest name, and to the plain page title when unbranded", () => {
    expect(brandedDocumentTitle("Intro", { site_title: "Acme Docs" }, "nest")).toBe("Intro · Acme Docs");
    expect(brandedDocumentTitle(null, { site_title: "Acme Docs" }, "nest")).toBe("Acme Docs");
    expect(brandedDocumentTitle("Intro", { accent_color: "#000" }, "Nest")).toBe("Intro · Nest");
  });
});

describe("cssUrl", () => {
  it("quotes and escapes anything that could leave the url() token", () => {
    expect(cssUrl("/nests/n/assets/a.png")).toBe('url("/nests/n/assets/a.png")');
    const inner = cssUrl(`https://x.test/a") ; background:red; x("\\\n'.png`).slice(5, -2);
    expect(inner).not.toMatch(/["'\\\n\r()\s]/);
  });
});
