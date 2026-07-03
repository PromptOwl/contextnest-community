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
    const { storage } = await engineCache.get(nestId);
    const docs = await storage.discoverDocuments();
    return new Map(docs.map((d) => [d.id, d.frontmatter.title as string]));
  } catch {
    return new Map();
  }
}

/**
 * The folder a node lives in, derived from its id. Node ids are
 * "nodes/<folder segments…>/<slug>" (see nodes/service.ts). Returns the
 * folder path ("Marketing/API"), or "" for a root-level document.
 */
export function folderForNode(nodeId: string): string {
  return nodeId
    .replace(/^nodes\//, "")
    .split("/")
    .slice(0, -1)
    .join("/");
}

/**
 * Human-facing label for a node in a notification: its document title (from
 * frontmatter) plus the folder it lives under, so a reviewer sees "API limits
 * (in Marketing/API)" rather than the raw "nodes/marketing/api/xyz" path.
 * Falls back to the node id if the title can't be resolved.
 */
export async function describeNode(
  nestId: string,
  nodeId: string,
): Promise<string> {
  const titles = await buildTitleMap(nestId);
  const title = titles.get(nodeId) || nodeId;
  const folder = folderForNode(nodeId);
  return folder ? `${title} (in ${folder})` : title;
}
