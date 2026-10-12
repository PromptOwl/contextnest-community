import type {
  NestStorage,
  GraphQueryEngine,
  VersionManager,
  ContextNode,
} from "@promptowl/contextnest-engine";
import { parseDocument } from "@promptowl/contextnest-engine";
import * as stewardship from "../governance/stewardship-service.js";
import * as reviews from "../governance/review-service.js";
import * as versions from "../governance/version-service.js";
import { reconstructApproved } from "../governance/approved-body.js";
import { loadStewardsConfig } from "../governance/stewards-parser.js";
import {
  canReadNode,
  canRequestDeletion,
  filterAccessible,
} from "../governance/access-guard.js";
import {
  matchDocuments,
  discoverForSearch,
} from "../nodes/search.js";
import {
  resolveNestPermission,
  permissionLevel,
} from "../shared/access.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { VaultBusyError, isVaultLockTimeout } from "../shared/errors.js";
import { engineApi, opContext } from "../nodes/engine.js";
import { addCollaborator } from "../nests/sharing-service.js";
import { holdWriteIfGated } from "../nests/push-confirmation-service.js";
import { queryTableNode } from "../tables/query.js";
import {
  addComment,
  createThread,
  getThread,
  setThreadStatus,
  syncAnnotationsNode,
} from "../annotations/service.js";
import {
  notifyCommentMentions,
  notifyCommentReply,
} from "../governance/mention-notify.js";
import {
  listUnsyncedFolders,
  syncUnsyncedFolder,
} from "../nests/unsynced-service.js";
import { isServerAdminUserId, isPublicReader } from "../shared/access.js";
import { config } from "../config.js";
import {
  createNode,
  updateNode,
  deleteNode,
  deleteFolder,
  moveNode,
  listNodesForCallerByEmail,
  getNodeForCaller,
  isIdUnderFolder,
  isDerivedAnnotationsNode,
  fieldsOfRaw,
} from "../nodes/service.js";
import { deleteNest, archiveNest } from "../nests/service.js";
import {
  addComputedFields,
  createFieldDefinition,
  deleteFieldDefinition,
  describeFields,
  listFieldDefinitionEvents,
  listFieldDefinitions,
  nodesWithInvalidValues,
  storedFieldsOf,
  updateFieldDefinition,
  type FieldDefinition,
} from "../nodes/custom-fields.js";
import { readIndexedNodes } from "../nodes/node-index.js";
import { AppError, ValidationError } from "../shared/errors.js";
import { listThreads } from "../annotations/service.js";
import { withNodeWriteLock, nodeWriteKey } from "../shared/node-write-lock.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { logTraceEvent } from "../telemetry/trace-log.js";
import { recordNodeAccess, type AccessAction } from "../governance/access-log.js";
import {
  mergeClient,
  parseClientMetadata,
  type ClientMetadata,
} from "../shared/client-metadata.js";
import { isWorkflowTool, runWorkflowTool } from "./workflow-tools.js";
import { HEADLESS_READER_TOOLS, headlessToolRefusal, isServiceUser } from "../auth/headless.js";
import {
  accessRequestHint,
  accessTargetTitle,
  canDecideAccessRequests,
  createAccessRequest,
  decideAccessRequest,
  listAccessRequests,
  type AccessTarget,
} from "../governance/access-request-service.js";

/** Upper bound on caller-set traversal depth — real graphs terminate long
 *  before this; the cap just fences a misbehaving client from a runaway query. */
const MAX_HOPS = 10;

/** Caller-supplied traversal depth → integer in [0, MAX_HOPS], default 2.
 *  null/undefined/non-numeric all fall through to the default (some tool-calling
 *  clients serialize an unset optional arg as JSON `null` rather than omitting). */
/** `limit` for context_search: a positive integer, defaulting to
 *  SEARCH_DEFAULT_LIMIT and capped at SEARCH_MAX_LIMIT. External LLM callers
 *  set this directly, so junk (NaN, negative, fractional) normalizes rather
 *  than throwing. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 200;
export function normalizeSearchLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return SEARCH_DEFAULT_LIMIT;
  return Math.min(n, SEARCH_MAX_LIMIT);
}

export function normalizeHops(raw: unknown): number {
  if (raw == null) return 2;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(MAX_HOPS, Math.floor(n)));
}

/**
 * What a tool handler returns.
 *
 * A bare string is prose only — the historical shape, and still what most
 * tools return. The object form carries the SAME prose plus the operation
 * catalog's JSON payload, which the route emits as MCP `structuredContent`
 * next to an unchanged `content` block. Chat clients keep reading the prose;
 * machine callers (`ctx` over MCP, which JSON.parses the catalog shapes) read
 * the structured half.
 *
 * Only the operations `ctx` actually drives return the object form:
 * context_list / get / search / query / versions / create / update / delete,
 * plus context_submit_review — which is where `ctx publish` lands on a nest
 * that publishes through review rather than exposing context_publish.
 *
 * `isError` marks a denial or a not-found. Without it a refusal is a bare
 * prose sentence with no signal at all — indistinguishable, to a machine
 * caller, from a successful empty result ("denied" reads as "no documents").
 * Set it via `toolError`, never by hand.
 */
export type ToolResult = string | { text: string; data: unknown; isError?: true };

/**
 * A denial / not-found / failure from one of the converted tools.
 *
 * The prose is passed through UNCHANGED — `isError` is the only thing added,
 * and `data` carries the engine's `{code, message}` error shape (the codes are
 * `ERROR_CODES` in `@promptowl/contextnest-engine/api`) so `ctx` can map the
 * result back to a typed engine error instead of string-matching the sentence.
 */
function toolError(
  text: string,
  code:
    | "DOCUMENT_NOT_FOUND"
    | "DOCUMENT_ALREADY_EXISTS"
    | "UNAUTHORIZED_ACTION"
    | "VERSION_NOT_FOUND"
    | "VALIDATION_FAILED"
    | "VAULT_BUSY"
    | "PENDING_CONFIRMATION"
    | "INTERNAL",
  /** Extra machine-readable fields beside {code, message} — e.g. the access
   *  request hint a refused write carries. */
  extra?: Record<string, unknown>,
): ToolResult {
  return { text, isError: true, data: { ...extra, code, message: text } };
}

/** A field definition write's AppError → a typed tool error. */
function fieldToolError(err: unknown): ToolResult {
  if (!(err instanceof AppError)) throw err;
  const code =
    err.statusCode === 403
      ? "UNAUTHORIZED_ACTION"
      : err.statusCode === 404
        ? "DOCUMENT_NOT_FOUND"
        : "VALIDATION_FAILED";
  return toolError(err.message, code);
}

/** A field definition, for prose. */
function describeDefinition(d: FieldDefinition): string {
  const bits = [d.type + (d.unit ? ` (${d.unit})` : "")];
  if (d.options.length) bits.push(`options: ${d.options.join(", ")}`);
  if (d.required) bits.push("required");
  if (d.default_value !== null && d.default_value !== undefined) {
    bits.push(`default: ${Array.isArray(d.default_value) ? d.default_value.join(", ") : String(d.default_value)}`);
  }
  bits.push(`applies to: ${d.applies_to.join(", ")}`);
  if (d.type === "time_in_status") bits.push("computed, read-only");
  return `- **${d.label}** \`${d.key}\` — ${bits.join(" · ")}`;
}

/** Stored + computed field values for a node, or undefined when it has none. */
function nodeFieldValues(
  node: { type?: string; metadata?: unknown; moved_at?: string; created_at?: string },
  defs: FieldDefinition[],
): Record<string, unknown> | undefined {
  const stored = storedFieldsOf(node.metadata);
  const [withComputed] = addComputedFields(
    [{ type: node.type, fields: stored, moved_at: node.moved_at, created_at: node.created_at }],
    defs,
  );
  const known = Object.fromEntries(
    Object.entries(withComputed.fields ?? {}).filter(([k]) => defs.some((d) => d.key === k)),
  );
  return Object.keys(known).length > 0 ? known : undefined;
}

/**
 * A refused write the caller could ask about instead (CU-wdqcq041jn). The
 * prose names context_request_access (or says the ask is already waiting),
 * and `data` carries the same fields the REST 403 does — can_request_access,
 * target, level, and the caller's pending/denied request — so an agent can
 * file the ask without parsing the sentence. Falls back to the plain refusal
 * for callers who can't ask (no account, read-only access keys) and for a
 * document the caller can't read: naming it would say it exists.
 */
async function writeRefusal(
  ctx: McpToolContext,
  text: string,
  target: AccessTarget,
): Promise<ToolResult> {
  if (
    target.type === "node" &&
    !(await canReadNode(ctx.nestId, target.id, ctx.userId, ctx.userEmail))
  ) {
    return toolError(text, "UNAUTHORIZED_ACTION");
  }
  const hint = await accessRequestHint({ nestId: ctx.nestId, userId: ctx.userId, target });
  if (!hint) return toolError(text, "UNAUTHORIZED_ACTION");
  // The REST hint's `code: "forbidden"` would shadow the engine error code.
  const { code: _restCode, ...fields } = hint;
  const pending = (fields.access_request as { status?: string; id?: string } | undefined);
  const next =
    pending?.status === "pending"
      ? `You already asked for this access (request ${pending.id}); it is waiting on a nest owner or admin.`
      : `Use context_request_access to ask a nest owner or admin for write access${target.type === "node" ? " to it" : ""} — say why in \`note\`.`;
  return toolError(`${text}\n\n${next}`, "UNAUTHORIZED_ACTION", fields);
}

/** What a headless access key gets for a tool it may not call (CU-wdqcq0314u)
 *  — the same shape on both MCP surfaces. */
export function headlessToolError(toolName: string): ToolResult {
  return toolError(headlessToolRefusal(toolName), "UNAUTHORIZED_ACTION");
}

