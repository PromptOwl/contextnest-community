import type {
  NestStorage,
  GraphQueryEngine,
  VersionManager,
  ContextNode,
} from "@promptowl/contextnest-engine";
import * as stewardship from "../governance/stewardship-service.js";
import * as reviews from "../governance/review-service.js";
import * as versions from "../governance/version-service.js";
import { loadStewardsConfig } from "../governance/stewards-parser.js";
import { canReadNode } from "../governance/access-guard.js";
import {
  resolveNestPermission,
  permissionLevel,
} from "../shared/access.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { addCollaborator } from "../nests/sharing-service.js";
import { queryTableNode } from "../tables/query.js";
import {
  listUnsyncedFolders,
  syncUnsyncedFolder,
} from "../nests/unsynced-service.js";
import { isServerAdminUserId } from "../shared/access.js";
import { config } from "../config.js";
import {
  createNode,
  updateNode,
  deleteNode,
  deleteFolder,
  moveNode,
  listNodesForCallerByEmail,
  isIdUnderFolder,
} from "../nodes/service.js";
import { deleteNest } from "../nests/service.js";
import { listThreads } from "../annotations/service.js";
import { withNodeWriteLock, nodeWriteKey } from "../shared/node-write-lock.js";
import { logTraceEvent } from "../telemetry/trace-log.js";
import { isWorkflowTool, runWorkflowTool } from "./workflow-tools.js";

/** Upper bound on caller-set traversal depth — real graphs terminate long
 *  before this; the cap just fences a misbehaving client from a runaway query. */
const MAX_HOPS = 10;

/** Caller-supplied traversal depth → integer in [0, MAX_HOPS], default 2.
 *  null/undefined/non-numeric all fall through to the default (some tool-calling
 *  clients serialize an unset optional arg as JSON `null` rather than omitting). */
export function normalizeHops(raw: unknown): number {
  if (raw == null) return 2;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(MAX_HOPS, Math.floor(n)));
}

export interface McpToolContext {
  storage: NestStorage;
  queryEngine: GraphQueryEngine;
  versionManager: VersionManager;
  nestId: string;
  userId: string;
  userEmail: string;
  /** Request origin, so review actions taken via MCP produce notification
   *  emails with a working "Open document" link (no PUBLIC_BASE_URL needed). */
  baseUrl?: string;
}

