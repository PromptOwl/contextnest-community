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

export const queryRoutes = new Hono<AuthEnv>();

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

  // ── 4. Budget-fit within max_tokens ──
  const included: ContextNode[] = [];
  let tokenCount = 0;
  for (const doc of accessible) {
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
