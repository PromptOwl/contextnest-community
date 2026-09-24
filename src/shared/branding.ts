/**
 * Per-nest branding for public reader sites (CU-wdqcq02ptm).
 *
 * One validated JSON document per nest (`nests.branding_json`). It is small,
 * strictly one-to-one with the nest, always read together with it, and never
 * queried by field — a column on the row the reader already fetches beats a
 * side table and a join.
 *
 * Validation is the security boundary, so it is deliberately narrow:
 *   - colors: `#rgb` / `#rrggbb` only, normalised to lowercase `#rrggbb`. They
 *     end up in CSS custom properties (in the SPA and in the server-rendered
 *     `/p` pages), so nothing that could close a declaration or call a CSS
 *     function (`red; background:url(…)`, `var()`, `expression()`) survives.
 *   - images: THIS nest's uploaded image asset (`/nests/<id>/assets/<uuid>.<png|jpg|gif|webp>`,
 *     checked to exist) or an `https:` URL whose path ends in one of those image
 *     extensions. No `javascript:`, `data:`, plain http, SVG (script-capable
 *     when opened directly — same exclusion as the asset uploader), video, or
 *     another nest's asset (the `/p` renderer inlines asset bytes, so a foreign
 *     asset path would be a cross-nest read).
 *   - text: plain strings with length caps; rendered escaped everywhere.
 *   - `hide_powered_by`: boolean; the ROUTE restricts turning it on to the
 *     server admin.
 *
 * The UI mirrors the color math in ui/src/lib/branding.ts (this repo mirrors
 * src ↔ ui code rather than sharing it); both sides are unit-tested.
 */
import { z } from "zod";

export const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp)$/i;
const ASSET_NAME_RE = /^[0-9a-f-]{36}\.(?:png|jpe?g|gif|webp)$/;

export const BRANDING_LIMITS = {
  site_title: 120,
  banner_headline: 120,
  banner_subtext: 280,
  footer_text: 280,
  footer_link_label: 80,
  url: 2048,
} as const;

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

export const IMAGE_FIELDS = ["logo_url", "banner_url", "favicon_url"] as const;
export const COLOR_FIELDS = ["accent_color", "header_bg_color", "page_tint_color"] as const;
// Control characters (other than ordinary whitespace) have no business in a
// title or footer and only make escaping bugs harder to see.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !CONTROL_RE.test(s), "must not contain control characters")
    .nullable()
    .optional();
const optColor = z.string().regex(HEX_RE, "must be a #rgb or #rrggbb hex color").nullable().optional();
const optUrl = z.string().max(BRANDING_LIMITS.url).nullable().optional();

/** Shape check. Unknown keys are refused — no free-form CSS/JS rides along. */
export const BrandingSchema = z.strictObject({
  logo_url: optUrl,
  banner_url: optUrl,
  banner_headline: optText(BRANDING_LIMITS.banner_headline),
  banner_subtext: optText(BRANDING_LIMITS.banner_subtext),
  accent_color: optColor,
  header_bg_color: optColor,
  page_tint_color: optColor,
  site_title: optText(BRANDING_LIMITS.site_title),
  footer_text: optText(BRANDING_LIMITS.footer_text),
  footer_link_url: optUrl,
  footer_link_label: optText(BRANDING_LIMITS.footer_link_label),
  favicon_url: optUrl,
  hide_powered_by: z.boolean().optional(),
});

/** The asset file name when `url` is an image asset of `nestId`, else null. */
export function nestAssetName(url: string, nestId: string): string | null {
  const prefix = `/nests/${nestId}/assets/`;
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  return ASSET_NAME_RE.test(name) ? name : null;
}

/** An https image URL: parseable, https, no credentials, image extension. */
export function isHttpsImageUrl(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname) return false;
  return IMAGE_EXT_RE.test(u.pathname);
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

export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string" || !HEX_RE.test(v)) return null;
  let h = v.slice(1).toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return "#" + h;
}

/** Drop empty strings / nulls / false so "no value" has one spelling. */
function compact(b: NestBranding): NestBranding | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      const t = v.trim();
      if (t === "") continue;
      out[k] = t;
    } else if (v === true) {
      out[k] = true;
    }
  }
  if (Object.keys(out).length === 0) return null;
  return out as NestBranding;
}

export class BrandingValidationError extends Error {}

/**
 * Validate a PATCH body into a normalised branding (or null = clear).
 * Throws BrandingValidationError with a field-named message on any problem.
 * `assetExists` is injected so this module stays free of filesystem access.
 */
