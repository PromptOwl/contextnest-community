/**
 * Ontology graph assembly — a read-only view over data the nest already holds:
 * nodes, edges resolved from [[wikilinks]] and shared tags, the tags/categories
 * they carry, and the stewardship overlay (who owns which node / tag / nest).
 * No new storage; pure assembly so the UI can render the ontology and surface
 * governance gaps.
 */

import { extractContextLinks, type ContextNode } from "@promptowl/contextnest-engine";
import { engineCache } from "./engine.js";
import { isDerivedAnnotationsNode } from "./service.js";
import { filterAccessible } from "../governance/access-guard.js";
import { listStewards } from "../governance/stewardship-service.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { isPublicReader } from "../shared/access.js";

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
  /** Stable identity key — the email for privileged callers, an opaque
   *  "s1"/"s2"… token for sub-write callers (see buildNestGraph). */
  id: string;
  /** Display name — the email for privileged callers, "Steward N" otherwise. */
  label: string;
  role: string;
  scope: "nest" | "tag" | "document";
  /** tag name (tag scope), node id (document scope), or "*" (nest scope). */
  target: string;
}

export interface GraphStewardEdge {
  /** GraphSteward.id this edge originates from. */
  steward: string;
  /** `tag:<name>` (tag scope), node id (document scope), or "*" (nest scope). */
  target: string;
  scope: "nest" | "tag" | "document";
}

export interface GraphTag {
  name: string;
  count: number;
}

/**
 * Governance gaps — the headline of the view. Computed server-side over the
 * FULL node/steward set so the numbers stay accurate even when the drawn graph
 * is truncated for the hairball cap.
 */
export interface GraphSignals {
  /** Nodes with no inbound/outbound [[wikilink]] and no shared tag with
   *  another node. */
  orphans: GraphNode[];
  /** Categories no tag-scope steward owns (a nest-wide steward does NOT
   *  count — that's the over-centralised case we want to surface, not hide). */
  unstewardedTags: GraphTag[];
  /** Stewards covering ≥50% of nodes, by distinct-doc share. */
  bottlenecks: Array<{ steward: string; label: string; share: number }>;
}

export interface NestGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  stewards: GraphSteward[];
  stewardEdges: GraphStewardEdge[];
  tags: GraphTag[];
  signals: GraphSignals;
  /** True when doc nodes exceeded MAX_GRAPH_NODES and the drawn set was capped.
   *  signals are still computed over the full set. */
  truncated: boolean;
  /** Total accessible doc count before any draw-cap. */
  totalNodes: number;
}

/** Force graphs hairball past ~100 nodes (ticket discipline). Cap the DRAWN
 *  doc nodes; tags/stewards are bounded and added client-side on top. */
const MAX_GRAPH_NODES = 150;

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** Bare slug of an engine id/target: the part after the last "/". Engine ids
 *  are `nodes/<slug>`; the editor inserts links as `[[<slug>|Title]]` (bare
 *  slug), so slug resolution is needed alongside id/title. */
function bareSlug(idOrTarget: string): string {
  const idx = idOrTarget.lastIndexOf("/");
  return idx >= 0 ? idOrTarget.slice(idx + 1) : idOrTarget;
}

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
 * Node ids linked from a body by the spec's own link form (§1.7):
 * `[text](contextnest://nodes/x)` or `<contextnest://nodes/x>`, including the
 * checkpoint-pinned / anchored forms (`contextnest://nodes/x@3#section`) —
 * the pin and anchor address a version/section OF the node, so the edge is to
 * the node itself, exactly as `[[nodes/x]]` would be.
 *
 * Parsing is the engine's `extractContextLinks` (linear, ReDoS-bounded, skips
 * fenced code and inline code spans), so this repo does not fork link syntax.
 * Folder / tag / search URIs and cross-namespace links come back as strings
 * that match no node id and are dropped by the id-only resolution callers do.
 * Returned targets are ids and must be resolved by id ONLY — never by title
 * or bare slug, or a dangling `contextnest://nodes/gone` could attach to an
 * unrelated `other/gone`.
 */
