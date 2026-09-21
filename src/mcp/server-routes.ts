/**
 * Server-level agent entry point — connect ONCE to the server with one key
 * and see everything that key can touch, instead of a connection per nest:
 *
 *   GET  /llms.txt  — public agent manual: endpoints, MCP, selector grammar,
 *                     hop/skip retrieval semantics, npm packages
 *   GET  /index     — the caller's grounded nest index (markdown or json)
 *   ALL  /mcp       — stateless MCP endpoint: nest_index + cross-nest tools
 *                     that take a `nest` (id or name) argument
 *
 * Fan-out reads: `context_search`, `context_list`, `context_query`,
 * `context_overview` accept `nest` as optional — omit to query ALL accessible
 * nests and get combined results. Targeted reads (`context_get`, etc.) and
 * all writes require an explicit `nest` argument.
 *
 * Writes available here: `nest_create`, `context_create`, `context_update`,
 * `context_delete`, `context_move`, `context_submit_review`. Each is gated
 * per-call by the same permission checks the per-nest endpoint uses
 * (handleToolCall's canCreateInNest / canUserEdit / canUserApprove).
 *
 * Governance tools that manage people or nest settings (`context_approve`,
 * `context_reject`, `context_share_nest`, `context_stewards`, etc.) stay on
 * the per-nest endpoint only.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { requestBaseUrl } from "../shared/base-url.js";
import {
  attributeRequest,
  clientToolField,
  connectionClient,
  type ClientMetadata,
} from "../shared/client-metadata.js";
import {
  resolveNestPermission,
  permissionLevel,
  type NestPermission,
} from "../shared/access.js";
import {
  listNests,
  listSharedNests,
  listPublicNests,
  createNest,
} from "../nests/service.js";
import { ValidationError } from "../shared/errors.js";
import {
  isSuspended,
  getSuspensionReason,
  getCurrentLicense,
} from "../auth/license.js";
import { handleToolCall, toCallToolResult, type ToolResult } from "./tools.js";
import { isDerivedAnnotationsNode } from "../nodes/service.js";
import type { Nest } from "../shared/types.js";

// Server-level tools that mutate. The top-level /mcp route carries no
// suspend/license middleware (unlike the per-nest access guard), so the
// kill-switch + license gates that every per-nest write honors must be
// enforced here or these two writes would bypass both. Reads stay open when
// suspended/unlicensed, matching the REST policy.
const SERVER_WRITE_TOOLS = new Set([
  "nest_create",
  "context_create",
  "context_update",
  "context_delete",
  "context_move",
  "context_submit_review",
]);

// Read tools that support fan-out when `nest` is omitted — search/list/query/overview
// across ALL accessible nests. Tools that need an exact target (get, resolve, comments)
// still require nest to be specified.
const FANOUT_READ_TOOLS = new Set([
  "context_search",
  "context_list",
  "context_query",
  "context_overview",
]);

async function getUserEmail(userId: string): Promise<string> {
  const db = getDb();
  const user = (await db.get("SELECT email FROM users WHERE id = ?", [
    userId,
  ])) as { email: string } | undefined;
  return user?.email || "anonymous@localhost";
}

async function canRead(nestId: string, userId: string): Promise<boolean> {
  if (config.AUTH_MODE === "open") return true;
  const perm = await resolveNestPermission(nestId, userId);
  return permissionLevel(perm) >= permissionLevel("read");
}

/**
 * Resolve a `nest` argument — id first, then case-insensitive name/slug.
 *
 * Name/slug are unique only per-owner (UNIQUE(user_id, slug)), so a global
 * name lookup can return several rows once two owners pick the same name.
 * When that happens, disambiguate to the nests THIS caller can actually read:
 * otherwise one user creating a same-named nest would silently break another
 * user's name-based resolution ("Deal Brain" suddenly stops resolving). The
 * final canRead gate in handleServerToolCall still governs the read itself.
 */
