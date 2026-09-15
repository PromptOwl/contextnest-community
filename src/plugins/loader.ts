/**
 * Server-level plugin set. Loaded once from `PLUGINS` (an explicit allowlist
 * of package names / module paths — never a directory scan), cached, and
 * reloadable when the superadmin edits the setting. One bad package is
 * reported, not fatal: the operator sees exactly what was refused on the
 * Settings page while the rest keep working.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { loadPlugins } from "@promptowl/contextnest-engine/plugins";
import type { NestPlugin } from "@promptowl/contextnest-plugin-sdk";
import { config } from "../config.js";

interface Loaded {
  specs: string[];
  plugins: Map<string, NestPlugin>;
  errors: Array<{ spec: string; error: string }>;
}

let cache: Promise<Loaded> | null = null;

/** A bare package name resolves from the server's own node_modules; a path is used as-is. */
function resolveSpec(spec: string): string {
  if (spec.startsWith(".") || path.isAbsolute(spec)) return pathToFileURL(path.resolve(spec)).href;
  try {
    return pathToFileURL(createRequire(path.join(process.cwd(), "package.json")).resolve(spec)).href;
  } catch {
    return spec;
  }
}

async function load(specs: string[]): Promise<Loaded> {
  const { plugins, errors } = await loadPlugins(specs, (s) => import(resolveSpec(s)));
  for (const e of errors) console.warn(`[plugins] refused ${e.spec}: ${e.error}`);
  if (plugins.length) console.log(`[plugins] loaded ${plugins.map((p) => `${p.manifest.name}@${p.manifest.version}`).join(", ")}`);
  return { specs, plugins: new Map(plugins.map((p) => [p.manifest.name, p])), errors };
}

/** The loaded set, (re)loading when the configured specs changed. */
export async function loadedPlugins(): Promise<Loaded> {
  const specs = config.PLUGINS;
  if (cache) {
    const cur = await cache;
    if (cur.specs.join(",") === specs.join(",")) return cur;
  }
  cache = load(specs);
  return cache;
}

/** Force a reload on the next call (superadmin changed PLUGINS). */
export function invalidatePlugins(): void {
  cache = null;
}

export async function getPlugin(name: string): Promise<NestPlugin | undefined> {
  return (await loadedPlugins()).plugins.get(name);
}
