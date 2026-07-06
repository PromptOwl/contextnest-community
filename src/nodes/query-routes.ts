import { Hono } from "hono";
import { serializeDocument } from "@promptowl/contextnest-engine";
import type { ContextNode } from "@promptowl/contextnest-engine";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "./engine.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { queryTableNode } from "../tables/query.js";
import { trackEvent } from "../telemetry/tracker.js";
import { syncNodeTags } from "../governance/tag-index-service.js";
import {
  resolveCallerEmail,
  filterAccessible,
} from "../governance/access-guard.js";
import { compilePrompt } from "./prompt-compiler.js";
import {
  nodeToMarkdown,
  nodesToMarkdown,
  isMarkdownFormat,
} from "./markdown-export.js";
import { resolveReadableBody, resolveExportBody } from "./readable-body.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { countThreadsByNode } from "../annotations/service.js";
import { permissionLevel } from "../shared/access.js";
import { buildNestGraph, extractWikiTargets } from "./graph-service.js";
import { config } from "../config.js";

export const queryRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/graph
// Ontology graph: nodes, resolved [[wikilink]] edges, tag/category counts, and
// the stewardship overlay — for the graph view (links / stewardship / coverage
// gaps). Read-only assembly, gated to what the caller can read.
queryRoutes.get("/graph", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  // Steward emails are write+ only — same rule as the collaborators roster, so
  // a public/read tier can't enumerate member emails via the graph overlay.
  const canSeeIdentities =
    permissionLevel(c.get("nestPermission")) >= permissionLevel("write");
  const graph = await buildNestGraph(nestId, userId, userEmail, canSeeIdentities);
  // Workflow plane ("turing"): typed edges ride along when the flag is on.
  // Only edges whose BOTH endpoints are already in the caller-visible node
  // set — the graph's own access filtering stays authoritative.
  if (config.FEATURE_WORKFLOW_PLANE) {
    const { getDb } = await import("../db/client.js");
    const rows = (await getDb().all(
      `SELECT e.from_node, e.to_node, e.condition_mode, t.name as type, t.color, t.is_flow
         FROM edges e JOIN edge_types t ON t.id = e.type_id
        WHERE e.nest_id = ?`,
      [nestId],
    )) as Array<{ from_node: string; to_node: string; condition_mode: string | null; type: string; color: string | null; is_flow: number }>;
    const visible = new Set(graph.nodes.map((n: any) => n.id));
    (graph as any).typedEdges = rows
      .filter((r) => visible.has(r.from_node) && visible.has(r.to_node))
      .map((r) => ({
        source: r.from_node,
        target: r.to_node,
        type: r.type,
        color: r.color,
        is_flow: !!r.is_flow,
        condition_mode: r.condition_mode,
      }));
  }
  return c.json(graph);
});

// ─── Token budgeting helper ───
// Rough 4-chars-per-token estimator. Good enough for budgeting; exact
// tokenization is provider-specific and would require tiktoken.
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatContextBlock(node: ContextNode): string {
  const tags = (node.frontmatter.tags || []).join(" ");
  const header = tags
    ? `# ${node.frontmatter.title}\n\n_tags: ${tags}_\n\n`
    : `# ${node.frontmatter.title}\n\n`;
  return header + (node.body || "").trim();
}

