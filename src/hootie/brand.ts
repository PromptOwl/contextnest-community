/**
 * Hootie's identity — the assistant's name, logo, accent colour and greeting.
 *
 * Server-level (the assistant is the same on every page and nest), stored as
 * ordinary server settings (HOOTIE_NAME, HOOTIE_LOGO_URL, HOOTIE_ACCENT_COLOR,
 * HOOTIE_GREETING) so the deploy env and Settings → General both work, with
 * the usual precedence (db/settings.ts).
 *
 * Custom identity is an ENTERPRISE entitlement. It is enforced twice:
 *   - on write: /admin/settings refuses any branding field without it (403);
 *   - on read: effectiveHootieBrand() returns the default identity without it,
 *     whatever is stored — a lapsed licence reverts every surface (UI, the
 *     system prompt, mention comments) without deleting the admin's values.
 */
import { hasEntitlement } from "../auth/entitlements.js";
import { isHttpsImageUrl, normalizeHex } from "../shared/branding.js";

export const DEFAULT_HOOTIE_NAME = "Hootie";
export const HOOTIE_NAME_MAX = 40;
export const HOOTIE_GREETING_MAX = 200;
export const HOOTIE_LOGO_URL_MAX = 2048;

export interface HootieBrand {
  name: string;
  logo_url: string | null;
  accent_color: string | null;
  greeting: string | null;
}

/** Request field → server setting it persists to. */
export const HOOTIE_BRAND_FIELDS = {
  hootie_name: "HOOTIE_NAME",
  hootie_logo_url: "HOOTIE_LOGO_URL",
  hootie_accent_color: "HOOTIE_ACCENT_COLOR",
  hootie_greeting: "HOOTIE_GREETING",
} as const;

export type HootieBrandField = keyof typeof HOOTIE_BRAND_FIELDS;

export const DEFAULT_HOOTIE_BRAND: HootieBrand = {
  name: DEFAULT_HOOTIE_NAME,
  logo_url: null,
  accent_color: null,
  greeting: null,
};

// Control characters (incl. newlines and tabs) and the Unicode line/paragraph
// separators become plain spaces: a name or greeting is one line of text.
// (Built from char codes: the separators are line terminators in JS source.)
const LINE_BREAKERS = new RegExp(`[\\x00-\\x1f\\x7f${String.fromCharCode(0x2028, 0x2029)}]+`, "g");

/** One line: control characters to spaces, runs of whitespace collapsed. */
export function oneLine(v: string): string {
  return v.replace(LINE_BREAKERS, " ").replace(/\s+/g, " ").trim();
}

/** The identity as stored, validated again on read (a hand-edited env var
 *  must not reach the UI unchecked). Invalid values fall back per field. */
export function storedHootieBrand(env: NodeJS.ProcessEnv = process.env): HootieBrand {
  const name = oneLine(env.HOOTIE_NAME ?? "");
  const greeting = oneLine(env.HOOTIE_GREETING ?? "");
  const logo = (env.HOOTIE_LOGO_URL ?? "").trim();
  return {
    name: name && name.length <= HOOTIE_NAME_MAX ? name : DEFAULT_HOOTIE_NAME,
    logo_url:
      logo && logo.length <= HOOTIE_LOGO_URL_MAX && isHttpsImageUrl(logo) ? logo : null,
    accent_color: normalizeHex((env.HOOTIE_ACCENT_COLOR ?? "").trim()),
    greeting: greeting && greeting.length <= HOOTIE_GREETING_MAX ? greeting : null,
  };
}

/** The licence feature that unlocks a custom identity (enterprise default;
 *  PromptOwl can grant or revoke it per licence). */
export const HOOTIE_BRANDING_FEATURE = "hootie_branding";

/** What every surface shows: the stored identity when the licence carries
 *  the branding feature, the default Hootie otherwise. */
export function effectiveHootieBrand(): HootieBrand {
  return hootieBrandingAvailable() ? storedHootieBrand() : { ...DEFAULT_HOOTIE_BRAND };
}