export const TOOL_DEFINITIONS = [
  {
    name: "context_init",
    description:
      "Load the vault's CONTEXT.md which contains operating instructions and behavioral guidelines. Call this FIRST in every conversation.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "context_overview",
    description:
      "Get a complete map of the vault: total node count, types, tags, and a title+snippet for every node.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "context_search",
    description:
      "Full-text keyword search across all node content, titles, tags, and metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search terms" },
      },
      required: ["query"],
    },
  },
  {
    name: "context_query",
    description:
      "Run a structured selector query. Supports: #tag, type:X, [[Title]], scope:X. Combine with +AND, |OR, -NOT.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Selector query" },
        hops: {
          type: "number",
          description:
            "Graph traversal depth from the matched nodes (default: 2). Use 1 for just the matches + direct links, higher to pull in more of the neighborhood.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "context_table_query",
    description:
      "Deterministic lookup against a TABLE node (CSV fact store). Fetch exact rows instead of reading the whole table: where <col> <op> <value> [and …] [select cols] [limit N]. Ops: = != > >= < <= contains. Same query + same version = same rows, always.",
    inputSchema: {
      type: "object" as const,
      properties: {
        table: {
          type: "string",
          description: 'The table node — "[[Title]]" or a node id like nodes/price-list',
        },
        query: {
          type: "string",
          description:
            'e.g. where region = "EU" and price > 100 select sku, price limit 5. Empty = all rows.',
        },
      },
      required: ["table"],
    },
  },
  {
    name: "context_get",
    description: "Get the FULL content of a specific node by title or ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the node" },
        id: { type: "string", description: "ID of the node" },
      },
    },
  },
  {
    name: "context_list",
    description:
      "Browse vault contents with optional type, tag, status, or limit filters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", description: "Filter by node type" },
        tag: {
          type: "string",
          description: "Filter by tag (leading # optional, case-insensitive)",
        },
        status: {
          type: "string",
          description:
            "Filter by status: draft | pending_review | approved | published | rejected. Aliases normalized. Retired nodes are hidden unless asked for.",
        },
        limit: { type: "number", description: "Max nodes to return" },
      },
    },
  },
  {
    name: "context_resolve",
    description:
      "Full context resolution — run a selector and return complete node content, respecting a token budget.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "Selector query string",
        },
        max_tokens: {
          type: "number",
          description: "Approximate token budget (default: 8000)",
        },
        hops: {
          type: "number",
          description:
            "Graph traversal depth from the matched nodes (default: 2)",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "context_export",
    description:
      "Export the ENTIRE nest as one markdown bundle — every accessible document's FULL content. Use when you need the whole nest as context rather than a targeted query. Respects an optional token budget.",
    inputSchema: {
      type: "object" as const,
      properties: {
        max_tokens: {
          type: "number",
          description:
            "Approximate token budget; documents are included until it's reached (omit for no cap).",
        },
      },
    },
  },
  {
    name: "context_comments",
    description:
      "Get the review comments/annotations on a document — anchored quotes, threaded replies, and open/resolved status — by title or ID. Use to pull human feedback into context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the node" },
        id: { type: "string", description: "ID of the node" },
      },
    },
  },
  {
    name: "context_create",
    description:
      "Create a new knowledge node in the vault. The title must not already be in use — these tools resolve documents by title, so a duplicate is refused rather than filed as an unreachable twin. To change an existing document use context_update; to refile it use context_move.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Descriptive title" },
        content: {
          type: "string",
          description: "Markdown content body",
        },
        type: {
          type: "string",
          description:
            "Node type (default: document). Note: artifact and table can be disabled server-wide by an admin — creating a disabled type is rejected; existing nodes of that type stay readable.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags",
        },
        scope: { type: "string", description: "Visibility scope" },
        folder: {
          type: "string",
          description:
            'Folder path under nodes/ (e.g. "gtm/deals"); segments are slugified. A leading "nodes/" is accepted and not doubled, so "nodes/gtm/deals" and "gtm/deals" mean the same folder.',
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "context_update",
    description:
      "Update an existing node — replace or append content, set tags, move it through its lifecycle. Whether the edit publishes is decided by this nest's stewardship rules, not by the caller.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          // Selects the node; it does NOT rename it. Titles are unique here
          // precisely so MCP callers can address a document this way. Renaming
          // is not reachable from this tool.
          type: "string",
          description: "Title of node to update (selects it; does not rename)",
        },
        content: {
          type: "string",
          description: "New content (replaces)",
        },
        append: { type: "string", description: "Content to append" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to add",
        },
        status: {
          type: "string",
          description:
            "New lifecycle status: draft | pending_review | approved | published | rejected. Aliases are normalized.",
        },
        changeNote: {
          type: "string",
          description: "Why this changed — recorded in version history",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "context_delete",
    // Mirrors the engine's canonical `context_delete` operation (core
    // namespace, alias delete_document): same name, same {id, title} input,
    // same "deleted" semantics. The engine's `uri` field is omitted — this
    // repo has no contextnest:// resolver on any surface, so accepting one
    // would promise a resolution it can't do.
    description:
      "Delete a node from the vault by title or id. Removes everything keyed to it: version history, review state, annotations, comments, watchers, schedules, trigger hooks, workflow edges, document grants, and any steward assignments scoped to it. Irreversible — the node must be recreated to come back, and it comes back clean: no history, no stewards, no shares. A node under open review is frozen unless you can approve it (owner, admin, or its reviewer).",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of node to delete" },
        id: {
          type: "string",
          description:
            'Node id / path (e.g. "nodes/gtm/deals/win-loss-log"). Use instead of title when two nodes share a title or the title is unknown.',
        },
      },
    },
  },
  {
    name: "context_move",
    // NOT in the engine's operation catalog — `move` is a community-edition
    // concern (the id rewrite spans governance tables the engine doesn't own).
    // This mirrors the existing REST POST /nodes/:id/move rather than adding a
    // new concept, so the surfaces agree. If move is ever promoted to a core
    // operation upstream, adopt that descriptor and drop this schema.
    description:
      "Move a node to a different folder. The id changes; version history, review state, annotations, comments, watchers, schedules, links, and document grants all follow. The title and its [[wiki-link]] stay valid. A node under open review is frozen unless you can approve it (owner, admin, or its reviewer).",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of node to move" },
        id: {
          type: "string",
          description:
            'Node id / path (e.g. "nodes/gtm/deals/win-loss-log"). Use instead of title when two nodes share a title or the title is unknown.',
        },
        folder: {
          type: "string",
          description:
            'Destination folder under nodes/ (e.g. "gtm/deals"); segments are slugified. Use "" to move to the nest root.',
        },
      },
      required: ["folder"],
    },
  },

  // ─── Governance Tools ───────────────────────────────────────────────

  {
    name: "context_stewards",
    description:
      "Show who the data stewards are for a specific node, or list all stewards for the vault. Stewards are the people who approve or reject changes before they go live.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Title of node to resolve stewards for (optional — omit for all stewards)",
        },
      },
    },
  },
  {
    // Deletion requests, mirroring the REST + UI flow: anyone who can READ a
    // thing may ask for it to be deleted; only an owner/admin resolves it.
    // Not in the engine catalog (1.2.1) — deletion requests live in this
    // repo's governance tables, which the engine doesn't own. Adopt an engine
    // descriptor here if the operation is ever promoted upstream.
    name: "context_request_deletion",
    description:
      "Ask for something to be deleted when you can't delete it yourself. Flags a document, a folder (with everything in it), or the whole nest for a nest owner/admin to action. Nothing is removed by this call — it opens a request, and the person who resolves it either deletes the target or declines with a note. Use this instead of context_delete when that returns a permission error, or when the document belongs to someone else.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the document to flag" },
        id: {
          type: "string",
          description:
            'Document id / path (e.g. "nodes/gtm/deals/win-loss-log"). Use instead of title when two documents share a title.',
        },
        folder: {
          type: "string",
          description:
            'Flag a whole folder instead of a document — the path, e.g. "gtm/deals". Every document under it goes if the request is honoured.',
        },
        nest: {
          type: "boolean",
          description:
            "Flag the ENTIRE nest for deletion. Only an owner/admin can honour it.",
        },
        reason: {
          type: "string",
          description:
            "Why it should be deleted. Required — this is what the admin judges.",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "context_deletion_queue",
    description:
      "Show deletion requests waiting on a nest owner/admin: what was flagged, who asked, and why. Use the request id with context_resolve_deletion to action one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          description:
            "pending (default) or declined — declined shows past verdicts and their notes.",
        },
      },
    },
  },
  {
    name: "context_resolve_deletion",
    description:
      "Action a deletion request: delete the flagged document/folder/nest, or decline it with a note explaining why it stays. Owner/admin only. Declining tells the requester the verdict; deleting is irreversible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        request_id: {
          type: "string",
          description: "Request id from context_deletion_queue",
        },
        action: {
          type: "string",
          description: '"delete" to honour it, "decline" to keep the target',
        },
        note: {
          type: "string",
          description: "Why you declined. Required when action is decline.",
        },
      },
      required: ["request_id", "action"],
    },
  },
  {
    name: "context_review_queue",
    description:
      "Show documents pending review. These need a steward to approve or reject them before they become available to AI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          description: "Filter by status: pending (default), approved, rejected, cancelled",
        },
      },
    },
  },
  {
    name: "context_my_drafts",
    description:
      "List YOUR unsubmitted drafts in this nest — documents you wrote that were never submitted for review (plus any that came back rejected). These are invisible to the review queue and unreadable by AI queries until submitted and approved. Use context_submit_review to hand one to a steward.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "context_submit_review",
    description:
      "Submit a node for steward review. The node will be marked as pending review and stewards will be notified.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the node to submit" },
        note: { type: "string", description: "Optional note for the reviewer" },
        priority: { type: "string", description: "Priority: low, normal (default), high, urgent" },
      },
      required: ["title"],
    },
  },
  {
    name: "context_approve",
    description:
      "Approve a node that is pending review. Only stewards with approval permission can do this. The approved version becomes available to AI queries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the node to approve" },
        note: { type: "string", description: "Optional approval note" },
      },
      required: ["title"],
    },
  },
  {
    name: "context_reject",
    description:
      "Reject a node that is pending review with a required note explaining what needs to change. Only stewards can reject.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the node to reject" },
        note: { type: "string", description: "Required: explain what needs to change" },
      },
      required: ["title", "note"],
    },
  },
  {
    name: "context_versions",
    description:
      "Show the version history of a node — all edits, who made them, their approval status, and which version is currently approved for AI use.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the node" },
      },
      required: ["title"],
    },
  },
  {
    name: "context_assign_steward",
    description:
      "Assign a data steward to govern a scope (nest, tag, or specific document). Stewards review and approve changes before they go live.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Email of the person to assign as steward" },
        scope: { type: "string", description: "Scope: nest (all docs), tag, or document" },
        target: { type: "string", description: "Scope target: tag name (e.g. #architecture) or document title" },
        role: { type: "string", description: "Role: reviewer (default), editor, or viewer" },
      },
      required: ["email", "scope"],
    },
  },
  {
    name: "context_share_nest",
    description:
      "Share this nest with another person by granting them access. This is plain access sharing (not a steward role): viewer = read, editor = read+edit, admin = full access except deleting the nest.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Email of the person to share with" },
        permission: {
          type: "string",
          description: "Access level: read (viewer, default), write (editor), or admin",
        },
      },
      required: ["email"],
    },
  },
  {
    name: "context_grant",
    description:
      "Share a SINGLE document or a FOLDER with a person (not the whole nest). The recipient can reach exactly that document (or everything under that folder) and nothing else. read = view, write = view+edit. Owner/admin only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Email of the person to share with" },
        target_type: {
          type: "string",
          description: "'document' to share one node, or 'folder' to share a path prefix",
        },
        target: {
          type: "string",
          description:
            "Node id (e.g. nodes/win-loss-log) for a document, or a folder prefix (e.g. nodes/gtm/deals) for a folder",
        },
        role: { type: "string", description: "read (default) or write" },
      },
      required: ["email", "target_type", "target"],
    },
  },

  // ─── Unsynced Folder Tools ─────────────────────────────────────────

  {
    name: "context_unsynced_list",
    description:
      "List folders under the data root that are sync candidates — dropped in by the starter CLI or copied in manually, not yet converted into a nest. Server-admin only in non-open mode.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "context_sync_folder",
    description:
      "Convert a sibling folder under the data root into a real nest. Imports its markdown, seeds governance, and removes the source folder. Use context_unsynced_list to discover folder names. Server-admin only in non-open mode.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Folder path relative to the data root (e.g. 'nodes/architecture'), as returned by context_unsynced_list.",
        },
      },
      required: ["name"],
    },
  },
];

