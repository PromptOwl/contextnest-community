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
  storage: S,
): { storage: S; invalidate: () => void } {
  const entries = new Map<string, { docs: ContextNode[]; ts: number }>();
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

  storage.discoverDocuments = async (options = {}) => {
    const key =
      options.includeRetired || options.includeSuperseded ? "all" : "live";
    const hit = entries.get(key);
    if (hit && Date.now() - hit.ts < DISCOVERY_TTL_MS) return hit.docs;
    // One crawl fills both keys: the engine reads every document and only then
    // drops the retired ones, so the superset is the same work and "live" is a
    // filter over it. A write path asks for both, back to back.
    const all = entries.get("all");
    if (all && Date.now() - all.ts < DISCOVERY_TTL_MS) {
      const docs = filtersRetired ? all.docs.filter(isLive) : all.docs;
      entries.set("live", { docs, ts: all.ts });
      return docs;
    }
    const startedAt = generation;
    const crawled = await discover({ ...options, includeRetired: true });
    const docs = key === "all" || !filtersRetired ? crawled : crawled.filter(isLive);
    if (generation === startedAt) {
      const ts = Date.now();
      entries.set("all", { docs: crawled, ts });
      entries.set(key, { docs, ts });
    }
    return docs;
  };

  const invalidate = () => {
    generation++;
    entries.clear();
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
    // Same guard as invalidate(): a crawl already in flight predates this write.
    generation++;
    let node: ContextNode | null = null;
    try {
      node = await readDoc(id);
    } catch (err) {
      // Only a MISSING document means it left the set. Any other failure —
      // a transient read on a network mount, right after the write — would
      // otherwise drop a document we just wrote until the TTL expires, so
      // re-crawl rather than cache a set we know might be wrong.
      if (!(err instanceof DocumentNotFoundError)) {
        invalidate();
        return;
      }
      node = null;
    }
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
          invalidate();
        }
      }
    };
  };

  wrap("writeDocument", (args) => patch(String(args[0])));
  wrap("deleteDocument", (args) => patch(String(args[0])));
  wrap("init", () => invalidate());
  wrap("writeVaultFile", (args) => {
    // Derived files (INDEX.md, context.yaml, agent configs) are outside
    // discovery; anything else written through this path could be a document.
    const rel = String(args[0] ?? "");
    const base = rel.split(/[/\\]/).pop() || "";
    if (rel.endsWith(".md") && !DERIVED_VAULT_FILES.has(base)) invalidate();
  });

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
