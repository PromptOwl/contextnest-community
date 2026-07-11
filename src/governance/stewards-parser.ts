/**
 * stewards.yaml loading — thin filesystem wrapper over the engine's canonical
 * parser.
 *
 * The FORMAT (parse/serialize) now lives in the engine (`parseStewards`), so
 * the community server, the CLI and TheOwl share ONE implementation instead of
 * each porting their own (this file used to be a hand-rolled port of TheOwl's
 * `deserializeStewards`). Only the vault-layout concern stays here: which paths
 * to check for a given nest. Seam #1 of the engine↔community separation.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseStewards, STEWARDS_FILENAMES } from "@promptowl/contextnest-engine";
import { resolveNestPath } from "../shared/paths.js";
import type { StewardsConfig } from "./types.js";

// Back-compat: `parseStewardsYaml` was the local name; the canonical parser now
// lives in the engine. Re-export under the old name so existing importers keep
// working.
export { parseStewards as parseStewardsYaml } from "@promptowl/contextnest-engine";

/**
 * Load stewards.yaml from a nest's vault directory. Returns null if absent.
 * Lookup locations + precedence come from the engine's STEWARDS_FILENAMES.
 */
export function loadStewardsConfig(nestId: string): StewardsConfig | null {
  const nestPath = resolveNestPath(nestId);
  for (const name of STEWARDS_FILENAMES) {
    const candidate = join(nestPath, name);
    if (existsSync(candidate)) {
      return parseStewards(readFileSync(candidate, "utf-8"));
    }
  }
  return null;
}

/** Check if a nest has stewardship configured. */
export function hasStweardshipConfig(nestId: string): boolean {
  return loadStewardsConfig(nestId) !== null;
}
