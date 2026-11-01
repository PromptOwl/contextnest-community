/**
 * Org-level Surfaces settings (PRD §4.1, single source of truth): defaults,
 * ranges and the cross-field rules. A value outside its range is a
 * SettingsError (HTTP 422). The buffer TTL has a hard 24 h ceiling that
 * config can't raise; effectiveTtlHours clamps whatever is stored.
 */
export interface SurfaceSettings {
  quiet_minutes: number;
  window_max_age_hours: number;
  buffer_ttl_hours: number;
  min_meaningful_chars: number;
  propose_threshold: number;
  reviewer_daily_cards: number;
  conversation_daily_cards: number;
  timezone: string;
  /** §12 R2: DM capture, default OFF. */
  dm_capture: boolean;
  /** Round 8: sign-in alerts for sealed-nest owners, default ON. Turning it off notifies every owner. */
  signin_alerts: boolean;
}

export const DEFAULT_SETTINGS: SurfaceSettings = {
  quiet_minutes: 20,
  window_max_age_hours: 6,
  buffer_ttl_hours: 24,
  min_meaningful_chars: 6,
  propose_threshold: 0.7,
  reviewer_daily_cards: 2,
  conversation_daily_cards: 3,
  timezone: "UTC",
  dm_capture: false,
  signin_alerts: true,
};

export const BUFFER_TTL_CEILING_HOURS = 24;

export class SettingsError extends Error {}

const RANGES: Record<Exclude<keyof SurfaceSettings, "timezone" | "dm_capture" | "signin_alerts">, { min: number; max: number; integer: boolean }> = {
  quiet_minutes: { min: 5, max: 240, integer: true },
  window_max_age_hours: { min: 1, max: 12, integer: true },
  buffer_ttl_hours: { min: 1, max: BUFFER_TTL_CEILING_HOURS, integer: true },
  min_meaningful_chars: { min: 1, max: 50, integer: true },
  propose_threshold: { min: 0.5, max: 0.95, integer: false },
  reviewer_daily_cards: { min: 1, max: 10, integer: true },
  conversation_daily_cards: { min: 1, max: 20, integer: true },
};

/** Validate a partial update against the current settings. Unknown keys and
 *  wrong types are refused, not ignored. */
export function applySettingsPatch(current: SurfaceSettings, patch: Record<string, unknown>): SurfaceSettings {
  const next: SurfaceSettings = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "timezone") {
      if (typeof v !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$|^UTC$/.test(v)) throw new SettingsError("timezone must be an IANA name like Europe/Berlin");
      next.timezone = v;
      continue;
    }
    if (k === "dm_capture") {
      if (typeof v !== "boolean") throw new SettingsError("dm_capture must be true or false");
      next.dm_capture = v;
      continue;
    }
    if (k === "signin_alerts") {
      if (typeof v !== "boolean") throw new SettingsError("signin_alerts must be true or false");
      next.signin_alerts = v;
      continue;
    }
    const r = RANGES[k as keyof typeof RANGES];
    if (!r) throw new SettingsError(`${k} is not a Surfaces setting`);
    if (typeof v !== "number" || !Number.isFinite(v) || (r.integer && !Number.isInteger(v))) {
      throw new SettingsError(`${k} must be ${r.integer ? "a whole number" : "a number"}`);
    }
    if (v < r.min || v > r.max) throw new SettingsError(`${k} must be between ${r.min} and ${r.max}`);
    (next as unknown as Record<string, number>)[k] = v;
  }
  if (next.window_max_age_hours >= next.buffer_ttl_hours) {
    throw new SettingsError("window_max_age_hours must be less than buffer_ttl_hours");
  }
  return next;
}

export function effectiveTtlHours(s: Pick<SurfaceSettings, "buffer_ttl_hours">): number {
  const h = Number(s.buffer_ttl_hours);
  if (!Number.isFinite(h) || h <= 0) return BUFFER_TTL_CEILING_HOURS;
  return Math.min(h, BUFFER_TTL_CEILING_HOURS);
}
