/**
 * Server-level agent entry point — connect ONCE to the server with one key
 * and see everything that key can touch, instead of a connection per nest:
 *
 *   GET  /llms.txt  — public agent manual: endpoints, MCP, selector grammar,
 *                     hop/skip retrieval semantics, npm packages
 *   GET  /index     — the caller's grounded nest index (markdown or json)
 *   ALL  /mcp       — stateless MCP endpoint: nest_index + cross-nest read
 *                     tools that take a `nest` (id or name) argument
 *
 * Write tools stay on the per-nest endpoint (/nests/:id/mcp) — cross-nest
 * mutation through one socket makes authz mistakes easy; reads are gated
 * per call via resolveNestPermission. Nest-scoped API keys are honored:
 * the index and every cross-nest call are restricted to the scoped nest.
 *
 * Two narrow exceptions to read-only, so single-connection clients (the
 * PromptOwl native tool) can bootstrap content: `nest_create` (caller owns
 * the new nest — no cross-nest authz to get wrong) and `context_create`
 * (gated by handleToolCall's own stewardship.canCreateInNest check, the
 * same PRIMARY write gate the per-nest endpoint uses). Everything else —
 * updates, governance, sharing — still requires the per-nest endpoint.
 */
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { requestBaseUrl } from "../shared/base-url.js";
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
import type { Nest } from "../shared/types.js";

// Server-level tools that mutate. The top-level /mcp route carries no
// suspend/license middleware (unlike the per-nest access guard), so the
// kill-switch + license gates that every per-nest write honors must be
// enforced here or these two writes would bypass both. Reads stay open when
// suspended/unlicensed, matching the REST policy.
const SERVER_WRITE_TOOLS = new Set(["nest_create", "context_create"]);

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
  const byId = (await db.get("SELECT * FROM nests WHERE id = ?", [ref])) as
    | Nest
    | undefined;
  if (byId) return byId;
  const byName = (await db.all(
    "SELECT * FROM nests WHERE LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?)",
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
        document_count = (await storage.discoverDocuments()).length;
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

/**
 * Nest-parameterized mirrors of the per-nest tools, plus nest_index and the
 * two bootstrap writes (nest_create, context_create). Same names as the
 * per-nest tools so agent muscle memory transfers; the extra `nest` argument
 * is the only difference.
 */
export const SERVER_TOOL_DEFINITIONS = [
  {
    name: "nest_index",
    description:
      "Grounded index of every nest these credentials can read: name, id, permission, document count. Call this FIRST, then target a nest with the other tools.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "context_query",
    description:
      "Run a structured selector query against one nest. Selector grammar: #tag, type:X, [[Title]], scope:X, combined with +AND, |OR, -NOT.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        query: { type: "string", description: "Selector query" },
        hops: {
          type: "number",
          description: "Graph traversal depth from the matches (default: 2)",
        },
      },
      required: ["nest", "query"],
    },
  },
  {
    name: "context_search",
    description: "Full-text keyword search across one nest.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        query: { type: "string", description: "Search terms" },
      },
      required: ["nest", "query"],
    },
  },
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
    name: "context_list",
    description:
      "Browse one nest's contents with optional type, tag, or limit filters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...NEST_ARG,
        type: { type: "string", description: "Filter by node type" },
        tag: { type: "string", description: "Filter by tag" },
        limit: { type: "number", description: "Max nodes to return" },
      },
      required: ["nest"],
    },
  },
  {
    name: "context_overview",
    description:
      "Map of one nest: node count, types, tags, title+snippet per node.",
    inputSchema: {
      type: "object" as const,
      properties: { ...NEST_ARG },
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
  {
    name: "context_create",
    description:
      "Create a new knowledge node (document) in a nest. Needs write permission on that nest. A `folder` path creates the folder implicitly — folders exist through the nodes placed in them.",
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
];

async function handleServerToolCall(
  toolName: string,
  args: any,
  userId: string,
  userEmail: string,
  nestScope: string | null,
  baseUrl: string,
): Promise<ToolResult> {
  if (toolName === "nest_index") {
    const nests = await buildNestIndex(userId, nestScope);
    if (!nests.length) return "No nests accessible with these credentials.";
    return renderNestIndexMarkdown(nests, baseUrl);
  }

  // Kill-switch + license gate for the bootstrap writes — parity with the
  // per-nest write path (app.ts nest access guard). Without this, a suspended
  // or unlicensed server would still accept nest_create / context_create here.
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
    // A nest-scoped key is confined to its one nest — minting new nests
    // would exceed the scope the key was issued for.
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

  // One indistinguishable message for "doesn't exist", "out of key scope",
  // and "no read grant" — otherwise the tool becomes an existence oracle
  // for other users' private nests (probe by name, compare messages).
  const inaccessible = `Nest not found or not accessible: "${args.nest}". Use nest_index to see what these credentials can read.`;
  const nest = await resolveNestRef(String(args.nest ?? ""), userId);
  if (!nest) return inaccessible;
  if (nestScope && nest.id !== nestScope) return inaccessible;
  if (!(await canRead(nest.id, userId))) return inaccessible;
  // context_create needs no extra gate here: handleToolCall's own
  // stewardship.canCreateInNest check is the canonical write gate (the
  // per-nest endpoint relies on the same one).

  const engine = await engineCache.get(nest.id);
  return handleToolCall(toolName, args, {
    storage: engine.storage,
    queryEngine: engine.query,
    versionManager: engine.versions,
    nestId: nest.id,
    userId,
    userEmail,
    baseUrl,
  });
}

function createServerMcp(
  userId: string,
  userEmail: string,
  nestScope: string | null,
  baseUrl: string,
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
    server.tool(tool.name, tool.description, shape, async (args) => {
      const out = await handleServerToolCall(
        tool.name,
        args,
        userId,
        userEmail,
        nestScope,
        baseUrl,
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

Write endpoints (need write permission):
- \`POST /nodes\` — \`{ "title", "content", "tags"?, "type"?, "folder"? }\`
- \`PATCH /nodes/<node-id>\` — \`{ "content"? , "append"?, "tags"?, "title"? }\`
- \`DELETE /nodes/<node-id>\`
- Governance: \`POST /nodes/<id>/submit-review\`, \`/approve\`, \`/reject\`

## MCP (Model Context Protocol)

Streamable HTTP, stateless. Two endpoints:

- \`${B}/mcp\` — server-level, one connection for everything readable.
  Tools: \`nest_index\` (call first), then \`context_query\`, \`context_search\`,
  \`context_get\`, \`context_list\`, \`context_overview\`, \`context_resolve\` —
  each takes a \`nest\` argument (id or exact name) plus the same
  selector/hops/max_tokens parameters as the REST API. Two bootstrap writes:
  \`nest_create\` (new nest owned by the caller) and \`context_create\`
  (new document in a writable nest; a \`folder\` path creates the folder).
- \`${B}/nests/<nest-id>/mcp\` — per-nest, full toolset including writes and
  governance (create/update, submit/approve/reject, stewards, sharing).

Claude Code / Cursor / VS Code connect natively via HTTP with the
\`Authorization: Bearer\` header. Claude Desktop needs the mcp-remote bridge:

\`\`\`
npx -y mcp-remote ${B}/mcp --header "Authorization: Bearer <api-key>"
\`\`\`

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