async function resolveNestRef(
  ref: string,
  userId: string,
): Promise<Nest | null> {
  const db = getDb();
  // Archived nests resolve to nothing here, by id or by name: they are absent
  // from the agent index, so serving one to a caller who happens to know the
  // reference would be the one way an archived nest could still feed an agent.
  const byId = (await db.get(
    "SELECT * FROM nests WHERE id = ? AND archived_at IS NULL",
    [ref],
  )) as Nest | undefined;
  if (byId) return byId;
  const byName = (await db.all(
    `SELECT * FROM nests
      WHERE archived_at IS NULL
        AND (LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?))`,
    [ref, ref],
  )) as Nest[];
  if (byName.length <= 1) return byName[0] ?? null;
  // Collision across owners — keep only what the caller can read and require
  // an unambiguous single match among those.
  const readable = (
    await Promise.all(
      byName.map(async (n) => ((await canRead(n.id, userId)) ? n : null)),
    )
  ).filter((n): n is Nest => n !== null);
  return readable.length === 1 ? readable[0] : null;
}

export interface IndexedNest {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  permission: NestPermission | "owner";
  document_count: number | null;
}

/**
 * The caller's grounded nest index — one entry per nest their credentials
 * can read, deduped, restricted to the key's nest scope when present.
 * Shared by GET /index and the MCP nest_index tool.
 */
export async function buildNestIndex(
  userId: string,
  nestScope: string | null,
): Promise<IndexedNest[]> {
  const [owned, shared, publicExtras] = await Promise.all([
    listNests(userId),
    listSharedNests(userId),
    listPublicNests(userId),
  ]);
  const seen = new Set<string>();
  const rows: Nest[] = [];
  for (const n of [...owned, ...shared, ...publicExtras]) {
    if (seen.has(n.id)) continue;
    if (nestScope && n.id !== nestScope) continue;
    seen.add(n.id);
    rows.push(n);
  }
  return Promise.all(
    rows.map(async (n) => {
      let permission: NestPermission = "read";
      try {
        permission =
          config.AUTH_MODE === "open"
            ? "owner"
            : await resolveNestPermission(n.id, userId);
      } catch {
        /* keep the conservative default */
      }
      // Doc count is best-effort — a nest with a broken vault folder should
      // not take the whole index down.
      let document_count: number | null = null;
      try {
        const { storage } = await engineCache.get(n.id);
        // Excludes the derived `— Annotations` projections, like every
        // listing does: this number is what an agent is told a nest holds
        // before it decides what to read, so it has to match what
        // context_list will actually return.
        document_count = (await storage.discoverDocuments()).filter(
          (d) => !isDerivedAnnotationsNode(d.id),
        ).length;
      } catch {
        /* count unavailable */
      }
      return {
        id: n.id,
        name: n.name,
        description: n.description,
        visibility: n.visibility,
        permission,
        document_count,
      };
    }),
  );
}

