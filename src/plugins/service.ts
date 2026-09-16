/**
 * Runs — the glue between a nest_plugins row and the engine's plugin host.
 * Resolves settings (+ secrets from nest_env), builds a host with the
 * Community writer, runs ingest / webhook / search / promote, and records
 * the outcome on the row and in the plugin_runs ledger.
 */
import { createPluginHost, type IngestResult, type Outcome } from "@promptowl/contextnest-engine/plugins";
import type { NestPlugin, InboundItem, SearchHit } from "@promptowl/contextnest-plugin-sdk";
import { ValidationError, NotFoundError, ConflictError } from "../shared/errors.js";
import { opContext } from "../nodes/engine.js";
import { getPlugin, loadedPlugins } from "./loader.js";
import { accessTokenFor } from "./oauth.js";
import { communityWriter } from "./writer.js";
import { config } from "../config.js";
import {
  getRow,
  insertRun,
  parseJson,
  readSecrets,
  recordRunState,
  secretSettingKeys,
  WEBHOOK_SECRET_KEY,
  type NestPluginRow,
  type PluginRunRow,
} from "./registry.js";

export type TriggeredBy = `manual:${string}` | "schedule" | "webhook";

export interface RunSummary extends IngestResult {
  id: string;
  status: PluginRunRow["status"];
  error: string | null;
  triggered_by: string;
  started_at: string;
  finished_at: string;
}

const hostLog = (level: string, msg: string, data?: unknown) => {
  if (level === "debug") return;
  const line = `[plugins] ${msg}`;
  if (level === "error") console.error(line, data ?? "");
  else if (level === "warn") console.warn(line, data ?? "");
  else console.log(line);
};

/**
 * Stored non-secret settings + resolved secrets, as the plugin sees them.
 * For an OAuth plugin the host adds a fresh `accessToken` (refreshed from the
 * stored refresh token, which the plugin never receives).
 */
export async function resolvedSettings(nestId: string, plugin: NestPlugin, row: NestPluginRow | null, opts: { withAccessToken?: boolean } = { withAccessToken: true }): Promise<Record<string, unknown>> {
  const stored = parseJson<Record<string, unknown>>(row?.settings_json, {});
  const secrets = await readSecrets(nestId, plugin.manifest.name, secretSettingKeys(plugin));
  const out: Record<string, unknown> = { ...stored };
  for (const k of [...secretSettingKeys(plugin), "accessToken"]) delete out[k]; // never trust a stored value for these
  const merged = { ...out, ...secrets };
  if (plugin.manifest.oauth && opts.withAccessToken !== false) merged.accessToken = await accessTokenFor(nestId, plugin);
  return merged;
}

export async function requirePlugin(name: string): Promise<NestPlugin> {
  const plugin = await getPlugin(name);
  if (!plugin) throw new NotFoundError(`No plugin "${name}" is loaded on this server`);
  return plugin;
}

function makeHost(nestId: string, plugin: NestPlugin) {
  return createPluginHost({
    plugins: [plugin],
    nestId,
    write: communityWriter(nestId),
    log: hostLog,
    fetch: { timeoutMs: 30_000, budget: 5_000 },
    // Summary mode: no distiller is wired in this release — items land raw
    // with a warning (see the engine mapper). The port is here for the TheOwl
    // distill endpoint / a governed run to plug into.
  });
}

/** (nest, plugin) pairs with a pull in flight — one at a time, so a slow pull
 *  is never re-fired by the next tick or a click and races itself on the cursor. */
const inFlight = new Set<string>();
export const isPullInFlight = (nestId: string, name: string) => inFlight.has(`${nestId}:${name}`);

/** Run the plugin's pull() for a nest and record the run. Never throws for plugin failures. */
export async function runPluginPull(nestId: string, name: string, triggeredBy: TriggeredBy): Promise<RunSummary> {
  const plugin = await requirePlugin(name);
  const row = await getRow(nestId, name);
  if (!row || !row.enabled) throw new ConflictError(`Plugin "${name}" is not enabled on this nest`);
  if (!plugin.pull) throw new ValidationError(`Plugin "${name}" has no pull() face — it only accepts webhooks or answers searches`);
  const key = `${nestId}:${name}`;
  if (inFlight.has(key)) throw new ConflictError(`Plugin "${name}" is already running on this nest`);
  inFlight.add(key);
  try {
    return await runPullLocked(nestId, name, plugin, row, triggeredBy);
  } finally {
    inFlight.delete(key);
  }
}

async function runPullLocked(nestId: string, name: string, plugin: NestPlugin, row: NestPluginRow, triggeredBy: TriggeredBy): Promise<RunSummary> {
  // Settings (and, for an OAuth plugin, a fresh access token) resolve BEFORE
  // the run: "not connected" / "reconnect" is the caller's state to fix and
  // surfaces as a 409, not as a failed run in the ledger.
  const settings = await resolvedSettings(nestId, plugin, row);
  const startedAt = new Date().toISOString();
  const host = makeHost(nestId, plugin);
  const ctx = await opContext(nestId, `system:plugin:${name}`);
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
  // Ledger first, then the row's cursor/last-run: a crash between the two
  // leaves a run with no advanced cursor (re-runnable), never an advanced
  // cursor with no run to explain it.
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
  await recordRunState(nestId, name, { at: finishedAt, status, ...(result.clean && result.nextCursor !== undefined ? { cursor: result.nextCursor } : {}) });
  return { ...result, id: run.id, status, error, triggered_by: triggeredBy, started_at: startedAt, finished_at: finishedAt };
}