/**
 * Tool return value → MCP CallToolResult. Used by both MCP endpoints
 * (per-nest routes.ts and server-level server-routes.ts).
 *
 * `content` is the prose, byte-identical to what this server has always
 * emitted — chat clients read nothing else. A handler that also returned a
 * catalog payload gets it attached as `structuredContent`, which is where a
 * machine caller looks.
 */
export function toCallToolResult(out: ToolResult) {
  if (typeof out === "string") {
    return { content: [{ type: "text" as const, text: out }] };
  }
  return {
    content: [{ type: "text" as const, text: out.text }],
    structuredContent: out.data as Record<string, unknown>,
    ...(out.isError ? { isError: true } : {}),
  };
}

/**
 * A ContextNode plus its ALREADY-GATED body → the catalog's `nodeSummary`
 * (engine api/core.ts). Callers MUST pass the body that `resolveLlmBody`
 * returned for this node, never `node.body` — that is the ungated on-disk
 * text, which under stewardship is the unapproved draft.
 */
function summarizeNode(node: ContextNode, body: string | null) {
  return {
    id: node.id,
    title: node.frontmatter.title,
    description: node.frontmatter.description,
    type: node.frontmatter.type || "document",
    status: node.frontmatter.status || "draft",
    tags: node.frontmatter.tags,
    body: body ?? undefined,
  };
}

/**
 * `**Source file:** PDF, N pages[, no text layer]` for a pdf node — tells an
 * agent the body is text extracted from a PDF, and when it is empty because
 * the PDF is a scan rather than because the document says nothing.
 *
 * Describes the version whose body is being returned: under stewardship
 * `body` is the APPROVED snapshot (frontmatter included), whose `pdf:` block
 * can differ from the live draft's, so it is read from there when present.
 */
function pdfSourceLine(node: ContextNode, body: string | null): string | null {
  if ((node.frontmatter.type || "document") !== "pdf") return null;
  let pdf = node.frontmatter.pdf;
  if (body && body.startsWith("---")) {
    try {
      pdf = parseDocument(`${node.id}.md`, body, node.id).frontmatter.pdf ?? pdf;
    } catch {
      // Unparseable snapshot: fall back to the live block.
    }
  }
  if (!pdf) return "**Source file:** PDF";
  const pages = `${pdf.pages} page${pdf.pages === 1 ? "" : "s"}`;
  return `**Source file:** PDF, ${pages}${pdf.text_layer ? "" : ", no text layer"}`;
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
  /** The API key this call arrived on — what the agent-write gate holds and
   *  what "always allow" whitelists. Null for a cookie-authenticated call. */
  apiKeyId?: string | null;
  apiKeyLabel?: string | null;
  /**
   * Caller attribution for this call (spec §9.4) — what the TRANSPORT could
   * derive, already merged with whatever the tool call itself sent (caller
   * wins, per key). Set by handleToolCall; a tool never reads `args.client`.
   *
   * A label, never an identity: no gate below may branch on it.
   */
  client?: ClientMetadata;
  /**
   * The version each document body was served at during this call, filled in
   * by resolveLlmBody (the one place a body is chosen) and read back by the
   * activity log so a read records exactly what the agent got. Set fresh per
   * call by handleToolCall.
   */
  servedVersions?: Map<string, number>;
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
      "Full-text keyword search across all node content, titles, tags, and metadata — the same index-backed match as REST GET /search. Returns `count` (everything found) and the first `limit` hits, title matches first.",
    inputSchema: {
      type: "object" as const,
      properties: {
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
            "Filter by status: draft | pending_review | approved | published | rejected. Aliases normalized. Unlike the CLI and the OSS server, retired nodes stay in this listing whether or not you ask — here they are unpublished documents their stewards may still act on.",
        },
        approved_only: {
          type: "boolean",
          description:
            "Return only nodes with an approved version, each served at that version rather than the live file — the view a public nest gives a stranger.",
        },
        limit: { type: "number", description: "Max nodes to return" },
        fields: {
          type: "object",
          description:
            'Filter by custom fields, field key → value; every entry must match. select/user/date/url/number match exactly (case-insensitive), multi_select matches when the option is one of its values, text matches a substring, checkbox takes true/false (unset counts as false), and "none" matches an unset field. E.g. {"severity": "high", "blocked": true}.',
        },
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
    name: "context_comment",
    description:
      "Leave a comment on a document — the same threads the web UI's comments panel shows. Omit `thread` to open a new one; pass a thread id (from context_comments) to reply to it. Use this to answer feedback you were given, or to raise something you noticed while working. Anyone who can read the document may comment; `@name` in the body notifies that person.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the node" },
        id: { type: "string", description: "ID of the node" },
        body: { type: "string", description: "The comment text" },
        thread: {
          type: "string",
          description:
            "Thread id to reply to (from context_comments). Omit to open a new thread on the document.",
        },
      },
      required: ["body"],
    },
  },
  {
    name: "context_resolve_comment",
    description:
      "Mark a comment thread resolved once you have addressed it, or reopen one that was closed too early. Records you as the resolver, exactly as the web UI does. Resolve only threads you actually acted on.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the node" },
        id: { type: "string", description: "ID of the node" },
        thread: {
          type: "string",
          description: "Thread id, from context_comments",
        },
        reopen: {
          type: "boolean",
          description: "Reopen the thread instead of resolving it",
        },
      },
      required: ["thread"],
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
        fields: {
          type: "object",
          description:
            "Custom field values, field key → value (see context_fields for this nest's fields and their types). Validated against the definitions: select takes one option, multi_select a list of options, user an email on the nest, date YYYY-MM-DD, url an http(s) URL, checkbox true/false, number a number. null clears a field. Computed fields (time in status) can't be set.",
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
        id: {
          type: "string",
          description:
            'Node id / path (e.g. "nodes/gtm/deals/win-loss-log"). Use instead of title when two nodes share a title or the title is unknown.',
        },
        content: {
          type: "string",
          description: "New content (replaces)",
        },
        append: { type: "string", description: "Content to append" },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "The node's full tag set — REPLACES the existing tags (same as the engine catalog). To add one, send the current tags plus the new one; to remove one, send the set without it.",
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
        fields: {
          type: "object",
          description:
            "Custom field values, field key → value (see context_fields for this nest's fields and their types). Validated against the definitions: select takes one option, multi_select a list of options, user an email on the nest, date YYYY-MM-DD, url an http(s) URL, checkbox true/false, number a number. null clears a field; keys you leave out are untouched. Computed fields (time in status) can't be set.",
        },
      },
      // Neither is required alone — one of them is (the engine catalog's
      // `.refine(id || title)`, which JSON Schema can't express here).
      // `title` was required, which made this tool unreachable for `ctx`:
      // it addresses nodes by id and never sends a title.
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

  // ─── Custom fields ──────────────────────────────────────────────────
  // Nest configuration, not engine operations: definitions live in this
  // repo's field_definitions table; VALUES live in each node's frontmatter
  // (metadata.fields) and travel through context_create/update/get/list.

  {
    name: "context_fields",
    description:
      "List this nest's custom field definitions — key, label, type, options, required/default, which node types each applies to, and the scale label of a number. Use before setting `fields` on context_create / context_update or filtering context_list by them. Pass `history: true` for the audit trail of definition changes instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        history: {
          type: "boolean",
          description: "Return who changed which definition and how (newest first) instead of the definitions",
        },
      },
    },
  },
  {
    name: "context_create_field",
    description:
      "Define a custom field on this nest (nest admins, the owner, and nest-wide reviewer stewards only). Types: text, number, select, multi_select, date, user (a person on the nest), url, checkbox — plus the computed time_in_status. Presets: `estimate` (a number with a points/hours scale) and `time_in_status` (read-only, how long a task has sat in its current board column).",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description:
            "Stable key values are stored under — lowercase letters, digits and _, starting with a letter. Can't change later. Optional with a preset.",
        },
        type: {
          type: "string",
          description:
            "text | number | select | multi_select | date | user | url | checkbox | time_in_status. Optional with a preset.",
        },
        preset: {
          type: "string",
          description: "estimate | time_in_status — fills key, label and type",
        },
        label: { type: "string", description: "Display name, e.g. Severity" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Allowed values, in display order — select and multi_select only",
        },
        required: {
          type: "boolean",
          description: "New documents must carry a value (defaults fill it when set)",
        },
        default_value: {
          description: "Value filled in on create when none is sent; must be valid for the type",
        },
        applies_to: {
          type: "array",
          items: { type: "string" },
          description: 'Node types the field applies to. Default ["task"]; ["*"] for every type.',
        },
        unit: {
          type: "string",
          description: "Scale label for a number field, e.g. points or hours",
        },
      },
    },
  },
  {
    name: "context_update_field",
    description:
      "Change a custom field's label, options, required/default, node types or unit (nest admins, the owner, and nest-wide reviewer stewards only). The key and type are fixed: values on documents are stored under them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        field: { type: "string", description: "The field's key (or id)" },
        label: { type: "string", description: "Display name, e.g. Severity" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Allowed values, in display order — select and multi_select only",
        },
        required: {
          type: "boolean",
          description: "New documents must carry a value (defaults fill it when set)",
        },
        default_value: {
          description: "Value filled in on create when none is sent; must be valid for the type",
        },
        applies_to: {
          type: "array",
          items: { type: "string" },
          description: 'Node types the field applies to. Default ["task"]; ["*"] for every type.',
        },
        unit: {
          type: "string",
          description: "Scale label for a number field, e.g. points or hours",
        },
        position: { type: "number", description: "Display order, 0 first" },
      },
      required: ["field"],
    },
  },
  {
    name: "context_delete_field",
    description:
      "Remove a custom field definition (nest admins, the owner, and nest-wide reviewer stewards only). Values already on documents stay in their frontmatter and version history; they stop being shown, and defining the same key again brings them back.",
    inputSchema: {
      type: "object" as const,
      properties: {
        field: { type: "string", description: "The field's key (or id)" },
      },
      required: ["field"],
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
      "Ask for something to be deleted when you can't delete it yourself. Flags a document, a folder (with everything in it), or the whole nest for a nest owner/admin to action. Nothing is removed by this call — it opens a request, and the person who resolves it either deletes the target or rejects it with a note. Use this instead of context_delete when that returns a permission error, or when the document belongs to someone else.",
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
            '"pending" (default) or "declined" — past rejections and their notes.',
        },
      },
    },
  },
  {
    name: "context_resolve_deletion",
    description:
      "Action a deletion request: delete the flagged document/folder/nest, or reject it with a note explaining why it stays. Owner/admin only. Rejecting tells the requester the verdict; deleting is irreversible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        request_id: {
          type: "string",
          description: "Request id from context_deletion_queue",
        },
        action: {
          type: "string",
          description:
            '"delete" to honour it, "decline" to reject it and keep the target',
        },
        note: {
          type: "string",
          description: 'Why you rejected it. Required when action is "decline".',
        },
      },
      required: ["request_id", "action"],
    },
  },
  {
    // Access requests (CU-wdqcq041jn), mirroring the REST surface 1:1. Like
    // the deletion trio, not an engine operation: the rows live in this repo's
    // governance tables, so there is no upstream descriptor to import.
    name: "context_request_access",
    description:
      "Ask a nest owner/admin for write access when a write was refused — to one document, a folder, or the whole nest. Nothing changes until someone approves it; you're told the verdict. Use this when context_update / context_create / context_delete / context_move return a permission error that mentions it. Asking twice for the same thing returns the pending request instead of a second one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Title of the document you need to edit" },
        id: {
          type: "string",
          description: 'Document id (e.g. "nodes/gtm/pricing"). Use instead of title when two documents share a title.',
        },
        folder: {
          type: "string",
          description: 'Ask for a whole folder instead of one document, e.g. "gtm/deals".',
        },
        nest: {
          type: "boolean",
          description: "Ask for write access to the entire nest (needed to create documents).",
        },
        note: {
          type: "string",
          description: "Why you need it — this is what the owner/admin judges.",
        },
      },
    },
  },
  {
    name: "context_access_requests",
    description:
      "Show access requests. A nest owner/admin sees everyone's (who wants what, and why); anyone else sees only their own.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          description: '"pending" (default), "approved", "denied" or "all"',
        },
      },
    },
  },
  {
    name: "context_resolve_access_request",
    description:
      "Approve or deny an access request. Owner/admin only. Approving grants the access (a write share on the document or folder, or nest write) and tells the requester; denying tells them why.",
    inputSchema: {
      type: "object" as const,
      properties: {
        request_id: { type: "string", description: "Request id from context_access_requests" },
        decision: { type: "string", description: '"approve" or "deny"' },
        note: { type: "string", description: "Optional note sent to the requester" },
      },
      required: ["request_id", "decision"],
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
        id: {
          type: "string",
          description:
            'Node id / path (e.g. "nodes/gtm/deals/win-loss-log"). Use instead of title when two nodes share a title or the title is unknown.',
        },
        note: { type: "string", description: "Optional note for the reviewer" },
        priority: { type: "string", description: "Priority: low, normal (default), high, urgent" },
      },
      // One of id or title — see context_update.
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
        id: {
          type: "string",
          description:
            'Node id / path (e.g. "nodes/gtm/deals/win-loss-log"). Use instead of title when two nodes share a title or the title is unknown.',
        },
      },
      // One of id or title — see context_update.
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
/**
 * What a caller that has ALREADY gated a whole list can hand resolveLlmBody so
 * it does no per-node lookups of its own. `filterAccessible` is the batched
 * form of `canReadNode` (same resolution, one query set for the list), so a
 * node that came out of it needs no second check; the nest's stewardship flag
 * and its approved-version map are one read each for the whole nest. Build
 * with `batchedBodyGate`.
 */
