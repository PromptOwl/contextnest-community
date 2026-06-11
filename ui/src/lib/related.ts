/**
 * Related documents — pure, framework-free so it's unit-testable in the node
 * test env. Computed client-side from the loaded node list; no server changes.
 *
 * Relatedness is a cheap content-free signal: shared tags weigh most, shared
 * outgoing wiki-link targets add a smaller boost. It deliberately ignores body
 * text so it stays O(n) over the list and needs no index.
 */

import { extractWikiLinkTargets } from "./backlinks";

export interface RelatableNode {
  id: string;
  title: string;
  tags?: string[];
  content?: string;
}

export interface RelatedDoc {
  id: string;
  title: string;
  score: number;
  sharedTags: string[];
}

function normTag(t: string): string {
  return t.replace(/^#/, "").toLowerCase();
}

const TAG_WEIGHT = 2;
const LINK_WEIGHT = 1;

/**
 * Top `limit` docs related to `target`, scored by shared tags (TAG_WEIGHT each)
 * plus shared outgoing wiki-link targets (LINK_WEIGHT each). Docs with no
 * overlap are dropped. Ties break by title for stable ordering.
 */
export function relatedDocs(
  target: RelatableNode,
  nodes: RelatableNode[],
  limit = 5,
): RelatedDoc[] {
  const targetId = target.id.toLowerCase();
  const targetTags = new Set((target.tags ?? []).map(normTag));
  const targetLinks = new Set(
    extractWikiLinkTargets(target.content ?? "").map((t) => t.toLowerCase()),
  );

  const out: RelatedDoc[] = [];
  for (const node of nodes) {
    if (node.id.toLowerCase() === targetId) continue;

    const shared: string[] = [];
    for (const tag of node.tags ?? []) {
      if (targetTags.has(normTag(tag))) shared.push(tag);
    }
    let linkOverlap = 0;
    for (const t of extractWikiLinkTargets(node.content ?? "")) {
      if (targetLinks.has(t.toLowerCase())) linkOverlap++;
    }

    const score = shared.length * TAG_WEIGHT + linkOverlap * LINK_WEIGHT;
    if (score > 0) {
      out.push({ id: node.id, title: node.title, score, sharedTags: shared });
    }
  }

  return out
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
