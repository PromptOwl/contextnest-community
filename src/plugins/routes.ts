/**
 * Nest Plugins — /nests/:nestId/plugins (config, health, run-now, promote)
 * and the unauthenticated /plugin-hooks/:token webhook face. All gated by
 * FEATURE_PLUGINS (404 when off, like the workflow plane's routes).
 *
 * Permission falls out of the nest middleware: GET is read-tier, everything
 * else is write-tier — so a viewer can see which plugins are connected but
 * only an editor can configure, run, or promote.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import type { NestPlugin } from "@promptowl/contextnest-plugin-sdk";
import { config } from "../config.js";
import { trimSlashes } from "@promptowl/contextnest-engine/plugins";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { permissionLevel } from "../shared/access.js";
import { tryConsume } from "../shared/rate-limit.js";
import { loadedPlugins } from "./loader.js";
import {
  getRow,
  listRows,
  parseJson,
  putSecrets,
  readSecrets,
  recentRuns,
  rowByWebhookToken,
  secretSettingKeys,
  upsertRow,
  type NestPluginRow,
  type PluginRunRow,
} from "./registry.js";
import { minIntervalMinutes, promoteHit, requirePlugin, resolvedSettings, runPluginPull, runPluginWebhook } from "./service.js";
import { beginConnect, completeConnect, connectionInfo, consumeState, disconnect } from "./oauth.js";
import { getPlugin } from "./loader.js";

export const requirePlugins = async (c: any, next: () => Promise<void>) => {
  if (!config.FEATURE_PLUGINS) return c.json({ error: "Not found" }, 404);
  await next();
};

// Presence only — no tail. The list is readable at the viewer tier, and a
// partial secret is still a partial secret.
const mask = (_v: unknown) => "••••";

function webhookUrl(c: any, token: string | null): string | null {
  if (!token) return null;
  const base = config.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  return `${base}/plugin-hooks/${token}`;
}

/**
 * Error text comes from the plugin / upstream and may echo a request or a
 * credential fragment; it reaches editors (who configured the plugin), never
 * the read tier. Viewers still see that a run failed and what it touched.
 */
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

// Write tier and up, the same ladder the query/run routes use — one source of truth.
const canReveal = (c: any) => permissionLevel(c.get("nestPermission")) >= permissionLevel("write");

async function describe(c: any, nestId: string, plugin: NestPlugin, row: NestPluginRow | null) {
  const secrets = secretSettingKeys(plugin);
  const stored = parseJson<Record<string, unknown>>(row?.settings_json, {});
  const present = await readSecrets(nestId, plugin.manifest.name, secrets);
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) if (!secrets.includes(k)) settings[k] = v;
  for (const k of secrets) if (present[k]) settings[k] = mask(present[k]);
  const m = plugin.manifest;
  return {
    name: m.name,
    version: m.version,
    displayName: m.displayName,
    description: m.description,
    capabilities: m.capabilities,
    itemKinds: m.itemKinds,
    settingsSchema: m.settings,
    secretKeys: secrets,
    faces: { pull: !!plugin.pull, webhook: !!plugin.webhook, process: !!plugin.process, search: !!plugin.search, healthcheck: !!plugin.healthcheck },
    configured: !!row,
    enabled: !!row?.enabled,
    mode: row?.mode ?? "raw",
    folder: row?.folder ?? null,
    every_minutes: row?.every_minutes ?? null,
    settings,
    cursor: parseJson<unknown>(row?.cursor_json, null),
    // The token in the URL is the credential: editors (who wire the sender)
    // see it; the read tier sees only that a webhook exists.
    webhook_url: plugin.webhook ? (canReveal(c) ? webhookUrl(c, row?.webhook_token ?? null) : row?.webhook_token ? "(set)" : null) : null,
    // Per-user consent: what to connect, and whether someone has.
    oauth: await connectionInfo(nestId, plugin),
    last_run_at: row?.last_run_at ?? null,
    last_status: row?.last_status ?? null,
    runs: row ? (await recentRuns(nestId, m.name, 10)).map((r) => runToResponse(r, canReveal(c))) : [],
  };
}

export const pluginNestRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/plugins — every loaded plugin, with this nest's config.
pluginNestRoutes.get("/", requirePlugins, async (c) => {
  const nestId = c.req.param("nestId")!;
  const { plugins, errors } = await loadedPlugins();
  const rows = await listRows(nestId);
  const out = [];
  for (const p of plugins.values()) out.push(await describe(c, nestId, p, rows.find((r) => r.plugin === p.manifest.name) ?? null));
  return c.json({ plugins: out, load_errors: errors });
});

