import { join } from "path";
import {
  NestStorage,
  GraphQueryEngine,
  VersionManager,
} from "@promptowl/contextnest-engine";
import { config } from "../config.js";

interface NestEngine {
  storage: NestStorage;
  query: GraphQueryEngine;
  // Engine-native version tracker. Writes .versions/{docName}/history.yaml
  // and keyframe v{N}.md files alongside the on-disk node, so version
  // content lives in the nest folder rather than the SQLite governance
  // DB. Used by routes/mcp on every edit + by LLM reads to fetch the
  // approved version's body via reconstructVersion().
  versions: VersionManager;
}

class NestEngineCache {
  private cache = new Map<string, NestEngine>();

  get(nestId: string): NestEngine {
    let engine = this.cache.get(nestId);
    if (!engine) {
      const nestPath = join(config.DATA_ROOT, "nests", nestId);
      const storage = new NestStorage(nestPath);
      const query = new GraphQueryEngine(storage as any);
      const versions = new VersionManager(storage);
      engine = { storage, query, versions };
      this.cache.set(nestId, engine);
    }
    return engine;
  }

  evict(nestId: string): void {
    this.cache.delete(nestId);
  }
}

export const engineCache = new NestEngineCache();
