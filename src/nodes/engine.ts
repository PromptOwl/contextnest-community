import { join } from "path";
import { NestStorage, GraphQueryEngine } from "@promptowl/contextnest-engine";
import { config } from "../config.js";

interface NestEngine {
  storage: NestStorage;
  query: GraphQueryEngine;
}

class NestEngineCache {
  private cache = new Map<string, NestEngine>();

  get(nestId: string): NestEngine {
    let engine = this.cache.get(nestId);
    if (!engine) {
      const nestPath = join(config.DATA_ROOT, "nests", nestId);
      const storage = new NestStorage(nestPath);
      const query = new GraphQueryEngine(storage as any);
      engine = { storage, query };
      this.cache.set(nestId, engine);
    }
    return engine;
  }

  evict(nestId: string): void {
    this.cache.delete(nestId);
  }
}

export const engineCache = new NestEngineCache();
