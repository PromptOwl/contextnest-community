/**
 * Nest Plugins service layer (Slice A, CU-wdqcq05raz) — the one place both
 * surfaces call: REST (routes.ts) and MCP (mcp/plugin-tools.ts). Every
 * permission decision is made here, so the two cannot drift.
 *
 *   list / runs / health  read tier (error text only at write tier)
 *   run                   write tier, full credential
 *   configure / remove    nest owner/admin, a person on a full credential
 *                         (configuring provisions a system identity)
 */
import { createPluginHost, trimSlashes, type IngestResult, type NestPlugin } from "@promptowl/contextnest-engine/plugins";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { resolveNestPermission, permissionLevel, type NestPermission } from "../shared/access.js";
import { checkActor, isNestAdmin } from "../auth/systems.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { opContext } from "../nodes/engine.js";
import { getPlugin, loadedPlugins } from "./loader.js";
import { communityWriter } from "./writer.js";
import { ensurePluginSystem, pluginSystem, retirePluginSystem, runAuthor } from "./identity.js";
import {
  deleteRow,
  getRow,
  insertRun,
  listRows,
  parseJson,
  putSecrets,
  readSecrets,
  recentRuns,
  recordRunState,
  secretSettingKeys,
  upsertRow,
  type NestPluginRow,
  type PluginRunRow,
  type RowPatch,
} from "./registry.js";

/** Who is asking: the user, and the capability of the credential they used. */
export interface Caller {
  userId: string;
  capability?: "read" | "write";
}

export interface RunSummary extends IngestResult {
  id: string;
  status: PluginRunRow["status"];
  error: string | null;
  triggered_by: string;
  started_at: string;
  finished_at: string;
}

const MASK = "••••";

const hostLog = (level: string, msg: string, data?: unknown) => {
  if (level === "debug") return;
  const line = `[plugins] ${msg}`;
  if (level === "error") console.error(line, data ?? "");
  else if (level === "warn") console.warn(line, data ?? "");
  else console.log(line);
};

async function callerPermission(nestId: string, caller: Caller): Promise<NestPermission> {
  const p = await resolveNestPermission(nestId, caller.userId);
  return caller.capability === "read" && permissionLevel(p) > permissionLevel("read") ? "read" : p;
}

async function requireTier(nestId: string, caller: Caller, tier: "read" | "write"): Promise<NestPermission> {
  const p = await callerPermission(nestId, caller);
  if (permissionLevel(p) < permissionLevel(tier)) {
    throw new ForbiddenError(
      tier === "write" ? "Running a plugin needs edit access to this nest." : "You don't have access to this nest.",
    );
  }
  return p;
}

async function requireNestAdmin(nestId: string, caller: Caller): Promise<void> {
  const bad = await checkActor(caller.userId, caller.capability);
  // Configuring provisions a system identity, so the same bar as Systems:
  // a person, on a full credential (never a read-only, system or headless key).
  if (bad) throw new ForbiddenError("Only a person on a read-write credential can configure plugins.");
  if (!(await isNestAdmin(nestId, caller.userId))) {
    throw new ForbiddenError("Only a nest owner or admin can configure plugins on this nest.");
  }
}

export async function requirePlugin(name: string): Promise<NestPlugin> {
  const plugin = await getPlugin(name);
  if (!plugin) throw new NotFoundError(`No plugin "${name}" is loaded on this server`);
  return plugin;
}

/** Plain settings + decrypted secrets, as the plugin sees them. A stored plain value never shadows a secret. */
export async function resolvedSettings(nestId: string, plugin: NestPlugin, row: NestPluginRow | null): Promise<Record<string, unknown>> {
  const keys = secretSettingKeys(plugin);
  const stored = parseJson<Record<string, unknown>>(row?.settings_json, {});
  for (const k of keys) delete stored[k];
  return { ...stored, ...(await readSecrets(nestId, plugin.manifest.name, keys)) };
}

