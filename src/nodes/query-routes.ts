import { Hono } from "hono";
import type { ContextNode } from "@promptowl/contextnest-engine";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "./engine.js";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from "../shared/errors.js";
import { rebuildNodeIndex } from "./node-index.js";
import { queryTableNode } from "../tables/query.js";
import { trackEvent } from "../telemetry/tracker.js";
import {
  resolveCallerEmail,
  filterAccessible,
} from "../governance/access-guard.js";
import {
  resolveContext,
  approxTokens,
  type ContextRequest,
} from "./context-service.js";
import { requestBaseUrl } from "../shared/base-url.js";
import {
  nodeToMarkdown,
  nodesToMarkdown,
  isMarkdownFormat,
} from "./markdown-export.js";
import { resolveExportBody } from "./readable-body.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { countThreadsByNode } from "../annotations/service.js";
import { permissionLevel, isPublicReader } from "../shared/access.js";
import { exportNestBundle } from "../nests/bundle-service.js";
import { buildNestGraph } from "./graph-service.js";
import {
  listNodesForCaller,
  listNestFolders,
  nestCensus,
  RUNNABLE_NODE_TYPES,
  createEmptyFolder,
  isDerivedAnnotationsNode,
} from "./service.js";
import { matchDocuments, toSearchHit, discoverForSearch } from "./search.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";

export const queryRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/changes?since=<ISO>&include_content=1
// Sync primitive for external mirrors (GitHub, GitBook): everything that
// changed after a point in time, in one deterministic call — created and
// updated docs (caller-gated via listNodesForCaller, so drafts/approvals
// follow the same rules as the node list) plus deletions from the
// node_deletions tombstones (DELETE purges all other traces of a node).
queryRoutes.get("/changes", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const sinceRaw = c.req.query("since");
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
  if (!sinceRaw || Number.isNaN(sinceMs)) {
    throw new ValidationError(
      'since must be an ISO-8601 date, e.g. ?since=2026-07-01T00:00:00Z',
    );
  }
  const includeContent = ["1", "true"].includes(
    c.req.query("include_content") || "",
  );

  // Bodies only when the caller asked to mirror them — otherwise this is a
  // metadata diff and the DB index answers it without touching the vault.
  const all = await listNodesForCaller(nestId, userId, {
    ...(includeContent ? { withContent: true } : {}),
  });
  const db = getDb();
  // Public readers only ever see the approved version's body — their change
  // signal must be approval time, not the raw frontmatter timestamps (see loop).
  const publicReader = await isPublicReader(nestId, userId);

  // Governed nests: an APPROVAL changes what read-tier mirrors see even
  // when the frontmatter updated_at predates `since` (edit before, publish
  // after). Treat approved_at as an additional change signal so a real
  // publish event is never silently dropped from the feed.
  const approvedRows = (await db.all(
    "SELECT node_id, approved_at FROM approved_versions WHERE nest_id = ?",
    [nestId],
  )) as Array<{ node_id: string; approved_at: string }>;
  // approved_at may be sqlite's "YYYY-MM-DD HH:MM:SS" (UTC) — normalize.
  const parseDbTs = (t: string) =>
    Date.parse(t.includes("T") ? t : `${t.replace(" ", "T")}Z`);
  const approvedAtMsByNode = new Map(
    approvedRows.map((r) => [r.node_id, parseDbTs(r.approved_at)]),
  );
  const publishedSince = new Set(
    approvedRows
      .filter((r) => parseDbTs(r.approved_at) > sinceMs)
      .map((r) => r.node_id),
  );

  // `updatedOverride` lets the public-reader path report the approval time as
  // updated_at (the only moment their visible content actually changed) instead
  // of the raw frontmatter value.
  const summarize = (n: (typeof all)[number], updatedOverride?: string) => ({
    id: n.id,
    title: n.title,
    type: n.type,
    status: n.status,
    tags: n.tags,
    created_at: n.created_at,
    updated_at: updatedOverride ?? n.updated_at,
    ...(includeContent ? { content: n.content } : {}),
  });
  const created = [] as ReturnType<typeof summarize>[];
  const updated = [] as ReturnType<typeof summarize>[];
  for (const n of all) {
    if (publicReader) {
      // Public readers see the approved body only. Bucket on approval time, not
      // frontmatter updated_at — updateNode bumps updated_at on every governed
      // edit, incl. unapproved drafts the public body doesn't reflect, so keying
      // off it would flag a "change" that returns byte-identical approved
      // content. A node with no approved version isn't visible to them; skip it.
      const approvedMs = approvedAtMsByNode.get(n.id);
      if (approvedMs === undefined) continue;
      const approvedIso = new Date(approvedMs).toISOString();
      const createdAt = Date.parse(n.created_at || "");
      if (!Number.isNaN(createdAt) && createdAt > sinceMs) {
        created.push(summarize(n, approvedIso));
      } else if (approvedMs > sinceMs) {
        updated.push(summarize(n, approvedIso));
      }
      continue;
    }
    const createdAt = Date.parse(n.created_at || "");
    const updatedAt = Date.parse(n.updated_at || "");
    if (!Number.isNaN(createdAt) && createdAt > sinceMs) created.push(summarize(n));
    else if (!Number.isNaN(updatedAt) && updatedAt > sinceMs) updated.push(summarize(n));
    else if (publishedSince.has(n.id)) updated.push(summarize(n));
  }

  // deleted[] is write+ only. Tombstones bypass the per-node read gates
  // (the doc is gone, so filterAccessible can't vouch for it) — a read-tier
  // or public caller could otherwise learn node ids and deleter emails for
  // docs they were never allowed to see. `null` (not []) tells read-tier
  // mirrors "not available at your access level — reconcile by id diff",
  // so silence is never mistaken for "no deletions".
  const canSeeDeleted =
    permissionLevel(c.get("nestPermission")) >= permissionLevel("write");
  let deleted: Array<{
    id: string;
    deleted_by: string | null;
    deleted_at: string;
  }> | null = null;
  if (canSeeDeleted) {
    // Tombstones newer than `since`, minus anything that now exists again
    // (delete → recreate lands in created[], not deleted[]).
    const rows = (await db.all(
      "SELECT node_id, deleted_by, deleted_at FROM node_deletions WHERE nest_id = ? AND deleted_at > ?",
      [nestId, new Date(sinceMs).toISOString()],
    )) as Array<{ node_id: string; deleted_by: string | null; deleted_at: string }>;
    const liveIds = new Set(all.map((n) => n.id));
    deleted = rows
      .filter((r) => !liveIds.has(r.node_id))
      .map((r) => ({ id: r.node_id, deleted_by: r.deleted_by, deleted_at: r.deleted_at }));
  }

  return c.json({
    since: new Date(sinceMs).toISOString(),
    now: new Date().toISOString(),
    created,
    updated,
    deleted,
  });
});

