/**
 * Hootie's side panel — width, layout and branding helpers (pure, tested in
 * hootie-panel.test.ts). The panel component stays about the conversation.
 */
import type { HootieBrand } from "./api";

export const HOOTIE_PANEL_MIN = 340;
export const HOOTIE_PANEL_MAX = 720;
export const HOOTIE_PANEL_DEFAULT = 420;
/** At or above this viewport width the open panel sits beside the page
 *  (pushes it over); below it, the panel overlays the page. */
export const HOOTIE_PUSH_BREAKPOINT = 1280;
const WIDTH_KEY = "cn.hootie.panelWidth";

/** Keep the panel between its min and max, and never wider than the page
 *  leaves room for (at least 480px of the page stays visible). */
export function clampPanelWidth(w: number, viewport: number): number {
  const roomy = Math.max(HOOTIE_PANEL_MIN, viewport - 480);
  const max = Math.min(HOOTIE_PANEL_MAX, roomy);
  if (!Number.isFinite(w)) return HOOTIE_PANEL_DEFAULT;
  return Math.round(Math.min(max, Math.max(HOOTIE_PANEL_MIN, w)));
}

export function pushesContent(viewport: number): boolean {
  return viewport >= HOOTIE_PUSH_BREAKPOINT;
}

/** The remembered width (per browser); storage can be unavailable. */
export function readPanelWidth(): number {
  try {
    const v = Number(window.localStorage.getItem(WIDTH_KEY));
    if (v) return clampPanelWidth(v, window.innerWidth);
  } catch {
    /* private mode / blocked storage */
  }
  return HOOTIE_PANEL_DEFAULT;
}

export function savePanelWidth(w: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* ignore */
  }
}

const HEX6 = /^#[0-9a-f]{6}$/i;

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function readableOn(hex: string): "#000000" | "#ffffff" {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  // Contrast against black vs against white; pick the stronger.
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? "#000000" : "#ffffff";
}

/** Inline colours for the launcher and panel header from the brand accent;
 *  null keeps the theme's primary colour. Only a #rrggbb value is used (the
 *  server normalises to that), so nothing else can reach a style. */
export function hootieAccentStyle(accent: string | null): { backgroundColor: string; color: string } | null {
  if (!accent || !HEX6.test(accent)) return null;
  return { backgroundColor: accent, color: readableOn(accent) };
}

/** The greeting line: the admin's, or "Hi, I'm <name>". */
export function hootieGreeting(brand: HootieBrand): string {
  return brand.greeting?.trim() || `Hi, I'm ${brand.name}`;
}
