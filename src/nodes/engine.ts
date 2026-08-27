import {
  NestStorage,
  GraphQueryEngine,
  VersionManager,
  DocumentNotFoundError,
} from "@promptowl/contextnest-engine";
import { createEngineApi } from "@promptowl/contextnest-engine/api";
import type { OperationContext } from "@promptowl/contextnest-engine/api";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { resolveNestPath, isImportedNest } from "../nests/service.js";
import { FlatNestStorage } from "./flat-storage.js";
import { syncIndexedNode, markIndexStale } from "./node-index.js";

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
 *
 * An expired entry is served, not awaited: the refresh runs behind the request
 * (see withDiscoveryCache), so the age bound above is really TTL + one crawl.
 */
const DISCOVERY_TTL_MS = 30_000;

/** The engine's own end-of-crawl filter for the default (non-retired) set. */
const isLive = (node: ContextNode) => node.frontmatter.status !== "rejected";

/**
 * Vault files discovery already ignores. Writing one cannot change which
 * documents come back, so it must not cost the next reader a re-crawl —
 * `regenerateIndex` writes several of them after every single mutation.
 */
const DERIVED_VAULT_FILES = new Set([
  "INDEX.md",
  "CONTEXT.md",
  "CLAUDE.md",
  "GEMINI.md",
  "AGENTS.md",
  "README.md",
]);

/**
 * Memoize `discoverDocuments` on one storage instance and keep it in step with
 * the documents this process writes.
 *
 * Wraps the instance rather than subclassing it so discovery semantics stay
 * owned by the engine (see the engine boundary in CLAUDE.md), and so the
 * GraphQueryEngine and VersionManager built on the same instance read through
 * the same cache instead of each re-crawling the nest.
 *
 * Both keys ("all" and "live") come from one crawl: the engine reads every
 * document and applies the retired filter only at the end, so a second pass
 * would re-read the whole nest to throw the same rows away.
 */
