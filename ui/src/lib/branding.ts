/**
 * Per-nest reader branding — pure helpers (CU-wdqcq02ptm).
 *
 * The server validates and stores branding (src/shared/branding.ts); this file
 * mirrors the parts the UI needs: the same field rules for inline form errors,
 * and the color math that turns an owner's picks into theme variables.
 *
 * Regression guarantee: no branding (or branding with no colors) → no css
 * variables at all, so an unbranded reader renders exactly as before.
 *
 * Accessibility guarantee: every color drawn as a surface gets an auto-chosen
 * black/white foreground (WCAG AA, ≥ 4.5:1 — the better of black and white
 * always clears it), and the accent drawn as TEXT (links, the active page) is
 * nudged darker (light theme) or lighter (dark theme) until it clears 4.5:1
 * against the page. A pale yellow accent still gets pale-yellow buttons with
 * black text, and readable dark-gold links.
 */

export interface NestBranding {
  logo_url?: string | null;
  banner_url?: string | null;
  banner_headline?: string | null;
  banner_subtext?: string | null;
  accent_color?: string | null;
  header_bg_color?: string | null;
  page_tint_color?: string | null;
  site_title?: string | null;
  footer_text?: string | null;
  footer_link_url?: string | null;
  footer_link_label?: string | null;
  favicon_url?: string | null;
  hide_powered_by?: boolean;
}

export type BrandingTheme = "light" | "dark";

/** Mirrors BRANDING_LIMITS in src/shared/branding.ts. */
export const BRANDING_LIMITS = {
  site_title: 120,
  banner_headline: 120,
  banner_subtext: 280,
  footer_text: 280,
  footer_link_label: 80,
  url: 2048,
} as const;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp)$/i;
const ASSET_NAME_RE = /^[0-9a-f-]{36}\.(?:png|jpe?g|gif|webp)$/;

/** Page / card backgrounds per theme (index.css `--background`, zinc-950). */
const PAGE_BG: Record<BrandingTheme, string> = { light: "#ffffff", dark: "#09090b" };

export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string" || !HEX_RE.test(v)) return null;
  let h = v.slice(1).toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return "#" + h;
}

function rgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex)!.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(c: number[]): string {
  return "#" + c.map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0")).join("");
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on `bg` — always ≥ 4.5:1. */
export function readableForeground(bg: string): "#000000" | "#ffffff" {
  return contrastRatio("#000000", bg) >= contrastRatio("#ffffff", bg) ? "#000000" : "#ffffff";
}

/** Linear mix: `weight` of `a` into `b`. */
export function mixHex(a: string, b: string, weight: number): string {
  const ca = rgb(a);
  const cb = rgb(b);
  return toHex([0, 1, 2].map((i) => ca[i] * weight + cb[i] * (1 - weight)));
}

/** `fg` nudged toward black/white until it reads at `min`:1 on `bg`. */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  const start = normalizeHex(fg)!;
  if (contrastRatio(start, bg) >= min) return start;
  const target = readableForeground(bg);
  for (let w = 0.05; w <= 1.0001; w += 0.05) {
    const c = mixHex(target, start, w);
    if (contrastRatio(c, bg) >= min) return c;
  }
  return target;
}

/** `#rrggbb` → the `H S% L%` triplet the Tailwind theme tokens expect. */
export function hexToHslTriplet(hex: string): string {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return `${round(h)} ${round(s * 100)}% ${round(l * 100)}%`;
}

/** Anything worth rendering? `hide_powered_by: false` and empty strings aren't. */
export function isBranded(b: NestBranding | null | undefined): b is NestBranding {
  if (!b) return false;
  return Object.entries(b).some(([, v]) => (typeof v === "string" ? v.trim() !== "" : v === true));
}