interface BatchedBodyGate {
  /** The node passed filterAccessible for this caller. */
  accessChecked: true;
  stewardshipEnabled: boolean;
  /** node id → approved version; null when stewardship is off. */
  approvedVersions: Map<string, number> | null;
}

async function batchedBodyGate(nestId: string): Promise<BatchedBodyGate> {
  const stewardshipEnabled = await isStewardshipEnabled(nestId);
  return {
    accessChecked: true,
    stewardshipEnabled,
    approvedVersions: stewardshipEnabled
      ? await versions.getApprovedVersions(nestId)
      : null,
  };
}

async function resolveLlmBody(
  ctx: McpToolContext,
  node: ContextNode,
  gate?: BatchedBodyGate,
): Promise<string | null> {
  // Enforce the SAME per-node access gate as the REST retrieval path. This was
  // missing here — MCP callers bypassed canUserAccess and could read every
  // approved node's body regardless of document/tag/steward scope. Route through
  // canReadNode (the REST helper); deny → return null so callers skip the node
  // instead of leaking it. Strictly more restrictive; can only remove access.
  // A caller that already ran the list through filterAccessible (the batched
  // form of the same check) says so with `gate`, and skips the per-node query.
  if (
    !gate?.accessChecked &&
    !(await canReadNode(ctx.nestId, node.id, ctx.userId, ctx.userEmail))
  ) {
    return null;
  }
  const stewardship = gate
    ? gate.stewardshipEnabled
    : await isStewardshipEnabled(ctx.nestId);
  if (!stewardship) {
    // Ungoverned: the live body, which is the document's current version.
    const live = Number(node.frontmatter?.version);
    if (Number.isInteger(live) && live > 0) ctx.servedVersions?.set(node.id, live);
    return node.body || "";
  }
  const approved = gate
    ? (gate.approvedVersions?.get(node.id) ?? null)
    : await versions.getApprovedVersion(ctx.nestId, node.id);
  if (approved == null) return null;
  try {
    const raw = (await reconstructApproved(ctx.versionManager, ctx.nestId, node.id, approved)).raw;
    ctx.servedVersions?.set(node.id, approved);
    return raw;
  } catch (err) {
    console.error("reconstructVersion failed", node.id, approved, err);
    return null;
  }
}

/** Read tools whose `data` names the documents they handed over, and what
 *  that counts as in the admin activity log. context_resolve and
 *  context_export return prose only, so they record from inside their cases. */
const ACCESS_BY_TOOL: Record<string, AccessAction> = {
  context_get: "read",
  context_query: "retrieve",
  context_search: "retrieve",
};

function recordToolAccess(toolName: string, result: ToolResult, ctx: McpToolContext): void {
  const action = ACCESS_BY_TOOL[toolName];
  if (!action || typeof result === "string" || result.isError || !ctx.nestId) return;
  // context_get names one document (`id`), context_query a list
  // (`documents`), context_search its page (`results`). Missing `results`
  // meant an agent's search — the most common read — was never recorded.
  const data = result.data as
    | { id?: unknown; documents?: Array<{ id?: unknown }>; results?: Array<{ id?: unknown }> }
    | undefined;
  const listed = (xs: unknown) =>
    Array.isArray(xs)
      ? xs.map((d) => (d as { id?: unknown })?.id).filter((id): id is string => typeof id === "string")
      : [];
  const ids = [
    ...(typeof data?.id === "string" ? [data.id] : []),
    ...listed(data?.documents),
    ...listed(data?.results),
  ];
  if (!ids.length) return;
  recordNodeAccess({
    nestId: ctx.nestId,
    nodeIds: ids,
    action,
    surface: "mcp",
    userId: ctx.userId,
    userEmail: ctx.userEmail,
    client: ctx.client,
    ...(ctx.servedVersions?.size ? { versions: Object.fromEntries(ctx.servedVersions) } : {}),
    detail: toolName,
  });
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
): Promise<ToolResult> {
  const started = Date.now();
  let status = 200;
  // Caller attribution, resolved once for the whole call: what the caller sent
  // wins per KEY over what the transport derived, so a call naming its agent
  // but no session still gains a session id (§9.4.2). Validated here rather
  // than in each tool — an out-of-bounds `client` is a refusal, not a 500, and
  // never a partial write.
  let client: ClientMetadata | undefined;
  try {
    client = mergeClient(ctx.client, parseClientMetadata(args.client));
  } catch (err) {
    void logTraceEvent({
      kind: "mcp",
      tool: toolName,
      nestId: ctx.nestId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      status: 400,
      durationMs: Date.now() - started,
    });
    return toolError((err as Error).message, "VALIDATION_FAILED");
  }
  const attributed: McpToolContext = { ...ctx, client, servedVersions: new Map() };
  // Headless access keys (CU-wdqcq0314u) read and nothing else. Checked here,
  // the one seam both MCP surfaces share, so no tool — including one added
  // later — is reachable with an access key unless it is on the read list.
  if (!HEADLESS_READER_TOOLS.has(toolName) && (await isServiceUser(ctx.userId))) {
    void logTraceEvent({
      kind: "mcp",
      tool: toolName,
      nestId: ctx.nestId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      status: 403,
      durationMs: Date.now() - started,
    });
    return headlessToolError(toolName);
  }
  // An agent that sends a whole file (frontmatter + body) as `content` used to
  // get a second, dead frontmatter block stored inside the body. Refuse and say
  // where those fields go instead.
  if (
    (toolName === "context_create" || toolName === "context_update") &&
    typeof args.content === "string" &&
    /^\s*---\r?\n[\w-]+:/.test(args.content)
  ) {
    return toolError(
      "`content` is the markdown body only — it starts with a YAML frontmatter block, which would be stored as body text. Drop the `---` block and pass tags/status as parameters; the server owns the frontmatter.",
      "VALIDATION_FAILED",
    );
  }
  try {
    const result = await runTool(toolName, args, attributed);
    recordToolAccess(toolName, result, attributed);
    return result;
  } catch (err) {
    // Vault write-lock timeout: map to a typed, retryable tool error HERE —
    // one seam covering both MCP surfaces — before the SDK flattens the throw
    // into prose and loses the code. Everything else keeps rethrowing.
    if (isVaultLockTimeout(err) || err instanceof VaultBusyError) {
      status = 503;
      return toolError(
        "The vault is busy with another write. Retry in a few seconds.",
        "VAULT_BUSY",
      );
    }
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
      // Reads record attribution HERE — the activity trace is this edition's
      // §9.2 access trace, and a read seals no version to carry it.
      client,
    });
  }
}