/** Whether this server may customise the identity: the licence carries
 *  the `hootie_branding` feature (Enterprise default, grantable per licence). */
export function hootieBrandingAvailable(): boolean {
  return hasEntitlement(HOOTIE_BRANDING_FEATURE);
}

/** The stored identity as the settings form shows it: each field's valid
 *  stored value, or "" when unset (or invalid, e.g. a hand-edited env var). */
export function storedHootieSettings(
  env: NodeJS.ProcessEnv = process.env,
): Record<HootieBrandField, string> {
  const b = storedHootieBrand(env);
  const name = oneLine(env.HOOTIE_NAME ?? "");
  return {
    hootie_name: name && name.length <= HOOTIE_NAME_MAX ? name : "",
    hootie_logo_url: b.logo_url ?? "",
    hootie_accent_color: b.accent_color ?? "",
    hootie_greeting: b.greeting ?? "",
  };
}

/** The value a branding field would be stored as, for comparison. */
function normalisedInput(field: HootieBrandField, raw: unknown): string {
  const v = raw === null || raw === undefined ? "" : String(raw);
  if (field === "hootie_accent_color") return v.trim() ? normalizeHex(v.trim()) ?? `invalid:${v}` : "";
  if (field === "hootie_logo_url") return v.trim();
  return oneLine(v);
}

/** The branding fields in the body whose value differs from what is stored.
 *  Echoing the current values back (a client that sends a whole form) is not
 *  a change, so it never trips the enterprise gate. */
export function changedHootieBrandFields(body: Record<string, unknown>): HootieBrandField[] {
  const stored = storedHootieSettings();
  return (Object.keys(HOOTIE_BRAND_FIELDS) as HootieBrandField[]).filter(
    (k) => k in body && normalisedInput(k, body[k]) !== stored[k],
  );
}

/**
 * Validate the branding fields of an /admin/settings PATCH. Empty clears a
 * field (back to the default). Returns the settings to persist, or adds a
 * field error — the caller writes nothing if any field failed.
 */
export function validateHootieBrandFields(
  body: Record<string, unknown>,
  addError: (field: string, message: string) => void,
): Array<{ name: string; value: string | null }> {
  const pending: Array<{ name: string; value: string | null }> = [];
  const str = (k: string) => (body[k] === null || body[k] === undefined ? "" : String(body[k]));

  if ("hootie_name" in body) {
    const v = oneLine(str("hootie_name"));
    if (v.length > HOOTIE_NAME_MAX)
      addError("hootie_name", `Name must be ${HOOTIE_NAME_MAX} characters or fewer.`);
    else pending.push({ name: "HOOTIE_NAME", value: v || null });
  }
  if ("hootie_logo_url" in body) {
    const v = str("hootie_logo_url").trim();
    if (v && (v.length > HOOTIE_LOGO_URL_MAX || !isHttpsImageUrl(v)))
      addError(
        "hootie_logo_url",
        "Logo must be an https:// link to an image (.png, .jpg, .gif or .webp).",
      );
    else pending.push({ name: "HOOTIE_LOGO_URL", value: v || null });
  }
  if ("hootie_accent_color" in body) {
    const raw = str("hootie_accent_color").trim();
    const v = raw ? normalizeHex(raw) : null;
    if (raw && !v)
      addError("hootie_accent_color", "Accent colour must be a hex colour like #0a7cff.");
    else pending.push({ name: "HOOTIE_ACCENT_COLOR", value: v });
  }
  if ("hootie_greeting" in body) {
    const v = oneLine(str("hootie_greeting"));
    if (v.length > HOOTIE_GREETING_MAX)
      addError("hootie_greeting", `Greeting must be ${HOOTIE_GREETING_MAX} characters or fewer.`);
    else pending.push({ name: "HOOTIE_GREETING", value: v || null });
  }
  return pending;
}
