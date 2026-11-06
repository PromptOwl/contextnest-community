/**
 * The plugin set this server runs: the `PLUGINS` allowlist, loaded through the
 * engine host's `loadPlugins` (per-spec import + manifest validation; one bad
 * plugin never blocks the rest). Cached until the allowlist changes, so a
 * superadmin edit in /admin/settings takes effect on next use, no restart.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { loadPlugins, type NestPlugin } from "@promptowl/contextnest-engine/plugins";
import { config } from "../config.js";

export interface LoadedPlugins {
  specs: string[];
  plugins: Map<string, NestPlugin>;
  errors: Array<{ spec: string; error: string }>;
}

let cache: Promise<LoadedPlugins> | null = null;
let cachedKey = "";

/** A bare package name resolves from the server's own node_modules; a path is used as-is. */
function resolveSpec(spec: string): string {
  if (spec.startsWith(".") || path.isAbsolute(spec)) return pathToFileURL(path.resolve(spec)).href;
  try {
    return pathToFileURL(createRequire(path.join(process.cwd(), "package.json")).resolve(spec)).href;
  } catch {
    return spec;
  }
}

async function load(specs: string[]): Promise<LoadedPlugins> {
  const { plugins, errors } = await loadPlugins(specs, (s) => import(resolveSpec(s)));
  for (const e of errors) console.warn(`[plugins] refused ${e.spec}: ${e.error}`);
  if (plugins.length) {
    console.log(`[plugins] loaded ${plugins.map((p) => `${p.manifest.name}@${p.manifest.version}`).join(", ")}`);
  }
  return { specs, plugins: new Map(plugins.map((p) => [p.manifest.name, p])), errors };
}

/** The loaded set, (re)loading when the configured specs changed. */
export function loadedPlugins(): Promise<LoadedPlugins> {
  const specs = config.PLUGINS;
  const key = specs.join(",");
  if (!cache || key !== cachedKey) {
    cachedKey = key;
    cache = load(specs);
  }
  return cache;
}

/** Force a reload on the next call (superadmin changed PLUGINS). */
export function invalidatePlugins(): void {
  cache = null;
}

export async function getPlugin(name: string): Promise<NestPlugin | undefined> {
  return (await loadedPlugins()).plugins.get(name);
}
