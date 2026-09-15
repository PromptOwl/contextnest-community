/**
 * Plugin pull scheduler — the tick that turns `every_minutes` on a
 * nest_plugins row into a run. Same shape as the workflow-plane scheduler
 * (interval-based, every row fails independently) but gated by
 * FEATURE_PLUGINS, not the plane. Skips archived nests, plugins that are
 * disabled or have no pull() face, and rows still inside their interval.
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { loadedPlugins } from "./loader.js";
import { runPluginPull, type RunSummary } from "./service.js";
import type { NestPluginRow } from "./registry.js";

function isDue(r: NestPluginRow, now: number): boolean {
  if (!r.every_minutes) return false;
  if (!r.last_run_at) return true;
  const last = Date.parse(r.last_run_at);
  return Number.isNaN(last) || now - last >= r.every_minutes * 60_000;
}

export async function pluginSchedulerTick(now: number = Date.now()): Promise<Array<{ nestId: string; plugin: string; run: RunSummary }>> {
  const db = getDb();
  const rows = (await db.all(
    `SELECT p.* FROM nest_plugins p JOIN nests n ON n.id = p.nest_id
      WHERE p.enabled = 1 AND p.every_minutes IS NOT NULL AND n.archived_at IS NULL`,
  )) as NestPluginRow[];
  const { plugins } = await loadedPlugins();
  const fired: Array<{ nestId: string; plugin: string; run: RunSummary }> = [];
  for (const r of rows.filter((r) => isDue(r, now))) {
    if (!plugins.get(r.plugin)?.pull) continue;
    try {
      const run = await runPluginPull(r.nest_id, r.plugin, "schedule");
      fired.push({ nestId: r.nest_id, plugin: r.plugin, run });
    } catch (err) {
      console.error(`[plugins] scheduled ${r.plugin} on ${r.nest_id} failed`, err);
    }
  }
  return fired;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startPluginScheduler(): void {
  if (!config.FEATURE_PLUGINS || timer) return;
  timer = setInterval(() => {
    void pluginSchedulerTick().catch((err) => console.error("[plugins] scheduler tick failed", err));
  }, 60_000);
  timer.unref?.();
  console.log("[plugins] plugin schedules active (60s tick)");
}

export function stopPluginScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
