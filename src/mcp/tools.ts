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
import { canManageWith } from "../governance/roles.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { addCollaborator } from "../nests/sharing-service.js";
import {
  listUnsyncedFolders,
  syncUnsyncedFolder,
} from "../nests/unsynced-service.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { config } from "../config.js";
import {
  createNode,
  updateNode,
  listNodesForCallerByEmail,
} from "../nodes/service.js";
import { listThreads } from "../annotations/service.js";

export interface McpToolContext {
  storage: NestStorage;
  queryEngine: GraphQueryEngine;
  versionManager: VersionManager;
  nestId: string;
  userId: string;
  userEmail: string;
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
      },
      required: ["query"],
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
      "Browse vault contents with optional type, tag, or limit filters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", description: "Filter by node type" },
        tag: { type: "string", description: "Filter by tag" },
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
    description: "Create a new knowledge node in the vault.",
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
          description: "Node type (default: document)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags",
        },
        scope: { type: "string", description: "Visibility scope" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "context_update",
    description:
      "Update an existing node — append, replace content, add tags.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Title of node to update",
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
        scope: { type: "string", description: "New scope" },
      },
      required: ["title"],
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

export async function handleToolCall(
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

    case "context_query": {
      const result = await queryEngine.query(args.query, { hops: 2 });
      const nodes = result.documents;
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
        limit: args.limit || 50,
      });
      if (!nodes.length) return "No nodes found with the given filters.";
      const list = nodes
        .map((n, i) => `${i + 1}. **${n.title}** [${n.type}]`)
        .join("\n");
      return `${nodes.length} node(s):\n\n${list}`;
    }

    case "context_resolve": {
      const result = await queryEngine.query(args.selector, { hops: 2 });
      const maxTokens = args.max_tokens || 8000;
      const approxChars = maxTokens * 4;
      let total = 0;
      const resolved: string[] = [];
      for (const n of result.documents) {
        const entry = `## ${n.frontmatter.title}\n\n${n.body || ""}`;
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
      const threads = listThreads(nestId, node.id);
      if (!threads.length)
        return `No comments on "${node.frontmatter.title}".`;
      const openCount = threads.filter((t) => t.status === "open").length;
      const sections = threads
        .map((t, i) => {
          const quote = t.anchor?.quote
            ? `> ${t.anchor.quote.replace(/\n/g, " ")}\n\n`
            : "";
          const head = `### ${i + 1}. [${t.status}]${
            t.anchor?.quote ? "" : " (whole-document)"
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
      // Defense-in-depth: the /mcp middleware already requires nest write,
      // but gate here too so creation stays locked if that ever changes.
      if (!(await stewardship.canCreateInNest(nestId, userEmail))) {
        return "You don't have permission to create documents in this nest.";
      }
      const { node } = await createNode(
        nestId,
        {
          title: args.title,
          content: args.content,
          type: args.type,
          tags: args.tags,
          scope: args.scope,
        },
        userEmail,
      );
      return `Created node: **${args.title}** (${node.id}) — status: ${node.frontmatter.status}`;
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
      const { node: updated } = await updateNode(
        nestId,
        node.id,
        {
          content: args.content,
          append: args.append,
          tags: args.tags,
        },
        userEmail,
      );
      return `Updated node: **${updated.frontmatter.title}**`;
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
      if (!stewardship.canManageStewards(ctx.userEmail)) {
        return "You don't have permission to list stewards. Only the super admin can do this.";
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

      const currentVersion = await versions.getCurrentVersion(ctx.nestId, node.id);

      try {
        const request = await reviews.approve({
          nestId: ctx.nestId,
          nodeId: node.id,
          version: currentVersion,
          approvedBy: ctx.userEmail,
          note: args.note,
        });

        return `Approved "${args.title}" v${currentVersion}. This version is now live for AI queries.${args.note ? `\nNote: ${args.note}` : ""}`;
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

      const currentVersion = await versions.getCurrentVersion(ctx.nestId, node.id);

      try {
        const request = await reviews.reject({
          nestId: ctx.nestId,
          nodeId: node.id,
          version: currentVersion,
          rejectedBy: ctx.userEmail,
          note: args.note,
        });

        return `Rejected "${args.title}" v${currentVersion}.\nReason: ${args.note}`;
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

      // Same authority as REST/UI — only the server admin manages stewards.
      // MCP calls don't pass through the /stewards HTTP middleware, so gate
      // here with the shared helper.
      if (!stewardship.canManageStewards(ctx.userEmail)) {
        return "You don't have permission to manage stewards. Only the super admin can do this.";
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
      // NOTE: this gate is intentionally stricter than REST/UI for now. REST
      // POST /collaborators allows write+ collaborators to invite (escalation-
      // capped in addCollaborator); this MCP tool still requires nest admin.
      // TODO(CU-wdqcpzudw5 follow-up): bring MCP to parity — accept write+ and
      // pass callerPermission into addCollaborator so the cap applies here too.
      const roles = await stewardship.resolveUserRoles(ctx.nestId, ctx.userEmail);
      if (!canManageWith(roles)) {
        return "You don't have permission to share this nest via this tool (admin only). You can still invite from the UI with write access, or ask a nest admin.";
      }
      const permission = (args.permission as string) || "read";
      try {
        await addCollaborator({
          nestId: ctx.nestId,
          email: args.email,
          permission,
          grantedByEmail: ctx.userEmail,
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

    case "context_unsynced_list": {
      // Same admin gate as REST GET /nests/unsynced — listing reflects
      // server-side filesystem state, so non-admins shouldn't probe it.
      if (config.AUTH_MODE !== "open" && !(await isLicenseAdminUserId(userId))) {
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
      if (config.AUTH_MODE !== "open" && !(await isLicenseAdminUserId(userId))) {
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
      return `Unknown tool: ${toolName}`;
  }
}
