/**
 * nest_plugins rows, the plugin_runs ledger, and plugin secrets.
 *
 * Secrets never touch these tables. Settings a plugin marks `x-secret` go to
 * the nest env store (nest_env) as PLUGIN__<PLUGIN>__<KEY>, encrypted at rest
 * by shared/secret-box like every other value there. settings_json holds plain
 * values only. The workflow runner's env bundle leaves PLUGIN__ keys out
 * (workflow/env-routes.ts), so a plugin credential reaches that plugin only.
 */
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { secretKeys, type NestPlugin } from "@promptowl/contextnest-engine/plugins";
import { getDb } from "../db/client.js";
import { encryptSecret, tryDecryptSecret } from "../shared/secret-box.js";

export interface NestPluginRow {
  nest_id: string;
  plugin: string;
  enabled: number;
  mode: "raw" | "summary";
  folder: string | null;
  settings_json: string;
  cursor_json: string | null;
  system_user_id: string | null;
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

/** The prefix every plugin secret's env key carries — what the runner bundle excludes. */
export const PLUGIN_ENV_PREFIX = "PLUGIN__";

/**
 * `PLUGIN__<PLUGIN>__<KEY>` — injective, so two (plugin, key) pairs never share
 * a nest_env row. Plugin names are `[a-z0-9]+(-[a-z0-9]+)*` (the SDK manifest
 * schema, validated by the engine loader), so `-` → `_` cannot produce `__`.
 * The key keeps digits, upper-cases lower-case letters, marks an upper-case
 * letter with a leading `_`, and writes anything else as `_` + two hex digits,
 * so `apiKey`, `apikey`, `api-key` and `api_key` land on different rows. Env
 * keys are capped at 64 chars; a longer one keeps a hash suffix.
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
  const full = `${PLUGIN_ENV_PREFIX}${p}__${k}`;
  if (full.length <= 64) return full;
  const digest = createHash("sha256").update(full).digest("hex").slice(0, 12).toUpperCase();
  return `${full.slice(0, 51)}_${digest}`;
};

/** Secret setting names for a plugin: its schema's `x-secret` fields. */
export function secretSettingKeys(plugin: NestPlugin): string[] {
  return secretKeys(plugin.manifest);
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export async function getRow(nestId: string, plugin: string): Promise<NestPluginRow | null> {
  const row = (await getDb().get("SELECT * FROM nest_plugins WHERE nest_id = ? AND plugin = ?", [nestId, plugin])) as
    | NestPluginRow
    | undefined;
  return row ?? null;
}

export async function listRows(nestId: string): Promise<NestPluginRow[]> {
  return (await getDb().all("SELECT * FROM nest_plugins WHERE nest_id = ? ORDER BY plugin", [nestId])) as NestPluginRow[];
}

export interface RowPatch {
  enabled?: boolean;
  mode?: "raw" | "summary";
  folder?: string | null;
  settings?: Record<string, unknown>;
  system_user_id?: string | null;
}

/**
 * Create-or-merge a row. `settings` are plain values (secrets already diverted
 * to nest_env) merged over what is stored. Run-state columns (cursor, last
 * run) are never touched here, so a save racing a run never loses the cursor.
 */
export async function upsertRow(nestId: string, plugin: string, patch: RowPatch, by: string): Promise<NestPluginRow> {
  const db = getDb();
  const prev = await getRow(nestId, plugin);
  const now = new Date().toISOString();
  const settings = { ...parseJson<Record<string, unknown>>(prev?.settings_json, {}), ...(patch.settings ?? {}) };
  const enabled = (patch.enabled ?? !!prev?.enabled) ? 1 : 0;
  const mode = patch.mode ?? prev?.mode ?? "raw";
  const folder = patch.folder === undefined ? (prev?.folder ?? null) : patch.folder;
  const systemUserId = patch.system_user_id === undefined ? (prev?.system_user_id ?? null) : patch.system_user_id;
  if (prev) {
    await db.run(
      `UPDATE nest_plugins SET enabled = ?, mode = ?, folder = ?, settings_json = ?, system_user_id = ?, updated_at = ?
        WHERE nest_id = ? AND plugin = ?`,
      [enabled, mode, folder, JSON.stringify(settings), systemUserId, now, nestId, plugin],
    );
  } else {
    await db.run(
      `INSERT INTO nest_plugins (nest_id, plugin, enabled, mode, folder, settings_json, system_user_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nestId, plugin, enabled, mode, folder, JSON.stringify(settings), systemUserId, by, now, now],
    );
  }
  return (await getRow(nestId, plugin))!;
}

export async function deleteRow(nestId: string, plugin: string): Promise<void> {
  await getDb().run("DELETE FROM nest_plugins WHERE nest_id = ? AND plugin = ?", [nestId, plugin]);
}

export async function recordRunState(
  nestId: string,
  plugin: string,
  patch: { cursor?: unknown; status: string; at: string },
): Promise<void> {
  const sets = ["last_status = ?", "last_run_at = ?", "updated_at = ?"];
  const args: Array<string | number | null> = [patch.status, patch.at, patch.at];
  if (patch.cursor !== undefined) {
    sets.push("cursor_json = ?");
    args.push(JSON.stringify(patch.cursor));
  }
  await getDb().run(`UPDATE nest_plugins SET ${sets.join(", ")} WHERE nest_id = ? AND plugin = ?`, [...args, nestId, plugin]);
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
  return (await getDb().all(
    "SELECT * FROM plugin_runs WHERE nest_id = ? AND plugin = ? ORDER BY started_at DESC, id DESC LIMIT ?",
    [nestId, plugin, limit],
  )) as PluginRunRow[];
}

// ── secrets (nest env store) ──

/** Write secrets; an empty value deletes that one. */
export async function putSecrets(nestId: string, plugin: string, secrets: Record<string, string>, by: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(secrets)) {
    const envKey = envKeyFor(plugin, key);
    if (!value) {
      await db.run("DELETE FROM nest_env WHERE nest_id = ? AND key = ?", [nestId, envKey]);
      continue;
    }
    const sealed = await encryptSecret(value);
    await db.run(
      `INSERT INTO nest_env (nest_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(nest_id, key) DO UPDATE SET value = ?, updated_by = ?, updated_at = ?`,
      [nestId, envKey, sealed, by, now, sealed, by, now],
    );
  }
}

/** Decrypted secrets for these keys; a value this server can't open is left out. */
export async function readSecrets(nestId: string, plugin: string, keys: string[]): Promise<Record<string, string>> {
  const db = getDb();
  const out: Record<string, string> = {};
  for (const key of keys) {
    const envKey = envKeyFor(plugin, key);
    const row = (await db.get("SELECT value FROM nest_env WHERE nest_id = ? AND key = ?", [nestId, envKey])) as
      | { value: string }
      | undefined;
    if (!row) continue;
    const plain = await tryDecryptSecret(row.value, `${envKey} on nest ${nestId}`);
    if (plain !== null) out[key] = plain;
  }
  return out;
}