/** Error text comes from the plugin / upstream and may echo a credential fragment: write tier only. */
function runToResponse(r: PluginRunRow, reveal: boolean) {
  const failed = parseJson<Array<{ externalId: string; error: string }>>(r.failed_json, []);
  return {
    id: r.id,
    triggered_by: r.triggered_by,
    status: r.status,
    created: r.created,
    updated: r.updated,
    unchanged: r.unchanged,
    conflicts: parseJson(r.conflicts_json, []),
    failed: reveal ? failed : failed.map((f) => ({ externalId: f.externalId, error: null })),
    error: reveal ? r.error : r.error ? "failed" : null,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}

async function describe(nestId: string, plugin: NestPlugin, row: NestPluginRow | null, reveal: boolean) {
  const secrets = secretSettingKeys(plugin);
  const stored = parseJson<Record<string, unknown>>(row?.settings_json, {});
  const present = await readSecrets(nestId, plugin.manifest.name, secrets);
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) if (!secrets.includes(k)) settings[k] = v;
  // Presence only — no tail: the list is readable at the viewer tier.
  for (const k of secrets) if (present[k]) settings[k] = MASK;
  const m = plugin.manifest;
  const system = await pluginSystem(row?.system_user_id);
  return {
    name: m.name,
    version: m.version,
    displayName: m.displayName,
    description: m.description,
    capabilities: m.capabilities,
    itemKinds: m.itemKinds,
    settingsSchema: m.settings,
    secretKeys: secrets,
    faces: { pull: !!plugin.pull, process: !!plugin.process, healthcheck: !!plugin.healthcheck },
    configured: !!row,
    enabled: !!row?.enabled,
    mode: row?.mode ?? "raw",
    folder: row?.folder ?? null,
    settings,
    cursor: parseJson<unknown>(row?.cursor_json, null),
    system,
    last_run_at: row?.last_run_at ?? null,
    last_status: row?.last_status ?? null,
    runs: row ? (await recentRuns(nestId, m.name, 10)).map((r) => runToResponse(r, reveal)) : [],
  };
}
export type PluginDescription = Awaited<ReturnType<typeof describe>>;

export async function listNestPlugins(nestId: string, caller: Caller) {
  const p = await requireTier(nestId, caller, "read");
  const reveal = permissionLevel(p) >= permissionLevel("write");
  const { plugins, errors } = await loadedPlugins();
  const rows = await listRows(nestId);
  const out: PluginDescription[] = [];
  for (const plugin of plugins.values()) {
    out.push(await describe(nestId, plugin, rows.find((r) => r.plugin === plugin.manifest.name) ?? null, reveal));
  }
  // Which specs failed to load is the operator's business, not a viewer's.
  return { plugins: out, load_errors: reveal ? errors : [] };
}

export async function listPluginRuns(nestId: string, name: string, caller: Caller, limit = 20) {
  const p = await requireTier(nestId, caller, "read");
  await requirePlugin(name);
  const reveal = permissionLevel(p) >= permissionLevel("write");
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  return { runs: (await recentRuns(nestId, name, n)).map((r) => runToResponse(r, reveal)) };
}

export async function pluginHealth(nestId: string, name: string, caller: Caller): Promise<{ ok: boolean; detail?: string }> {
  await requireTier(nestId, caller, "read");
  const plugin = await requirePlugin(name);
  if (!plugin.healthcheck) return { ok: true, detail: "plugin has no healthcheck" };
  const row = await getRow(nestId, name);
  try {
    return await plugin.healthcheck({ nestId, settings: await resolvedSettings(nestId, plugin, row), log: () => {}, fetch: globalThis.fetch } as any);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** PUT body / MCP args, as one shape. */
export interface ConfigureInput {
  enabled?: unknown;
  mode?: unknown;
  folder?: unknown;
  settings?: unknown;
}

export async function configurePlugin(nestId: string, name: string, input: ConfigureInput, caller: Caller) {
  await requireNestAdmin(nestId, caller);
  const plugin = await requirePlugin(name);
  const by = await resolveCallerEmail(caller.userId);

  const patch: RowPatch = {};
  if (input.enabled !== undefined) patch.enabled = !!input.enabled;
  if (input.mode !== undefined) {
    if (input.mode !== "raw" && input.mode !== "summary") throw new ValidationError('mode must be "raw" or "summary"');
    patch.mode = input.mode;
  }
  if (input.folder !== undefined) {
    if (input.folder !== null && typeof input.folder !== "string") throw new ValidationError("folder must be a string or null");
    const f = typeof input.folder === "string" ? trimSlashes(input.folder.trim()) : "";
    if (f.split("/").includes("..")) throw new ValidationError('folder must not contain ".."');
    patch.folder = f || null;
  }

  const secretKeys = secretSettingKeys(plugin);
  let secrets: Record<string, string> = {};
  if (input.settings !== undefined) {
    if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) {
      throw new ValidationError("settings must be an object");
    }
    const incoming = input.settings as Record<string, unknown>;
    const declared = new Set(Object.keys(plugin.manifest.settings.properties ?? {}));
    const unknown = Object.keys(incoming).filter((k) => !declared.has(k));
    if (unknown.length) throw new ValidationError(`unknown setting(s) for ${name}: ${unknown.join(", ")}`);
    const plain: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (secretKeys.includes(k)) {
        if (v !== null && typeof v !== "string") throw new ValidationError(`${k} must be a string`);
        // null clears; empty or the mask means "leave the stored secret alone".
        if (v === null) secrets[k] = "";
        else if (v && v !== MASK) secrets[k] = v;
      } else plain[k] = v;
    }
    // The plugin vetoes BEFORE anything is written, seeing the merged view.
    if (plugin.validateSettings) {
      const row = await getRow(nestId, name);
      const merged = { ...(await resolvedSettings(nestId, plugin, row)), ...plain, ...secrets };
      for (const [k, v] of Object.entries(secrets)) if (!v) delete merged[k];
      try {
        await plugin.validateSettings(merged);
      } catch (err) {
        throw new ValidationError(`${name}: ${(err as Error).message}`);
      }
    }
    patch.settings = plain;
  }

  // An enabled plugin always has a live system identity to write as.
  const prev = await getRow(nestId, name);
  const willBeEnabled = patch.enabled ?? !!prev?.enabled;
  if (willBeEnabled) {
    const sys = await ensurePluginSystem({
      nestId,
      displayName: plugin.manifest.displayName,
      current: prev?.system_user_id ?? null,
      actorId: caller.userId,
      actorCapability: caller.capability,
    });
    patch.system_user_id = sys.id;
  }
  if (Object.keys(secrets).length) await putSecrets(nestId, name, secrets, by);
  const row = await upsertRow(nestId, name, patch, by);
  return { plugin: await describe(nestId, plugin, row, true) };
}