export function renderNestIndexMarkdown(
  nests: IndexedNest[],
  baseUrl: string,
): string {
  const lines = [
    "# Nest index",
    "",
    `${nests.length} nest${nests.length === 1 ? "" : "s"} accessible with these credentials. Full interaction manual: ${baseUrl}/llms.txt`,
    "",
  ];
  for (const n of nests) {
    lines.push(`## ${n.name}`);
    lines.push("");
    lines.push(`- id: \`${n.id}\``);
    if (n.description) lines.push(`- description: ${n.description}`);
    lines.push(`- permission: ${n.permission} · visibility: ${n.visibility}`);
    if (n.document_count !== null)
      lines.push(`- documents: ${n.document_count}`);
    lines.push(
      `- retrieve: \`POST ${baseUrl}/nests/${n.id}/context\` · mcp: \`${baseUrl}/nests/${n.id}/mcp\` · export: \`${baseUrl}/nests/${n.id}/export?format=markdown\``,
    );
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Server-level MCP ────────────────────────────────────────────────────

const NEST_ARG = {
  nest: {
    type: "string",
    description: "Target nest — id, or exact name/slug (case-insensitive)",
  },
} as const;

// Optional nest argument for fan-out read tools — omit to search/list across all nests
const NEST_ARG_OPTIONAL = {
  nest: {
    type: "string",
    description:
      "Target nest — id or name. Omit to search/list across ALL accessible nests.",
  },
} as const;

/**
 * Server-level MCP tools. Fan-out reads (search, list, query, overview) make
 * `nest` optional — omit to query all accessible nests. Targeted reads and
 * writes require `nest` to specify which nest to act on.
 */
export const SERVER_TOOL_DEFINITIONS = [
  {
    name: "nest_index",
    description:
      "Grounded index of every nest these credentials can read: name, id, permission, document count. Call this FIRST.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  // ─── Fan-out reads (nest optional) ─────────────────────────────────────
  {
    name: "context_query",
    description:
      "Run a structured selector query. Omit `nest` to query ALL accessible nests. Selector: #tag, type:X, [[Title]], scope:X, +AND, |OR, -NOT.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG_OPTIONAL,
        query: { type: "string", description: "Selector query" },
        hops: {
          type: "number",
          description: "Graph traversal depth from the matches (default: 2)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "context_search",
    description:
      "Full-text keyword search. Omit `nest` to search ALL accessible nests. Returns count and first `limit` hits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG_OPTIONAL,
        query: { type: "string", description: "Search terms" },
        limit: {
          type: "number",
          description: "Max hits to return (default 20, max 200)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "context_list",
    description:
      "Browse contents with optional type, tag, or limit filters. Omit `nest` to list ALL accessible nests.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG_OPTIONAL,
        type: { type: "string", description: "Filter by node type" },
        tag: { type: "string", description: "Filter by tag" },
        limit: { type: "number", description: "Max nodes to return" },
      },
    },
  },
  {
    name: "context_overview",
    description:
      "Map of nests: node count, types, tags, title+snippet per node. Omit `nest` for ALL accessible nests.",
    inputSchema: {
      type: "object" as const,
      properties: { ...NEST_ARG_OPTIONAL },
    },
  },
  // ─── Targeted reads (nest required) ────────────────────────────────────
  {
    name: "context_get",
    description: "Get the FULL content of a node in a nest by title or id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        title: { type: "string", description: "Title of the node" },
        id: { type: "string", description: "ID of the node" },
      },
      required: ["nest"],
    },
  },
  {
    name: "context_resolve",
    description:
      "Full deterministic context resolution against one nest — selector + hops + token budget, complete node bodies.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        selector: { type: "string", description: "Selector query string" },
        max_tokens: {
          type: "number",
          description: "Approximate token budget (default: 8000)",
        },
        hops: {
          type: "number",
          description: "Graph traversal depth from the matches (default: 2)",
        },
      },
      required: ["nest", "selector"],
    },
  },
  {
    // Read-only, so it belongs on this endpoint: an agent reading a nest's
    // documents across nests also needs the feedback left on them. Writing a
    // comment stays on the per-nest endpoint with the other write tools.
    name: "context_comments",
    description:
      "Get the review comments/annotations on a document in a nest — anchored quotes, threaded replies, and open/resolved status. Use to pull human feedback into context before acting on a document.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nest: { type: "string", description: "Nest name or id (see nest_index)" },
        title: { type: "string", description: "Title of the node" },
        id: { type: "string", description: "ID of the node" },
      },
      required: ["nest"],
    },
  },
  {
    name: "nest_create",
    description:
      "Create a new nest owned by the caller. Returns the new nest's id — target it with the other tools afterwards.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Nest name" },
        description: { type: "string", description: "Optional description" },
      },
      required: ["name"],
    },
  },
  // ─── Writes (nest required) ────────────────────────────────────────────
  {
    name: "context_create",
    description:
      "Create a new document in a nest. Needs write permission. A `folder` path creates the folder implicitly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        title: { type: "string", description: "Descriptive title" },
        content: { type: "string", description: "Markdown content body" },
        type: { type: "string", description: "Node type (default: document)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        scope: { type: "string", description: "Visibility scope" },
        folder: {
          type: "string",
          description:
            'Folder path under nodes/ (e.g. "gtm/deals"); segments are slugified',
        },
      },
      required: ["nest", "title", "content"],
    },
  },
  {
    name: "context_update",
    description:
      "Update an existing node by title or id. Needs write permission. Use `content` to replace, `append` to add.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        title: { type: "string", description: "Title of node to update" },
        id: { type: "string", description: "Node id (use when title is ambiguous)" },
        content: { type: "string", description: "New content (replaces)" },
        append: { type: "string", description: "Content to append" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to add" },
        status: { type: "string", description: "New status: draft|pending_review|approved|published" },
        changeNote: { type: "string", description: "Why this changed — recorded in history" },
      },
      required: ["nest"],
    },
  },
  {
    name: "context_delete",
    description:
      "Delete a node by title or id. Needs write permission. Irreversible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        title: { type: "string", description: "Title of node to delete" },
        id: { type: "string", description: "Node id (use when title is ambiguous)" },
      },
      required: ["nest"],
    },
  },
  {
    name: "context_move",
    description:
      "Move a node to a different folder. The id changes; history and links follow. Needs write permission.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        title: { type: "string", description: "Title of node to move" },
        id: { type: "string", description: "Node id (use when title is ambiguous)" },
        folder: { type: "string", description: 'Destination folder (e.g. "gtm/deals"); "" for root' },
      },
      required: ["nest", "folder"],
    },
  },
  {
    name: "context_submit_review",
    description:
      "Submit a node for steward review. Stewards will be notified. Use on governed nests.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        title: { type: "string", description: "Title of node to submit" },
        id: { type: "string", description: "Node id (use when title is ambiguous)" },
        note: { type: "string", description: "Note for the reviewer" },
        priority: { type: "string", description: "Priority: low, normal, high, urgent" },
      },
      required: ["nest"],
    },
  },
];