// GET /nests/:nestId/runnables
// Orchestrator surface: every runnable node (type agent/skill) with its
// schedule and content, so an external scheduler can connect, discover
// what to run and when, and pull the prompt/skill body in one call.
// Reuses listNodesForCaller, so stewardship gating and the public-reader
// approved-only rule apply — an orchestrator with a read key never sees
// unapproved agent definitions.
queryRoutes.get("/runnables", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  // Push the type filter down so only agent/skill docs pay the per-node
  // governance/version enrichment — not every plain document in the nest.
  const all = await listNodesForCaller(nestId, userId, {
    type: RUNNABLE_NODE_TYPES,
    // The prompt/skill body IS the payload here — an orchestrator pulls it to
    // run the thing, so this surface pays for the file reads.
    withContent: true,
  });
  const runnables = all.map((n) => ({
    id: n.id,
    title: n.title,
    type: n.type,
    schedule: n.schedule ?? null,
    status: n.status,
    tags: n.tags,
    updated_at: n.updated_at,
    content: n.content,
  }));
  return c.json({ count: runnables.length, runnables });
});

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

// POST /nests/:nestId/context
// One-call context retrieval for app integrations. Accepts either a
// natural-language `prompt` (compiled to a selector server-side) or an
// explicit `selector`. Returns markdown ready to prepend to an LLM prompt,
// plus trace + manifest. The retrieval itself lives in context-service.ts,
// shared with Hootie's chat route.
queryRoutes.post("/context", async (c) => {
  const body = await c.req.json<ContextRequest>();
  const { blocks: _blocks, ...result } = await resolveContext({
    nestId: c.req.param("nestId")!,
    userId: c.get("userId"),
    baseUrl: requestBaseUrl(c.req.url),
    body,
  });
  return c.json(result);
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
  const matches = matchDocuments(await discoverForSearch(storage), q).filter(
    (n) => !isDerivedAnnotationsNode(n.id),
  );

  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  const accessible = await filterAccessible(nestId, userId, userEmail, matches);

  return c.json({
    query: q,
    count: accessible.length,
    nodes: accessible.map((n) => toSearchHit(n, q)),
  });
});

