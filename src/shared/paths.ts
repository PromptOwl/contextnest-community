/**
 * Nest storage path resolution — the single source of truth for where a
 * nest's on-disk vault (markdown + version history) lives.
 *
 * By default nests live under `<DATA_ROOT>/nests`, preserving historic
 * behaviour. Setting `NEST_STORAGE_ROOT` points them elsewhere — e.g. at a
 * Cloud Storage (GCS) volume mount on Cloud Run — so nest files can live on
 * object storage while the SQLite DB stays on `DATA_ROOT` (off the mount).
 *
 * Every module that needs a nest's on-disk location must go through here so
 * the root is configured in exactly one place.
 */

import { join } from "path";
import { config } from "../config.js";

/** Root directory holding every nest's vault folder. */
export function nestStorageRoot(): string {
  return config.NEST_STORAGE_ROOT;
}

/** On-disk storage root for a single nest — always `<NEST_STORAGE_ROOT>/<id>`. */
export function resolveNestPath(nestId: string): string {
  return join(nestStorageRoot(), nestId);
}
