/**
 * Branding settings — the super-admin white-label surface.
 *
 * Values live in the `server_settings` KV table and OVERRIDE the env-var
 * defaults (config.LOGO_URL). Read path merges DB over config so an operator
 * can still seed a logo via env and a super admin can later change it from
 * the UI without a redeploy. Unset DB keys fall back to the env/default.
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";

export interface Branding {
  /** Absolute https/http or data:image URL; null → bundled default icon. */
  logo_url: string | null;
  /** Product name in the header, login screen, and browser title. */
  app_name: string;
  /** Optional one-line tagline under the logo on the login screen. */
  sign_in_tagline: string | null;
}

const KEYS = {
  logo: "brand.logo_url",
  name: "brand.app_name",
  tagline: "brand.sign_in_tagline",
} as const;

const DEFAULT_APP_NAME = "ContextNest";
const APP_NAME_MAX = 60;
const TAGLINE_MAX = 140;

// Same allowlist as config.LOGO_URL — reject anything that could smuggle a
// javascript:/file: scheme into the <img src> on the login screen.
const LOGO_URL_RE = /^(https?:\/\/|data:image\/)/i;

function readKey(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM server_settings WHERE key = ?")
    .get(key) as { value: string | null } | undefined;
  const v = row?.value?.trim();
  return v ? v : null;
}

export function getBranding(): Branding {
  return {
    logo_url: readKey(KEYS.logo) ?? config.LOGO_URL,
    app_name: readKey(KEYS.name) ?? DEFAULT_APP_NAME,
    sign_in_tagline: readKey(KEYS.tagline),
  };
}

export class BrandingValidationError extends Error {}

function upsert(key: string, value: string | null, byEmail: string): void {
  const db = getDb();
  if (value === null) {
    db.prepare("DELETE FROM server_settings WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO server_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(key, value, byEmail);
}

/**
 * Apply a partial branding update. Only keys present in `patch` are touched;
 * an empty string clears that override (reverts to env/default). Throws
 * BrandingValidationError on a malformed logo URL or an over-long field.
 */
export function setBranding(
  patch: {
    logo_url?: string;
    app_name?: string;
    sign_in_tagline?: string;
  },
  byEmail: string,
): Branding {
  if (patch.logo_url !== undefined) {
    const raw = patch.logo_url.trim();
    if (raw && !LOGO_URL_RE.test(raw)) {
      throw new BrandingValidationError(
        "Logo URL must start with https://, http://, or data:image/",
      );
    }
    upsert(KEYS.logo, raw || null, byEmail);
  }
  if (patch.app_name !== undefined) {
    const raw = patch.app_name.trim();
    if (raw.length > APP_NAME_MAX) {
      throw new BrandingValidationError(
        `App name must be ${APP_NAME_MAX} characters or fewer`,
      );
    }
    upsert(KEYS.name, raw || null, byEmail);
  }
  if (patch.sign_in_tagline !== undefined) {
    const raw = patch.sign_in_tagline.trim();
    if (raw.length > TAGLINE_MAX) {
      throw new BrandingValidationError(
        `Sign-in tagline must be ${TAGLINE_MAX} characters or fewer`,
      );
    }
    upsert(KEYS.tagline, raw || null, byEmail);
  }
  return getBranding();
}
