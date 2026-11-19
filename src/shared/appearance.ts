/**
 * Server appearance (PO-1430): the navigation rail's color.
 *
 * One server-wide setting, NAV_COLOR, kept in the ordinary server-settings
 * store (db/settings.ts) next to COMMUNITY_NAME and LOGO_URL, so the deploy
 * env and Server settings → Basic both work with the usual precedence. Unset
 * means the built-in navy, and the UI renders exactly as before.
 *
 * Read by anyone (GET /health `nav_color`, MCP `context_appearance`); written
 * by a server admin (PATCH /admin/settings, MCP `context_appearance_update`).
 * Both writes go through validateAppearanceFields, so they accept and refuse
 * the same values.
 */
import { z } from "zod";
import { normalizeHex, readableForeground } from "./branding.js";
import { applySettings } from "../db/settings.js";

export const NAV_COLOR_SETTING = "NAV_COLOR";

/** The rail's built-in color, hsl(228 73% 24%) — what an unset NAV_COLOR shows. */
export const DEFAULT_NAV_COLOR = "#11226a";

/** The stored color, validated again on read (a hand-edited env var must not
 *  reach the UI unchecked). null = unset or invalid → the default. */
export function navColor(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeHex((env[NAV_COLOR_SETTING] ?? "").trim());
}

export interface Appearance {
  /** The admin's color, or null for the default. */
  nav_color: string | null;
  default_nav_color: string;
  /** What the rail shows: nav_color, else the default. */
  effective_nav_color: string;
  /** Black or white, whichever reads better on the rail (WCAG AA). */
  foreground: "#000000" | "#ffffff";
}

export function currentAppearance(): Appearance {
  const nav = navColor();
  const effective = nav ?? DEFAULT_NAV_COLOR;
  return {
    nav_color: nav,
    default_nav_color: DEFAULT_NAV_COLOR,
    effective_nav_color: effective,
    foreground: readableForeground(effective),
  };
}

export const NAV_COLOR_ERROR = "Use a hex color like #1e40af, or leave it empty for the default.";

/**
 * Validate the appearance fields of a settings write. Empty or null clears the
 * color (back to the default). Returns the settings to persist, or adds a
 * field error — the caller writes nothing if any field failed.
 */
export function validateAppearanceFields(
  body: Record<string, unknown>,
  addError: (field: string, message: string) => void,
): Array<{ name: string; value: string | null }> {
  if (!("nav_color" in body)) return [];
  const raw = body.nav_color;
  if (raw === null || raw === undefined) return [{ name: NAV_COLOR_SETTING, value: null }];
  if (typeof raw !== "string") {
    addError("nav_color", NAV_COLOR_ERROR);
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) return [{ name: NAV_COLOR_SETTING, value: null }];
  const hex = normalizeHex(trimmed);
  if (!hex) {
    addError("nav_color", NAV_COLOR_ERROR);
    return [];
  }
  return [{ name: NAV_COLOR_SETTING, value: hex }];
}

// ─── MCP inputs (schemas generated from these via mcpInputSchema) ──────────

export const AppearanceReadInput = z.object({});

export const AppearanceUpdateInput = z.object({
  // Plain z.string() on purpose: toolShape maps a JSON-schema `type`, and a
  // nullable union would be advertised untyped. Empty string = default.
  nav_color: z
    .string()
    .describe('The navigation rail color as hex, e.g. "#0f766e" or "#fde047". An empty string restores the default navy.'),
});

/**
 * Apply an appearance change (the MCP write; REST applies it inside the
 * /admin/settings batch). Both go through applySettings (db/settings.ts):
 * persist first, then the live env.
 */
export async function updateAppearance(
  body: Record<string, unknown>,
): Promise<{ ok: true; appearance: Appearance } | { ok: false; fieldErrors: Record<string, string> }> {
  const fieldErrors: Record<string, string> = {};
  const pending = validateAppearanceFields(body, (f, m) => (fieldErrors[f] = m));
  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors };
  await applySettings(pending);
  return { ok: true, appearance: currentAppearance() };
}