async function handleServerToolCall(
  toolName: string,
  args: any,
  userId: string,
  userEmail: string,
  nestScope: string | null,
  baseUrl: string,
  client?: ClientMetadata,
): Promise<ToolResult> {
  if (toolName === "nest_index") {
    const nests = await buildNestIndex(userId, nestScope);
    if (!nests.length) return "No nests accessible with these credentials.";
    return renderNestIndexMarkdown(nests, baseUrl);
  }

  // Kill-switch + license gate for writes — parity with per-nest write path.
  if (SERVER_WRITE_TOOLS.has(toolName)) {
    if (isSuspended()) {
      const reason = getSuspensionReason();
      return `This server is suspended by PromptOwl; writes are blocked${
        reason ? ` — ${reason}` : ""
      }. Contact support@promptowl.ai.`;
    }
    if (!getCurrentLicense()?.valid) {
      return "This server has no valid PromptOwl license installed, so writes are disabled. Ask the server admin to install one (POST /license/install).";
    }
  }

  if (toolName === "nest_create") {
    if (nestScope) {
      return "This credential is scoped to a single nest and cannot create new ones.";
    }
    try {
      const nest = await createNest(
        userId,
        String(args.name ?? ""),
        args.description ? String(args.description) : undefined,
      );
      return `Created nest "${nest.name}" (id: ${nest.id}). Add documents with context_create, retrieve with the other tools.`;
    } catch (err) {
      if (err instanceof ValidationError) return err.message;
      throw err;
    }
  }

  // ─── Fan-out reads when nest is omitted ────────────────────────────────
  // For search/list/query/overview: run across ALL accessible nests and combine.
  const nestArg = args.nest;
  if (!nestArg && FANOUT_READ_TOOLS.has(toolName)) {
    const nests = await buildNestIndex(userId, nestScope);
    if (!nests.length) return "No nests accessible with these credentials.";

    // Filter to nests with content (skip empty nests for fan-out)
    const nonEmpty = nests.filter((n) => (n.document_count ?? 0) > 0);
    if (!nonEmpty.length) {
      return "All accessible nests are empty. Use context_create to add documents first.";
    }

    // Run tool against each nest in parallel, combine results
    const results = await Promise.allSettled(
      nonEmpty.map(async (n) => {
        const engine = await engineCache.get(n.id);
        const result = await handleToolCall(toolName, args, {
          storage: engine.storage,
          queryEngine: engine.query,
          versionManager: engine.versions,
          nestId: n.id,
          userId,
          userEmail,
          baseUrl,
          // Same attribution the single-nest branch below passes (§9.4). A
          // fan-out read is still one call per nest on the trace, and each row
          // has to name the caller — without this the derived agent/session is
          // dropped and only an explicit `client` in the args survives.
          client,
        });
        return { nest: n, result };
      }),
    );

    // Combine successful results with nest headers
    const parts: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        const { nest: n, result } = r.value;
        const text = typeof result === "string" ? result : result.text;
        parts.push(`## ${n.name} (${n.id})\n\n${text}`);
      }
      // Skip failed nests silently (best-effort, like nest_index)
    }

    if (!parts.length) {
      return "No results found across any accessible nests.";
    }
    return parts.join("\n\n---\n\n");
  }

  // ─── Single-nest operations (nest required) ────────────────────────────
  // One indistinguishable message for "doesn't exist", "out of key scope",
  // and "no read grant" — no existence oracle.
  const inaccessible = `Nest not found or not accessible: "${nestArg}". Use nest_index to see what these credentials can read.`;

  if (!nestArg) {
    // Fan-out not supported for this tool — nest is required
    return "This tool requires a `nest` argument. Use nest_index to see available nests.";
  }

  const nest = await resolveNestRef(String(nestArg), userId);
  if (!nest) return inaccessible;
  if (nestScope && nest.id !== nestScope) return inaccessible;
  if (!(await canRead(nest.id, userId))) return inaccessible;

  const engine = await engineCache.get(nest.id);
  return handleToolCall(toolName, args, {
    storage: engine.storage,
    queryEngine: engine.query,
    versionManager: engine.versions,
    nestId: nest.id,
    userId,
    userEmail,
    baseUrl,
    client,
  });
}