/**
 * Theme variables for a branded reader. Keys are CSS custom properties, set
 * as an inline style on the reader's root — so they override index.css's
 * tokens for that subtree only.
 *
 *   --primary / --primary-foreground / --ring  accent (contrast-safe as text)
 *   --accent / --accent-foreground              soft accent wash (nav hover/active)
 *   --background                                page tint (a 10% wash, never raw)
 *   --reader-accent / --reader-accent-fg        raw accent + auto text (banner)
 *   --reader-accent-text                        accent readable as text (links)
 *   --reader-header-bg / --reader-header-fg     header bar + auto text
 *   --reader-page-bg                            tinted page as hex (for checks)
 */
export function brandingToCssVars(
  b: NestBranding | null | undefined,
  theme: BrandingTheme = "light",
): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!b) return vars;
  const base = PAGE_BG[theme];
  const tint = normalizeHex(b.page_tint_color);
  const page = tint ? mixHex(tint, base, theme === "light" ? 0.1 : 0.14) : base;
  if (tint) {
    vars["--background"] = hexToHslTriplet(page);
    vars["--reader-page-bg"] = page;
  }
  const accent = normalizeHex(b.accent_color);
  if (accent) {
    // Readable against both the page and the card (cards stay --card).
    const text = ensureContrast(ensureContrast(accent, page), base);
    const wash = mixHex(accent, base, theme === "light" ? 0.12 : 0.22);
    vars["--reader-accent"] = accent;
    vars["--reader-accent-fg"] = readableForeground(accent);
    vars["--reader-accent-text"] = text;
    vars["--primary"] = hexToHslTriplet(text);
    vars["--primary-foreground"] = hexToHslTriplet(readableForeground(text));
    vars["--ring"] = vars["--primary"];
    vars["--accent"] = hexToHslTriplet(wash);
    vars["--accent-foreground"] = hexToHslTriplet(readableForeground(wash) === "#000000" ? "#18181b" : "#fafafa");
  }
  const header = normalizeHex(b.header_bg_color);
  if (header) {
    vars["--reader-header-bg"] = header;
    vars["--reader-header-fg"] = readableForeground(header);
  }
  return vars;
}

/** This nest's uploaded image asset, or an https URL ending in an image extension. */
export function isAllowedImageUrl(url: string, nestId: string): boolean {
  const prefix = `/nests/${nestId}/assets/`;
  if (url.startsWith(prefix)) return ASSET_NAME_RE.test(url.slice(prefix.length));
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && !!u.hostname && IMAGE_EXT_RE.test(u.pathname);
  } catch {
    return false;
  }
}

export function isHttpsLink(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && !!u.hostname;
  } catch {
    return false;
  }
}

/** Client-side mirror of the server's rules → { field: message } (empty = ok). */
export function validateBrandingDraft(d: NestBranding, nestId: string): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of ["accent_color", "header_bg_color", "page_tint_color"] as const) {
    const v = d[f];
    if (v && !normalizeHex(v)) errs[f] = "Use a hex color like #1e40af";
  }
  for (const f of ["logo_url", "banner_url", "favicon_url"] as const) {
    const v = d[f]?.trim();
    if (v && !isAllowedImageUrl(v, nestId))
      errs[f] = "Upload an image, or use an https:// link ending in .png, .jpg, .gif or .webp";
  }
  const link = d.footer_link_url?.trim();
  if (link && !isHttpsLink(link)) errs.footer_link_url = "Use an https:// link";
  for (const f of ["site_title", "banner_headline", "banner_subtext", "footer_text", "footer_link_label"] as const) {
    const v = d[f];
    if (v && v.length > BRANDING_LIMITS[f]) errs[f] = `At most ${BRANDING_LIMITS[f]} characters`;
  }
  return errs;
}

/** Browser tab title in the branded reader: "Page · Site" (site falls back to the nest name). */
export function brandedDocumentTitle(
  pageTitle: string | null | undefined,
  b: NestBranding | null | undefined,
  nestName: string,
): string {
  const site = b?.site_title?.trim() || nestName;
  return pageTitle ? `${pageTitle} · ${site}` : site;
}
