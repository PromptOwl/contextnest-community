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

/** Broken documents warned about per nest before one summary line. */
export const UNREADABLE_WARN_PER_NEST = 50;
/** Nests remembered; the least recently seen is forgotten first. */
export const UNREADABLE_WARN_NESTS = 200;
const unreadableWarned = new Map<string, { docs: Set<string>; capped: boolean }>();

/**
 * The line to log for a version whose body cannot be read, or null when this
 * document (or, past the per-nest cap, this nest) was already reported. Every
 * page load reads the same versions, so a broken nest would otherwise log on
 * every load. Bounded per nest and across nests (LRU), so a large broken nest
 * logs at most UNREADABLE_WARN_PER_NEST + 1 lines rather than starting over
 * when a global set is cleared.
 */
export function unreadableWarning(nestId: string, nodeId: string, version: number): string | null {
  let seen = unreadableWarned.get(nestId);
  if (seen) {
    unreadableWarned.delete(nestId); // Map order is insertion order: re-insert = most recent.
  } else {
    seen = { docs: new Set(), capped: false };
    if (unreadableWarned.size >= UNREADABLE_WARN_NESTS) {
      // The map is non-empty here (size >= the cap), so the first key exists:
      // it is the least recently seen nest.
      unreadableWarned.delete(unreadableWarned.keys().next().value as string);
    }
  }
  unreadableWarned.set(nestId, seen);
  if (seen.capped || seen.docs.has(nodeId)) return null;
  if (seen.docs.size >= UNREADABLE_WARN_PER_NEST) {
    seen.capped = true;
    return `[me/stream] more unreadable version bodies in nest ${nestId}; not warning about each one`;
  }
  seen.docs.add(nodeId);
  return `[me/stream] version body unreadable: ${nestId}:${nodeId}@${version}`;
}

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
    // A missing live file is the same broken chain: warn below, not silently.
    const node = await storage.readDocument(nodeId).catch(() => null);
    if (node && (node.frontmatter.version ?? 1) === version) {
      return { body: node.body ?? "", frontmatter: node.frontmatter as unknown as Record<string, unknown> };
    }
    // Neither the chain nor the live file has this version: a broken
    // chain. The post shows no summary; say so once per document.
    const warning = unreadableWarning(nestId, nodeId, version);
    if (warning) console.warn(warning);
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
  items?: boolean;
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
    items: opts.items,
    readVersion: readStreamVersion,
  });
}