// PUT /nests/:nestId/plugins/:name — create or merge this nest's config.
pluginNestRoutes.put("/:name", requirePlugins, async (c) => {
  const nestId = c.req.param("nestId")!;
  const plugin = await requirePlugin(c.req.param("name")!);
  const body = await c.req.json<Record<string, unknown>>().catch(() => {
    throw new ValidationError("Invalid JSON body");
  });
  const by = await resolveCallerEmail(c.get("userId"));

  const patch: Parameters<typeof upsertRow>[2] = {};
  if ("enabled" in body) patch.enabled = !!body.enabled;
  if ("mode" in body) {
    if (body.mode !== "raw" && body.mode !== "summary") throw new ValidationError('mode must be "raw" or "summary"');
    patch.mode = body.mode;
  }
  if ("folder" in body) {
    if (body.folder !== null && typeof body.folder !== "string") throw new ValidationError("folder must be a string or null");
    const f = typeof body.folder === "string" ? trimSlashes(body.folder.trim()) : "";
    if (f.includes("..")) throw new ValidationError('folder must not contain ".."');
    patch.folder = f || null;
  }
  if ("every_minutes" in body) {
    if (body.every_minutes === null || body.every_minutes === 0) patch.every_minutes = null;
    else {
      const n = Number(body.every_minutes);
      if (!Number.isInteger(n) || n < minIntervalMinutes()) throw new ValidationError(`every_minutes must be an integer ≥ ${minIntervalMinutes()} (or null to disable the schedule)`);
      patch.every_minutes = n;
    }
  }

  const secretKeys = secretSettingKeys(plugin);
  if ("settings" in body) {
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) throw new ValidationError("settings must be an object");
    const incoming = body.settings as Record<string, unknown>;
    const declared = new Set([...Object.keys(plugin.manifest.settings.properties ?? {}), ...secretKeys]);
    // The access token is the host's to mint — never a setting anyone stores.
    const unknown = Object.keys(incoming).filter((k) => !declared.has(k) || k === "accessToken");
    if (unknown.length) throw new ValidationError(`unknown setting(s) for ${plugin.manifest.name}: ${unknown.join(", ")}`);
    const plain: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (secretKeys.includes(k)) {
        if (v !== null && typeof v !== "string") throw new ValidationError(`${k} must be a string`);
        // An empty/masked value means "leave the stored secret alone".
        if (v === null) secrets[k] = "";
        else if (v && !/^••••/.test(v)) secrets[k] = v;
      } else plain[k] = v;
    }
    // Let the plugin veto BEFORE anything is written, seeing the merged view.
    if (plugin.validateSettings) {
      const row = await getRow(nestId, plugin.manifest.name);
      const merged = { ...(await resolvedSettings(nestId, plugin, row, { withAccessToken: false })), ...plain, ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)) };
      try {
        await plugin.validateSettings(merged);
      } catch (err) {
        throw new ValidationError(`${plugin.manifest.name}: ${(err as Error).message}`);
      }
    }
    patch.settings = plain;
    if (Object.keys(secrets).length) await putSecrets(nestId, plugin.manifest.name, secrets, by);
  }

  const row = await upsertRow(nestId, plugin, patch, by);
  return c.json({ plugin: await describe(c, nestId, plugin, row) });
});

// GET /nests/:nestId/plugins/:name/health
pluginNestRoutes.get("/:name/health", requirePlugins, async (c) => {
  const nestId = c.req.param("nestId")!;
  const plugin = await requirePlugin(c.req.param("name")!);
  if (!plugin.healthcheck) return c.json({ ok: true, detail: "plugin has no healthcheck" });
  const row = await getRow(nestId, plugin.manifest.name);
  try {
    const r = await plugin.healthcheck({ nestId, settings: await resolvedSettings(nestId, plugin, row), log: () => {}, fetch: globalThis.fetch });
    return c.json(r);
  } catch (err) {
    return c.json({ ok: false, detail: (err as Error).message });
  }
});

// POST /nests/:nestId/plugins/:name/run — run now.
pluginNestRoutes.post("/:name/run", requirePlugins, async (c) => {
  const nestId = c.req.param("nestId")!;
  const by = await resolveCallerEmail(c.get("userId"));
  const run = await runPluginPull(nestId, c.req.param("name")!, `manual:${by}`);
  return c.json({ run });
});

// POST /nests/:nestId/plugins/:name/promote { externalId } — land a live hit.
pluginNestRoutes.post("/:name/promote", requirePlugins, async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{ externalId?: unknown }>().catch(() => ({}) as { externalId?: unknown });
  if (typeof body.externalId !== "string" || !body.externalId) throw new ValidationError("externalId is required");
  const by = await resolveCallerEmail(c.get("userId"));
  const result = await promoteHit(nestId, c.req.param("name")!, body.externalId, by);
  return c.json({ result });
});