export async function removePlugin(nestId: string, name: string, caller: Caller) {
  await requireNestAdmin(nestId, caller);
  const plugin = await requirePlugin(name);
  const row = await getRow(nestId, name);
  if (!row) throw new NotFoundError("Plugin is not configured on this nest");
  const by = await resolveCallerEmail(caller.userId);
  await putSecrets(nestId, name, Object.fromEntries(secretSettingKeys(plugin).map((k) => [k, ""])), by);
  await retirePluginSystem(row.system_user_id, caller.userId, caller.capability);
  await deleteRow(nestId, name);
  return { deleted: true as const };
}

/**
 * (nest, plugin) pairs with a pull in flight — one at a time, so a slow pull
 * is never re-fired and races itself on the cursor. Per-process: on a
 * multi-instance deployment two servers could each accept one; the writer's
 * content-hash rule keeps that safe (the second lands unchanged/conflict).
 */
const inFlight = new Set<string>();

/** Run the plugin's pull() now and record the run. Plugin failures are a failed run, not an error. */
export async function runPluginNow(nestId: string, name: string, caller: Caller): Promise<{ run: RunSummary }> {
  await requireTier(nestId, caller, "write");
  const plugin = await requirePlugin(name);
  const row = await getRow(nestId, name);
  if (!row || !row.enabled) throw new ConflictError(`Plugin "${name}" is not enabled on this nest`);
  if (!plugin.pull) throw new ValidationError(`Plugin "${name}" has no pull() face`);
  const author = await runAuthor(nestId, row.system_user_id);
  const key = `${nestId}:${name}`;
  if (inFlight.has(key)) throw new ConflictError(`Plugin "${name}" is already running on this nest`);
  inFlight.add(key);
  try {
    const by = await resolveCallerEmail(caller.userId);
    return { run: await runPull(nestId, plugin, row, author, `manual:${by}`) };
  } finally {
    inFlight.delete(key);
  }
}

async function runPull(nestId: string, plugin: NestPlugin, row: NestPluginRow, author: string, triggeredBy: string): Promise<RunSummary> {
  const name = plugin.manifest.name;
  const settings = await resolvedSettings(nestId, plugin, row);
  const startedAt = new Date().toISOString();
  const host = createPluginHost({
    plugins: [plugin],
    nestId,
    write: communityWriter(nestId, author),
    log: hostLog,
    fetch: { timeoutMs: 30_000, budget: 5_000 },
    // No distiller wired yet: summary-mode items land raw with a warning
    // (engine mapper). The port is here for the distill endpoint.
  });
  const ctx = await opContext(nestId, author);
  let result: IngestResult;
  let error: string | null = null;
  try {
    result = await host.ingest(ctx, {
      plugin: name,
      settings,
      cursor: parseJson<unknown>(row.cursor_json, undefined),
      mode: row.mode,
      target: row.folder ? { folder: row.folder } : {},
    });
  } catch (err) {
    error = (err as Error).message;
    result = { plugin: name, created: 0, updated: 0, unchanged: 0, skipped: 0, conflicts: [], failed: [], results: [], clean: false };
    hostLog("error", `${name} on ${nestId} failed: ${error}`);
  }
  const finishedAt = new Date().toISOString();
  const status: PluginRunRow["status"] = error ? "failed" : result.clean ? "clean" : result.failed.length ? "failed" : "conflicts";
  // Ledger first, then the row: a crash between the two leaves a run with no
  // advanced cursor (re-runnable), never an advanced cursor with no run.
  const run = await insertRun({
    nest_id: nestId,
    plugin: name,
    triggered_by: triggeredBy,
    status,
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    conflicts_json: JSON.stringify(result.conflicts),
    failed_json: JSON.stringify(result.failed),
    error,
    started_at: startedAt,
    finished_at: finishedAt,
  });
  await recordRunState(nestId, name, {
    at: finishedAt,
    status,
    ...(result.clean && result.nextCursor !== undefined ? { cursor: result.nextCursor } : {}),
  });
  return { ...result, id: run.id, status, error, triggered_by: triggeredBy, started_at: startedAt, finished_at: finishedAt };
}
