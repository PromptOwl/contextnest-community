/**
 * Context retrieval — the one-call "what should an LLM read for this" resolver
 * behind POST /nests/:nestId/context, shared with Hootie's chat route.
 *
 * Accepts either a natural-language `prompt` (compiled to a selector, then
 * body-scored) or an explicit `selector` ([[Title]] parts allowed), expands
 * hops over the wikilink graph, gates every document through the caller's
 * permissions, and budget-fits the result. Lives outside the route so a second
 * caller gets the same retrieval AND the same gate — never a re-implementation
 * that drifts from what /context returns.
 */
import type { ContextNode } from "@promptowl/contextnest-engine";
import { engineCache } from "./engine.js";
import { ValidationError } from "../shared/errors.js";
import { trackEvent } from "../telemetry/tracker.js";
import {
  resolveCallerEmail,
  filterAccessible,
} from "../governance/access-guard.js";
import { compilePrompt, scorePrompt, tokenizePrompt } from "./prompt-compiler.js";
import { resolveNodeUrl } from "../governance/title-resolver.js";
import { readableVersions, resolveReadableBody } from "./readable-body.js";
import { extractContextTargets, extractWikiTargets } from "./graph-service.js";
import { recordNodeAccess } from "../governance/access-log.js";
import type { ClientMetadata } from "../shared/client-metadata.js";

export interface ContextRequest {
  prompt?: string;
  selector?: string;
  max_tokens?: number;
  hops?: number;
  include_drafts?: boolean;
}

export interface ContextNodeSummary {
  id: string;
  title: string;
  url?: string;
  tags: string[];
  type: string;
  score?: number;
  via?: string;
}

export interface ContextResult {
  context: string;
  nodes: ContextNodeSummary[];
  /** The same content as `context`, one entry per included node, so a caller
   *  merging two retrievals (Hootie: open document + question) can de-dupe by
   *  id instead of by text. Not part of the /context wire shape. */
  blocks: Array<{
    id: string;
    title: string;
    markdown: string;
    /** `markdown` is `header + body`: the title/tags/source lines, then the
     *  readable body — split out so a caller can reshape the body (Hootie
     *  reduces an HTML artifact to its text) and keep the header. */
    header: string;
    body: string;
    type: string;
  }>;
  trace: {
    selector_used: string | null;
    from_prompt: string | null;
    compiled: {
      matched_tags: string[];
      matched_titles: string[];
      unmatched_tokens: string[];
      fallback: "fulltext" | null;
    } | null;
    total_matched: number;
    permission_filtered: number;
    included: number;
    truncated_by_budget: number;
    hops_used: number;
    nodes_traversed: number;
    approx_tokens: number;
    max_tokens: number;
  };
}

// ─── Token budgeting helper ───
// Rough 4-chars-per-token estimator. Good enough for budgeting; exact
// tokenization is provider-specific and would require tiktoken.
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatContextBlock(node: ContextNode, url?: string): string {
  return contextBlockHeader(node, url) + (node.body || "").trim();
}

/** The title/tags/source lines a context block opens with. */
export function contextBlockHeader(node: ContextNode, url?: string): string {
  const tags = (node.frontmatter.tags || []).join(" ");
  const meta = [
    tags ? `_tags: ${tags}_` : null,
    url ? `_source: ${url}_` : null,
  ].filter(Boolean);
  return meta.length
    ? `# ${node.frontmatter.title}\n\n${meta.join("\n")}\n\n`
    : `# ${node.frontmatter.title}\n\n`;
}