// GET /nests/:nestId/overview
queryRoutes.get("/overview", async (c) => {
  const { storage } = await engineCache.get(c.req.param("nestId")!);
  // Derived annotation projections stay out of the counts and — because this
  // is where the tag facet comes from — out of tag filtering too.
  const documents = (await storage.discoverDocuments()).filter(
    (d) => !isDerivedAnnotationsNode(d.id),
  );

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

// GET /nests/:nestId/census
//
// Everything that describes the WHOLE nest — folder tree, counts, tags,
// types, authors — for a client that lists one folder level at a time and
// would otherwise have no way to show nest-wide filters or totals. Separate
// from the listing so expanding a folder does not recompute it.
queryRoutes.get("/census", async (c) => {
  const census = await nestCensus(c.req.param("nestId")!, c.get("userId"));
  return c.json({ census });
});

// GET /nests/:nestId/folders?folder=&recursive=0
//
// The nest's folder tree on its own, for callers that need the SHAPE of the
// vault (a navigable tree, a folder picker) and none of its content. Reads
// directory entries only — no document is opened, so this stays cheap on a
// vault where listing the documents would not be.
queryRoutes.get("/folders", async (c) => {
  const q = c.req.query();
  const folders = await listNestFolders(c.req.param("nestId")!, {
    ...(q.folder !== undefined ? { folder: q.folder } : {}),
    ...(q.recursive === "0" || q.recursive === "false" ? { recursive: false } : {}),
  });
  return c.json({ folders });
});

// POST /nests/:nestId/folders  { "folder": "gtm/deals" }
//
// Create a folder with nothing in it. Folders are path-derived, so this
// records the path instead of seeding a placeholder document that would then
// count as real content everywhere (CU-wdqcpzzzut). Write tier, like any
// other POST under a nest.
queryRoutes.post("/folders", async (c) => {
  const body = await c.req
    .json<{ folder?: string }>()
    .catch(() => ({}) as { folder?: string });
  if (typeof body.folder !== "string" || !body.folder.trim()) {
    throw new ValidationError('folder (a string like "gtm/deals") is required');
  }
  const folder = await createEmptyFolder(c.req.param("nestId")!, body.folder);
  return c.json({ folder }, 201);
});

// POST /nests/:nestId/reindex
//
// Force-rebuild the nest's document index from disk.
//
// The index heals itself: anything that leaves it possibly out of step with
// the vault — an out-of-band edit, an import, a write we could not mirror —
// marks the nest stale, and the next read rebuilds before answering. This is
// the manual lever for when an operator wants that to happen NOW, or suspects
// the mirror is wrong for a reason nothing flagged.
//
// Write tier: a rebuild crawls the whole vault, so it is not something a
// read-only caller should be able to trigger at will.
queryRoutes.post("/reindex", async (c) => {
  if (permissionLevel(c.get("nestPermission")) < permissionLevel("write")) {
    throw new ForbiddenError("Reindexing a nest requires write access");
  }
  const indexed = await rebuildNodeIndex(c.req.param("nestId")!);
  return c.json({ indexed });
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
  const nestId = c.req.param("nestId")!;

  // Portability bundle (?format=bundle): the nest's documents as a .zip that
  // the existing folder importer (POST /nests/import) ingests. Gated the same
  // as the markdown export above — the nest access middleware already 404s
  // callers with no access at all, so any reader (viewer and up) may export.
  // `?includeDrafts=1` also exports unapproved drafts; default is approved only.
  if (c.req.query("format") === "bundle") {
    const draftsParam = c.req.query("includeDrafts");
    const includeDrafts = draftsParam === "1" || draftsParam === "true";
    const zip = await exportNestBundle(nestId, includeDrafts);
    const filename = `nest-${nestId}.zip`;
    return c.body(zip, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
  }

  if (!isMarkdownFormat(c)) {
    throw new ValidationError("format=markdown or format=bundle is required");
  }

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
  // with ?max_tokens= (same estimator and fill rule as POST /context: a
  // document that doesn't fit is skipped, not the end of the list).
  const maxParam = parseInt(c.req.query("max_tokens") ?? "", 10);
  const maxTokens = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : null;
  let included = fields;
  if (maxTokens) {
    const kept: typeof fields = [];
    let tokens = 0;
    for (const f of fields) {
      const t = approxTokens(nodeToMarkdown(f));
      if (tokens + t > maxTokens) continue;
      kept.push(f);
      tokens += t;
    }
    included = kept.length > 0 ? kept : fields.slice(0, 1);
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
      folder?: string;
    }>;
    context_md?: string;
  }>();

  if (!body.documents?.length && !body.context_md) {
    throw new ValidationError("documents array or context_md is required");
  }

  // Content-type toggles gate this bulk path up front. createNode refuses a
  // disabled artifact/table below anyway, but that would land the rows before
  // it and report the rest as failures — and a disabled type is a POLICY
  // violation, so it fails the WHOLE batch before any write, context_md
  // included. (Malformed rows — missing title/content — keep this endpoint's
  // existing skip-silently semantics below; those are shape problems,
  // not policy ones.)
  for (const doc of body.documents || []) {
    const t = doc.type || "document";
    if (t === "artifact" && !config.TYPE_ARTIFACT_ENABLED) {
      throw new ValidationError("Artifact nodes are disabled on this server");
    }
    if (t === "table" && !config.TYPE_TABLE_ENABLED) {
      throw new ValidationError("Table nodes are disabled on this server");
    }
  }

  const nestId = c.req.param("nestId")!;
  const userEmail = await resolveCallerEmail(c.get("userId"));
  const created: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ title: string; error: string }> = [];

  if (body.context_md) {
    // No engine op exists for context.md, so this stays a direct write; the
    // index regen keeps graph-mode reads (seeded from context.yaml) aware of
    // it. Document creation below regenerates per doc via the engine.
    const { storage } = await engineCache.get(nestId);
    await storage.writeContextMd(body.context_md);
    await storage.regenerateIndex();
  }

  for (const doc of body.documents || []) {
    if (!doc.title || !doc.content) continue;

    // Route through the canonical create (engine `context_create` underneath)
    // instead of hand-assembling documents here: same slugs, same governance
    // rows, same id-occupancy check as every other create surface. The engine
    // regenerates the index per create, where the old direct-write path
    // regenerated once for the batch — fine at agent batch sizes, and the cost
    // of a bulk path that no longer bypasses the vault lock.
    try {
      const result = await createNode(
        nestId,
        {
          title: doc.title,
          content: doc.content,
          type: doc.type,
          tags: doc.tags,
          scope: doc.scope,
          folder: doc.folder,
        },
        userEmail,
      );
      created.push(result.node.id);
    } catch (err) {
      // Occupied id: the legacy handler silently overwrote the existing doc
      // and restarted its history. Skip instead — republishing a folder must
      // not destroy version chains — and report it so callers can react.
      if (err instanceof ConflictError) {
        skipped.push(doc.title);
        continue;
      }
      // A busy vault fails every remaining document the same way, so stop and
      // let the caller retry the whole batch: what already landed comes back
      // as `skipped`, so the retry finishes the job instead of duplicating.
      if (isVaultLockTimeout(err) || err instanceof VaultBusyError) throw err;
      // Anything else is one document's problem — an unusable title, a type
      // the engine rejects. Report it and keep going: aborting the batch left
      // the earlier writes on disk with nothing in the response naming them.
      // Only an AppError's message is caller-facing; anything else could carry
      // a filesystem path, so it goes to the log and the caller gets the
      // generic line, same as the 500 handler would have given them.
      if (!(err instanceof AppError)) console.error("bulk publish row failed", err);
      failed.push({
        title: doc.title,
        error: err instanceof AppError ? err.message : "Could not create this document",
      });
    }
  }

  trackEvent("nest.publish", { nestId, count: created.length });

  return c.json(
    {
      published: created.length,
      context_md_updated: !!body.context_md,
      node_ids: created,
      skipped,
      failed,
    },
    201,
  );
});
