/**
 * surface_settings persistence (one row per org; defaults when absent).
 */
import { getDb } from "../../db/client.js";
import { ORG_ID } from "../flags.js";
import { applySettingsPatch, DEFAULT_SETTINGS, type SurfaceSettings } from "../core/settings.js";

const COLS = Object.keys(DEFAULT_SETTINGS) as Array<keyof SurfaceSettings>;

export async function getSettings(): Promise<SurfaceSettings> {
  const row = (await getDb().get("SELECT * FROM surface_settings WHERE org_id = ?", [ORG_ID])) as Record<string, unknown> | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const k of COLS) if (row[k] !== null && row[k] !== undefined) out[k] = k === "timezone" ? String(row[k]) : k === "dm_capture" || k === "signin_alerts" ? !!Number(row[k]) : Number(row[k]);
  return out as unknown as SurfaceSettings;
}

/** Validate (SettingsError → 422) and save. */
export async function updateSettings(
  patch: Record<string, unknown>,
  runner: { run: (sql: string, p?: any[]) => Promise<unknown> } = getDb(),
): Promise<SurfaceSettings> {
  const next = applySettingsPatch(await getSettings(), patch);
  const now = new Date().toISOString();
  await runner.run(
    `INSERT INTO surface_settings (org_id, ${COLS.join(", ")}, created_at, updated_at) VALUES (?, ${COLS.map(() => "?").join(", ")}, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET ${COLS.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`,
    [ORG_ID, ...COLS.map((c) => (typeof next[c] === "boolean" ? (next[c] ? 1 : 0) : (next[c] as string | number))), now, now],
  );
  return next;
}