export async function resolveContext(params: {
  nestId: string;
  userId: string;
  /** For the per-node `url` in the manifest and in each context block. */
  baseUrl: string;
  body: ContextRequest;
  /** Caller attribution (§9.4) for the activity log — which agent pulled
   *  these documents. A label, never a gate. */
  client?: ClientMetadata;
}): Promise<ContextResult> {
  const { nestId, userId, baseUrl, body, client } = params;
  if (!body.prompt && !body.selector) {
    throw new ValidationError("prompt or selector is required");
  }

  const { query: queryEngine, storage } = await engineCache.get(nestId);
  // Floor at 50 tokens — anything smaller returns nothing useful. Default
  // is 4000, a typical system-prompt budget.
  const maxTokens = Math.max(50, body.max_tokens ?? 4000);
  // A prompt is a relevance question, so it defaults to no hop expansion —
  // neighbours of a keyword match are not answers to the prompt, and callers
  // cite every node returned. Explicit selectors keep the engine's default.
  const promptPath = !body.selector?.trim() && !!body.prompt;
  const hops = body.hops ?? (promptPath ? 0 : 2);
  const includeDrafts = body.include_drafts === true;

  // Mirror the engine's draft rule (isPublished: status === "published") so the
  // hand-rolled [[Title]] + hop path below never surfaces drafts the engine's
  // selector path would have filtered out for the same include_drafts value.
  const isVisible = (d: ContextNode) =>
    includeDrafts || d.frontmatter.status === "published";

  // ── 1. Resolve selector + title-match list ──
  let selector: string | null = body.selector?.trim() || null;
  let compileDetail: Awaited<ReturnType<typeof compilePrompt>> | null = null;
  let titleMatches: ContextNode[] = [];
  // True once an explicit selector's [[Title]] parts were peeled + resolved —
  // guards the prompt branch below from clobbering those matches.
  let resolvedTitleSelector = false;
  const allDocs = await storage.discoverDocuments();

  // Explicit selectors may carry [[Title]] parts in an OR union — that's
  // what the graph view's click-to-query and the API docs emit. The engine
  // grammar doesn't accept wiki syntax, so peel those parts off here: match
  // titles directly (case-insensitive) and hand the rest to the engine.
  // A part may also be an id ([[nodes/some-id]]) — the same id-style wiki
  // target the graph resolves — which names exactly one document where a
  // title may name several. Hop expansion for the matches happens after the
  // merge below, over the same wikilink graph the engine traverses.
  if (selector && selector.includes("[[")) {
    const parts = selector.split("|").map((p) => p.trim()).filter(Boolean);
    const wantedTitles = new Set<string>();
    const wantedIds = new Set<string>();
    const rest: string[] = [];
    for (const p of parts) {
      const m = /^\[\[(.+)\]\]$/.exec(p);
      if (!m) {
        rest.push(p);
        continue;
      }
      const inner = m[1].trim();
      if (inner.startsWith("nodes/")) wantedIds.add(inner);
      else wantedTitles.add(inner.toLowerCase());
    }
    if (wantedTitles.size > 0 || wantedIds.size > 0) {
      selector = rest.join("|") || null;
      resolvedTitleSelector = true;
      titleMatches = allDocs.filter(
        (d: ContextNode) =>
          (wantedIds.has(d.id) ||
            wantedTitles.has(String(d.frontmatter.title || "").toLowerCase())) &&
          isVisible(d),
      );
    }
  }

  if (!selector && !resolvedTitleSelector && body.prompt) {
    const titles = allDocs.map((d: ContextNode) => d.frontmatter.title);
    compileDetail = await compilePrompt(body.prompt, nestId, titles);
    selector = compileDetail.selector;

    // Title matches are fetched directly — the engine's selector grammar
    // doesn't accept [[Title]] wiki syntax.
    if (compileDetail.matchedTitles.length > 0) {
      const matchedLower = new Set(
        compileDetail.matchedTitles.map((t) => t.toLowerCase()),
      );
      titleMatches = allDocs.filter(
        (d: ContextNode) =>
          matchedLower.has(d.frontmatter.title.toLowerCase()) && isVisible(d),
      );
    }
  }

  // ── 2. Run the engine (or short-circuit if nothing compiled) ──
  let documents: ContextNode[] = [];
  let hopsUsed = 0;
  let nodesTraversed = 0;

  if (selector) {
    // full:true skips the context.yaml index path and loads every document
    // fresh — the indexed path can miss recently-added nodes until
    // context.yaml is regenerated. Correct + cheap for typical nest sizes.
    const result = await queryEngine.query(selector, {
      hops,
      includeDrafts,
      full: true,
    });
    documents = result.documents;
    hopsUsed = result.hopsUsed;
    nodesTraversed = result.nodesTraversed;
  }

  // Hop-expand over the link graph (both directions) — [[wikilinks]] AND
  // contextnest:// links — from the title matches AND the selector's own
  // matches. The engine call above runs full:true, and the engine's full mode
  // ignores `hops`, so without seeding from `documents` here a selector's
  // advertised hop expansion was a no-op. hops:0 skips this block entirely,
  // so hops:0 results are unchanged. Same neighbourhood the graph view draws.
  // De-duplicated by id: a doc can match both the selector and a [[Title]]
  // part (`[[Hub Note]] | #hub`), and should seed the frontier once.
  const hopSeeds = [
    ...new Map([...documents, ...titleMatches].map((d) => [d.id, d])).values(),
  ];
  if (hopSeeds.length > 0 && hops > 0) {
    const byTitle = new Map(
      allDocs.map((d: ContextNode) => [
        String(d.frontmatter.title || "").toLowerCase(),
        d,
      ]),
    );
    const byId = new Map(allDocs.map((d: ContextNode) => [d.id, d]));
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
      (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
    };
    for (const d of allDocs) {
      for (const target of extractWikiTargets(d.body || "")) {
        // Resolve id-style targets ([[nodes/some-id]]) as well as titles, the
        // same way buildNestGraph does — otherwise the hop neighborhood the API
        // returns disagrees with the one the graph view highlights.
        const t = byId.get(target) ?? byTitle.get(target.toLowerCase());
        if (t && t.id !== d.id) link(d.id, t.id);
      }
      // contextnest:// targets are ids — resolve by id only.
      for (const target of extractContextTargets(d.body || "")) {
        const t = byId.get(target);
        if (t && t.id !== d.id) link(d.id, t.id);
      }
    }
    const seen = new Set(hopSeeds.map((d) => d.id));
    let frontier = hopSeeds.map((d) => d.id);
    for (let depth = 0; depth < hops && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          const doc = byId.get(nb);
          // Skip drafts entirely when include_drafts is off — don't return them
          // and don't traverse through them, so the neighborhood matches what
          // the engine selector path would have produced.
          if (!doc || !isVisible(doc)) continue;
          next.push(nb);
          titleMatches.push(doc);
        }
      }
      frontier = next;
      hopsUsed = Math.max(hopsUsed, depth + 1);
    }
    nodesTraversed += seen.size;
  }

  // Merge title-matched docs, de-duped by id.
  if (titleMatches.length > 0) {
    const seen = new Set(documents.map((d) => d.id));
    for (const t of titleMatches) {
      if (!seen.has(t.id)) {
        documents.push(t);
        seen.add(t.id);
      }
    }
  }

  // ── 2b. Rank the prompt path ──
  // Tag/title compilation is exact-token only: a natural-language question
  // often compiles to nothing, or to one weak title while the real answer
  // sits in another document's body. So every visible document is scored
  // against the prompt and unioned with the compiled set, best first so the
  // budget keeps the right ones. Of the body hits, anything under half the
  // top score is noise (a stray "run" in a body) and dropped; compiled
  // matches are what the caller's tag or title named and always stay, as do
  // hop neighbours — the caller asked for them. Every node carries score +
  // via so a caller can cite matches and skip hops. An empty answer stays
  // empty: callers dump the whole nest otherwise.
  const relevance = new Map<string, { score: number; via: string }>();
  let fallback: "fulltext" | null = null;
  if (compileDetail) {
    const tokens = tokenizePrompt(body.prompt!);
    const compiled = new Set(documents.map((d) => d.id));
    for (const d of allDocs) {
      const { score, via } = scorePrompt(d, tokens);
      if (compiled.has(d.id)) relevance.set(d.id, { score, via: via ?? "hop" });
      else if (score > 0 && isVisible(d)) {
        relevance.set(d.id, { score, via: via! });
        documents.push(d);
      }
    }
    if (compiled.size === 0 && documents.length > 0) fallback = "fulltext";
    const top = Math.max(0, ...documents.map((d) => relevance.get(d.id)!.score));
    documents = documents.filter((d) => {
      const r = relevance.get(d.id)!;
      return compiled.has(d.id) || r.via === "hop" || r.score >= top / 2;
    });
    documents.sort((a, b) => relevance.get(b.id)!.score - relevance.get(a.id)!.score);
  }

  // ── 3. Permission gate (no-op when stewardship is disabled) ──
  const userEmail = await resolveCallerEmail(userId);
  const beforePermission = documents.length;
  const accessible = await filterAccessible(nestId, userId, userEmail, documents);
  const permissionFiltered = beforePermission - accessible.length;

  // Public readers must see approved bodies only, never on-disk drafts. The
  // source URL rides along so it resolves once per node, then feeds the budget
  // pass, the markdown, and the manifest.
  const readable = await Promise.all(
    accessible.map(async (doc) => ({
      ...doc,
      body: await resolveReadableBody(nestId, doc.id, userId, doc.body || ""),
      url: resolveNodeUrl(doc, { nestId, baseUrl }),
    })),
  );

  // ── 4. Budget-fit within max_tokens ──
  // Skip a block that doesn't fit and keep going: one large document early in
  // the list must not empty the rest of the budget. Only when nothing at all
  // fits does the best match go through oversized — never an empty answer
  // for a non-empty result.
  const included: (ContextNode & { url?: string })[] = [];
  let tokenCount = 0;
  for (const doc of readable) {
    const block = formatContextBlock(doc, doc.url);
    const blockTokens = approxTokens(block);
    if (tokenCount + blockTokens > maxTokens) continue;
    included.push(doc);
    tokenCount += blockTokens;
  }
  if (included.length === 0 && readable.length > 0) {
    included.push(readable[0]);
    tokenCount = approxTokens(formatContextBlock(readable[0], readable[0].url));
  }
  const truncatedByBudget = accessible.length - included.length;

  // ── 5. Format response ──
  const contextMarkdown = included
    .map((n) => formatContextBlock(n, n.url))
    .join("\n\n---\n\n");

  trackEvent("context.resolve", {
    nestId,
    selector_from_prompt: !!compileDetail,
    included: included.length,
    permission_filtered: permissionFiltered,
    token_count: tokenCount,
  });
  // Admin activity log: the documents this call handed over (REST /context and
  // Hootie's chat both come through here).
  recordNodeAccess({
    nestId,
    nodeIds: included.map((n) => n.id),
    action: "retrieve",
    surface: "api",
    userId,
    userEmail,
    client,
    versions: await readableVersions(nestId, userId, included),
    detail: "context",
  });

  return {
    context: contextMarkdown,
    blocks: included.map((n) => ({
      id: n.id,
      title: n.frontmatter.title,
      markdown: formatContextBlock(n, n.url),
      header: contextBlockHeader(n, n.url),
      body: (n.body || "").trim(),
      type: n.frontmatter.type || "document",
    })),
    nodes: included.map((n) => ({
      id: n.id,
      title: n.frontmatter.title,
      url: n.url,
      tags: n.frontmatter.tags || [],
      type: n.frontmatter.type || "document",
      ...relevance.get(n.id),
    })),
    trace: {
      selector_used: selector,
      from_prompt: body.prompt ?? null,
      compiled: compileDetail
        ? {
            matched_tags: compileDetail.matchedTags,
            matched_titles: compileDetail.matchedTitles,
            unmatched_tokens: compileDetail.unmatched,
            fallback,
          }
        : null,
      total_matched: documents.length,
      permission_filtered: permissionFiltered,
      included: included.length,
      truncated_by_budget: truncatedByBudget,
      hops_used: hopsUsed,
      nodes_traversed: nodesTraversed,
      approx_tokens: tokenCount,
      max_tokens: maxTokens,
    },
  };
}
