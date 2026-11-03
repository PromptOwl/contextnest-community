/**
 * Hootie's side panel — width, layout and branding helpers (pure, tested in
 * hootie-panel.test.ts). The panel component stays about the conversation.
 */
import type { HootieBrand } from "./api";
import { WIKI_LINK, citationResolver, splitWikiLink, type CitableNode } from "../../../src/hootie/citations";

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

// ─── Citations ───────────────────────────────────────────────────────────
// The panel resolves `[[X]]` with the server's own module (pure, no imports),
// so the chips can never disagree with the server's `cited`.
export type { CitableNode };

/** Escape text for a markdown link label. */
function escapeLabel(s: string): string {
  return s.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/**
 * The answer as markdown for the bubble: each `[[X]]` that resolves against
 * `cited` becomes a `[Title](#cite:<id>)` link (the bubble renders those as
 * chips; an alias, `[[X|alias]]`, is shown instead of the title), and every
 * other one becomes its plain text — no brackets, nothing that looks
 * clickable but isn't. `cited` is undefined while the answer streams.
 */
export function linkCitations(content: string, cited: readonly CitableNode[] | undefined): string {
  const resolve = citationResolver(cited ?? []);
  return content.replace(WIKI_LINK, (_whole, inner: string) => {
    const { target, label } = splitWikiLink(inner);
    const n = resolve(target);
    if (!n) return label ?? target;
    return `[${escapeLabel(label ?? n.title)}](#cite:${encodeURIComponent(n.id)})`;
  });
}

// ─── Searching ───────────────────────────────────────────────────────────
// While Hootie searches the nest again the bubble shows what it's doing.
// A status supersedes any text so far (the model thinking aloud before it
// searched); the next text clears the status.

interface Streaming {
  content: string;
  status?: string;
}

export function withStatus<M extends Streaming>(m: M, text: string): M {
  return { ...m, content: "", status: text };
}

export function withDelta<M extends Streaming>(m: M, text: string): M {
  return { ...m, content: m.content + text, status: undefined };
}

/** The pending bubble's line before any answer text arrives. */
export function pendingLabel(m: Streaming): string {
  return m.status || "Reading the nest…";
}
