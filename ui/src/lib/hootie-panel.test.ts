import { describe, it, expect } from "vitest";
import {
  HOOTIE_PANEL_DEFAULT,
  HOOTIE_PANEL_MAX,
  HOOTIE_PANEL_MIN,
  clampPanelWidth,
  hootieAccentStyle,
  hootieGreeting,
  pushesContent,
  readableOn,
} from "./hootie-panel";

describe("Hootie side panel layout", () => {
  it("clamps the width between min and max, leaving room for the page", () => {
    expect(clampPanelWidth(100, 1600)).toBe(HOOTIE_PANEL_MIN);
    expect(clampPanelWidth(5000, 1600)).toBe(HOOTIE_PANEL_MAX);
    expect(clampPanelWidth(500, 1600)).toBe(500);
    // A narrow window keeps at least 480px of page visible.
    expect(clampPanelWidth(700, 1000)).toBe(520);
    expect(clampPanelWidth(Number.NaN, 1600)).toBe(HOOTIE_PANEL_DEFAULT);
  });

  it("pushes the page on wide screens and overlays on narrow ones", () => {
    expect(pushesContent(1440)).toBe(true);
    expect(pushesContent(1280)).toBe(true);
    expect(pushesContent(1024)).toBe(false);
    expect(pushesContent(390)).toBe(false);
  });
});

describe("Hootie branding in the panel", () => {
  it("uses only a #rrggbb accent, with a readable foreground", () => {
    expect(hootieAccentStyle("#1d4ed8")).toEqual({ backgroundColor: "#1d4ed8", color: "#ffffff" });
    // A bright blue reads better with black text (5.3:1 vs 3.9:1 for white).
    expect(hootieAccentStyle("#0a7cff")).toEqual({ backgroundColor: "#0a7cff", color: "#000000" });
    expect(hootieAccentStyle("#ffe600")).toEqual({ backgroundColor: "#ffe600", color: "#000000" });
    expect(hootieAccentStyle(null)).toBeNull();
    // Anything that isn't a normalised hex never reaches a style.
    expect(hootieAccentStyle("red")).toBeNull();
    expect(hootieAccentStyle("#fff")).toBeNull();
    expect(hootieAccentStyle("#000000;background:url(x)")).toBeNull();
  });

  it("picks black or white by contrast", () => {
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#ffffff")).toBe("#000000");
  });

  it("greets with the admin's line, or 'Hi, I'm <name>'", () => {
    expect(hootieGreeting({ name: "Hootie", logo_url: null, accent_color: null, greeting: null })).toBe(
      "Hi, I'm Hootie",
    );
    expect(hootieGreeting({ name: "Ava", logo_url: null, accent_color: null, greeting: "  " })).toBe(
      "Hi, I'm Ava",
    );
    expect(
      hootieGreeting({ name: "Ava", logo_url: null, accent_color: null, greeting: "Welcome to Acme." }),
    ).toBe("Welcome to Acme.");
  });
});