// POST /nests/:nestId/context
// One-call context retrieval for app integrations. Accepts either a
// natural-language `prompt` (compiled to a selector server-side) or an
// explicit `selector`. Returns markdown ready to prepend to an LLM prompt,
// plus trace + manifest.
queryRoutes.post("/context", async (c) => {
  const body = await c.req.json<{
    prompt?: string;
    selector?: string;
    max_tokens?: number;
    hops?: number;
    include_drafts?: boolean;
  }>();

  if (!body.prompt && !body.selector) {
    throw new ValidationError("prompt or selector is required");
  }

  const nestId = c.req.param("nestId")!;
  const { query: queryEngine, storage } = await engineCache.get(nestId);
  // Floor at 50 tokens — anything smaller returns nothing useful. Default
  // is 4000, a typical system-prompt budget.
  const maxTokens = Math.max(50, body.max_tokens ?? 4000);
  const hops = body.hops ?? 2;
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
  // Hop expansion for the title matches happens after the merge below, over
  // the same wikilink graph the engine traverses.
  if (selector && selector.includes("[[")) {
    const parts = selector.split("|").map((p) => p.trim()).filter(Boolean);
    const wantedTitles = new Set<string>();
    const rest: string[] = [];
    for (const p of parts) {
      const m = /^\[\[(.+)\]\]$/.exec(p);
      if (m) wantedTitles.add(m[1].trim().toLowerCase());
      else rest.push(p);
    }
    if (wantedTitles.size > 0) {
      selector = rest.join("|") || null;
      resolvedTitleSelector = true;
      titleMatches = allDocs.filter(
        (d: ContextNode) =>
          wantedTitles.has(String(d.frontmatter.title || "").toLowerCase()) &&
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
      titleMatches = allDocs.filter((d: ContextNode) =>
        matchedLower.has(d.frontmatter.title.toLowerCase()),
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

  // Hop-expand title matches over the wikilink graph (both directions) so
  // "[[Title]] + hops" pulls the same neighborhood the engine would for a
  // selector match — and the same one the graph view highlights.
  if (titleMatches.length > 0 && hops > 0) {
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
    }
    const seen = new Set(titleMatches.map((d) => d.id));
    let frontier = titleMatches.map((d) => d.id);
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

  // ── 3. Permission gate (no-op when stewardship is disabled) ──
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  const beforePermission = documents.length;
  const accessible = await filterAccessible(nestId, userId, userEmail, documents);
  const permissionFiltered = beforePermission - accessible.length;

  // Public readers must see approved bodies only, never on-disk drafts.
  const readable = await Promise.all(
    accessible.map(async (doc) => ({
      ...doc,
      body: await resolveReadableBody(nestId, doc.id, userId, doc.body || ""),
    })),
  );

  // ── 4. Budget-fit within max_tokens ──
  const included: ContextNode[] = [];
  let tokenCount = 0;
  for (const doc of readable) {
    const block = formatContextBlock(doc);
    const blockTokens = approxTokens(block);
    if (tokenCount + blockTokens > maxTokens && included.length > 0) break;
    included.push(doc);
    tokenCount += blockTokens;
  }
  const truncatedByBudget = accessible.length - included.length;

  // ── 5. Format response ──
  const contextMarkdown = included
    .map(formatContextBlock)
    .join("\n\n---\n\n");

  trackEvent("context.resolve", {
    nestId,
    selector_from_prompt: !!compileDetail,
    included: included.length,
    permission_filtered: permissionFiltered,
    token_count: tokenCount,
  });

  return c.json({
    context: contextMarkdown,
    nodes: included.map((n) => ({
      id: n.id,
      title: n.frontmatter.title,
      tags: n.frontmatter.tags || [],
      type: n.frontmatter.type || "document",
    })),
    trace: {
      selector_used: selector,
      from_prompt: body.prompt ?? null,
      compiled: compileDetail
        ? {
            matched_tags: compileDetail.matchedTags,
            matched_titles: compileDetail.matchedTitles,
            unmatched_tokens: compileDetail.unmatched,
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
  });
});

// POST /nests/:nestId/query
// POST /nests/:nestId/table-query — deterministic fact lookup against a
// TABLE node (body = CSV with directive-annotated headers). The point:
// an agent with a 1,000-row table fetches the exact rows it needs instead
// of dragging the whole table into context, and the same query against the
// same version always returns the same rows.
//
//   { "table": "[[Price List]]" | "nodes/price-list",
//     "query": "where region = \"EU\" and price > 100 select sku, price limit 5" }
queryRoutes.post("/table-query", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{
    table?: string;
    query?: string;
    include_drafts?: boolean;
  }>();
  const ref = typeof body.table === "string" ? body.table.trim() : "";
  if (!ref) throw new ValidationError("table is required — [[Title]] or node id");
  const result = await queryTableNode(
    nestId,
    ref,
    typeof body.query === "string" ? body.query : "",
    body.include_drafts === true,
  );
  return c.json(result);
});

queryRoutes.post("/query", async (c) => {
  const body = await c.req.json<{ query?: string; hops?: number }>();
  if (!body.query) {
    throw new ValidationError("query is required");
  }

  const nestId = c.req.param("nestId")!;
  const { query: queryEngine } = await engineCache.get(nestId);
  const result = await queryEngine.query(body.query, {
    hops: body.hops ?? 2,
  });

  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  const accessible = await filterAccessible(nestId, userId, userEmail, result.documents);

  return c.json({
    query: body.query,
    count: accessible.length,
    nodes: accessible.map((n) => ({
      id: n.id,
      title: n.frontmatter.title,
      type: n.frontmatter.type || "document",
      tags: n.frontmatter.tags || [],
      snippet: (n.body || "").slice(0, 200).replace(/\n/g, " "),
    })),
  });
});

// GET /nests/:nestId/search?q=
queryRoutes.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q) {
    throw new ValidationError("q query parameter is required");
  }

  const nestId = c.req.param("nestId")!;
  const { storage } = await engineCache.get(nestId);
  const documents = await storage.discoverDocuments();

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = documents.filter((node) => {
    const haystack = [
      node.frontmatter.title,
      node.body || "",
      node.frontmatter.type || "",
      ...(node.frontmatter.tags || []),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  const accessible = await filterAccessible(nestId, userId, userEmail, matches);

  return c.json({
    query: q,
    count: accessible.length,
    nodes: accessible.map((n) => ({
      id: n.id,
      title: n.frontmatter.title,
      type: n.frontmatter.type || "document",
      tags: n.frontmatter.tags || [],
      snippet: (n.body || "").slice(0, 200).replace(/\n/g, " "),
    })),
  });
});

// GET /nests/:nestId/overview
queryRoutes.get("/overview", async (c) => {
  const { storage } = await engineCache.get(c.req.param("nestId")!);
  const documents = await storage.discoverDocuments();

  const types: Record<string, number> = {};
  const tags: Record<string, number> = {};

  for (const node of documents) {
    const t = node.frontmatter.type || "document";
    types[t] = (types[t] || 0) + 1;
    for (const tag of node.frontmatter.tags || []) {
      tags[tag] = (tags[tag] || 0) + 1;
    }
  }

  return c.json({
    total: documents.length,
    types,
    tags,
    nodes: documents.map((n) => ({
      id: n.id,
      title: n.frontmatter.title,
      type: n.frontmatter.type || "document",
      tags: n.frontmatter.tags || [],
      snippet: (n.body || "").slice(0, 120).replace(/\n/g, " "),
    })),
  });
});

// GET /nests/:nestId/comment-counts
// Per-node annotation (comment) counts for the whole nest, so the UI can sort
// document lists by "most comments" in one call instead of N per-node fetches.
queryRoutes.get("/comment-counts", async (c) => {
  const counts = await countThreadsByNode(c.req.param("nestId")!);
  return c.json({ counts });
});

// GET /nests/:nestId/context
queryRoutes.get("/context", async (c) => {
  const { storage } = await engineCache.get(c.req.param("nestId")!);
  const content = await storage.readContextMd();
  return c.json({ content: content || "" });
});

// GET /nests/:nestId/export?format=markdown[&selector=]
// LLM-pointed plain-text view: every accessible node serialized as
// frontmatter + body, concatenated with `---` separators. Optional
// `selector` narrows the set via the engine selector grammar. Reuses the
// same permission gate as /context (filterAccessible).
queryRoutes.get("/export", async (c) => {
  if (!isMarkdownFormat(c)) {
    throw new ValidationError("format=markdown is required");
  }

  const nestId = c.req.param("nestId")!;
  const { storage, query: queryEngine } = await engineCache.get(nestId);
  const selector = c.req.query("selector")?.trim() || null;

  let documents: ContextNode[];
  if (selector) {
    const result = await queryEngine.query(selector, { hops: 2, full: true });
    documents = result.documents;
  } else {
    documents = await storage.discoverDocuments();
  }

  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  const accessible = await filterAccessible(nestId, userId, userEmail, documents);

  // Export is APPROVED-ONLY for every caller — drafts never export. On a
  // governed nest, nodes with no approved version are dropped; the body is the
  // approved version's bytes. On an ungoverned nest the working copy is the
  // published state.
  const governed = await isStewardshipEnabled(nestId);
  const resolved = await Promise.all(
    accessible.map(async (n) => {
      const body = await resolveExportBody(nestId, n.id, n.body || "");
      if (body == null) return null;
      return {
        id: n.id,
        title: n.frontmatter.title,
        tags: (n.frontmatter.tags || []) as string[],
        status: governed ? "published" : n.frontmatter.status,
        body,
      };
    }),
  );
  const fields = resolved.filter(
    (f): f is NonNullable<typeof f> => f != null,
  );

  // Optional token budget — full set by default; an agent can cap a fetch
  // with ?max_tokens= (same estimator as POST /context).
  const maxParam = parseInt(c.req.query("max_tokens") ?? "", 10);
  const maxTokens = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : null;
  let included = fields;
  if (maxTokens) {
    const kept: typeof fields = [];
    let tokens = 0;
    for (const f of fields) {
      const t = approxTokens(nodeToMarkdown(f));
      if (tokens + t > maxTokens && kept.length > 0) break;
      kept.push(f);
      tokens += t;
    }
    included = kept;
  }

  trackEvent("nest.export", {
    nestId,
    count: included.length,
    selector,
    truncated_by_budget: fields.length - included.length,
  });

  return c.body(nodesToMarkdown(included), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
  });
});

// POST /nests/:nestId/publish — bulk publish
queryRoutes.post("/publish", async (c) => {
  const body = await c.req.json<{
    documents?: Array<{
      title: string;
      content: string;
      type?: string;
      tags?: string[];
      scope?: string;
    }>;
    context_md?: string;
  }>();

  if (!body.documents?.length && !body.context_md) {
    throw new ValidationError("documents array or context_md is required");
  }

  const nestId = c.req.param("nestId")!;
  const { storage } = await engineCache.get(nestId);
  const created: string[] = [];

  if (body.context_md) {
    await storage.writeContextMd(body.context_md);
  }

  for (const doc of body.documents || []) {
    if (!doc.title || !doc.content) continue;

    const slug = doc.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const id = `nodes/${slug}`;
    const now = new Date().toISOString();
    const tags =
      doc.tags?.map((t) => (t.startsWith("#") ? t : `#${t}`)) || [];

    const node: ContextNode = {
      id,
      filePath: "",
      frontmatter: {
        title: doc.title,
        type: (doc.type as any) || "document",
        tags,
        status: "draft",
        version: 1,
        created_at: now,
        updated_at: now,
        metadata: {
          owners: ["*"],
          scope: doc.scope || "team",
        },
      },
      body: doc.content,
      rawContent: "",
    };

    const serialized = serializeDocument(node);
    await storage.writeDocument(id, serialized);
    await syncNodeTags(nestId, id, tags);
    created.push(id);
  }

  trackEvent("nest.publish", { nestId, count: created.length });

  return c.json(
    {
      published: created.length,
      context_md_updated: !!body.context_md,
      node_ids: created,
    },
    201,
  );
});