// Resolve the LLM-visible body for a node. When the nest enforces
// stewardship, the LLM must NEVER see post-approval edits — return the
// reconstructed approved version. Without stewardship, the latest
// on-disk body is fine (every save is auto-approved). Returns null
// when stewardship is on but the node has no approved version yet, so
// callers can skip it instead of leaking draft content.
async function resolveLlmBody(
  ctx: McpToolContext,
  node: ContextNode,
): Promise<string | null> {
  // Enforce the SAME per-node access gate as the REST retrieval path. This was
  // missing here — MCP callers bypassed canUserAccess and could read every
  // approved node's body regardless of document/tag/steward scope. Route through
  // canReadNode (the REST helper); deny → return null so callers skip the node
  // instead of leaking it. Strictly more restrictive; can only remove access.
  if (!(await canReadNode(ctx.nestId, node.id, ctx.userId, ctx.userEmail))) {
    return null;
  }
  if (!(await isStewardshipEnabled(ctx.nestId))) return node.body || "";
  const approved = await versions.getApprovedVersion(ctx.nestId, node.id);
  if (approved == null) return null;
  try {
    return await ctx.versionManager.reconstructVersion(node.id, approved);
  } catch (err) {
    console.error("reconstructVersion failed", node.id, approved, err);
    return null;
  }
}

/**
 * Public entry for every MCP tool call. Logging lives HERE (not in the route
 * wrapper) so it covers per-nest AND server-level MCP, and so a tool that
 * throws still produces an audit row (status 500). Best-effort:
 * `logTraceEvent` swallows its own errors and never alters tool behavior.
 */