/** One inbound webhook delivery → the plugin verifies + parses → items ingested. */
export async function runPluginWebhook(row: NestPluginRow, req: { headers: Record<string, string>; body: string }): Promise<{ results: Array<{ externalId: string; id: string; outcome: Outcome }>; failed: Array<{ externalId: string; error: string }> }> {
  const plugin = await requirePlugin(row.plugin);
  if (!plugin.webhook) throw new ValidationError(`Plugin "${row.plugin}" has no webhook() face`);
  const settings = await resolvedSettings(row.nest_id, plugin, row);
  const host = makeHost(row.nest_id, plugin);
  const ctx = await opContext(row.nest_id, `system:plugin:${row.plugin}`);
  const pctx = { nestId: row.nest_id, settings, log: (l: string, m: string, d?: unknown) => hostLog(l, `[${row.plugin}] ${m}`, d), fetch: globalThis.fetch };
  // The plugin's verify step runs here, over the raw body — a bad signature throws.
  const items: InboundItem[] = await plugin.webhook(pctx as any, { ...req, secret: typeof settings[WEBHOOK_SECRET_KEY] === "string" ? (settings[WEBHOOK_SECRET_KEY] as string) : undefined });
  const results: Array<{ externalId: string; id: string; outcome: Outcome }> = [];
  const failed: Array<{ externalId: string; error: string }> = [];
  for (const item of items) {
    try {
      results.push(await host.ingestItem(ctx, { plugin: row.plugin, settings, item, mode: row.mode, target: row.folder ? { folder: row.folder } : {} }));
    } catch (err) {
      failed.push({ externalId: String(item?.externalId ?? "?"), error: (err as Error).message });
    }
  }
  const at = new Date().toISOString();
  const status: PluginRunRow["status"] = failed.length ? "failed" : results.some((r) => r.outcome === "conflict") ? "conflicts" : "clean";
  await insertRun({
    nest_id: row.nest_id, plugin: row.plugin, triggered_by: "webhook", status,
    created: results.filter((r) => r.outcome === "created").length,
    updated: results.filter((r) => r.outcome === "updated").length,
    unchanged: results.filter((r) => r.outcome === "unchanged").length,
    conflicts_json: JSON.stringify(results.filter((r) => r.outcome === "conflict")),
    failed_json: JSON.stringify(failed), error: null, started_at: at, finished_at: at,
  });
  // A delivery is not a pull: it must not push the scheduled pull's cadence out.
  await recordRunState(row.nest_id, row.plugin, { at, status, touchLastRun: false });
  return { results, failed };
}

export interface LiveHits {
  plugin: string;
  displayName: string;
  hits: Array<SearchHit & { governed: false; promotable: true }>;
}

/** Fan a query out to every enabled plugin on this nest that has a search() face. */
export async function liveSearch(nestId: string, text: string, limit: number, rows: NestPluginRow[]): Promise<{ live: LiveHits[]; errors: Array<{ plugin: string; error: string }> }> {
  const { plugins } = await loadedPlugins();
  const targets = rows.filter((r) => r.enabled && plugins.get(r.plugin)?.search);
  if (targets.length === 0) return { live: [], errors: [] };
  const host = createPluginHost({ plugins: targets.map((r) => plugins.get(r.plugin)!), nestId, write: communityWriter(nestId), log: hostLog });
  const ctx = await opContext(nestId, "system:plugin-search");
  const withSettings = await Promise.all(targets.map(async (r) => ({ plugin: r.plugin, settings: await resolvedSettings(nestId, plugins.get(r.plugin)!, r) })));
  const out = await host.search(ctx, { text, limit, plugins: withSettings, includeNest: false });
  return {
    live: out.live.map((l) => ({ plugin: l.plugin, displayName: plugins.get(l.plugin)!.manifest.displayName, hits: l.hits })),
    errors: out.errors,
  };
}

export async function promoteHit(nestId: string, name: string, externalId: string, by: string): Promise<{ externalId: string; id: string; outcome: Outcome }> {
  const plugin = await requirePlugin(name);
  const row = await getRow(nestId, name);
  if (!row || !row.enabled) throw new ConflictError(`Plugin "${name}" is not enabled on this nest`);
  const host = makeHost(nestId, plugin);
  const ctx = await opContext(nestId, `system:plugin:${name}`);
  const r = await host.promote(ctx, { plugin: name, settings: await resolvedSettings(nestId, plugin, row), externalId, mode: row.mode, target: row.folder ? { folder: row.folder } : {} });
  await insertRun({
    nest_id: nestId, plugin: name, triggered_by: `manual:${by}`, status: r.outcome === "conflict" ? "conflicts" : "clean",
    created: r.outcome === "created" ? 1 : 0, updated: r.outcome === "updated" ? 1 : 0, unchanged: r.outcome === "unchanged" ? 1 : 0,
    conflicts_json: JSON.stringify(r.outcome === "conflict" ? [r] : []), failed_json: "[]", error: null,
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
  });
  return r;
}

export function minIntervalMinutes(): number {
  return config.PLUGIN_MIN_INTERVAL_MINUTES;
}
