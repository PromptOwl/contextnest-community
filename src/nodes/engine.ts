import {
  NestStorage,
  GraphQueryEngine,
  VersionManager,
} from "@promptowl/contextnest-engine";
import { createEngineApi } from "@promptowl/contextnest-engine/api";
import type { OperationContext } from "@promptowl/contextnest-engine/api";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { resolveNestPath, isImportedNest } from "../nests/service.js";
import { FlatNestStorage } from "./flat-storage.js";

/**
 * How long a nest's discovered-document set stays cached, in ms.
 *
 * Discovery reads and parses every markdown file in the nest. That is cheap on
 * a disk and expensive on a Cloud Storage mount, where it costs one network
 * round trip per document — repeated for every listing, search, and graph
 * query, since neither the engine nor `context_list` memoizes it (`full` only
 * changes what is returned; the reads already happened).
 *
 * The price is staleness: a write from a DIFFERENT server instance stays
 * invisible here until the entry expires, so this also bounds how far two
 * instances behind one load balancer can disagree. Writes made through this
 * process evict on the spot. Matches the UI's read-cache TTL in
 * `ui/src/lib/api.ts`, so both layers go stale on the same clock.
 */
const DISCOVERY_TTL_MS = 30_000;

/** Storage methods that can change which documents discovery would return. */
const DOCUMENT_WRITERS = [
  "writeDocument",
  "deleteDocument",
  "writeVaultFile",
  "init",
] as const;

/**
 * Memoize `discoverDocuments` on one storage instance and drop the entry
 * whenever this process writes a document.
 *
 * Wraps the instance rather than subclassing it so discovery semantics stay
 * owned by the engine (see the engine boundary in CLAUDE.md), and so the
 * GraphQueryEngine and VersionManager built on the same instance read through
 * the same cache instead of each re-crawling the nest.
 *
 * Entries are keyed by `includeRetired` rather than filtered down from one
 * superset: what counts as retired is the engine's call, not ours.
 */
function withDiscoveryCache<S extends NestStorage>(
  storage: S,
): { storage: S; invalidate: () => void } {
  const entries = new Map<string, { docs: ContextNode[]; ts: number }>();
  const discover = storage.discoverDocuments.bind(storage);
  // Bumped on every write so a crawl already in flight when one lands knows its
  // result predates the write and must not be cached (the same generation guard
  // the UI read cache uses).
  let generation = 0;

  storage.discoverDocuments = async (options = {}) => {
    const key =
      options.includeRetired || options.includeSuperseded ? "all" : "live";
    const hit = entries.get(key);
    if (hit && Date.now() - hit.ts < DISCOVERY_TTL_MS) return hit.docs;
    const startedAt = generation;
    const docs = await discover(options);
    if (generation === startedAt) entries.set(key, { docs, ts: Date.now() });
    return docs;
  };

  const invalidate = () => {
    generation++;
    entries.clear();
  };

  // Version keyframes, diffs, suggestions and INDEX/CONTEXT files all live in
  // paths discovery already excludes, so only these four can invalidate it.
  for (const name of DOCUMENT_WRITERS) {
    const write = (storage[name] as (...a: any[]) => Promise<unknown>).bind(storage);
    (storage as any)[name] = async (...args: unknown[]) => {
      try {
        return await write(...args);
      } finally {
        // After the write, not before: clearing first leaves a window where a
        // concurrent read repopulates the entry with pre-write content.
        // `finally` so a write that threw part-way still drops the stale set.
        invalidate();
      }
    };
  }
  return { storage, invalidate };
}

interface NestEngine {
  storage: NestStorage;
  query: GraphQueryEngine;
  // Engine-native version tracker. Writes .versions/{docName}/history.yaml
  // and keyframe v{N}.md files alongside the on-disk node, so version
  // content lives in the nest folder rather than the SQLite governance
  // DB. Used by routes/mcp on every edit + by LLM reads to fetch the
  // approved version's body via reconstructVersion().
  versions: VersionManager;
  /**
   * Drop this nest's cached document set. For the callers that reconcile
   * against what is actually on disk — import registration and the drift
   * scanner — where a write this process never saw is exactly the thing being
   * looked for, so a cached view would hide it.
   */
  invalidateDiscovery: () => void;
}

class NestEngineCache {
  private cache = new Map<string, NestEngine>();

  async get(nestId: string): Promise<NestEngine> {
    let engine = this.cache.get(nestId);
    if (!engine) {
      const nestPath = resolveNestPath(nestId);
      // Imported nests discover markdown anywhere in the copied folder;
      // default nests keep the engine's structured (nodes/) layout.
      const { storage, invalidate } = withDiscoveryCache(
        (await isImportedNest(nestId))
          ? new FlatNestStorage(nestPath)
          : new NestStorage(nestPath),
      );
      const query = new GraphQueryEngine(storage as any);
      const versions = new VersionManager(storage);
      engine = { storage, query, versions, invalidateDiscovery: invalidate };
      this.cache.set(nestId, engine);
    }
    return engine;
  }

  evict(nestId: string): void {
    this.cache.delete(nestId);
  }
}

export const engineCache = new NestEngineCache();

/**
 * The engine's canonical operation catalog (`context_*`). Prefer running an
 * operation through this over re-implementing it against engine primitives —
 * it is the same catalog the OSS CLI and mcp-server execute, so all three
 * surfaces stay on one contract (see docs/prds/api-convergence.md).
 */
export const engineApi = createEngineApi();

/**
 * Build an OperationContext for one nest. `onProgress` is the engine's
 * transport-agnostic progress sink — supply it for long batch operations
 * (import/publish) to drive a progress stream; omit it and the operation runs
 * identically.
 */
export async function opContext(
  nestId: string,
  actor: string,
  onProgress?: (done: number, total: number) => void,
): Promise<OperationContext> {
  const { storage, query, versions } = await engineCache.get(nestId);
  return { storage, query, versions, actor, onProgress };
}