/**
 * Resolve the node a title-or-id tool is aimed at. Returns the node, or the
 * message to hand back to the caller when it can't be resolved — the tools
 * here answer in prose, not exceptions, so a miss reads as an answer rather
 * than a JSON-RPC error. Shared by every node-addressing tool (delete, move,
 * update, versions) so they all accept the same two ways of naming a document
 * — which is also what the engine's operation catalog specifies (`id | title`,
 * `api/index.js`), and what `ctx` sends: it addresses nodes by id.
 *
 * An ambiguous title REFUSES rather than picking one. Titles are not unique —
 * the same title in two folders is two different documents. Guessing would
 * mean an agent silently acting on the wrong document with no error to notice.
 * (context_update used to guess here, on the grounds that a wrong edit is
 * recoverable from history. It now refuses like the rest: the message names
 * the candidate ids, which is a better answer than a coin flip.)
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
      // SECURITY: readDocument is join(nestRoot, id + ".md") with NO
      // containment, so an id is a filesystem path — `../otherNest/nodes/x`
      // reads (and for the write tools below, edits or deletes) another
      // tenant's file. REST funnels every :nodeId through this same guard in
      // app.ts; MCP never did, so the id branch was uncontained for
      // context_delete/context_move too. Inside the try on purpose: a bad id
      // answers "Node not found" in prose like every other miss here.
      return await storage.readDocument(assertSafeNodeId(args.id));
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
): Promise<ToolResult> {
  const { storage, queryEngine, versionManager, nestId, userId, userEmail } = ctx;

  switch (toolName) {
    case "context_init": {
      const { context_md } = await engineApi.run<{ context_md: string | null }>(
        "context_init",
        {},
        await opContext(nestId, userEmail),
      );
      if (!context_md)
        return "No CONTEXT.md found. Use context_overview to see what's available.";
      return `# Vault Instructions (CONTEXT.md)\n\n${context_md}`;
    }

    case "context_overview": {
      // Counts come from the engine, which sees the whole vault; the NODE LIST
      // must not. This tool used to dump every node's title, tags and a body
      // excerpt straight from discoverDocuments with no gate at all — the same
      // hole resolveLlmBody closed for context_get and context_search, still
      // open here. Route the listing through the caller-gated path instead.
      const { total } = await engineApi.run<{ total: number }>(
        "context_init",
        {},
        await opContext(nestId, userEmail),
      );

      // `withContent` for the body previews below. An explicit whole-vault
      // call, so paying for the crawl here is honest; the document tree and
      // context_list do not, and read from the index instead.
      const visible = await listNodesForCallerByEmail(nestId, userEmail, {
        withContent: true,
      });
      const types: Record<string, number> = {};
      const tags: Record<string, number> = {};
      for (const n of visible) {
        types[n.type] = (types[n.type] || 0) + 1;
        for (const tag of n.tags || []) tags[tag] = (tags[tag] || 0) + 1;
      }
      const fmt = (counts: Record<string, number>) =>
        Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([k, c]) => `  ${k}: ${c}`)
          .join("\n");
      const nodeList = visible
        .map(
          (n, i) =>
            `${i + 1}. **${n.title}** [${n.type}] ${(n.tags || []).slice(0, 4).join(" ")}\n   ${(n.content || "").slice(0, 120).replace(/\n/g, " ")}`,
        )
        .join("\n\n");
      // Say so when governance is hiding things, rather than quietly reporting
      // a smaller vault than the one that exists.
      const withheld = total - visible.length;
      const note = withheld > 0 ? `\n_${withheld} node(s) not visible to you._\n` : "";
      return `# Vault Overview\n**Total nodes:** ${visible.length}\n${note}\n## Types\n${fmt(types)}\n\n## Tags\n${fmt(tags)}\n\n## All Nodes\n\n${nodeList}`;
    }

    case "context_search": {
      const query = String(args.query ?? "");
      const limit = normalizeSearchLimit(args.limit);
      // Same path as REST GET /nests/:id/search, in the same order:
      //   1. match terms against the cached discovery set (title, body,
      //      type, tags — matchDocuments), title hits ranked first;
      //   2. gate the HITS with filterAccessible (public reader →
      //      approved-only; governed nest → steward coverage or a share
      //      grant; ungoverned → members see all, grantees their grants);
      //   3. resolve the LLM-visible body for the page only.
      // It used to run step 3 over EVERY document in the nest before matching
      // anything — per node, a permission lookup plus an approved-version
      // read plus a version-chain reconstruction, all in one Promise.all —
      // which is what pushed `ctx search --vault <remote>` past the CLI's 30s
      // timeout on a 444-node governed nest while REST answered at once.
      const matches = matchDocuments(await discoverForSearch(storage), query)
        .filter((n) => !isDerivedAnnotationsNode(n.id));
      const accessible = await filterAccessible(
        nestId,
        userId,
        userEmail,
        matches,
      );
      const count = accessible.length;
      if (count === 0)
        return {
          text: `No nodes matched search: "${query}"`,
          data: { results: [], count },
        };
      // Bodies stay gated exactly as before: under stewardship the LLM only
      // ever sees the approved version, and a hit with no approved version
      // yet is listed (REST lists it) but carries no body. The hits are
      // already access-checked (filterAccessible, above), so the page shares
      // one gate — nest flag + approved-version map — instead of re-running
      // canReadNode and getApprovedVersion per returned node.
      const gate = await batchedBodyGate(nestId);
      const page = await Promise.all(
        accessible.slice(0, limit).map(async (node) => ({
          node,
          body: await resolveLlmBody(ctx, node, gate),
        })),
      );
      const results = page
        .map(({ node: n, body }, i) => {
          const head = `${i + 1}. **${n.frontmatter.title}** [${n.frontmatter.type || "document"}] ${(n.frontmatter.tags || []).join(" ")}`;
          const preview =
            body === null
              ? "_(no approved version yet — body withheld)_"
              : body.slice(0, 200).replace(/\n/g, " ");
          return `${head}\n   ${preview}`;
        })
        .join("\n\n");
      const more =
        count > page.length
          ? ` (showing the first ${page.length}; pass \`limit\` for more)`
          : "";
      return {
        text: `Found ${count} node(s) matching "${query}"${more}:\n\n${results}`,
        // `count` is everything found (like REST); `results` is the page.
        // Bodies are the gated ones the prose is built from. No `score`:
        // this is a term-containment filter with title-first ordering, not
        // a ranked search.
        data: {
          results: page.map(({ node: n, body }) => summarizeNode(n, body)),
          count,
        },
      };
    }

    case "context_table_query": {
      // Same read as every other MCP body read (resolveLlmBody): gated by
      // canReadNode, and approved rows only on a governed nest or for a
      // public reader — never the unapproved working copy.
      const result = await queryTableNode(
        nestId,
        String(args.table ?? ""),
        String(args.query ?? ""),
        false,
        {
          userId: ctx.userId,
          userEmail: ctx.userEmail,
          approvedOnly:
            (await isStewardshipEnabled(nestId)) ||
            (await isPublicReader(nestId, ctx.userId)),
        },
      );
      // Admin activity log: the table the rows came from, at the version
      // queried. Prose-only result, so it records here rather than through
      // recordToolAccess.
      recordNodeAccess({
        nestId,
        nodeIds: [result.table],
        action: "retrieve",
        surface: "mcp",
        userId: ctx.userId,
        userEmail: ctx.userEmail,
        client: ctx.client,
        ...(result.version ? { versions: { [result.table]: result.version } } : {}),
        detail: "context_table_query",
      });
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
      // Traversal stats describe the engine's walk and are true regardless of
      // which documents survive the visibility filter below.
      const { documents, traversal } = await engineApi.run<{
        documents: Array<{
          id: string;
          title: string;
          description?: string;
          type: string;
          status?: string;
          tags?: string[];
          body?: string;
        }>;
        traversal?: { mode: string; hops_used: number; nodes_traversed: number };
      }>(
        "context_query",
        { query: args.query, hops: normalizeHops(args.hops) },
        await opContext(nestId, userEmail),
      );
      // Hide nodes the caller can't see (approved-only under stewardship) so the
      // listing doesn't leak restricted titles — same gate as context_search.
      const visibility = await Promise.all(
        documents.map(async (d) => ({
          doc: d,
          body: await resolveLlmBody(ctx, {
            id: d.id,
            body: d.body ?? "",
            frontmatter: { title: d.title },
          } as ContextNode),
        })),
      );
      const visible = visibility.filter((e) => e.body !== null);
      const nodes = visible.map((e) => e.doc);
      if (!nodes.length)
        return {
          text: `No nodes matched: ${args.query}`,
          data: { documents: [], traversal },
        };
      // Field values from the index mirror (frontmatter only, no file reads).
      // Under stewardship resolveLlmBody served the approved version's raw
      // markdown, so the values come from IT, never the live (draft) file.
      const queryDefs = await listFieldDefinitions(nestId);
      const queryGoverned = queryDefs.length > 0 && (await isStewardshipEnabled(nestId));
      const fmById = new Map<string, ContextNode["frontmatter"]>();
      if (queryDefs.length > 0) {
        for (const n of await readIndexedNodes(nestId)) fmById.set(n.id, n.frontmatter);
      }
      const bodyById = new Map(visible.map((e) => [e.doc.id, e.body ?? ""]));
      const queryValues = (id: string) => {
        const fm = fmById.get(id);
        if (!fm) return undefined;
        return nodeFieldValues(
          {
            type: fm.type,
            metadata: queryGoverned
              ? { fields: fieldsOfRaw(id, bodyById.get(id) ?? "") }
              : fm.metadata,
            moved_at: (fm.metadata as any)?.moved_at,
            created_at: fm.created_at == null ? undefined : String(fm.created_at),
          },
          queryDefs,
        );
      };
      const list = nodes
        .map((n, i) => {
          const f = describeFields(queryValues(n.id), queryDefs);
          return `${i + 1}. **${n.title}** [${n.type}] ${(n.tags || []).join(" ")}${f.length ? `\n   ${f.join(" · ")}` : ""}`;
        })
        .join("\n\n");
      return {
        text: `Found ${nodes.length} node(s) for \`${args.query}\`:\n\n${list}`,
        // The engine already hands back catalog `nodeSummary` shapes — only
        // `body` is swapped for the gated one resolveLlmBody returned.
        // `source_nodes` is deliberately absent: this handler never gates
        // them, so serving them would hand out content the prose refuses.
        data: {
          documents: visible.map((e) => {
            const values = queryValues(e.doc.id);
            return {
              ...e.doc,
              body: e.body ?? undefined,
              ...(values ? { frontmatter: { title: e.doc.title, metadata: { fields: values } } } : {}),
            };
          }),
          traversal,
        },
      };
    }

    case "context_get": {
      // Shared read. This used to load and parse EVERY file in the vault to
      // find one node — an id lookup is a direct read, and only a title needs
      // to search.
      let node: ContextNode;
      try {
        node = await getNodeForCaller(
          nestId,
          args.title ? { title: args.title } : { id: args.id },
          ctx.userId,
          userEmail,
        );
      } catch {
        // getNodeForCaller THROWS on a miss and on a denied id alike — both
        // answer "Node not found" so probing ids can't map a governed nest.
        // Flagging here is the only place it can be flagged: the call never
        // returns a falsy node, so a post-call guard would be dead code.
        return toolError(
          `Node not found: ${args.title || args.id}`,
          "DOCUMENT_NOT_FOUND",
        );
      }
      const body = await resolveLlmBody(ctx, node);
      if (body === null) {
        // Covers both halves of resolveLlmBody's null: the caller may not read
        // this node, or it has no approved version. Either way the content is
        // withheld — UNAUTHORIZED_ACTION is the catalog code for "refused",
        // and telling the two apart would leak which one it was.
        return toolError(
          `Node "${node.frontmatter.title}" has no approved version yet — not available to AI.`,
          "UNAUTHORIZED_ACTION",
        );
      }
      const fieldDefs = await listFieldDefinitions(nestId);
      // Under stewardship `body` is the approved version's raw markdown: its
      // field values, never the live (draft) file's.
      const fieldGoverned = fieldDefs.length > 0 && (await isStewardshipEnabled(nestId));
      const fieldValues = nodeFieldValues(
        {
          type: node.frontmatter.type,
          metadata: fieldGoverned ? { fields: fieldsOfRaw(node.id, body) } : node.frontmatter.metadata,
          moved_at: (node.frontmatter.metadata as any)?.moved_at,
          created_at: node.frontmatter.created_at == null ? undefined : String(node.frontmatter.created_at),
        },
        fieldDefs,
      );
      const meta = [
        `**Title:** ${node.frontmatter.title}`,
        `**Type:** ${node.frontmatter.type || "document"}`,
        node.frontmatter.tags?.length
          ? `**Tags:** ${node.frontmatter.tags.join(" ")}`
          : null,
        pdfSourceLine(node, body),
        ...describeFields(fieldValues, fieldDefs).map((l) => `**${l.replace(": ", ":** ")}`),
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text: `${meta}\n\n---\n\n${body || "(no content)"}`,
        // `body` is the gated one, not node.body — under stewardship that is
        // the APPROVED snapshot, which can be older than the live draft this
        // frontmatter came from. So the payload carries only the fields the
        // prose above already reports, none of which claim to describe a
        // specific version. `version`, `status`, `checksum` and the
        // timestamps are deliberately absent: they describe the draft, and
        // pairing them with an approved body would misdescribe it (checksum
        // would also be a draft hash — see context_versions). `raw` is absent
        // too: no include_raw input here (Phase 2).
        data: {
          id: node.id,
          frontmatter: {
            title: node.frontmatter.title,
            description: node.frontmatter.description,
            type: node.frontmatter.type || "document",
            tags: node.frontmatter.tags,
            // Custom field values, where they are stored (metadata.fields),
            // plus computed ones. The catalog's frontmatter carries metadata.
            ...(fieldValues ? { metadata: { fields: fieldValues } } : {}),
          },
          body,
        },
      };
    }

    case "context_list": {
      // Same per-caller gating REST/UI use: steward access, public-reader
      // approved-only, pending/status resolution.
      const nodes = await listNodesForCallerByEmail(nestId, userEmail, {
        type: args.type,
        tag: args.tag,
        status: args.status,
        approvedOnly: args.approved_only === true,
        // Under stewardship an agent sees approved content only — field
        // values and field filters included, never the live draft's.
        approvedFields: await isStewardshipEnabled(nestId),
        limit: args.limit || 50,
        ...(args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
          ? { fields: args.fields }
          : {}),
      }).catch((err) => {
        if (err instanceof ValidationError) return err;
        throw err;
      });
      if (nodes instanceof ValidationError) return toolError(nodes.message, "VALIDATION_FAILED");
      const listDefs = await listFieldDefinitions(nestId);
      const valuesOf = (n: (typeof nodes)[number]) => {
        const known = Object.fromEntries(
          Object.entries(n.fields ?? {}).filter(([k]) => listDefs.some((d) => d.key === k)),
        );
        return Object.keys(known).length > 0 ? known : undefined;
      };
      // No `body`: listNodesForCaller gates WHICH documents come back, but
      // the `content` it carries is the latest on-disk text — under
      // stewardship that is the unapproved draft resolveLlmBody would refuse.
      // The catalog makes body optional; omitting it is the honest read.
      const documents = nodes.map((n) => ({
        id: n.id,
        title: n.title,
        description: n.description,
        type: n.type || "document",
        status: n.status || "draft",
        tags: n.tags,
        // Custom field values ride in the catalog's optional `frontmatter`,
        // where they are stored (metadata.fields).
        ...(valuesOf(n) ? { frontmatter: { title: n.title, metadata: { fields: valuesOf(n) } } } : {}),
      }));
      if (!nodes.length)
        return { text: "No nodes found with the given filters.", data: { documents } };
      const list = nodes
        .map((n, i) => {
          const f = describeFields(valuesOf(n), listDefs);
          return `${i + 1}. **${n.title}** [${n.type}]${f.length ? ` — ${f.join(" · ")}` : ""}`;
        })
        .join("\n");
      return { text: `${nodes.length} node(s):\n\n${list}`, data: { documents } };
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
      const handed: string[] = [];
      for (const { node: n, body } of resolvedBodies) {
        if (body === null) continue; // not visible / no approved version yet
        const entry = `## ${n.frontmatter.title}\n\n${body}`;
        if (total + entry.length > approxChars) break;
        resolved.push(entry);
        handed.push(n.id);
        total += entry.length;
      }
      recordNodeAccess({
        nestId,
        nodeIds: handed,
        action: "retrieve",
        surface: "mcp",
        userId: ctx.userId,
        userEmail,
        client: ctx.client,
        detail: "context_resolve",
      });
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
      if (parts.length) {
        // Whole nest unless the token budget cut it short — then the documents
        // that actually left.
        const sent = resolved.filter((r) => r.body !== null).slice(0, parts.length);
        recordNodeAccess({
          nestId,
          ...(budgetHit ? { nodeIds: sent.map((r) => r.node.id) } : { wholeNest: true }),
          action: "export",
          surface: "mcp",
          userId: ctx.userId,
          userEmail,
          client: ctx.client,
          detail: `context_export (${parts.length} documents)`,
        });
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
      // Gate by per-node read access. Collaborators/stewards who can read the
      // node in the UI may also read its comment threads over MCP even when the
      // document is not yet approved. Public readers remain blocked by
      // canReadNode until approval. This preserves privacy while letting
      // collaborators address feedback and resubmit.
      if (!(await canReadNode(nestId, node.id, ctx.userId, userEmail))) {
        return `Node not found: ${args.title || args.id}`;
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

    // ── Comments: write half of context_comments ──────────────────────────
    //
    // Both cases target the annotation store the UI's comments panel uses, so
    // an agent's comment and a human's are the same object, and both carry the
    // side effects the REST routes carry: the @mention fan-out and the derived
    // `— Annotations` projection an artifact's agents read back.
    //
    // PRIMARY permission gate, like context_create's: the /mcp middleware
    // admits read-tier callers (the transport is always POST), so the check
    // here is the real one. Commenting is READ-tier — the same rule REST
    // applies in app.ts (isAnnotationAction) — so canReadNode is the bar, not
    // write access. Deliberately NOT gated on an approved version: a reviewer
    // comments on a draft, and unlike reading a thread, writing one discloses
    // nothing (the caller supplies the text).
    case "context_comment":
    case "context_resolve_comment": {
      const body = String(args.body ?? "");
      const isResolve = toolName === "context_resolve_comment";
      // Plain strings, like every other missing-argument answer in this file
      // (`folder is required — …`, `reason is required — …`): a toolError
      // envelope carries a machine-readable `code`, and every code in that
      // union describes a state of the vault, not a malformed call.
      if (!isResolve && !body.trim()) {
        return "body is required — the comment text.";
      }
      const threadId = args.thread ? String(args.thread) : "";
      if (isResolve && !threadId) {
        return "thread is required — the id from context_comments.";
      }

      const docs = await storage.discoverDocuments();
      let node: ContextNode | undefined;
      if (args.title) {
        node = docs.find(
          (n) =>
            n.frontmatter.title.toLowerCase() ===
            String(args.title).toLowerCase(),
        );
      } else if (args.id) {
        node = docs.find((n) => n.id === String(args.id));
      }
      if (!node) {
        return toolError(
          `Node not found: ${args.title || args.id || "(no title or id given)"}`,
          "DOCUMENT_NOT_FOUND",
        );
      }
      if (!(await canReadNode(nestId, node.id, ctx.userId, userEmail))) {
        // Same shape as the not-found above, and it never repeats the resolved
        // title — otherwise the refusal confirms what the caller guessed.
        return toolError(
          `Node not found: ${args.title || args.id}`,
          "DOCUMENT_NOT_FOUND",
        );
      }
      const label = node.frontmatter.title || node.id;

      // A thread id has to belong to THIS node: the services scope their own
      // lookups, but saying so here turns an opaque failure into an
      // instruction the agent can act on.
      if (threadId) {
        const existing = await getThread(threadId);
        if (!existing || existing.nodeId !== node.id || existing.nestId !== nestId) {
          return toolError(
            `Thread ${threadId} is not a thread on "${label}". Call context_comments to list its threads.`,
            "DOCUMENT_NOT_FOUND",
          );
        }
      }

      if (isResolve) {
        const reopen = args.reopen === true;
        const thread = await setThreadStatus(
          nestId,
          node.id,
          threadId,
          reopen ? "open" : "resolved",
          userEmail,
        );
        await syncAnnotationsNode(nestId, node.id, userEmail);
        return reopen
          ? `Reopened the thread on "${label}". It is back in the open list for whoever picks it up.`
          : `Resolved the thread on "${label}", recorded against ${thread.resolvedBy}.`;
      }

      // addComment reopens a resolved thread. Not echoed in the confirmation,
      // for the reason below: it would report the thread's state.
      const thread = threadId
        ? await addComment(nestId, node.id, threadId, userEmail, body)
        : await createThread(nestId, node.id, { body, anchor: null }, userEmail);
      // The confirmation deliberately doesn't report the thread's comment
      // count: writing is admitted on a node whose threads the caller may not
      // be allowed to READ (the approval gate applies to context_comments, not
      // here), so the reply should tell them what THEY did and nothing about
      // what is already in the thread.
      // A reply also notifies the thread's earlier participants, the same
      // fan-out the REST reply route uses.
      //
      // baseUrl: without it the notification still reaches the person, but
      // its "Open document" link falls back to PUBLIC_BASE_URL and comes out
      // empty when that isn't configured — every other notifying tool in
      // this file passes it, and the REST route passes requestBaseUrl.
      if (threadId) {
        await notifyCommentReply({
          nestId,
          nodeId: node.id,
          thread,
          body,
          actorEmail: userEmail,
          baseUrl: ctx.baseUrl,
        });
      } else {
        await notifyCommentMentions({
          nestId,
          nodeId: node.id,
          body,
          actorEmail: userEmail,
          baseUrl: ctx.baseUrl,
        });
      }
      await syncAnnotationsNode(nestId, node.id, userEmail);
      return threadId
        ? `Replied on "${label}", in thread ${thread.id}.`
        : `Commented on "${label}" — opened thread ${thread.id}. Reply to it by passing that id as \`thread\`.`;
    }

    case "context_create": {
      // PRIMARY write gate: the /mcp middleware admits read-tier callers
      // (the MCP transport is always POST), so this per-tool check is what
      // keeps creation locked to write+ collaborators and nest-scope editors.
      if (!(await stewardship.canCreateInNest(nestId, userEmail))) {
        return writeRefusal(
          ctx,
          "You don't have permission to create documents in this nest.",
          { type: "nest", id: nestId },
        );
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
          // A twin with no version rows is invisible to the tools that would
          // normally resolve it: under stewardship it has no approved version,
          // so context_get reads "not found" and no draft list carries it. Say
          // so rather than sending the caller after something they cannot see.
          // The cause is NOT certain — an interrupted create leaves this state,
          // and so does a staged import whose registration never finished — so
          // the message offers writing into it before removing it.
          const twinVersions = await versions.getVersions(nestId, twin.id);
          if (twinVersions.length === 0) {
            return toolError(
              `A node titled "${twin.frontmatter.title}" already exists (${twin.id}) but has no version history, which is why it doesn't show up in a read or a draft list. It may be an interrupted create or a document whose import never finished. Write into it with context_update "${twin.id}" to keep whatever is there, or remove it with context_delete "${twin.id}" and create again — check its content first.`,
              "DOCUMENT_ALREADY_EXISTS",
            );
          }
          return toolError(
            `A node titled "${twin.frontmatter.title}" already exists (${twin.id}). Titles must be unique — MCP tools resolve documents by title, so a second one would be unreachable. Use context_update to change it, context_move to refile it, or create this one under a different title.`,
            "DOCUMENT_ALREADY_EXISTS",
          );
        }
        // Agent-write gate: on a gated nest a non-whitelisted credential does
        // not write, it queues. MCP is an agent surface whatever it
        // authenticated with, so unlike the REST create this holds a cookie
        // call too.
        const held = await holdWriteIfGated({
          nestId,
          userId,
          keyId: ctx.apiKeyId ?? null,
          keyLabel: ctx.apiKeyLabel ?? null,
          userEmail,
          payload: {
            documents: [
              {
                title: args.title,
                content: args.content,
                type: args.type,
                tags: args.tags,
                scope: args.scope,
                folder: args.folder,
                ...(args.fields !== undefined ? { fields: args.fields } : {}),
              },
            ],
          },
        });
        if (held) {
          // An error, not a success with a caveat: nothing was created, and an
          // agent that reads this as "done" will go on to update or link a
          // document that does not exist yet.
          return toolError(
            `This nest holds agent writes for review. "${args.title}" is queued as ${held.id} and will be created only when a reviewer confirms it in ${held.nest_name} — it does not exist yet, so do not reference it. Nothing else is needed from you.`,
            "PENDING_CONFIRMATION",
          );
        }

        let created: Awaited<ReturnType<typeof createNode>>;
        try {
          created = await createNode(
            nestId,
            {
              title: args.title,
              content: args.content,
              type: args.type,
              tags: args.tags,
              scope: args.scope,
              folder: args.folder,
              client: ctx.client,
              ...(args.fields !== undefined ? { fields: args.fields } : {}),
            },
            userEmail,
          );
        } catch (err) {
          // A field value the nest's definitions refuse: say which, typed.
          if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
          throw err;
        }
        const { node, version } = created;
        return {
          text: `Created node: **${args.title}** (${node.id}) — status: ${node.frontmatter.status}`,
          // checkpoint is null by construction: this server seals nothing —
          // a write becomes live through steward review, not a checkpoint.
          data: {
            id: node.id,
            version,
            status: node.frontmatter.status,
            checkpoint: null,
          },
        };
      });
    }

    case "context_update": {
      const node = await resolveTargetNode(storage, args);
      if (typeof node === "string") return toolError(node, "DOCUMENT_NOT_FOUND");
      // What the caller called it. Mirrors resolveTargetNode's precedence: an
      // id wins, so a title sent alongside one was ignored and must not be
      // echoed back as if it named the document. Title-only echoes verbatim.
      const label = args.id ? node.frontmatter.title : args.title;
      // Defense-in-depth: same per-node edit check REST resolves, so editing
      // stays gated regardless of the /mcp middleware. Unchanged by accepting
      // an id: resolution reaches the same nest-scoped documents either way,
      // and this gate runs on the resolved node, not on how it was named.
      const editCheck = await stewardship.canUserEdit(nestId, node.id, userEmail);
      if (!editCheck.allowed) {
        return writeRefusal(
          ctx,
          `You don't have permission to edit "${label}": ${editCheck.reason}`,
          { type: "node", id: node.id },
        );
      }
      // Tags REPLACE, per the engine catalog's context_update. This used to
      // merge ("Tags to add"), which left no way to remove a tag over MCP.
      let result: Awaited<ReturnType<typeof updateNode>>;
      try {
        result = await updateNode(
          nestId,
          node.id,
          {
            content: args.content,
            append: args.append,
            tags: args.tags,
            status: args.status,
            changeNote: args.changeNote,
            client: ctx.client,
            ...(args.fields !== undefined ? { fields: args.fields } : {}),
          },
          userEmail,
        );
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
        throw err;
      }
      const { node: updated, version } = result;
      return {
        text: `Updated node: **${updated.frontmatter.title}** — v${version}, status: ${updated.frontmatter.status}`,
        // checkpoint null — see context_create.
        data: {
          id: updated.id,
          version,
          status: updated.frontmatter.status,
          checkpoint: null,
        },
      };
    }

    case "context_fields": {
      if (args.history === true) {
        const events = await listFieldDefinitionEvents(nestId);
        if (events.length === 0) return { text: "No field definition changes recorded yet.", data: { events } };
        const lines = events.map(
          (e) =>
            `- ${e.at} — ${e.actor_email ?? e.actor_id ?? "unknown"} ${e.action}d \`${e.field_key}\``,
        );
        return { text: `${events.length} definition change(s):\n\n${lines.join("\n")}`, data: { events } };
      }
      const defs = await listFieldDefinitions(nestId);
      if (defs.length === 0) {
        return {
          text: "This nest defines no custom fields yet. A nest admin can add some with context_create_field.",
          data: { fields: [] },
        };
      }
      return {
        text: `${defs.length} custom field(s):\n\n${defs.map(describeDefinition).join("\n")}`,
        data: { fields: defs },
      };
    }

    // PRIMARY gate for the three definition writes is assertCanManageFields
    // inside the service (owner / nest admin / license admin / nest-wide
    // reviewer steward, never on an archived nest) — the same function the
    // REST routes call, so the two surfaces can't disagree.
    case "context_create_field": {
      try {
        const field = await createFieldDefinition(nestId, userId, {
          key: args.key,
          label: args.label,
          type: args.type,
          options: args.options,
          required: args.required,
          default_value: args.default_value,
          applies_to: args.applies_to,
          unit: args.unit,
          preset: args.preset,
        });
        return {
          text: `Defined field:\n${describeDefinition(field)}`,
          data: { field },
        };
      } catch (err) {
        return fieldToolError(err);
      }
    }

    case "context_update_field": {
      try {
        const patch: Record<string, unknown> = {};
        for (const k of [
          "label",
          "options",
          "required",
          "default_value",
          "applies_to",
          "unit",
          "position",
          "key",
          "type",
        ]) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        const field = await updateFieldDefinition(nestId, String(args.field ?? ""), userId, patch);
        const invalid = await nodesWithInvalidValues(nestId, field);
        return {
          text: `Updated field:\n${describeDefinition(field)}${
            invalid.length
              ? `\n\n${invalid.length} document(s) keep a value that no longer fits this definition (it stays in their history; the next edit of that field must fix it): ${invalid.slice(0, 10).join(", ")}`
              : ""
          }`,
          data: { field, invalid_values: invalid.length, invalid_nodes: invalid.slice(0, 50) },
        };
      } catch (err) {
        return fieldToolError(err);
      }
    }

    case "context_delete_field": {
      try {
        const field = await deleteFieldDefinition(nestId, String(args.field ?? ""), userId);
        return {
          text: `Removed field **${field.label}** (\`${field.key}\`). Values already on documents stay in their history.`,
          data: { deleted: true, field },
        };
      } catch (err) {
        return fieldToolError(err);
      }
    }

    case "context_delete": {
      const node = await resolveTargetNode(storage, args);
      if (typeof node === "string") return toolError(node, "DOCUMENT_NOT_FOUND");
      // PRIMARY write gate — the /mcp transport admits read-tier callers, so
      // this per-tool check is the only thing standing between a viewer and a
      // deleted document. Delete is at least as privileged as edit, so it
      // takes the same per-node check context_update does.
      const deleteCheck = await stewardship.canUserEdit(nestId, node.id, userEmail);
      if (!deleteCheck.allowed) {
        // Dead end otherwise — point at the request path the UI offers here.
        return writeRefusal(
          ctx,
          `You don't have permission to delete "${node.frontmatter.title}": ${deleteCheck.reason}\n\nUse context_request_deletion to ask a nest owner/admin to delete it, with a reason.`,
          { type: "node", id: node.id },
        );
      }
      await deleteNode(nestId, node.id, userEmail, { client: ctx.client });
      return {
        text: `Deleted node: **${node.frontmatter.title}** (${node.id})`,
        data: {
          id: node.id,
          title: node.frontmatter.title,
          deleted: true as const,
        },
      };
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
        return writeRefusal(
          ctx,
          `You don't have permission to move "${node.frontmatter.title}": ${moveCheck.reason}`,
          { type: "node", id: node.id },
        );
      }
      const { node: moved, previousId } = await moveNode(
        nestId,
        node.id,
        args.folder,
        userEmail,
      );
      // `data` is what `ctx move` reads; the prose is for chat clients.
      const data = { id: moved.id, previous_id: previousId, title: moved.frontmatter.title };
      if (previousId === moved.id) {
        return { text: `**${moved.frontmatter.title}** is already at \`${moved.id}\` — nothing to move.`, data };
      }
      return { text: `Moved **${moved.frontmatter.title}**: \`${previousId}\` → \`${moved.id}\``, data };
    }

    // ─── Governance Tool Handlers ──────────────────────────────────────

    case "context_stewards": {
      if (args.title) {
        // Resolve stewards for a specific node
        const docs = await storage.discoverDocuments();
        const node = docs.find(
          (n) => n.frontmatter.title.toLowerCase() === args.title.toLowerCase(),
        );
        // A title the caller cannot open resolves exactly like one that does
        // not exist — otherwise its document-scoped stewards (and so the
        // document itself) leak through the lookup.
        const readable =
          node !== undefined &&
          (await canReadNode(ctx.nestId, node.id, ctx.userId, ctx.userEmail));
        const nodeId = readable ? node.id : "";
        const resolved = await stewardship.resolveStewardsForNode(ctx.nestId, nodeId);

        if (resolved.length === 0) {
          return `No stewards configured for "${args.title}". Changes are auto-approved.`;
        }

        // Members see who reviews their work; a public reader is an outsider
        // and gets the roles without the people's email addresses.
        const hideEmails = await isPublicReader(ctx.nestId, ctx.userId);
        const list = resolved
          .map(
            (r, i) =>
              `${i + 1}. **${hideEmails ? "a steward" : r.steward.userEmail}** — ${r.steward.role} (${hideEmails ? r.steward.scope : r.source})${r.steward.role === "reviewer" ? " ✓ can approve" : ""}`,
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
        if (
          !(await canRequestDeletion({ nestId, userId, userEmail, nodeId: "" }))
        ) {
          return "Only an editor, a nest admin, or the nest owner can request the deletion of a nest.";
        }
        const request = await reviews.requestDeletion({
          nestId,
          nodeId: nestId,
          targetType: "nest",
          requestedBy: userEmail,
          reason,
          baseUrl: ctx.baseUrl,
        });
        return `Requested deletion of the **entire nest**. A nest owner or admin will delete it or reject the request.\nRequest id: \`${request.id}\``;
      }

      // Folder — normalized the same way the REST route does, so two people
      // flagging "gtm/deals" and "/nodes/gtm/deals/" collide on one request.
      if (typeof args.folder === "string" && args.folder.trim()) {
        if (
          !(await canRequestDeletion({ nestId, userId, userEmail, nodeId: "" }))
        ) {
          return "Only an editor, a nest admin, or the nest owner can request the deletion of a folder.";
        }
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
        return `Requested deletion of folder **${folder}** (${inside.length} document(s) inside). A nest owner or admin will delete it or reject the request.\nRequest id: \`${request.id}\``;
      }

      // Document — resolved by title or id like every other node tool.
      const node = await resolveTargetNode(storage, args);
      if (typeof node === "string") return node;
      // Read gate first, so a caller who can't see the node learns nothing
      // beyond "not found"; then the editor gate (see canRequestDeletion —
      // proposing a deletion is an editor's act, not a reader's).
      if (!(await canReadNode(nestId, node.id, userId, userEmail))) {
        return `Node not found: ${node.id}`;
      }
      if (
        !(await canRequestDeletion({
          nestId,
          userId,
          userEmail,
          nodeId: node.id,
        }))
      ) {
        return "Only an editor, a nest admin, or the nest owner can request the deletion of a document.";
      }
      const request = await reviews.requestDeletion({
        nestId,
        nodeId: node.id,
        targetType: "document",
        requestedBy: userEmail,
        reason,
        baseUrl: ctx.baseUrl,
      });
      return `Requested deletion of **${node.frontmatter.title}**. A nest owner or admin will delete it or reject the request — nothing is removed yet.\nRequest id: \`${request.id}\``;
    }

    case "context_deletion_queue": {
      const status = args.status === "declined" ? "declined" : "pending";
      const requests = await reviews.listDeletionRequests({ nestId, status });
      if (requests.length === 0) {
        return status === "pending"
          ? "No deletion requests waiting. All caught up!"
          : "No rejected deletion requests.";
      }
      const list = requests
        .map((r, i) => {
          const kind = r.targetType === "document" ? "" : `${r.targetType}: `;
          const verdict =
            r.status === "declined"
              ? `\n   Rejected by ${r.resolvedBy}: "${r.resolutionNote}"`
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
          return "note is required when rejecting — the requester is told why it stays.";
        }
        await reviews.declineDeletion({
          nestId,
          id: requestId,
          declinedBy: userEmail,
          note,
          baseUrl: ctx.baseUrl,
        });
        return `Rejected the deletion request for **${label}**. It stays, and ${request.requestedBy} has been told why.`;
      }

      // Same branch set as the REST honour route (governance/routes.ts) — this
      // is a parallel implementation of the same verdict, so a target type
      // missing here doesn't fall through to a sensible default: it reaches
      // deleteNode with a nodeId that is really a NEST id and throws
      // "Node not found".
      if (request.targetType === "nest_archive") {
        // archiveNest clears the pending nest_archive row itself.
        await archiveNest(nestId);
      } else if (request.targetType === "nest") {
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
      return request.targetType === "nest_archive"
        ? `Archived **${label}** — ${request.requestedBy}'s request was honoured. Nothing was deleted: the nest is read-only and hidden until someone restores it.`
        : `Deleted **${label}** — ${request.requestedBy}'s request was honoured. Irreversible.`;
    }

    case "context_request_access": {
      let targetType: "node" | "folder" | "nest";
      let targetId: string | undefined;
      if (args.nest === true) {
        targetType = "nest";
      } else if (typeof args.folder === "string" && args.folder.trim()) {
        targetType = "folder";
        targetId = args.folder;
      } else {
        const node = await resolveTargetNode(storage, args);
        if (typeof node === "string") return toolError(node, "DOCUMENT_NOT_FOUND");
        targetType = "node";
        targetId = node.id;
      }
      try {
        const { request, created } = await createAccessRequest({
          nestId,
          requesterId: userId,
          requesterEmail: userEmail,
          targetType,
          targetId,
          level: "write",
          note: args.note,
          baseUrl: ctx.baseUrl,
        });
        const label = await accessTargetTitle(nestId, {
          type: request.target_type,
          id: request.target_id,
        });
        return {
          text: created
            ? `Asked for write access to **${label}**. A nest owner or admin will approve or deny it; you'll be notified.\nRequest id: \`${request.id}\``
            : `You already asked for write access to **${label}** — it is still waiting on a nest owner or admin.\nRequest id: \`${request.id}\``,
          data: { ...request, title: label, created },
        };
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 404) return toolError(e.message ?? "Not found", "DOCUMENT_NOT_FOUND");
        // 400: already held / archived / not signed in; 429: denied recently.
        if (e.statusCode === 400 || e.statusCode === 429) {
          return toolError(e.message ?? "Invalid request", "VALIDATION_FAILED");
        }
        throw err;
      }
    }

    case "context_access_requests": {
      const status = ["pending", "approved", "denied", "all"].includes(args.status)
        ? args.status
        : "pending";
      const decider = await canDecideAccessRequests(nestId, userId);
      const requests = await listAccessRequests({
        nestId,
        status,
        ...(decider ? {} : { requesterId: userId }),
      });
      if (requests.length === 0) {
        return status === "pending" ? "No access requests waiting." : `No ${status} access requests.`;
      }
      const list = requests
        .map((r, i) => {
          const kind = r.target_type === "node" ? "" : `${r.target_type}: `;
          const why = r.note ? `: "${r.note}"` : "";
          const verdict =
            r.status === "pending"
              ? ""
              : `\n   ${r.status === "approved" ? "Approved" : "Denied"} by ${r.resolved_by}${r.resolution_note ? `: "${r.resolution_note}"` : ""}`;
          return `${i + 1}. **${kind}${r.title || r.target_id}** — ${r.level}\n   Asked by ${r.requested_by}${why}\n   Request id: \`${r.id}\`${verdict}`;
        })
        .join("\n\n");
      return {
        text: `# Access requests (${status})\n**${requests.length} item(s)**\n\n${list}`,
        data: { requests },
      };
    }

    case "context_resolve_access_request": {
      const requestId = typeof args.request_id === "string" ? args.request_id : "";
      const decision =
        args.decision === "approve" ? "approve" : args.decision === "deny" ? "deny" : null;
      if (!requestId || !decision) {
        return toolError(
          'request_id and decision are required — decision is "approve" or "deny". Use context_access_requests to list request ids.',
          "VALIDATION_FAILED",
        );
      }
      // The /mcp transport admits read-tier callers, so this is the gate.
      if (!(await canDecideAccessRequests(nestId, userId))) {
        return toolError(
          "Only the nest owner, a nest admin, or the server admin can decide access requests.",
          "UNAUTHORIZED_ACTION",
        );
      }
      let decided;
      try {
        decided = await decideAccessRequest({
          nestId,
          id: requestId,
          decision,
          decidedById: userId,
          decidedByEmail: userEmail,
          note: typeof args.note === "string" ? args.note : undefined,
          baseUrl: ctx.baseUrl,
        });
      } catch (err) {
        // Archived nest (400) or a plan with no seat for it (402): the request
        // stays pending and the decider is told why.
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 400 || e.statusCode === 402) {
          return toolError(e.message ?? "Couldn't grant the access", "VALIDATION_FAILED");
        }
        throw err;
      }
      if (!decided) {
        return toolError(`No pending access request with id ${requestId}.`, "DOCUMENT_NOT_FOUND");
      }
      const label = await accessTargetTitle(nestId, {
        type: decided.target_type,
        id: decided.target_id,
      });
      return {
        text:
          decision === "approve"
            ? `Approved — ${decided.requested_by} now has ${decided.level} access to **${label}**, and has been told.`
            : `Denied ${decided.requested_by}'s request for **${label}**. They have been told${decided.resolution_note ? " why" : ""}.`,
        data: decided,
      };
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
      const resolved = await resolveTargetNode(storage, args);
      if (typeof resolved === "string") return toolError(resolved, "DOCUMENT_NOT_FOUND");
      const node = resolved;
      const nodeLabel = args.title || args.id;

      // Defense-in-depth: submitting a draft for review is an edit-level
      // action — gate it with the same per-node edit check.
      const submitCheck = await stewardship.canUserEdit(ctx.nestId, node.id, userEmail);
      if (!submitCheck.allowed) {
        return toolError(
          `You don't have permission to submit "${nodeLabel}" for review: ${submitCheck.reason}`,
          "UNAUTHORIZED_ACTION",
        );
      }

      const currentVersion = await versions.getCurrentVersion(ctx.nestId, node.id);
      if (currentVersion === 0)
        return toolError(`No versions found for "${nodeLabel}"`, "VERSION_NOT_FOUND");

      try {
        const request = await reviews.submitForReview({
          nestId: ctx.nestId,
          nodeId: node.id,
          version: currentVersion,
          requestedBy: ctx.userEmail,
          note: args.note,
          priority: args.priority as any,
          baseUrl: ctx.baseUrl,
          client: ctx.client,
        });

        const resolved = await stewardship.resolveStewardsForNode(
          ctx.nestId,
          node.id,
        );

        const stewardList = resolved.length > 0
          ? `\n\n**Stewards who can review:**\n${resolved.map((r) => `- ${r.steward.userEmail} (${r.source})`).join("\n")}`
          : "";

        return {
          text: `Submitted "${nodeLabel}" v${currentVersion} for review (${request.priority} priority).${stewardList}`,
          // No catalog shape to conform to — `context_submit_review` is a
          // governance-namespace operation and that namespace is declared but
          // unimplemented in the engine (`api/index.ts`, NAMESPACES). So this
          // is the review state the handler already computed, and nothing
          // more: no `version`/`checkpoint` at the top level, because this
          // operation writes no new version and seals no checkpoint — it
          // points a review request at the version that already existed.
          // Built from the same gated values the prose above is built from
          // (`request`, `resolved`), never re-read past the permission check.
          data: {
            id: node.id,
            submitted: true as const,
            review: {
              id: request.id,
              version: request.version,
              status: request.status,
              priority: request.priority,
              requested_by: request.requestedBy,
              requested_at: request.requestedAt,
            },
            reviewers: resolved.map((r) => r.steward.userEmail),
          },
        };
      } catch (err: any) {
        // A submit that threw (most often "a review is already pending") is a
        // failure, not an answer. Without isError the client would parse this
        // sentence as a payload and report a contract mismatch instead of the
        // reason. INTERNAL is the catalog's code for an uncoded throw.
        return toolError(`Failed to submit: ${err.message}`, "INTERNAL");
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
          client: ctx.client,
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
      const node = await resolveTargetNode(storage, args);
      if (typeof node === "string") return toolError(node, "DOCUMENT_NOT_FOUND");
      // Version history is a node read, gated like REST GET .../versions: a
      // caller who cannot open the node does not get its editors, statuses and
      // change notes either. Answered as a miss, so it is no existence oracle.
      if (!(await canReadNode(ctx.nestId, node.id, ctx.userId, ctx.userEmail))) {
        return toolError(
          `Node not found: ${args.id ?? args.title}`,
          "DOCUMENT_NOT_FOUND",
        );
      }
      // See context_update: an id wins over a title sent with it.
      const label = args.id ? node.frontmatter.title : args.title;

      const allVersions = await versions.getVersions(ctx.nestId, node.id);
      const approved = await versions.getApprovedVersion(ctx.nestId, node.id);

      if (allVersions.length === 0) {
        return {
          text: `No version history for "${label}".`,
          data: { id: node.id, approved_version: approved ?? null, versions: [] },
        };
      }

      const list = allVersions
        .map(
          (v) =>
            `- **v${v.version}** ${v.status}${v.version === approved ? " (AI-active)" : ""} — by ${v.editedBy} at ${v.editedAt}${v.changeNote ? ` "${v.changeNote}"` : ""}${
              // §9.4: which agent wrote it. In the prose as well as the
              // structured payload — a chat client reads only this half.
              v.client?.agent ? ` [via ${v.client.agent}]` : ""
            }`,
        )
        .join("\n");

      return {
        text: `# Version History: ${label}\n**Current:** v${allVersions[0]?.version || 0} | **AI-active:** ${approved ? `v${approved}` : "none"}\n\n${list}`,
        // Five catalog fields have no equivalent here and are omitted rather
        // than faked: `keyframe_interval` and `keyframe` (content lives on
        // disk — there is no keyframe+diff model), `chain_hash` (integrity is
        // server-side, not a per-version chain), `content_hash` (the column
        // exists but is conflict-detection state this tool has never served,
        // and it is ungated), and `published_at` (a version carries a
        // lifecycle status, not a publish timestamp). `status` and
        // `approved_version` are the community equivalent — the same two
        // facts the prose above reports.
        data: {
          id: node.id,
          approved_version: approved ?? null,
          versions: allVersions.map((v) => ({
            version: v.version,
            status: v.status,
            edited_by: v.editedBy,
            edited_at: v.editedAt,
            note: v.changeNote,
            // §9.4: which agent wrote this version, in which session. Omitted
            // (not `{}`) when the write carried no attribution — "not
            // attributed" and "attributed to nobody" are different claims.
            ...(v.client ? { client: v.client } : {}),
          })),
        },
      };
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
        const { normalizeEmail } = await import("../shared/email.js");
        const e = normalizeEmail(String(args.email || ""));
        if (!e) return "email is required.";
        const { findOrCreateInvitedUser } = await import("../auth/invited-user.js");
        const row = await findOrCreateInvitedUser(e, { invitedBy: ctx.userEmail });
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
          ctx.client,
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
