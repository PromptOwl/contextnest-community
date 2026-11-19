/**
 * The navigation rail's color (PO-1430) — pure helpers.
 *
 * The server stores one hex (`nav_color` on /health; null = the default navy).
 * The rail restyles itself by re-pointing the shared color tokens on its root
 * (every control inside reads them), so one color here becomes the whole
 * palette: text, muted text, hover/active surface, borders, inputs, the count
 * pill and the focus ring.
 *
 * Regression guarantee: no color (or an invalid one) → NAVY_RAIL_TOKENS, the
 * exact tokens the rail had before this setting existed.
 *
 * Accessibility guarantee: text and muted text clear 4.5:1 (WCAG AA) on both
 * the rail and its hover surface, and the pill's text clears it on the pill.
 * Light rails get near-black text; dark rails get white.
 */
import type { CSSProperties } from "react";
import { contrastRatio, ensureContrast, hexToHslTriplet, mixHex, normalizeHex, readableForeground } from "./branding";

/** hsl(228 73% 24%) — what the rail has always drawn. Mirrors src/shared/appearance.ts. */
export const DEFAULT_NAV_COLOR = "#11226a";

/**
 * The navy rail's tokens: light text, translucent-looking hover and border
 * surfaces, a brighter blue for the count pill. Menus portaled out of the
 * rail keep the normal light theme.
 */
export const NAVY_RAIL_TOKENS: Record<string, string> = {
  "--foreground": "0 0% 100%",
  "--muted-foreground": "228 60% 84%",
  "--background": "228 73% 20%",
  "--muted": "228 60% 33%",
  "--accent": "228 60% 33%",
  "--accent-foreground": "0 0% 100%",
  "--secondary": "228 60% 36%",
  "--secondary-foreground": "0 0% 100%",
  "--border": "228 55% 34%",
  "--input": "228 55% 34%",
  "--primary": "228 80% 48%",
  "--primary-foreground": "0 0% 100%",
  "--ring": "228 90% 75%",
};

/** The curated choices in Server settings, default first. Two light ones, so
 *  a pale brand still has a designed option. */
export const NAV_PALETTE: { name: string; hex: string | null }[] = [
  { name: "Navy", hex: null },
  { name: "Slate", hex: "#1e293b" },
  { name: "Graphite", hex: "#27272a" },
  { name: "Teal", hex: "#115e59" },
  { name: "Forest", hex: "#14532d" },
  { name: "Plum", hex: "#581c87" },
  { name: "Wine", hex: "#881337" },
  { name: "Rust", hex: "#9a3412" },
  { name: "Sand", hex: "#e7e5e4" },
  { name: "Butter", hex: "#fde68a" },
];

/** An idle rail row's text: the rail foreground at --rail-idle opacity (80%,
 *  or full strength on a mid-tone rail). Used by every row in the rail. */
export const RAIL_IDLE_TEXT = "text-[hsl(var(--foreground)/var(--rail-idle,0.8))]";

export const NAV_COLOR_ERROR = "Use a hex color like #1e40af, or leave it empty for the default.";

/** Inline error for the settings field: null when fine (empty = default). */
export function navColorError(v: string): string | null {
  const t = v.trim();
  return !t || normalizeHex(t) ? null : NAV_COLOR_ERROR;
}

export interface NavRail {
  /** A custom color is in effect (false = the default navy). */
  custom: boolean;
  /** CSS background for the rail. */
  background: string;
  /** Token overrides for the rail's root (HSL triplets, as index.css uses). */
  vars: Record<string, string>;
  /** The derived colors as hex — what the contrast checks run on. */
  colors: { foreground: string; mutedForeground: string; hover: string; primary: string; primaryForeground: string };
  /** Opacity of an idle row's text (ROW_IDLE reads it as --rail-idle). */
  idleOpacity: number;
}

/** At least 4.5:1 on every surface given, with headroom for HSL rounding. */
function readableOn(fg: string, surfaces: string[]): string {
  let c = fg;
  for (let i = 0; i < 3; i++) for (const s of surfaces) c = ensureContrast(c, s, 4.7);
  return surfaces.every((s) => contrastRatio(c, s) >= 4.5) ? c : readableForeground(surfaces[0]);
}

/** "H S% L%" → #rrggbb. */
function hslHex(triplet: string): string {
  const [h, s, l] = triplet.split(" ").map((p) => parseFloat(p));
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function navRail(color: string | null | undefined): NavRail {
  const hex = normalizeHex(color ?? "");
  if (!hex) {
    return {
      custom: false,
      background: "hsl(228 73% 24%)",
      vars: NAVY_RAIL_TOKENS,
      colors: {
        foreground: hslHex(NAVY_RAIL_TOKENS["--foreground"]),
        mutedForeground: hslHex(NAVY_RAIL_TOKENS["--muted-foreground"]),
        hover: hslHex(NAVY_RAIL_TOKENS["--muted"]),
        primary: hslHex(NAVY_RAIL_TOKENS["--primary"]),
        primaryForeground: hslHex(NAVY_RAIL_TOKENS["--primary-foreground"]),
      },
      idleOpacity: 0.8,
    };
  }
  const dark = readableForeground(hex) === "#ffffff";
  // Ink: white on a dark rail; zinc-900 on a light one (softer than black).
  const ink = dark ? "#ffffff" : "#18181b";
  const hover = mixHex(ink, hex, dark ? 0.14 : 0.08);
  const foreground = readableOn(ink, [hex, hover]);
  const mutedForeground = readableOn(mixHex(ink, hex, 0.72), [hex, hover]);
  const secondary = mixHex(ink, hex, dark ? 0.18 : 0.1);
  const border = mixHex(ink, hex, dark ? 0.18 : 0.14);
  // Inputs (the nest filter) sit a step into the rail: darker on a dark rail,
  // lighter on a light one.
  const field = dark ? mixHex("#000000", hex, 0.18) : mixHex("#ffffff", hex, 0.6);
  // The count pill: an ink pill with rail-colored text — the inverse of the
  // rail, so it reads at the same ratio as the text does.
  const primary = foreground;
  const primaryForeground = readableOn(hex, [primary]);
  // Idle rows draw the text at 80% (as on navy); on a mid-tone rail where
  // that would drop under 4.5:1 they draw it at full strength instead.
  const idle = contrastRatio(mixHex(foreground, hex, 0.8), hex) >= 4.5 ? "0.8" : "1";
  const t = hexToHslTriplet;
  return {
    custom: true,
    background: hex,
    vars: {
      "--foreground": t(foreground),
      "--muted-foreground": t(mutedForeground),
      "--background": t(field),
      "--muted": t(hover),
      "--accent": t(hover),
      "--accent-foreground": t(foreground),
      "--secondary": t(secondary),
      "--secondary-foreground": t(readableOn(foreground, [secondary])),
      "--border": t(border),
      "--input": t(border),
      "--primary": t(primary),
      "--primary-foreground": t(primaryForeground),
      "--ring": t(mixHex(ink, hex, 0.6)),
      "--rail-idle": idle,
    },
    colors: { foreground, mutedForeground, hover, primary, primaryForeground },
    idleOpacity: Number(idle),
  };
}

/** The rail root's style: its background plus the token overrides. */
export function navRailStyle(color: string | null | undefined): CSSProperties {
  const r = navRail(color);
  return { ...r.vars, backgroundColor: r.background } as CSSProperties;
}