function createServerMcp(
  userId: string,
  userEmail: string,
  nestScope: string | null,
  baseUrl: string,
  c: Context<AuthEnv>,
): McpServer {
  const server = new McpServer(
    { name: "contextnest-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  for (const tool of SERVER_TOOL_DEFINITIONS) {
    const props = (tool.inputSchema as any).properties || {};
    const required = (tool.inputSchema as any).required || [];
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, def] of Object.entries(props) as Array<[string, any]>) {
      let field: z.ZodTypeAny;
      if (def.type === "string") field = z.string();
      else if (def.type === "number") field = z.number();
      else if (def.type === "array") field = z.array(z.string());
      else field = z.any();
      if (!required.includes(key)) field = field.optional();
      shape[key] = field;
    }
    // Same §9.4 field the per-nest surface advertises.
    Object.assign(shape, clientToolField);
    server.tool(tool.name, tool.description, shape, async (args) => {
      // See mcp/routes.ts: resolved per call, because the handshake that
      // reports `clientInfo` completes inside the transport.
      // Its stash on the request is inert here too — see mcp/routes.ts.
      const out = await handleServerToolCall(
        tool.name,
        args,
        userId,
        userEmail,
        nestScope,
        baseUrl,
        attributeRequest(c, undefined, connectionClient(server)),
      );
      return toCallToolResult(out);
    });
  }
  return server;
}

export const serverMcpRoutes = new Hono<AuthEnv>();

// POST/GET/DELETE /mcp — stateless, one server per request, same transport
// shape as the per-nest endpoint.
serverMcpRoutes.all("/", async (c) => {
  const userId = c.get("userId");
  const userEmail = await getUserEmail(userId);
  const server = createServerMcp(
    userId,
    userEmail,
    c.get("nestScope"),
    requestBaseUrl(c.req.url),
    c,
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    await transport.close();
    await server.server.close();
  }
});

// ─── GET /index — the person nest index ──────────────────────────────────

export const nestIndexRoutes = new Hono<AuthEnv>();

nestIndexRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const nests = await buildNestIndex(userId, c.get("nestScope"));
  if (c.req.query("format") === "json") {
    return c.json({ count: nests.length, nests });
  }
  const md = renderNestIndexMarkdown(nests, requestBaseUrl(c.req.url));
  return c.text(md, 200, { "Content-Type": "text/markdown; charset=utf-8" });
});

// ─── GET /llms.txt — the agent manual ────────────────────────────────────

/**
 * Everything an agent needs to interact with this server, in one public
 * URL. No secrets — it documents shapes, not data. Deliberately follows
 * the llms.txt convention so "point Claude at <server>/llms.txt" works.
 */
