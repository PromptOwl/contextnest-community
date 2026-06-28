import { Hono } from "hono";
import { serializeDocument } from "@promptowl/contextnest-engine";
import type { ContextNode } from "@promptowl/contextnest-engine";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "./engine.js";
import { ValidationError } from "../shared/errors.js";
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
import { buildNestGraph } from "./graph-service.js";

export const queryRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/graph
// Ontology graph: nodes, resolved [[wikilink]] edges, tag/category counts, and
// the stewardship overlay — for the graph view (links / stewardship / coverage
// gaps). Read-only assembly, gated to what the caller can read.
queryRoutes.get("/graph", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const userEmail = resolveCallerEmail(userId);
  const graph = await buildNestGraph(nestId, userId, userEmail);
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
  const { query: queryEngine, storage } = engineCache.get(nestId);
  // Floor at 50 tokens — anything smaller returns nothing useful. Default
  // is 4000, a typical system-prompt budget.
  const maxTokens = Math.max(50, body.max_tokens ?? 4000);
  const hops = body.hops ?? 2;
  const includeDrafts = body.include_drafts === true;

  // ── 1. Resolve selector + title-match list ──
  let selector: string | null = body.selector?.trim() || null;
  let compileDetail: ReturnType<typeof compilePrompt> | null = null;
  let titleMatches: ContextNode[] = [];
  const allDocs = await storage.discoverDocuments();

  if (!selector && body.prompt) {
    const titles = allDocs.map((d: ContextNode) => d.frontmatter.title);
    compileDetail = compilePrompt(body.prompt, nestId, titles);
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
  const userEmail = resolveCallerEmail(userId);
  const beforePermission = documents.length;
  const accessible = filterAccessible(nestId, userId, userEmail, documents);
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
queryRoutes.post("/query", async (c) => {
  const body = await c.req.json<{ query?: string; hops?: number }>();
  if (!body.query) {
    throw new ValidationError("query is required");
  }

  const nestId = c.req.param("nestId")!;
  const { query: queryEngine } = engineCache.get(nestId);
  const result = await queryEngine.query(body.query, {
    hops: body.hops ?? 2,
  });

  const userId = c.get("userId");
  const userEmail = resolveCallerEmail(userId);
  const accessible = filterAccessible(nestId, userId, userEmail, result.documents);

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
  const { storage } = engineCache.get(nestId);
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
  const userEmail = resolveCallerEmail(userId);
  const accessible = filterAccessible(nestId, userId, userEmail, matches);

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
  const { storage } = engineCache.get(c.req.param("nestId")!);
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

// GET /nests/:nestId/context
queryRoutes.get("/context", async (c) => {
  const { storage } = engineCache.get(c.req.param("nestId")!);
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
  const { storage, query: queryEngine } = engineCache.get(nestId);
  const selector = c.req.query("selector")?.trim() || null;

  let documents: ContextNode[];
  if (selector) {
    const result = await queryEngine.query(selector, { hops: 2, full: true });
    documents = result.documents;
  } else {
    documents = await storage.discoverDocuments();
  }

  const userId = c.get("userId");
  const userEmail = resolveCallerEmail(userId);
  const accessible = filterAccessible(nestId, userId, userEmail, documents);

  // Export is APPROVED-ONLY for every caller — drafts never export. On a
  // governed nest, nodes with no approved version are dropped; the body is the
  // approved version's bytes. On an ungoverned nest the working copy is the
  // published state.
  const governed = isStewardshipEnabled(nestId);
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
  const { storage } = engineCache.get(nestId);
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
    syncNodeTags(nestId, id, tags);
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
