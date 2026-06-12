/**
 * Wiki link health — pure, framework-free, unit-testable in the node env.
 *
 * - ORPHANS: docs nothing links to (no inbound wiki links). Only meaningful
 *   once the nest uses wiki links at all — in a nest with zero links every
 *   doc is trivially an orphan, which is noise, not a signal. So orphans are
 *   reported only when at least one wiki link exists nest-wide.
 * - BROKEN: [[targets]] that resolve to no doc in the nest (by id, title,
 *   or bare slug — same resolution as everywhere else).
 *
 * Computed entirely client-side from the node list (content included).
 */
import { extractWikiLinkTargets } from "./backlinks";
import { resolveWikiTarget, type PreviewNode } from "./wiki-preview";

export interface LinkHealth {
  orphans: Array<{ id: string; title: string }>;
  broken: Array<{ sourceId: string; sourceTitle: string; target: string }>;
}

export function linkHealth(nodes: PreviewNode[]): LinkHealth {
  const linkedIds = new Set<string>();
  const broken: LinkHealth["broken"] = [];
  let anyLinks = false;

  for (const node of nodes) {
    for (const target of extractWikiLinkTargets(node.content ?? "")) {
      anyLinks = true;
      const resolved = resolveWikiTarget(nodes, target);
      if (resolved) {
        if (resolved.id !== node.id) linkedIds.add(resolved.id);
      } else {
        broken.push({
          sourceId: node.id,
          sourceTitle: node.title,
          target,
        });
      }
    }
  }

  // No links anywhere → "orphan" is meaningless; report none.
  const orphans = anyLinks
    ? nodes
        .filter((n) => !linkedIds.has(n.id))
        .map((n) => ({ id: n.id, title: n.title }))
    : [];

  return { orphans, broken };
}