export function renderLlmsTxt(baseUrl: string): string {
  const B = baseUrl || "<server-url>";
  return `# ContextNest Community Server

Self-hosted context governance server. Nests are versioned knowledge vaults
of markdown documents with tags, wiki-links ([[Title]]), and steward
governance. This file is the complete interaction manual for agents.

## Authentication

Every request (except this file and /health): \`Authorization: Bearer cnst_<api-key>\`.
Keys are minted in the web UI (Connect dialog → Generate Key). A key is
either user-level (sees every nest the user can read) or scoped to one nest.
Servers in "open" auth mode need no key.

## Start here

1. \`GET ${B}/index\` — your grounded nest index (markdown; \`?format=json\` for JSON).
   One entry per accessible nest: name, id, permission, document count, and
   the per-nest URLs below.
2. Pick a nest id, then retrieve with the API or MCP.

## Deterministic retrieval API

Same inputs → same context, every time. The primary call:

\`\`\`
POST ${B}/nests/<nest-id>/context
Content-Type: application/json
{ "selector": "#gtm", "hops": 2, "max_tokens": 4000, "include_drafts": false }
\`\`\`

Returns \`{ context, nodes[], trace }\` — assembled markdown plus a trace with
\`hops_used\` and \`nodes_traversed\` so you can audit exactly what was pulled.

Selector grammar:
- \`#tag\` — nodes carrying a tag
- \`type:document\` — nodes of a type
- \`[[Title]]\` — a node by exact title
- \`scope:team\` — nodes by visibility scope
- Combine: \`+AND\`, \`|OR\`, \`-NOT\` (e.g. \`#gtm+type:document-#draft\`)

Graph-hop logic: \`hops\` is the traversal depth over wiki-links from the
selector matches. \`hops: 0\` = exactly the matches; \`hops: 1\` = matches plus
directly linked nodes; \`hops: 2\` (default) and up walk the link graph
further out. For an exact set with no expansion, OR the selectors together
(\`[[A]]|[[B]]\`) and pass \`hops: 0\`.

Skip logic — what retrieval excludes and why:
- Draft/unapproved documents are skipped unless \`include_drafts: true\`
  (and public/read-only callers always get approved content only).
- \`max_tokens\` is a budget: documents that don't fit are skipped, and the
  trace reports \`truncated_by_budget\` so silence never means "complete".
- Documents are deduped by id when a title match and a selector match overlap.

Other read endpoints (all under \`${B}/nests/<nest-id>\`):
- \`POST /query\` — \`{ "query": "<selector>", "hops": N }\`; matches + snippets, no bodies
- \`GET /search?q=<terms>\` — full-text search
- \`GET /overview\` — node count, types, tags
- \`GET /nodes\` — list; \`GET /nodes/<node-id>?format=markdown\` — one document
- \`GET /nodes/<node-id>?format=raw\` — direct consumption path: the node BODY as plain text (no JSON envelope; add \`&frontmatter=1\` for the stored YAML block)
- \`GET /export?format=markdown\` — whole nest as one markdown file (optional \`selector\`, \`max_tokens\`)
- \`GET /graph\` — ontology graph (nodes, links, tags, stewards)
- \`GET /folders\` — folder tree; \`GET /nodes?folder=<path>\` — one folder level
- \`POST /table-query\` — exact rows from a table node: \`{ "table": "[[Title]]", "query": "where <col> <op> <value> [select cols] [limit N]" }\`
- \`GET /nodes/<node-id>/versions\` — history (who, when, approval state); \`/versions/<n>\` — one version
- \`GET /nodes/<node-id>/comments\` — review threads (anchored quotes, replies, open/resolved)

Write endpoints (need write permission):
- \`POST /nodes\` — \`{ "title", "content", "tags"?, "type"?, "folder"? }\`
- \`PATCH /nodes/<node-id>\` — \`{ "content"? , "append"?, "tags"?, "title"? }\`
- \`DELETE /nodes/<node-id>\`; \`POST /nodes/<id>/request-deletion\` when you lack delete rights
- \`POST /nodes/<id>/move\` — \`{ "folder" }\`; history and comments follow
- \`POST /nodes/<id>/revert\` — \`{ "targetVersion" }\` restores a past version as a new one
- \`POST /nodes/<id>/comments\` — leave or reply to a review comment
- Governance: \`POST /nodes/<id>/submit-review\`, \`/approve\`, \`/reject\`, \`/cancel-review\`
- \`GET /review-queue\` — what is waiting on a steward in this nest

## Your inbox (server-level)

- \`GET ${B}/me/work\` — reviews waiting on you and handoffs, across every nest
- \`GET ${B}/me/drafts\` — your documents never submitted for review
- \`GET ${B}/me/notifications\` — watcher and review notifications

## Say who you are: \`client\`

Every write body and every MCP tool call takes an optional
\`client\` object — \`{ "agent": "claude-code", "session_id": "s-9f2" }\`, plus any
custom scalar keys. A write that seals a version records it on that version
(\`GET /nodes/<id>/versions\` and \`context_versions\` serve it back); every call
records it on this server's activity trace, which is how a READ gets attributed.

Send it. Nothing requires it and no call is refused for omitting it, but a vault
serving several agents cannot otherwise tell which of you wrote what. It is a
label, never an identity claim: it is not authenticated, grants nothing, and is
never part of a hash. Bounded — scalar values up to 512 chars, at most 16 custom
keys beyond \`agent\` and \`session_id\`.

## MCP (Model Context Protocol)

Streamable HTTP, stateless. Two endpoints:

- \`${B}/mcp\` — server-level, one connection for everything.
  Tools: \`nest_index\` (call first), then:
  - Fan-out reads (omit \`nest\` to search/list ALL nests): \`context_search\`,
    \`context_list\`, \`context_query\`, \`context_overview\`
  - Targeted reads (\`nest\` required): \`context_get\`, \`context_resolve\`, \`context_comments\`
  - Writes (\`nest\` required): \`nest_create\`, \`context_create\`, \`context_update\`,
    \`context_delete\`, \`context_move\`, \`context_submit_review\`
- \`${B}/nests/<nest-id>/mcp\` — per-nest, the full toolset. Same names as the
  server-level tools without the \`nest\` argument, plus:
  - read: \`context_init\` (operating instructions — call first), \`context_export\`, \`context_table_query\`, \`context_versions\`
  - write: \`context_update\`, \`context_delete\`, \`context_move\`, \`context_request_deletion\`
  - review: \`context_submit_review\`, \`context_approve\`, \`context_reject\`, \`context_review_queue\`, \`context_my_drafts\`
  - comments: \`context_comment\`, \`context_resolve_comment\`
  - people: \`context_stewards\`, \`context_assign_steward\`, \`context_share_nest\`, \`context_grant\`
  - admin: \`context_deletion_queue\`, \`context_resolve_deletion\`, \`context_unsynced_list\`, \`context_sync_folder\`
  - \`workflow_*\` (runs, edges, edge types) when the nest's workflow plane is on
  Sharing a slice is one call: \`context_grant\` with
  \`{ "email", "target_type": "document" | "folder", "target", "role": "read" | "write" }\`
  — \`target\` is a node id (\`nodes/win-loss-log\`) or a folder prefix
  (\`nodes/gtm/deals\`). The recipient reaches exactly that document, or
  everything under that folder, and nothing else in the nest. Owner/admin only.

Claude Code / Cursor / VS Code connect natively via HTTP with the
\`Authorization: Bearer\` header. Claude Desktop needs the mcp-remote bridge:

\`\`\`
npx -y mcp-remote ${B}/mcp --header "Authorization: Bearer <api-key>"
\`\`\`

## From the ctx CLI

The \`ctx\` CLI (\`@promptowl/contextnest-cli\` 2.2+) reads a hosted nest the
same way it reads a local vault: register the MCP endpoint as a vault alias,
then pass \`--vault <alias>\` to \`query\`, \`read\`, \`list\`, \`search\`. The key
is read from the environment variable named by \`--bearer-env\` — never put it
on the command line.

\`\`\`
export CONTEXTNEST_API_KEY=<api-key>
# every nest these credentials can read, through the server-level endpoint
ctx vault add contextnest --url ${B}/mcp --bearer-env CONTEXTNEST_API_KEY
# or one nest
ctx vault add mynest --url ${B}/nests/<nest-id>/mcp --bearer-env CONTEXTNEST_API_KEY
ctx query "#gtm" --vault mynest
\`\`\`

Servers in "open" auth mode: drop \`--bearer-env\`. Pushing a local folder up
is \`ctx push --server ${B} --nest <nest-id>\` with the same env var set.

## npm packages

- \`@promptowl/contextnest-community\` — this server
- \`@promptowl/contextnest-engine\` — vault storage + selector/graph engine

## Conventions

- Node ids are paths: \`nodes/<slug>\` or nested \`nodes/<folder>/<slug>\`.
- Tags are \`#lowercase\`. Wiki-links are \`[[Exact Title]]\`.
- Every write is versioned and hash-chained; governed nests route writes
  through steward review before they become AI-visible.
`;
}

export const llmsTxtRoutes = new Hono();

llmsTxtRoutes.get("/", (c) => {
  const md = renderLlmsTxt(requestBaseUrl(c.req.url));
  return c.text(md, 200, { "Content-Type": "text/markdown; charset=utf-8" });
});