// GET /nests/:nestId/plugins/:name/connect — start the consent flow (write tier: the nest middleware
// treats GET as read, so the permission is checked here explicitly).
pluginNestRoutes.get("/:name/connect", requirePlugins, async (c) => {
  if (!canReveal(c)) return c.json({ error: "Only editors can connect an account to this nest" }, 403);
  const nestId = c.req.param("nestId")!;
  const plugin = await requirePlugin(c.req.param("name")!);
  if (!plugin.manifest.oauth) throw new ValidationError(`${plugin.manifest.displayName} does not use a connected account`);
  const email = await resolveCallerEmail(c.get("userId"));
  const url = await beginConnect(nestId, plugin, String(c.get("userId")), email);
  return c.redirect(url, 302);
});

// DELETE /nests/:nestId/plugins/:name/connection — forget the account's tokens.
pluginNestRoutes.delete("/:name/connection", requirePlugins, async (c) => {
  const nestId = c.req.param("nestId")!;
  const plugin = await requirePlugin(c.req.param("name")!);
  await disconnect(nestId, plugin, await resolveCallerEmail(c.get("userId")));
  return c.json({ disconnected: true });
});

// DELETE /nests/:nestId/plugins/:name — forget config + secrets; nodes stay.
pluginNestRoutes.delete("/:name", requirePlugins, async (c) => {
  const nestId = c.req.param("nestId")!;
  const plugin = await requirePlugin(c.req.param("name")!);
  const row = await getRow(nestId, plugin.manifest.name);
  if (!row) throw new NotFoundError("Plugin is not configured on this nest");
  const by = await resolveCallerEmail(c.get("userId"));
  await putSecrets(nestId, plugin.manifest.name, Object.fromEntries(secretSettingKeys(plugin).map((k) => [k, ""])), by);
  // A connected account is a secret too — the refresh token must not outlive the row.
  if (plugin.manifest.oauth) await disconnect(nestId, plugin, by);
  const { getDb } = await import("../db/client.js");
  await getDb().run("DELETE FROM nest_plugins WHERE nest_id = ? AND plugin = ?", [nestId, plugin.manifest.name]);
  return c.json({ deleted: true });
});

/**
 * POST /plugin-hooks/:token — the inbound face. The token is the capability
 * (same model as /hooks/:id); the plugin's webhook() verifies the delivery
 * over the raw body before anything is parsed. Rate-limited per token.
 */
/**
 * GET /auth/plugins/callback — the provider sends the browser back here.
 * Unauthenticated by design (the state row is the credential: single use,
 * ten minutes, bound to the nest/plugin/user that started it). Ends with a
 * redirect to the nest's Plugins tab either way, carrying the outcome.
 */
export const pluginOAuthCallbackRoutes = new Hono();
pluginOAuthCallbackRoutes.get("/callback", requirePlugins, async (c) => {
  const state = c.req.query("state") ?? "";
  const row = state ? await consumeState(state) : null;
  if (!row) return c.json({ error: "This connection link is invalid or has expired. Start again from the nest's Plugins tab." }, 400);
  const back = (params: Record<string, string>) => {
    const u = new URL(`${config.PUBLIC_BASE_URL || new URL(c.req.url).origin}/nest/${row.nest_id}`);
    u.searchParams.set("tab", "plugins");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return c.redirect(u.toString(), 302);
  };
  const err = c.req.query("error");
  if (err) return back({ connect_error: err });
  const code = c.req.query("code");
  if (!code) return back({ connect_error: "no_code" });
  const plugin = await getPlugin(row.plugin);
  if (!plugin) return back({ connect_error: "plugin_not_loaded" });
  try {
    await completeConnect(row, plugin, code);
    return back({ connected: row.plugin });
  } catch (e) {
    console.warn(`[plugins] oauth callback for ${row.plugin} on ${row.nest_id} failed: ${(e as Error).message}`);
    return back({ connect_error: "exchange_failed" });
  }
});

export const pluginHookRoutes = new Hono();
pluginHookRoutes.post("/:token", requirePlugins, async (c) => {
  const token = c.req.param("token")!;
  // Global fence first, so guessing tokens can't grow the bucket map; the
  // per-row bucket is keyed on a row that exists, never on the raw path.
  if (!tryConsume("plugin-hook:*", { windowMs: 60_000, max: 600 })) return c.json({ error: "Too many requests" }, 429);
  const row = await rowByWebhookToken(token);
  if (!row || !row.enabled) return c.json({ error: "Not found" }, 404);
  if (!tryConsume(`plugin-hook:${row.nest_id}:${row.plugin}`, { windowMs: 60_000, max: 120 })) return c.json({ error: "Too many requests" }, 429);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const body = await c.req.text();
  try {
    const out = await runPluginWebhook(row, { headers, body });
    return c.json(out, 202);
  } catch (err) {
    // Verification/parsing failures are the plugin's call; answer 401 without
    // echoing the reason (the signing secret's shape is not a public fact).
    console.warn(`[plugins] webhook for ${row.plugin} on ${row.nest_id} rejected: ${(err as Error).message}`);
    return c.json({ error: "Rejected" }, 401);
  }
});
