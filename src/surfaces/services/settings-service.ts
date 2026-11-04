/**
 * surface_settings persistence (one row per org; defaults when absent).
 */
import { getDb } from "../../db/client.js";
import { ORG_ID } from "../flags.js";
import { applySettingsPatch, DEFAULT_SETTINGS, type SurfaceSettings } from "../core/settings.js";

const COLS = Object.keys(DEFAULT_SETTINGS) as Array<keyof SurfaceSettings>;

function parseList(v: unknown): string[] {
  try {
    const x = JSON.parse(String(v));
    return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
const cell = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : Array.isArray(v) ? JSON.stringify(v) : (v as string | number));

export async function getSettings(): Promise<SurfaceSettings> {
  const row = (await getDb().get("SELECT * FROM surface_settings WHERE org_id = ?", [ORG_ID])) as Record<string, unknown> | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const k of COLS) {
    if (row[k] === null || row[k] === undefined) continue;
    if (k === "timezone" || k === "default_seed") out[k] = String(row[k]);
    else if (k === "dm_capture" || k === "signin_alerts") out[k] = !!Number(row[k]);
    else if (k === "seed_library_nests") out[k] = parseList(row[k]);
    else out[k] = Number(row[k]);
  }
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
    [ORG_ID, ...COLS.map((c) => cell(next[c])), now, now],
  );
  return next;
}