export function extractContextTargets(body: string): string[] {
  const out: string[] = [];
  if (!body) return out;
  for (const uri of extractContextLinks(body)) {
    // Plain index scans, no regex: strip scheme, anchor, pin, trailing slash.
    let t = uri.slice("contextnest://".length);
    const hash = t.indexOf("#");
    if (hash !== -1) t = t.slice(0, hash);
    const at = t.indexOf("@");
    if (at !== -1) t = t.slice(0, at);
    if (t.endsWith("/")) t = t.slice(0, -1);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Build the ontology graph for a nest, gated to what the caller can read.
 * Links are de-duplicated and only kept when both ends resolve to an
 * accessible node (so the view never dangles into hidden/missing targets).
 * [[wikilink]] and contextnest:// link edges are directed; tag-cooccurrence edges are inherently
 * undirected and stored in one canonical (sorted) direction.
 */
export async function buildNestGraph(
  nestId: string,
  userId: string,
  userEmail: string,
  /** Whether the caller may see steward identities (emails). Mirrors the
   *  collaborators-roster rule: only write+ callers see member emails, so a
   *  public/read tier can't enumerate them via the graph. */
  canSeeIdentities: boolean,
): Promise<NestGraph> {
  const { storage } = await engineCache.get(nestId);
  // Derived annotation projections are machine-maintained, so they are not
  // nodes of the ontology the graph draws.
  const docs: ContextNode[] = (await storage.discoverDocuments()).filter(
    (d) => !isDerivedAnnotationsNode(d.id),
  );
  const accessible = await filterAccessible(nestId, userId, userEmail, docs);

  const idSet = new Set(accessible.map((d) => d.id));
  const titleToId = new Map<string, string>();
  // Bare-slug → id, so the editor's `[[<slug>|Title]]` link form resolves
  // (mirrors the client's backlink resolution: id, title, OR bare slug).
  const slugToId = new Map<string, string>();
  for (const d of accessible) {
    const t = (d.frontmatter?.title || "").toLowerCase().trim();
    // First occurrence wins — duplicate case-folded titles are ambiguous, so
    // don't let a later doc silently steal title-based incoming links (which
    // would make the earlier doc look like a false orphan).
    if (t && !titleToId.has(t)) titleToId.set(t, d.id);
    const slug = bareSlug(d.id).toLowerCase();
    if (slug && !slugToId.has(slug)) slugToId.set(slug, d.id);
  }

  const allNodes: GraphNode[] = accessible.map((d) => ({
    id: d.id,
    title: d.frontmatter?.title || d.id,
    type: (d.frontmatter as { type?: string })?.type || "document",
    tags: ((d.frontmatter?.tags as string[]) || []).map(normalizeTag),
  }));

  const allLinks: GraphLink[] = [];
  const seen = new Set<string>();
  for (const d of accessible) {
    for (const raw of extractWikiTargets(d.body || "")) {
      const norm = raw.toLowerCase().trim();
      // Resolve by exact id, then title, then bare slug (the form the editor
      // actually writes) — matching the client's wiki-link resolution.
      const targetId = idSet.has(raw)
        ? raw
        : titleToId.get(norm) ?? slugToId.get(bareSlug(raw).toLowerCase());
      if (!targetId || targetId === d.id) continue;
      const key = `${d.id}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allLinks.push({ source: d.id, target: targetId });
    }
  }
  // contextnest:// links are edges too (id-only resolution — see
  // extractContextTargets). Same dedupe key, so a doc linking a node both ways
  // draws one edge.
  for (const d of accessible) {
    for (const targetId of extractContextTargets(d.body || "")) {
      if (!idSet.has(targetId) || targetId === d.id) continue;
      const key = `${d.id}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allLinks.push({ source: d.id, target: targetId });
    }
  }

  // Tag counts + tag→doc-ids index (the latter powers exact bottleneck share).
  const tagCounts = new Map<string, number>();
  const tagToDocs = new Map<string, Set<string>>();
  for (const n of allNodes) {
    for (const t of n.tags) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      let s = tagToDocs.get(t);
      if (!s) tagToDocs.set(t, (s = new Set()));
      s.add(n.id);
    }
  }
  const tags: GraphTag[] = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // A shared tag is a relationship too, same as a [[wikilink]] — pair up every
  // two docs that carry a tag in common and merge into the same edge set (so
  // orphan detection and the rendered graph both see it). Reuses `seen` from
  // the wikilink pass above so a pair already linked by wikilink doesn't get
  // a redundant duplicate edge.
  for (const docIds of tagToDocs.values()) {
    const ids = [...docIds].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}->${ids[j]}`;
        if (seen.has(key) || seen.has(`${ids[j]}->${ids[i]}`)) continue;
        seen.add(key);
        allLinks.push({ source: ids[i], target: ids[j] });
      }
    }
  }

  // ── Stewards (identity-masked for sub-write callers) ──
  // Skip the roster entirely for public/anon readers (even masked, the roster
  // is member-only — same rule as the collaborators list) and when the nest
  // isn't governed (every other endpoint treats disabled stewardship as no
  // rows; returning stale rows here would contradict them).
  const exposeStewards =
    (await isStewardshipEnabled(nestId)) &&
    !(await isPublicReader(nestId, userId));
  const stewardRows = exposeStewards
    ? (await listStewards({ nestId })).filter(
        // Drop document-scoped rows whose node the caller can't see.
        (s) => s.scope !== "document" || idSet.has(s.nodePattern || ""),
      )
    : [];

  // Assign stable opaque ids when masking: sort emails so the same email maps
  // to the same "sN" token across requests (stable node identity) without
  // exposing the address itself.
  const maskId = new Map<string, string>();
  if (!canSeeIdentities) {
    const emails = [...new Set(stewardRows.map((s) => s.userEmail))].sort();
    emails.forEach((e, i) => maskId.set(e, `s${i + 1}`));
  }
  const identity = (email: string) => {
    if (canSeeIdentities) return { id: email, label: email };
    const id = maskId.get(email)!;
    return { id, label: `Steward ${id.slice(1)}` };
  };

  // One entry per row — a person may hold several scope rows (e.g. a tag row
  // and a doc row). Edges and signals are computed over rows; the steward NODE
  // list is deduped below so d3-force doesn't get two nodes with the same id.
  const stewardRowsMapped: GraphSteward[] = stewardRows.map((s) => {
    const { id, label } = identity(s.userEmail);
    return {
      id,
      label,
      role: s.role,
      scope: s.scope,
      target:
        s.scope === "document"
          ? s.nodePattern || ""
          : s.scope === "tag"
            ? normalizeTag(s.tagName || "")
            : "*",
    };
  });

  const stewardEdges: GraphStewardEdge[] = stewardRowsMapped.map((s) => ({
    steward: s.id,
    target:
      s.scope === "tag" ? `tag:${s.target}` : s.scope === "document" ? s.target : "*",
    scope: s.scope,
  }));

  // Deduped node list — first row per identity. Edges (above) stay 1:1 with
  // rows so every governed target keeps its edge.
  const seenSteward = new Set<string>();
  const stewards: GraphSteward[] = stewardRowsMapped.filter((s) =>
    seenSteward.has(s.id) ? false : (seenSteward.add(s.id), true),
  );

  // ── Governance signals over the FULL set (accuracy survives truncation) ──
  const linkedIds = new Set<string>();
  for (const l of allLinks) {
    linkedIds.add(l.source);
    linkedIds.add(l.target);
  }
  const orphans = allNodes.filter((n) => !linkedIds.has(n.id));

  const stewardedTags = new Set(
    stewardRows.filter((s) => s.scope === "tag").map((s) => normalizeTag(s.tagName || "")),
  );
  const unstewardedTags = tags.filter((t) => !stewardedTags.has(t.name));

  // Bottleneck = distinct-doc share ≥50%. Accumulate covered doc IDS into a Set
  // per steward so overlapping rows (a tag row + a doc row inside that tag, two
  // tag rows sharing docs) can't double-count and push share past 100%.
  const coveredBySteward = new Map<string, Set<string>>();
  const labelById = new Map<string, string>();
  // Iterate ALL rows (not the deduped node list) so a person's coverage unions
  // across every scope row they hold.
  for (const s of stewardRowsMapped) {
    labelById.set(s.id, s.label);
    let cov = coveredBySteward.get(s.id);
    if (!cov) coveredBySteward.set(s.id, (cov = new Set()));
    if (s.scope === "nest") for (const id of idSet) cov.add(id);
    else if (s.scope === "tag")
      for (const id of tagToDocs.get(s.target) || []) cov.add(id);
    else if (idSet.has(s.target)) cov.add(s.target);
  }
  const denom = idSet.size;
  const bottlenecks =
    denom === 0
      ? []
      : [...coveredBySteward.entries()]
          .map(([steward, cov]) => ({
            steward,
            label: labelById.get(steward) || steward,
            share: Math.round((cov.size / denom) * 100),
          }))
          .filter((b) => b.share >= 50)
          .sort((a, b) => b.share - a.share);

  const signals: GraphSignals = { orphans, unstewardedTags, bottlenecks };

  // ── Draw-cap: keep the highest-degree docs so the rendered web stays legible
  // past the hairball threshold. Orphans/gaps are surfaced in `signals`, not
  // the canvas, so dropping low-degree nodes here doesn't hide a governance
  // finding. Deterministic: degree desc, id asc tiebreak. ──
  const truncated = allNodes.length > MAX_GRAPH_NODES;
  let nodes = allNodes;
  let links = allLinks;
  if (truncated) {
    const degree = new Map<string, number>();
    for (const l of allLinks) {
      degree.set(l.source, (degree.get(l.source) || 0) + 1);
      degree.set(l.target, (degree.get(l.target) || 0) + 1);
    }
    nodes = [...allNodes]
      .sort(
        (a, b) =>
          (degree.get(b.id) || 0) - (degree.get(a.id) || 0) ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, MAX_GRAPH_NODES);
    const kept = new Set(nodes.map((n) => n.id));
    links = allLinks.filter((l) => kept.has(l.source) && kept.has(l.target));
  }

  return {
    nodes,
    links,
    stewards,
    stewardEdges,
    tags,
    signals,
    truncated,
    totalNodes: allNodes.length,
  };
}
