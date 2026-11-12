/**
 * The document stream for one caller (CU-wdqcq02crv, po-1214) — the one path
 * both GET /me/stream and the MCP tool `context_stream` read through, so an
 * agent gets exactly the feed a person sees: the same nests, the same access
 * filter, the same attribution.
 */
import { engineCache } from "../nodes/engine.js";
import { parseVersionRaw } from "../nodes/service.js";
import { listVisibleNests } from "../nests/service.js";
import { getDocStream, type StreamFilters, type StreamPage } from "./stream-service.js";

const unreadableWarned = new Set<string>();

/** One version's body and frontmatter for its summary; null when the chain
 *  cannot produce it. */
export async function readStreamVersion(
  nestId: string,
  nodeId: string,
  version: number,
): Promise<{ body: string; frontmatter?: Record<string, unknown> } | null> {
  const { storage, versions } = await engineCache.get(nestId);
  try {
    return parseVersionRaw(nodeId, await versions.reconstructVersion(nodeId, version));
  } catch {
    // The unreviewed draft on top is never in the chain — its bytes are
    // the live file (same fallback as GET …/versions/:version).
    const node = await storage.readDocument(nodeId);
    if ((node.frontmatter.version ?? 1) === version) {
      return { body: node.body ?? "", frontmatter: node.frontmatter as unknown as Record<string, unknown> };
    }
    // Neither the chain nor the live file has this version: a broken
    // chain. The post shows no summary; say so once per document.
    const key = `${nestId}:${nodeId}`;
    if (!unreadableWarned.has(key)) {
      // Bounded: a long-lived server forgets old ones rather than grow.
      if (unreadableWarned.size >= 1000) unreadableWarned.clear();
      unreadableWarned.add(key);
      console.warn(`[me/stream] version body unreadable: ${key}@${version}`);
    }
    return null;
  }
}

/**
 * The caller's stream over every nest they can read — or, with `onlyNest`,
 * over that one nest when they can read it (an unreadable one yields an empty
 * page, never an error that would confirm it exists).
 */
export async function streamForCaller(opts: {
  userId: string;
  userEmail: string;
  filters?: StreamFilters;
  limit?: number;
  offset?: number;
  facets?: boolean;
  onlyNest?: string;
}): Promise<StreamPage> {
  const nests = new Map<string, string>();
  for (const n of await listVisibleNests(opts.userId, { readable: true })) {
    if (!opts.onlyNest || n.id === opts.onlyNest) nests.set(n.id, n.name ?? n.id);
  }
  return getDocStream({
    userId: opts.userId,
    userEmail: opts.userEmail,
    nests,
    filters: opts.filters,
    limit: opts.limit,
    offset: opts.offset,
    facets: opts.facets,
    readVersion: readStreamVersion,
  });
}