export async function handleToolCall(
  toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<string> {
  const started = Date.now();
  let status = 200;
  try {
    return await runTool(toolName, args, ctx);
  } catch (err) {
    status = 500;
    throw err;
  } finally {
    void logTraceEvent({
      kind: "mcp",
      tool: toolName,
      nestId: ctx.nestId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      status,
      durationMs: Date.now() - started,
    });
  }
}

/**
 * Resolve the node a title-or-id tool is aimed at. Returns the node, or the
 * message to hand back to the caller when it can't be resolved — the tools
 * here answer in prose, not exceptions, so a miss reads as an answer rather
 * than a JSON-RPC error. Shared by the id-rewriting tools (delete, move) so
 * both accept the same two ways of naming a document.
 *
 * An ambiguous title REFUSES rather than picking one. Titles are not unique —
 * the same title in two folders is two different documents — and these tools
 * delete or relocate what they resolve. Guessing would mean an agent silently
 * destroying the wrong document with no error to notice and no way back.
 * context_update guesses because a wrong edit is recoverable from history;
 * a wrong delete is not.
 */
async function resolveTargetNode(
  storage: NestStorage,
  args: Record<string, any>,
): Promise<ContextNode | string> {
  if (!args.id && !args.title) return "Provide a title or an id.";

  // An id IS the storage key, so read it directly. Ambiguity is impossible
  // here and a discoverDocuments() scan would parse every document in the
  // vault to find one the caller already named.
  if (args.id) {
    try {
      return await storage.readDocument(args.id);
    } catch {
      return `Node not found: ${args.id}`;
    }
  }

  // Titles have no index, so this branch has to scan.
  const docs = await storage.discoverDocuments();
  const matches = docs.filter(
    (n) => n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
  );
  if (matches.length > 1) {
    return `${matches.length} nodes share the title "${args.title}". Re-run with one of these ids instead: ${matches
      .map((n) => n.id)
      .join(", ")}`;
  }
  return matches[0] ?? `Node not found: ${args.title}`;
}

/**
 * SECURITY INVARIANT — new mutating tools MUST self-gate. The /mcp transport
 * admits READ-tier callers (MCP is always POST, so the route can't
 * distinguish reads from writes); per-tool permission checks in the cases
 * below are the ONLY write/governance enforcement. Follow the existing
 * patterns: canCreateInNest / canUserEdit for content writes, canUserApprove
 * (inside review-service) for governance, explicit admin checks for
 * stewards/sharing/sync. A mutating case without its own check ships a
 * privilege escalation.
 */
async function runTool(
  toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<string> {
  const { storage, queryEngine, versionManager, nestId, userId, userEmail } = ctx;

  switch (toolName) {
    case "context_init": {
      const content = await storage.readContextMd();
      if (!content)
        return "No CONTEXT.md found. Use context_overview to see what's available.";
      return `# Vault Instructions (CONTEXT.md)\n\n${content}`;
    }

    case "context_overview": {
      const docs = await storage.discoverDocuments();
      const types: Record<string, number> = {};
      const tags: Record<string, number> = {};
      for (const n of docs) {
        const t = n.frontmatter.type || "document";
        types[t] = (types[t] || 0) + 1;
        for (const tag of n.frontmatter.tags || []) tags[tag] = (tags[tag] || 0) + 1;
      }
      const typeList = Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, c]) => `  ${t}: ${c}`).join("\n");
      const tagList = Object.entries(tags).sort((a, b) => b[1] - a[1]).map(([t, c]) => `  ${t}: ${c}`).join("\n");
      const nodeList = docs
        .map(
          (n, i) =>
            `${i + 1}. **${n.frontmatter.title}** [${n.frontmatter.type || "document"}] ${(n.frontmatter.tags || []).slice(0, 4).join(" ")}\n   ${(n.body || "").slice(0, 120).replace(/\n/g, " ")}`,
        )
        .join("\n\n");
      return `# Vault Overview\n**Total nodes:** ${docs.length}\n\n## Types\n${typeList}\n\n## Tags\n${tagList}\n\n## All Nodes\n\n${nodeList}`;
    }

    case "context_search": {
      const docs = await storage.discoverDocuments();
      const terms = (args.query || "").toLowerCase().split(/\s+/).filter(Boolean);
      // Resolve approved bodies up front so search hits only matter
      // when they're in content the LLM is allowed to see. Under
      // stewardship, draft text on disk is invisible to search.
      const enriched = await Promise.all(
        docs.map(async (n) => ({ node: n, body: await resolveLlmBody(ctx, n) })),
      );
      const visible = enriched.filter((e) => e.body !== null);
      const matches = visible.filter(({ node: n, body }) => {
        const hay = [
          n.frontmatter.title,
          body || "",
          n.frontmatter.type || "",
          ...(n.frontmatter.tags || []),
        ]
          .join(" ")
          .toLowerCase();
        return terms.every((t: string) => hay.includes(t));
      });
      if (!matches.length) return `No nodes matched search: "${args.query}"`;
      const results = matches
        .map(
          ({ node: n, body }, i) =>
            `${i + 1}. **${n.frontmatter.title}** [${n.frontmatter.type || "document"}] ${(n.frontmatter.tags || []).join(" ")}\n   ${(body || "").slice(0, 200).replace(/\n/g, " ")}`,
        )
        .join("\n\n");
      return `Found ${matches.length} node(s) matching "${args.query}":\n\n${results}`;
    }

    case "context_table_query": {
      const result = await queryTableNode(
        nestId,
        String(args.table ?? ""),
        String(args.query ?? ""),
        false,
      );
      // Compact CSV back out — models read it fine and it round-trips.
      const lines = [
        result.columns.join(","),
        ...result.rows.map((r: string[]) => r.join(",")),
      ];
      return `${result.returned} of ${result.matched} matching rows (table ${result.table} v${result.version}, ${result.total} total):\n${lines.join("\n")}`;
    }

    case "context_query": {
      // hops mirrors REST POST /context — caller-controlled traversal depth.
      // External LLM callers set this directly, so normalize junk values
      // (negative, fractional, NaN) to a sane non-negative integer.
      const result = await queryEngine.query(args.query, {
        hops: normalizeHops(args.hops),
      });
      // Hide nodes the caller can't see (approved-only under stewardship) so the
      // listing doesn't leak restricted titles — same gate as context_search.
      const visibility = await Promise.all(
        result.documents.map(async (n) => ({
          node: n,
          visible: (await resolveLlmBody(ctx, n)) !== null,
        })),
      );
      const nodes = visibility.filter((e) => e.visible).map((e) => e.node);
      if (!nodes.length) return `No nodes matched: ${args.query}`;
      const list = nodes
        .map(
          (n, i) =>
            `${i + 1}. **${n.frontmatter.title}** [${n.frontmatter.type || "document"}] ${(n.frontmatter.tags || []).join(" ")}`,
        )
        .join("\n\n");
      return `Found ${nodes.length} node(s) for \`${args.query}\`:\n\n${list}`;
    }

    case "context_get": {
      const docs = await storage.discoverDocuments();
      let node: ContextNode | undefined;
      if (args.title) {
        node = docs.find(
          (n) =>
            n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
        );
      } else if (args.id) {
        node = docs.find((n) => n.id === args.id);
      }
      if (!node) return `Node not found: ${args.title || args.id}`;
      const body = await resolveLlmBody(ctx, node);
      if (body === null) {
        return `Node "${node.frontmatter.title}" has no approved version yet — not available to AI.`;
      }
      const meta = [
        `**Title:** ${node.frontmatter.title}`,
        `**Type:** ${node.frontmatter.type || "document"}`,
        node.frontmatter.tags?.length
          ? `**Tags:** ${node.frontmatter.tags.join(" ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      return `${meta}\n\n---\n\n${body || "(no content)"}`;
    }

    case "context_list": {
      // Same per-caller gating REST/UI use: steward access, public-reader
      // approved-only, pending/status resolution.
      const nodes = await listNodesForCallerByEmail(nestId, userEmail, {
        type: args.type,
        tag: args.tag,
        status: args.status,
        limit: args.limit || 50,
      });
      if (!nodes.length) return "No nodes found with the given filters.";
      const list = nodes
        .map((n, i) => `${i + 1}. **${n.title}** [${n.type}]`)
        .join("\n");
      return `${nodes.length} node(s):\n\n${list}`;
    }

    case "context_resolve": {
      const result = await queryEngine.query(args.selector, {
        hops: normalizeHops(args.hops),
      });
      const maxTokens = args.max_tokens || 8000;
      const approxChars = maxTokens * 4;
      // Gate bodies the same way context_get/search/export do — approved-only
      // under stewardship. Raw `n.body` here would leak draft/unapproved text,
      // and caller-set hops now widens the neighborhood pulled through this path.
      const resolvedBodies = await Promise.all(
        result.documents.map(async (n) => ({
          node: n,
          body: await resolveLlmBody(ctx, n),
        })),
      );
      let total = 0;
      const resolved: string[] = [];
      for (const { node: n, body } of resolvedBodies) {
        if (body === null) continue; // not visible / no approved version yet
        const entry = `## ${n.frontmatter.title}\n\n${body}`;
        if (total + entry.length > approxChars) break;
        resolved.push(entry);
        total += entry.length;
      }
      return resolved.join("\n\n---\n\n") || "No nodes resolved.";
    }

    case "context_export": {
      // Whole-nest bundle: every accessible document's full body, gated the
      // same way context_get is (approved-only under stewardship). Optional
      // token budget; include in discovery order until it's reached.
      const docs = await storage.discoverDocuments();
      const approxChars = args.max_tokens ? args.max_tokens * 4 : Infinity;
      // Resolve every approved body up front (concurrent), matching
      // context_search, then apply the token budget over the resolved list in
      // discovery order.
      const resolved = await Promise.all(
        docs.map(async (n) => ({ node: n, body: await resolveLlmBody(ctx, n) })),
      );
      let total = 0;
      let budgetHit = false;
      const parts: string[] = [];
      for (const { node: n, body } of resolved) {
        if (body === null) continue; // not visible / no approved version yet
        const meta = [
          `**Title:** ${n.frontmatter.title}`,
          `**Type:** ${n.frontmatter.type || "document"}`,
          n.frontmatter.tags?.length
            ? `**Tags:** ${n.frontmatter.tags.join(" ")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n");
        const entry = `${meta}\n\n${body || "(no content)"}`;
        if (total + entry.length > approxChars) {
          budgetHit = true;
          break;
        }
        parts.push(entry);
        total += entry.length;
      }
      if (!parts.length) {
        return budgetHit
          ? "Token budget reached before any document fit — raise max_tokens, or use context_query/context_resolve to target."
          : "No documents available to export.";
      }
      const note = budgetHit
        ? `\n\n_(Token budget reached — ${parts.length} of ${docs.length} documents included. Raise max_tokens, or use context_query/context_resolve to target.)_`
        : "";
      return `# Nest export — ${parts.length} document(s)\n\n${parts.join(
        "\n\n---\n\n",
      )}${note}`;
    }

    case "context_comments": {
      const docs = await storage.discoverDocuments();
      let node: ContextNode | undefined;
      if (args.title) {
        node = docs.find(
          (n) =>
            n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
        );
      } else if (args.id) {
        node = docs.find((n) => n.id === args.id);
      }
      if (!node) return `Node not found: ${args.title || args.id}`;
      // Gate the same way context_get/context_export do: under stewardship a
      // node with no approved version is invisible to AI. Its threads embed
      // draft body text (anchor.quote) and paraphrases in comment bodies, so
      // serving them would leak unapproved content through the side door.
      if ((await resolveLlmBody(ctx, node)) === null) {
        return `Node "${node.frontmatter.title}" has no approved version yet — not available to AI.`;
      }
      const threads = await listThreads(nestId, node.id);
      if (!threads.length)
        return `No comments on "${node.frontmatter.title}".`;
      const openCount = threads.filter((t) => t.status === "open").length;
      const sections = threads
        .map((t, i) => {
          const quote = t.anchor?.quote
            ? `> ${t.anchor.quote.replace(/\n/g, " ")}\n\n`
            : "";
          const head = `### ${i + 1}. [${t.status}]${t.anchor?.quote ? "" : " (whole-document)"
            }`;
          const comments = t.comments
            .map((c) => `- **${c.author}** (${c.createdAt}): ${c.body}`)
            .join("\n");
          return `${head}\n${quote}${comments}`;
        })
        .join("\n\n");
      return `# Comments on "${node.frontmatter.title}" — ${threads.length} thread(s), ${openCount} open\n\n${sections}`;
    }

    case "context_create": {
      // PRIMARY write gate: the /mcp middleware admits read-tier callers
      // (the MCP transport is always POST), so this per-tool check is what
      // keeps creation locked to write+ collaborators and nest-scope editors.
      if (!(await stewardship.canCreateInNest(nestId, userEmail))) {
        return "You don't have permission to create documents in this nest.";
      }
      // Refuse a title already used ANYWHERE in the vault, not just in the
      // requested folder: every title-addressed tool here resolves by title, so
      // a twin filed elsewhere is unreachable for all of them (CU-wdqcpzxcg8).
      // Scan and create under one nest-wide key — createNode's own lock is per
      // id, and two twins land on DIFFERENT ids, so only a shared key stops
      // both from passing the scan before either writes.
      const wanted = String(args.title ?? "").toLowerCase();
      return withNodeWriteLock(nodeWriteKey(nestId, "*create*"), async () => {
        const existingDocs = await storage.discoverDocuments();
        const twin = existingDocs.find(
          (n) => String(n.frontmatter.title ?? "").toLowerCase() === wanted,
        );
        if (twin) {
          return `A node titled "${twin.frontmatter.title}" already exists (${twin.id}). Titles must be unique — MCP tools resolve documents by title, so a second one would be unreachable. Use context_update to change it, context_move to refile it, or create this one under a different title.`;
        }
        const { node } = await createNode(
          nestId,
          {
            title: args.title,
            content: args.content,
            type: args.type,
            tags: args.tags,
            scope: args.scope,
            folder: args.folder,
          },
          userEmail,
        );
        return `Created node: **${args.title}** (${node.id}) — status: ${node.frontmatter.status}`;
      });
    }

    case "context_update": {
      // MCP resolves doc by title; service operates on id.
      const docs = await storage.discoverDocuments();
      const node = docs.find(
        (n) => n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
      );
      if (!node) return `Node not found: ${args.title}`;
      // Defense-in-depth: same per-node edit check REST resolves, so editing
      // stays gated regardless of the /mcp middleware.
      const editCheck = await stewardship.canUserEdit(nestId, node.id, userEmail);
      if (!editCheck.allowed) {
        return `You don't have permission to edit "${args.title}": ${editCheck.reason}`;
      }
      const { node: updated, version } = await updateNode(
        nestId,
        node.id,
        {
          content: args.content,
          append: args.append,
          tags: args.tags,
          status: args.status,
          changeNote: args.changeNote,
        },
        userEmail,
      );
      return `Updated node: **${updated.frontmatter.title}** — v${version}, status: ${updated.frontmatter.status}`;
    }

    case "context_delete": {
      const node = await resolveTargetNode(storage, args);
      if (typeof node === "string") return node;
      // PRIMARY write gate — the /mcp transport admits read-tier callers, so
      // this per-tool check is the only thing standing between a viewer and a
      // deleted document. Delete is at least as privileged as edit, so it
      // takes the same per-node check context_update does.
      const deleteCheck = await stewardship.canUserEdit(nestId, node.id, userEmail);
      if (!deleteCheck.allowed) {
        // Dead end otherwise — point at the request path the UI offers here.
        return `You don't have permission to delete "${node.frontmatter.title}": ${deleteCheck.reason}\n\nUse context_request_deletion to ask a nest owner/admin to delete it, with a reason.`;
      }
      await deleteNode(nestId, node.id, userEmail);
      return `Deleted node: **${node.frontmatter.title}** (${node.id})`;
    }

    case "context_move": {
      if (typeof args.folder !== "string") {
        return 'folder is required — a path like "gtm/deals", or "" for the nest root.';
      }
      const node = await resolveTargetNode(storage, args);
      if (typeof node === "string") return node;
      // PRIMARY write gate, same reasoning as context_delete: a move rewrites
      // the node's id across every governance table, so it is at least as
      // privileged as an edit.
      const moveCheck = await stewardship.canUserEdit(nestId, node.id, userEmail);
      if (!moveCheck.allowed) {
        return `You don't have permission to move "${node.frontmatter.title}": ${moveCheck.reason}`;
      }
      const { node: moved, previousId } = await moveNode(
        nestId,
        node.id,
        args.folder,
        userEmail,
      );
      if (previousId === moved.id) {
        return `**${moved.frontmatter.title}** is already at \`${moved.id}\` — nothing to move.`;
      }
      return `Moved **${moved.frontmatter.title}**: \`${previousId}\` → \`${moved.id}\``;
    }

    // ─── Governance Tool Handlers ──────────────────────────────────────

    case "context_stewards": {
      if (args.title) {
        // Resolve stewards for a specific node
        const docs = await storage.discoverDocuments();
        const node = docs.find(
          (n) => n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
        );
        const nodeId = node?.id || "";
        const resolved = await stewardship.resolveStewardsForNode(ctx.nestId, nodeId);

        if (resolved.length === 0) {
          return `No stewards configured for "${args.title}". Changes are auto-approved.`;
        }

        const list = resolved
          .map(
            (r, i) =>
              `${i + 1}. **${r.steward.userEmail}** — ${r.steward.role} (${r.source})${r.steward.role === "reviewer" ? " ✓ can approve" : ""}`,
          )
          .join("\n");
        return `# Stewards for "${args.title}"\n\n${list}`;
      }

      // Listing the full roster is admin-only (same as REST GET /stewards).
      // Resolving stewards for a specific node above stays open so callers
      // can see who'd review their work.
      if (!(await stewardship.canManageStewards(ctx.nestId, ctx.userId))) {
        return "You don't have permission to list stewards. Only a nest admin, the nest owner, or the server admin can do this.";
      }

      // List all stewards for the nest
      const allStewards = await stewardship.getStewardsForNest(ctx.nestId);
      if (allStewards.length === 0) {
        return "No stewards configured. All changes are auto-approved.\n\nTo configure stewards, add a `stewards.yaml` file to the vault root, or use `context_assign_steward`.";
      }

      const byScope: Record<string, typeof allStewards> = {};
      for (const s of allStewards) {
        const key = s.scope === "nest"
          ? "Nest-level"
          : s.scope === "tag"
            ? `Tag: ${s.tagName}`
            : `Document: ${s.nodeTitle || s.nodePattern}`;
        (byScope[key] = byScope[key] || []).push(s);
      }

      const sections = Object.entries(byScope)
        .map(
          ([scope, stewards]) =>
            `## ${scope}\n${stewards.map((s) => `- **${s.userEmail}** (${s.role})${s.role === "reviewer" ? " — can approve" : ""}`).join("\n")}`,
        )
        .join("\n\n");

      return `# Data Stewards\n\n${sections}`;
    }

    case "context_request_deletion": {
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (!reason) {
        return "reason is required — say why it should be deleted; that is what the admin judges.";
      }

      // Whole nest.
      if (args.nest === true) {
        const request = await reviews.requestDeletion({
          nestId,
          nodeId: nestId,
          targetType: "nest",
          requestedBy: userEmail,
          reason,
          baseUrl: ctx.baseUrl,
        });
        return `Requested deletion of the **entire nest**. A nest owner or admin will delete it or decline.\nRequest id: \`${request.id}\``;
      }

      // Folder — normalized the same way the REST route does, so two people
      // flagging "gtm/deals" and "/nodes/gtm/deals/" collide on one request.
      if (typeof args.folder === "string" && args.folder.trim()) {
        const folder = args.folder
          .trim()
          .replace(/^\/+|\/+$/g, "")
          .replace(/^nodes\//, "");
        const docs = await storage.discoverDocuments();
        const inside = docs.filter((d) => isIdUnderFolder(d.id, folder));
        if (inside.length === 0) {
          return `No folder "${folder}" — nothing is filed under it. Use context_list to see what exists.`;
        }
        const request = await reviews.requestDeletion({
          nestId,
          nodeId: folder,
          targetType: "folder",
          requestedBy: userEmail,
          reason,
          baseUrl: ctx.baseUrl,
        });
        return `Requested deletion of folder **${folder}** (${inside.length} document(s) inside). A nest owner or admin will delete it or decline.\nRequest id: \`${request.id}\``;
      }

      // Document — resolved by title or id like every other node tool.
      const node = await resolveTargetNode(storage, args);
      if (typeof node === "string") return node;
      // Read gate: you may flag anything you can see. That is the point —
      // whoever notices dead content usually can't delete it.
      if (!(await canReadNode(nestId, node.id, userId, userEmail))) {
        return `Node not found: ${node.id}`;
      }
      const request = await reviews.requestDeletion({
        nestId,
        nodeId: node.id,
        targetType: "document",
        requestedBy: userEmail,
        reason,
        baseUrl: ctx.baseUrl,
      });
      return `Requested deletion of **${node.frontmatter.title}**. A nest owner or admin will delete it or decline — nothing is removed yet.\nRequest id: \`${request.id}\``;
    }

    case "context_deletion_queue": {
      const status = args.status === "declined" ? "declined" : "pending";
      const requests = await reviews.listDeletionRequests({ nestId, status });
      if (requests.length === 0) {
        return status === "pending"
          ? "No deletion requests waiting. All caught up!"
          : "No declined deletion requests.";
      }
      const list = requests
        .map((r, i) => {
          const kind = r.targetType === "document" ? "" : `${r.targetType}: `;
          const verdict =
            r.status === "declined"
              ? `\n   Declined by ${r.resolvedBy}: "${r.resolutionNote}"`
              : "";
          return `${i + 1}. **${kind}${r.title || r.nodeId}**\n   Asked by ${r.requestedBy}: "${r.reason}"\n   Request id: \`${r.id}\`${verdict}`;
        })
        .join("\n\n");
      return `# Deletion requests (${status})\n**${requests.length} item(s)**\n\n${list}`;
    }

    case "context_resolve_deletion": {
      const requestId = typeof args.request_id === "string" ? args.request_id : "";
      const action = args.action === "delete" ? "delete" : args.action === "decline" ? "decline" : null;
      if (!requestId || !action) {
        return 'request_id and action are required — action is "delete" or "decline". Use context_deletion_queue to list request ids.';
      }
      const request = await reviews.getDeletionRequest(requestId);
      if (!request || request.nestId !== nestId || request.status !== "pending") {
        return `No pending deletion request with id ${requestId}.`;
      }

      // Resolving is the owner/admin call the UI and REST both gate on — the
      // /mcp transport admits read-tier callers, so this per-tool check is the
      // only thing between a viewer and a deleted nest.
      const roles = await stewardship.resolveUserRoles(nestId, userEmail);
      if (!roles.includes("owner") && !roles.includes("admin")) {
        return `You don't have permission to resolve deletion requests in this nest — only a nest owner or admin can. You can add to the discussion, but the verdict is theirs.`;
      }

      const label = await reviews.deletionTargetTitle(request);
      if (action === "decline") {
        const note = typeof args.note === "string" ? args.note.trim() : "";
        if (!note) {
          return "note is required when declining — the requester is told why it stays.";
        }
        await reviews.declineDeletion({
          nestId,
          id: requestId,
          declinedBy: userEmail,
          note,
          baseUrl: ctx.baseUrl,
        });
        return `Declined the deletion request for **${label}**. It stays, and ${request.requestedBy} has been told why.`;
      }

      if (request.targetType === "nest") {
        await deleteNest(nestId);
      } else if (request.targetType === "folder") {
        await deleteFolder(nestId, request.nodeId, userEmail);
        await reviews.dropDeletionRequest(request.id);
      } else {
        await deleteNode(nestId, request.nodeId, userEmail);
      }
      await reviews.notifyDeletionResolved({
        nestId,
        nodeId: request.nodeId,
        docTitle: label,
        outcome: "deleted",
        requestedBy: request.requestedBy,
        resolvedBy: userEmail,
        requestId: request.id,
        targetType: request.targetType,
        baseUrl: ctx.baseUrl,
      });
      return `Deleted **${label}** — ${request.requestedBy}'s request was honoured. Irreversible.`;
    }

    case "context_review_queue": {
      const status = args.status || "pending";
      const result = await reviews.getReviewQueue({
        nestId: ctx.nestId,
        status: status as any,
      });

      if (result.requests.length === 0) {
        return status === "pending"
          ? "No documents pending review. All caught up!"
          : `No reviews with status "${status}".`;
      }

      const list = result.requests
        .map(
          (r, i) =>
            `${i + 1}. **${r.title || r.nodeId}** v${r.version} — ${r.priority} priority\n   Submitted by: ${r.requestedBy} at ${r.requestedAt}${r.requestNote ? `\n   Note: "${r.requestNote}"` : ""}`,
        )
        .join("\n\n");

      return `# Review Queue (${status})\n**${result.total} item(s)**\n\n${list}`;
    }

    case "context_my_drafts": {
      // Self-scoped by construction — only rows this caller authored, in a nest
      // they already hold read on, so no extra permission gate.
      const { drafts, total } = await versions.listMyDrafts({
        authorEmail: userEmail,
        nestIds: [ctx.nestId],
        limit: 100,
      });
      if (total === 0) {
        return "No unsubmitted drafts — everything you've written here is in review or approved.";
      }
      const list = drafts
        .map(
          (d, i) =>
            `${i + 1}. **${d.title}** v${d.version} — ${d.status}\n   Path: ${d.nodeId}\n   Last edited: ${d.updatedAt}`,
        )
        .join("\n\n");
      // Say when the list is cut off rather than letting an agent read a capped
      // page as the whole set.
      const more =
        total > drafts.length
          ? `\n\n_Showing the ${drafts.length} most recent of ${total}._`
          : "";
      return `# My Drafts\n**${total} unsubmitted document(s)**\n\n${list}${more}\n\nSubmit one with \`context_submit_review\`.`;
    }

    case "context_submit_review": {
      const docs = await storage.discoverDocuments();
      const node = docs.find(
        (n) => n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
      );
      if (!node) return `Node not found: ${args.title}`;

      // Defense-in-depth: submitting a draft for review is an edit-level
      // action — gate it with the same per-node edit check.
      const submitCheck = await stewardship.canUserEdit(ctx.nestId, node.id, userEmail);
      if (!submitCheck.allowed) {
        return `You don't have permission to submit "${args.title}" for review: ${submitCheck.reason}`;
      }

      const currentVersion = await versions.getCurrentVersion(ctx.nestId, node.id);
      if (currentVersion === 0) return `No versions found for "${args.title}"`;

      try {
        const request = await reviews.submitForReview({
          nestId: ctx.nestId,
          nodeId: node.id,
          version: currentVersion,
          requestedBy: ctx.userEmail,
          note: args.note,
          priority: args.priority as any,
          baseUrl: ctx.baseUrl,
        });

        const resolved = await stewardship.resolveStewardsForNode(
          ctx.nestId,
          node.id,
        );

        const stewardList = resolved.length > 0
          ? `\n\n**Stewards who can review:**\n${resolved.map((r) => `- ${r.steward.userEmail} (${r.source})`).join("\n")}`
          : "";

        return `Submitted "${args.title}" v${currentVersion} for review (${request.priority} priority).${stewardList}`;
      } catch (err: any) {
        return `Failed to submit: ${err.message}`;
      }
    }

    case "context_approve": {
      const docs = await storage.discoverDocuments();
      const node = docs.find(
        (n) => n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
      );
      if (!node) return `Node not found: ${args.title}`;

      try {
        // Report the version the resolution actually landed on (request.version),
        // not a pre-read — an author revising their pending submission can bump
        // it between here and the lock-protected approve.
        const request = await reviews.approve({
          nestId: ctx.nestId,
          nodeId: node.id,
          approvedBy: ctx.userEmail,
          note: args.note,
          baseUrl: ctx.baseUrl,
        });

        return `Approved "${args.title}" v${request.version}. This version is now live for AI queries.${args.note ? `\nNote: ${args.note}` : ""}`;
      } catch (err: any) {
        return `Cannot approve: ${err.message}`;
      }
    }

    case "context_reject": {
      const docs = await storage.discoverDocuments();
      const node = docs.find(
        (n) => n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
      );
      if (!node) return `Node not found: ${args.title}`;

      try {
        const request = await reviews.reject({
          nestId: ctx.nestId,
          nodeId: node.id,
          rejectedBy: ctx.userEmail,
          note: args.note,
          baseUrl: ctx.baseUrl,
        });

        return `Rejected "${args.title}" v${request.version}.\nReason: ${args.note}`;
      } catch (err: any) {
        return `Cannot reject: ${err.message}`;
      }
    }

    case "context_versions": {
      const docs = await storage.discoverDocuments();
      const node = docs.find(
        (n) => n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
      );
      if (!node) return `Node not found: ${args.title}`;

      const allVersions = await versions.getVersions(ctx.nestId, node.id);
      const approved = await versions.getApprovedVersion(ctx.nestId, node.id);

      if (allVersions.length === 0) {
        return `No version history for "${args.title}".`;
      }

      const list = allVersions
        .map(
          (v) =>
            `- **v${v.version}** ${v.status}${v.version === approved ? " (AI-active)" : ""} — by ${v.editedBy} at ${v.editedAt}${v.changeNote ? ` "${v.changeNote}"` : ""}`,
        )
        .join("\n");

      return `# Version History: ${args.title}\n**Current:** v${allVersions[0]?.version || 0} | **AI-active:** ${approved ? `v${approved}` : "none"}\n\n${list}`;
    }

    case "context_assign_steward": {
      const scope = args.scope as "nest" | "tag" | "document";
      if (!["nest", "tag", "document"].includes(scope)) {
        return `Invalid scope "${args.scope}". Use: nest, tag, or document.`;
      }

      // Same authority as REST/UI — server admin or nest owner/admin manages
      // stewards. MCP calls don't pass through the /stewards HTTP middleware,
      // so gate here with the shared helper.
      if (!(await stewardship.canManageStewards(ctx.nestId, ctx.userId))) {
        return "You don't have permission to manage stewards. Only a nest admin, the nest owner, or the server admin can do this.";
      }

      try {
        // Use createStewardRecord (not raw assignSteward) so MCP gets the
        // same conflict check, email/tag normalization, and governed-mode
        // flip the REST route uses.
        await stewardship.createStewardRecord({
          nestId: ctx.nestId,
          scope,
          documentId: scope === "document" ? args.target : undefined,
          tagName: scope === "tag" ? args.target : undefined,
          users: [{ email: args.email, role: (args.role as any) || "reviewer" }],
          assignedBy: ctx.userEmail,
        });

        const targetDesc = scope === "nest"
          ? "all documents"
          : `${scope}: ${args.target}`;

        return `Assigned **${args.email}** as ${args.role || "reviewer"} for ${targetDesc}.`;
      } catch (err: any) {
        return `Failed to assign steward: ${err.message}`;
      }
    }

    case "context_share_nest": {
      // Parity with REST POST /collaborators (CU-wdqcpzudw5 follow-up):
      // write+ may invite; the escalation cap in addCollaborator stops
      // anyone granting above their own level, so only admin/owner can
      // hand out admin.
      const callerPermission =
        config.AUTH_MODE === "open"
          ? ("owner" as const)
          : await resolveNestPermission(ctx.nestId, ctx.userId);
      if (permissionLevel(callerPermission) < permissionLevel("write")) {
        return "You don't have permission to share this nest. Sharing needs write access — ask a nest admin or the owner.";
      }
      const permission = (args.permission as string) || "read";
      try {
        await addCollaborator({
          nestId: ctx.nestId,
          email: args.email,
          permission,
          grantedByEmail: ctx.userEmail,
          callerPermission,
        });
        const label =
          permission === "admin"
            ? "admin"
            : permission === "write"
              ? "editor"
              : "viewer";
        return `Shared this nest with **${args.email}** as ${label}.`;
      } catch (err: any) {
        return `Failed to share nest: ${err.message}`;
      }
    }

    case "context_grant": {
      // Owner/admin only — same authority as steward/sharing management.
      if (!(await stewardship.canManageStewards(ctx.nestId, ctx.userId))) {
        return "You don't have permission to share documents in this nest (owner/admin only).";
      }
      const targetType = String(args.target_type || "");
      const target = String(args.target || "").trim();
      const role = (String(args.role || "read")) as "read" | "write";
      if (!["document", "folder"].includes(targetType)) {
        return "target_type must be 'document' or 'folder'.";
      }
      if (!target) return "target is required (a node id or folder prefix).";
      if (!["read", "write"].includes(role)) return "role must be read or write.";
      try {
        const { createGrant } = await import("../governance/grants-service.js");
        // Resolve the grantee — mint a placeholder invited user if unknown,
        // same as collaborator/document sharing.
        const db = (await import("../db/client.js")).getDb();
        const { normalizeEmail } = await import("../shared/email.js");
        const e = normalizeEmail(String(args.email || ""));
        if (!e) return "email is required.";
        let row = (await db.get("SELECT id FROM users WHERE LOWER(email) = ?", [e])) as
          | { id: string }
          | undefined;
        if (!row) {
          const { hashPassword } = await import("../auth/keys.js");
          const { v4: uuid } = await import("uuid");
          const id = uuid();
          await db.run(
            "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
            [id, e, null, await hashPassword(uuid())],
          );
          row = { id };
        }
        await createGrant({
          nestId: ctx.nestId,
          targetType: targetType as any,
          target,
          userId: row.id,
          role,
          grantedBy: ctx.userEmail,
        });
        return `Shared ${targetType} \`${target}\` with **${args.email}** as ${role}.`;
      } catch (err: any) {
        return `Failed to share: ${err.message}`;
      }
    }

    case "context_unsynced_list": {
      // Same admin gate as REST GET /nests/unsynced — listing reflects
      // server-side filesystem state, so non-admins shouldn't probe it.
      if (config.AUTH_MODE !== "open" && !(await isServerAdminUserId(userId))) {
        return "You don't have permission to list unsynced folders. Server admin only.";
      }
      const folders = listUnsyncedFolders();
      if (!folders.length) return "No unsynced folders found.";
      const list = folders
        .map(
          (f, i) =>
            `${i + 1}. **${f.label}** \`${f.name}\` — ${f.mdCount} md file(s), ${f.sizeBytes} bytes`,
        )
        .join("\n");
      return `# Unsynced Folders (${folders.length})\n\n${list}`;
    }

    case "context_sync_folder": {
      // Same admin gate as REST POST /nests/unsynced/sync.
      if (config.AUTH_MODE !== "open" && !(await isServerAdminUserId(userId))) {
        return "You don't have permission to sync folders. Server admin only.";
      }
      try {
        const { nest, documents } = await syncUnsyncedFolder(
          userId,
          args.name,
          userEmail,
        );
        return `Synced folder "${args.name}" → nest **${nest.name}** (${nest.id}) with ${documents} document(s).`;
      } catch (err: any) {
        return `Failed to sync folder: ${err.message}`;
      }
    }

    default:
      // Workflow-plane tools are registered only when FEATURE_WORKFLOW_PLANE
      // is on (mcp/routes.ts); they share the run/edge service layer with the
      // REST routes. Delegate here so trace logging in handleToolCall still
      // wraps them.
      if (isWorkflowTool(toolName)) {
        return runWorkflowTool(toolName, args, ctx);
      }
      return `Unknown tool: ${toolName}`;
  }
}
