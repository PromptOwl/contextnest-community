/**
 * nest_plugins rows + plugin_runs ledger. Secrets never touch these tables:
 * settings marked `x-secret` (and the reserved `webhookSecret`) go to
 * nest_env as PLUGIN_<NAME>_<KEY>, and settings_json keeps only an `env:`
 * pointer so a read can say "set" without knowing the value.
 */
import { randomBytes, createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { secretKeys, type NestPlugin } from "@promptowl/contextnest-plugin-sdk";
import { getDb } from "../db/client.js";

export interface NestPluginRow {
  nest_id: string;
  plugin: string;
  enabled: number;
  mode: "raw" | "summary";
  folder: string | null;
  every_minutes: number | null;
  settings_json: string;
  cursor_json: string | null;
  webhook_token: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PluginRunRow {
  id: string;
  nest_id: string;
  plugin: string;
  triggered_by: string;
  status: "clean" | "conflicts" | "failed";
  created: number;
  updated: number;
  unchanged: number;
  conflicts_json: string;
  failed_json: string;
  error: string | null;
  started_at: string;
  finished_at: string;
}

/** The reserved secret every webhook-capable plugin gets, whether or not its schema names it. */
export const WEBHOOK_SECRET_KEY = "webhookSecret";

/**
 * `PLUGIN__<PLUGIN>__<KEY>` — injective, so two (plugin, key) pairs can never
 * share a nest_env row. The plugin part maps `-` → `_` (names are [a-z0-9-],
 * so no `__` can appear inside it); the key part keeps digits, encodes each
 * letter with its case (`a` → `A`, `A` → `_A`) and every other character as
 * `_` + two hex digits, so `webhookSecret`, `webhooksecret`, `webhook-secret`
 * and `webhook_secret` all land on different rows. Env-store keys are capped
 * at 64 chars, so a very long setting name is truncated to a hash suffix.
 */
export const envKeyFor = (plugin: string, key: string): string => {
  const p = plugin.toUpperCase().replace(/-/g, "_");
  let k = "";
  for (const ch of key) {
    if (/[0-9]/.test(ch)) k += ch;
    else if (/[a-z]/.test(ch)) k += ch.toUpperCase();
    else if (/[A-Z]/.test(ch)) k += `_${ch}`;
    else k += `_${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  const full = `PLUGIN__${p}__${k}`;
  if (full.length <= 64) return full;
  const digest = createHash("sha256").update(full).digest("hex").slice(0, 12).toUpperCase();
  return `${full.slice(0, 51)}_${digest}`;
};

/** Secret setting names for a plugin: schema `x-secret` fields + the reserved webhook secret. */
export function secretSettingKeys(plugin: NestPlugin): string[] {
  const keys = new Set(secretKeys(plugin.manifest));
  if (plugin.manifest.capabilities.includes("webhook")) keys.add(WEBHOOK_SECRET_KEY);
  return [...keys];
}

export async function getRow(nestId: string, plugin: string): Promise<NestPluginRow | null> {
  const row = (await getDb().get("SELECT * FROM nest_plugins WHERE nest_id = ? AND plugin = ?", [nestId, plugin])) as NestPluginRow | undefined;
  return row ?? null;
}

export async function listRows(nestId: string): Promise<NestPluginRow[]> {
  return (await getDb().all("SELECT * FROM nest_plugins WHERE nest_id = ? ORDER BY plugin", [nestId])) as NestPluginRow[];
}

/** The row for a webhook token — never for an archived nest (it is read-only). */
export async function rowByWebhookToken(token: string): Promise<NestPluginRow | null> {
  const row = (await getDb().get(
    `SELECT p.* FROM nest_plugins p JOIN nests n ON n.id = p.nest_id
      WHERE p.webhook_token = ? AND n.archived_at IS NULL`,
    [token],
  )) as NestPluginRow | undefined;
  return row ?? null;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Create-or-merge a row. `settings` are non-secret values (secrets already diverted to nest_env). */
export async function upsertRow(
  nestId: string,
  plugin: NestPlugin,
  patch: { enabled?: boolean; mode?: "raw" | "summary"; folder?: string | null; every_minutes?: number | null; settings?: Record<string, unknown> },
  by: string,
): Promise<NestPluginRow> {
  const db = getDb();
  const prev = await getRow(nestId, plugin.manifest.name);
  const now = new Date().toISOString();
  const settings = { ...parseJson<Record<string, unknown>>(prev?.settings_json, {}), ...(patch.settings ?? {}) };
  const webhookToken =
    prev?.webhook_token ?? (plugin.manifest.capabilities.includes("webhook") ? randomBytes(24).toString("base64url") : null);
  const row: NestPluginRow = {
    nest_id: nestId,
    plugin: plugin.manifest.name,
    enabled: (patch.enabled ?? !!prev?.enabled) ? 1 : 0,
    mode: patch.mode ?? prev?.mode ?? "raw",
    folder: patch.folder === undefined ? (prev?.folder ?? null) : patch.folder,
    every_minutes: patch.every_minutes === undefined ? (prev?.every_minutes ?? null) : patch.every_minutes,
    settings_json: JSON.stringify(settings),
    cursor_json: prev?.cursor_json ?? null,
    webhook_token: webhookToken,
    last_run_at: prev?.last_run_at ?? null,
    last_status: prev?.last_status ?? null,
    created_by: prev?.created_by ?? by,
    created_at: prev?.created_at ?? now,
    updated_at: now,
  };
  // UPDATE the config columns on an existing row (never a REPLACE, which on
  // SQLite would rewrite cursor_json / last_run_at from the stale `prev` and
  // lose a run that finished in between); INSERT only when there is no row.
  if (prev) {
    await db.run(
      `UPDATE nest_plugins SET enabled = ?, mode = ?, folder = ?, every_minutes = ?, settings_json = ?, webhook_token = ?, updated_at = ?
        WHERE nest_id = ? AND plugin = ?`,
      [row.enabled, row.mode, row.folder, row.every_minutes, row.settings_json, row.webhook_token, row.updated_at, row.nest_id, row.plugin],
    );
  } else {
    await db.run(
      `INSERT INTO nest_plugins (nest_id, plugin, enabled, mode, folder, every_minutes, settings_json, cursor_json, webhook_token, last_run_at, last_status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.nest_id, row.plugin, row.enabled, row.mode, row.folder, row.every_minutes, row.settings_json, row.cursor_json, row.webhook_token, row.last_run_at, row.last_status, row.created_by, row.created_at, row.updated_at],
    );
  }
  return (await getRow(nestId, plugin.manifest.name))!;
}

export async function recordRunState(
  nestId: string,
  plugin: string,
  patch: { cursor?: unknown; status: string; at: string; touchLastRun?: boolean },
): Promise<void> {
  const db = getDb();
  const sets = ["last_status = ?", "updated_at = ?"];
  const args: Array<string | number | null> = [patch.status, patch.at];
  // last_run_at drives the pull cadence — only a pull moves it.
  if (patch.touchLastRun !== false) {
    sets.push("last_run_at = ?");
    args.push(patch.at);
  }
  if (patch.cursor !== undefined) {
    sets.push("cursor_json = ?");
    args.push(JSON.stringify(patch.cursor));
  }
  await db.run(`UPDATE nest_plugins SET ${sets.join(", ")} WHERE nest_id = ? AND plugin = ?`, [...args, nestId, plugin]);
}

export async function insertRun(run: Omit<PluginRunRow, "id">): Promise<PluginRunRow> {
  const id = `prun_${uuid()}`;
  await getDb().run(
    `INSERT INTO plugin_runs (id, nest_id, plugin, triggered_by, status, created, updated, unchanged, conflicts_json, failed_json, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, run.nest_id, run.plugin, run.triggered_by, run.status, run.created, run.updated, run.unchanged, run.conflicts_json, run.failed_json, run.error, run.started_at, run.finished_at],
  );
  return { id, ...run };
}

export async function recentRuns(nestId: string, plugin: string, limit = 10): Promise<PluginRunRow[]> {
  return (await getDb().all("SELECT * FROM plugin_runs WHERE nest_id = ? AND plugin = ? ORDER BY started_at DESC LIMIT ?", [nestId, plugin, limit])) as PluginRunRow[];
}

// ── secrets (nest_env) ──

export async function putSecrets(nestId: string, plugin: string, secrets: Record<string, string>, by: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(secrets)) {
    const envKey = envKeyFor(plugin, key);
    if (!value) {
      await db.run("DELETE FROM nest_env WHERE nest_id = ? AND key = ?", [nestId, envKey]);
      continue;
    }
    await db.run(
      `INSERT INTO nest_env (nest_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(nest_id, key) DO UPDATE SET value = ?, updated_by = ?, updated_at = ?`,
      [nestId, envKey, value, by, now, value, by, now],
    );
  }
}

export async function readSecrets(nestId: string, plugin: string, keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const db = getDb();
  const out: Record<string, string> = {};
  for (const key of keys) {
    const row = (await db.get("SELECT value FROM nest_env WHERE nest_id = ? AND key = ?", [nestId, envKeyFor(plugin, key)])) as { value: string } | undefined;
    if (row) out[key] = row.value;
  }
  return out;
}