function withDiscoveryCache<S extends NestStorage>(
  nestId: string,
  storage: S,
): { storage: S; invalidate: () => void; desync: () => void } {
  const entries = new Map<string, { docs: ContextNode[]; ts: number }>();
  // The crawl in flight, if any. Cross-nest search fans out over every nest at
  // once and the palette fires a query per keystroke, so without this the same
  // cold nest gets crawled several times over, concurrently. One entry, not one
  // per key, because a crawl produces both sets.
  let inflight: Promise<{ all: ContextNode[]; live: ContextNode[] }> | null =
    null;
  const discover = storage.discoverDocuments.bind(storage);
  const readDoc = storage.readDocument.bind(storage);
  // FlatNestStorage discovers an imported folder wholesale and honours no
  // options, so for it the two key sets are the same crawl and must not be
  // filtered down. Only the engine's own storage retires anything.
  const filtersRetired = !(storage instanceof FlatNestStorage);
  // Bumped on every write so a crawl already in flight when one lands knows its
  // result predates the write and must not be cached (the same generation guard
  // the UI read cache uses).
  let generation = 0;

  /**
   * Crawl once, fill both keys. The engine reads every document and only then
   * drops the retired ones, so the superset is the same work and "live" is a
   * filter over it — a write path asks for both, back to back.
   */
  const crawl = (
    options: Parameters<typeof discover>[0],
  ): Promise<{ all: ContextNode[]; live: ContextNode[] }> => {
    if (inflight) return inflight;
    const startedAt = generation;
    const run = discover({ ...options, includeRetired: true })
      .then((crawled) => {
        const sets = {
          all: crawled,
          live: filtersRetired ? crawled.filter(isLive) : crawled,
        };
        if (generation === startedAt) {
          const ts = Date.now();
          entries.set("all", { docs: sets.all, ts });
          entries.set("live", { docs: sets.live, ts });
        }
        return sets;
      })
      .finally(() => {
        if (inflight === run) inflight = null;
      });
    inflight = run;
    return run;
  };

  storage.discoverDocuments = async (options = {}) => {
    const key: "all" | "live" =
      options.includeRetired || options.includeSuperseded ? "all" : "live";
    // A folder-scoped crawl describes ONE directory, and both the entries and
    // the in-flight promise are keyed only by retired-ness. Caching it would
    // publish that one folder as the nest-wide set — and joining an in-flight
    // scoped crawl would hand the same partial answer to an unscoped caller.
    // Scoped crawls are narrow by definition, so they simply run uncached.
    if (options.folder !== undefined) {
      const crawled = await discover({ ...options, includeRetired: true });
      return key === "all" || !filtersRetired ? crawled : crawled.filter(isLive);
    }
    const hit = entries.get(key);
    if (hit) {
      // Stale-while-revalidate. The crawl parses every file in the nest, so
      // waiting for a fresh one put the caller behind a multi-second walk every
      // time the entry aged out — the cross-nest search paid it per nest, for
      // any query not repeated inside the TTL. Serve what we have and refresh
      // behind the request: the set is at most one crawl older than the strict
      // version, and a write through this process still reconciles on the spot.
      if (Date.now() - hit.ts >= DISCOVERY_TTL_MS) {
        void crawl(options).catch((err) => {
          // A failed refresh keeps the previous set and the next read retries,
          // so reads keep succeeding — which is exactly why this is logged: a
          // wedged storage mount would otherwise stay invisible behind a cache
          // that never stops serving.
          console.error("[discovery] background refresh failed", err);
        });
      }
      return hit.docs;
    }
    return (await crawl(options))[key];
  };

  const invalidate = () => {
    generation++;
    entries.clear();
    // Drop the in-flight crawl too, or a read arriving after the write joins
    // one that started before it and gets pre-write content.
    inflight = null;
  };

  /**
   * Drop the in-memory set AND flag the nest's DB mirror for a rebuild.
   *
   * Used wherever we no longer know that either view matches disk — a write we
   * could not fold in, a vault file that might be a document, an out-of-band
   * edit. The DB mirror outlives this process, so unlike `invalidate` it has to
   * be told; the next read rebuilds it from disk before answering.
   */
  const desync = async (): Promise<void> => {
    invalidate();
    await markIndexStale(nestId);
  };

  /**
   * Fold one written or deleted document into the cached sets instead of
   * dropping them. Clearing made every write cost the next reader a full crawl
   * — one MCP create pays three of those, and on a Cloud Storage mount a crawl
   * is one network round trip per document (CU: nest writes time out at 500+).
   * Entry timestamps are left alone, so the TTL still bounds how stale a set
   * can get relative to another instance.
   */
  const patch = async (id: string): Promise<void> => {
    // Same guard as invalidate(): a crawl already in flight predates this
    // write, so its result must neither be cached nor handed to a reader that
    // joins it after the fact.
    generation++;
    inflight = null;
    let node: ContextNode | null = null;
    try {
      node = await readDoc(id);
    } catch (err) {
      // Only a MISSING document means it left the set. Any other failure —
      // a transient read on a network mount, right after the write — would
      // otherwise drop a document we just wrote until the TTL expires, so
      // re-crawl rather than cache a set we know might be wrong.
      if (!(err instanceof DocumentNotFoundError)) {
        await desync();
        return;
      }
      node = null;
    }
    // Mirror the same fact into the DB index: `node` is the document as it now
    // stands on disk, or null when the write removed it.
    await syncIndexedNode(nestId, id, node);
    for (const [key, entry] of entries) {
      const docs = entry.docs.filter((d) => d.id !== id);
      // "all" keeps everything; "live" drops rejected documents, matching the
      // filter the engine applies at the end of its own crawl.
      if (node && (key === "all" || isLive(node))) {
        // Discovery returns documents id-sorted; splice in at that position.
        const at = docs.findIndex((d) => d.id > id);
        docs.splice(at === -1 ? docs.length : at, 0, node);
      }
      entry.docs = docs;
    }
  };

  /** Run `after` once the wrapped write has settled; any failure there falls
   *  back to dropping the cache rather than leaving a wrong set in place. */
  const wrap = (
    name: "writeDocument" | "deleteDocument" | "writeVaultFile" | "init",
    after: (args: unknown[]) => void | Promise<void>,
  ) => {
    const write = (storage[name] as (...a: any[]) => Promise<unknown>).bind(storage);
    (storage as any)[name] = async (...args: unknown[]) => {
      try {
        return await write(...args);
      } finally {
        // After the write, not before: patching first leaves a window where a
        // concurrent read repopulates the entry with pre-write content.
        // `finally` so a write that threw part-way still reconciles the set.
        try {
          await after(args);
        } catch {
          await desync();
        }
      }
    };
  };

  wrap("writeDocument", (args) => patch(String(args[0])));
  wrap("deleteDocument", (args) => patch(String(args[0])));
  wrap("init", () => desync());
  wrap("writeVaultFile", (args) => {
    // Derived files (INDEX.md, context.yaml, agent configs) are outside
    // discovery; anything else written through this path could be a document.
    const rel = String(args[0] ?? "");
    const base = rel.split(/[/\\]/).pop() || "";
    if (rel.endsWith(".md") && !DERIVED_VAULT_FILES.has(base)) return desync();
  });

  // Two invalidators, deliberately. `invalidate` (memory only) is what a
  // rebuild of the DB mirror uses — it needs a fresh crawl but must not mark
  // the nest stale again, or it would undo the stamp it is about to write.
  // `desync` is for callers who mean "disk may have moved under us".
  return { storage, invalidate, desync: () => void desync() };
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
   * Drop this nest's cached document set AND flag its DB index for a rebuild.
   * For the callers that reconcile against what is actually on disk — import
   * registration and the drift scanner — where a write this process never saw
   * is exactly the thing being looked for, so neither a cached view nor a
   * mirror built before that write may answer.
   */
  invalidateDiscovery: () => void;
  /**
   * Drop the cached document set only, leaving the DB index's freshness stamp
   * alone. For the index rebuild itself: it must crawl disk rather than a
   * memoized set, but flagging the nest stale here would undo the stamp the
   * rebuild is about to write.
   */
  dropDiscoveryCache: () => void;
}

class NestEngineCache {
  private cache = new Map<string, NestEngine>();

  async get(nestId: string): Promise<NestEngine> {
    let engine = this.cache.get(nestId);
    if (!engine) {
      const nestPath = resolveNestPath(nestId);
      // Imported nests discover markdown anywhere in the copied folder;
      // default nests keep the engine's structured (nodes/) layout.
      const { storage, invalidate, desync } = withDiscoveryCache(
        nestId,
        (await isImportedNest(nestId))
          ? new FlatNestStorage(nestPath)
          : new NestStorage(nestPath),
      );
      const query = new GraphQueryEngine(storage as any);
      const versions = new VersionManager(storage);
      engine = {
        storage,
        query,
        versions,
        invalidateDiscovery: desync,
        dropDiscoveryCache: invalidate,
      };
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
