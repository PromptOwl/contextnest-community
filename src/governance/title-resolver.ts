/**
 * Title resolver — shared helper for surfacing on-disk document titles
 * to governance APIs. The governance DB stores node ids ("nodes/foo"); the
 * user-facing title lives in the frontmatter on disk. Endpoints that list
 * by node id (review queue, stewards) call this to enrich responses so
 * the UI never has to render the raw storage path.
 */

import { engineCache } from "../nodes/engine.js";

export async function buildTitleMap(
  nestId: string,
): Promise<Map<string, string>> {
  try {
    const { storage } = engineCache.get(nestId);
    const docs = await storage.discoverDocuments();
    return new Map(docs.map((d) => [d.id, d.frontmatter.title as string]));
  } catch {
    return new Map();
  }
}