export async function validateBrandingInput(
  body: unknown,
  nestId: string,
  assetExists: (name: string) => Promise<boolean>,
): Promise<NestBranding | null> {
  if (body === null || body === undefined) return null;
  const parsed = BrandingSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.join(".") || "branding";
    const msg =
      issue?.code === "unrecognized_keys"
        ? `unknown branding field(s): ${issue.keys.join(", ")}`
        : `${field}: ${issue?.message ?? "invalid"}`;
    throw new BrandingValidationError(msg);
  }
  const b = compact(parsed.data as NestBranding);
  if (!b) return null;

  for (const f of COLOR_FIELDS) {
    if (b[f]) b[f] = normalizeHex(b[f]);
  }
  for (const f of IMAGE_FIELDS) {
    const url = b[f];
    if (!url) continue;
    const asset = nestAssetName(url, nestId);
    if (asset) {
      if (!(await assetExists(asset))) {
        throw new BrandingValidationError(`${f}: no such asset in this nest`);
      }
      continue;
    }
    if (!isHttpsImageUrl(url)) {
      throw new BrandingValidationError(
        `${f}: must be an image uploaded to this nest or an https:// URL ending in .png, .jpg, .gif or .webp`,
      );
    }
    // Store the parser's serialisation: quotes, spaces and the like come back
    // percent-encoded, so the value is inert wherever it is later interpolated.
    b[f] = new URL(url).href;
  }
  if (b.footer_link_url) {
    if (!isHttpsLink(b.footer_link_url)) {
      throw new BrandingValidationError("footer_link_url: must be an https:// URL");
    }
    b.footer_link_url = new URL(b.footer_link_url).href;
  }
  return b;
}

/**
 * Read a stored row for `nestId`. Re-validates it with the same rules as a
 * write — never trust a hand-edited row: colors must still be hex (a bad one
 * fails the whole parse), and a URL that no longer passes its write-time rule
 * (https image / this nest's image asset / https link) is dropped rather than
 * rendered. Returns null for anything that leaves nothing to show.
 */
export function parseStoredBranding(
  raw: string | null | undefined,
  nestId: string,
): NestBranding | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = BrandingSchema.safeParse(data);
  if (!parsed.success) return null;
  const b = compact(parsed.data as NestBranding);
  if (!b) return null;
  for (const f of IMAGE_FIELDS) {
    const url = b[f];
    if (url && !nestAssetName(url, nestId) && !isHttpsImageUrl(url)) delete b[f];
  }
  if (b.footer_link_url && !isHttpsLink(b.footer_link_url)) delete b.footer_link_url;
  const kept = compact(b);
  if (!kept) return null;
  return { ...kept, hide_powered_by: kept.hide_powered_by === true };
}

// ── WCAG color math ───────────────────────────────────────────────────────

function rgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex)!.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0")).join("");
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

/** Black or white — whichever reads better on `bg`. Always ≥ 4.5:1. */
export function readableForeground(bg: string): "#000000" | "#ffffff" {
  return contrastRatio("#000000", bg) >= contrastRatio("#ffffff", bg) ? "#000000" : "#ffffff";
}

/** Linear mix: `weight` of `a` into `b`. */
export function mixHex(a: string, b: string, weight: number): string {
  const ca = rgb(a);
  const cb = rgb(b);
  return toHex([0, 1, 2].map((i) => ca[i] * weight + cb[i] * (1 - weight)) as [number, number, number]);
}

/**
 * `fg` nudged toward black (light bg) or white (dark bg) until it reads at
 * `min`:1 against `bg`. An already-readable color is returned unchanged.
 */
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

/**
 * CSS custom properties for the server-rendered `/p` pages, as one
 * `:root{…}` rule — or "" for no branding. Every value is re-normalised
 * here, so even a row that bypassed validation cannot inject CSS.
 */
export function publishBrandCssVars(b: NestBranding | null): string {
  if (!b) return "";
  const decls: string[] = [];
  const tint = normalizeHex(b.page_tint_color);
  const page = tint ? mixHex(tint, "#ffffff", 0.1) : "#ffffff";
  const accent = normalizeHex(b.accent_color);
  if (accent) {
    // Readable on the tinted body and on white cards — same nesting as the UI reader.
    const text = ensureContrast(ensureContrast(accent, page), "#ffffff");
    decls.push(
      `--cn-accent:${accent}`,
      `--cn-accent-fg:${readableForeground(accent)}`,
      `--cn-accent-text:${text}`,
    );
  }
  const header = normalizeHex(b.header_bg_color);
  if (header) decls.push(`--cn-header-bg:${header}`, `--cn-header-fg:${readableForeground(header)}`);
  if (tint) decls.push(`--cn-page-bg:${page}`);
  return decls.length ? `:root{${decls.join(";")}}` : "";
}

/**
 * A URL as a CSS `url("…")` token, escaped by construction: quotes,
 * parentheses, backslashes, whitespace and control characters are
 * percent-encoded, so nothing in the value can close the string or the
 * declaration — whatever upstream validation did or didn't normalise.
 */
export function cssUrl(url: string): string {
  const safe = url.replace(/["'()\\\s\u0000-\u001f\u007f]/g, (ch) =>
    "%" + ch.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase(),
  );
  return `url("${safe}")`;
}
