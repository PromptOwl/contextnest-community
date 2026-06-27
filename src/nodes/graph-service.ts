/**
 * Ontology graph assembly — a read-only view over data the nest already holds:
 * nodes, their resolved [[wikilink]] edges, the tags/categories they carry, and
 * the stewardship overlay (who owns which node / tag / nest). No new storage;
 * pure assembly so the UI can render the ontology and surface governance gaps.
 */

import type { ContextNode } from "@promptowl/contextnest-engine";
import { engineCache } from "./engine.js";
import { filterAccessible } from "../governance/access-guard.js";
import { listStewards } from "../governance/stewardship-service.js";
import { normalizeTag } from "../governance/tag-index-service.js";

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphSteward {
  email: string;
  role: string;
  scope: "nest" | "tag" | "document";
  /** tag name (tag scope), node id (document scope), or "*" (nest scope). */
  target: string;
}

export interface GraphTag {
  name: string;
  count: number;
}

export interface NestGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  stewards: GraphSteward[];
  tags: GraphTag[];
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** Extract the raw [[target]] strings (ignoring |display aliases) from a body. */
export function extractWikiTargets(body: string): string[] {
  const out: string[] = [];
  if (!body) return out;
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const t = (m[1] || "").trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * Build the ontology graph for a nest, gated to what the caller can read.
 * Links are de-duplicated, directed, and only kept when both ends resolve to an
 * accessible node (so the view never dangles into hidden/missing targets).
 */
export async function buildNestGraph(
  nestId: string,
  userId: string,
  userEmail: string,
): Promise<NestGraph> {
  const { storage } = engineCache.get(nestId);
  const docs: ContextNode[] = await storage.discoverDocuments();
  const accessible = filterAccessible(nestId, userId, userEmail, docs);

  const idSet = new Set(accessible.map((d) => d.id));
  const titleToId = new Map<string, string>();
  for (const d of accessible) {
    const t = (d.frontmatter?.title || "").toLowerCase().trim();
    if (t) titleToId.set(t, d.id);
  }

  const nodes: GraphNode[] = accessible.map((d) => ({
    id: d.id,
    title: d.frontmatter?.title || d.id,
    type: (d.frontmatter as { type?: string })?.type || "document",
    tags: ((d.frontmatter?.tags as string[]) || []).map(normalizeTag),
  }));

  const links: GraphLink[] = [];
  const seen = new Set<string>();
  for (const d of accessible) {
    for (const raw of extractWikiTargets(d.body || "")) {
      const targetId = idSet.has(raw)
        ? raw
        : titleToId.get(raw.toLowerCase().trim());
      if (!targetId || targetId === d.id) continue;
      const key = `${d.id}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: d.id, target: targetId });
    }
  }

  const tagCounts = new Map<string, number>();
  for (const n of nodes) {
    for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }
  const tags: GraphTag[] = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const stewardRows = await listStewards({ nestId });
  const stewards: GraphSteward[] = stewardRows
    // Drop document-scoped rows whose node the caller can't see.
    .filter((s) => s.scope !== "document" || idSet.has(s.nodePattern || ""))
    .map((s) => ({
      email: s.userEmail,
      role: s.role,
      scope: s.scope,
      target:
        s.scope === "document"
          ? s.nodePattern || ""
          : s.scope === "tag"
            ? normalizeTag(s.tagName || "")
            : "*",
    }));

  return { nodes, links, stewards, tags };
}
