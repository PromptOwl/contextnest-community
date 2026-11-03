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
 * `context_delete`, `context_move`, `context_submit_review`,
 * `context_request_access`. Each is gated
 * per-call by the same permission checks the per-nest endpoint uses
 * (handleToolCall's canCreateInNest / canUserEdit / canUserApprove).
 *
 * Metacognition (`context_metacognition_list` / `_suggest` / `_configure` / `_run` / `_remove`, nest
 * required) is offered to people who own or administer a nest while its flags
 * are on, and re-checked on the named nest per call.
 *
 * Governance tools that manage people or nest settings (`context_approve`,
 * `context_reject`, `context_share_nest`, `context_stewards`, etc.) stay on
 * the per-nest endpoint only.
 */
import { Hono } from "hono";
import { credentialMayContribute } from "../governance/org-contribution.js";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { requestBaseUrl } from "../shared/base-url.js";
import {
  attributeRequest,
  connectionClient,
  type ClientMetadata,
} from "../shared/client-metadata.js";
import {
  resolveNestPermission,
  permissionLevel,
  isServerAdminUserId,
  type NestPermission,
} from "../shared/access.js";
import {
  listNests,
  listSharedNests,
  listPublicNests,
  createNest,
} from "../nests/service.js";
import { ValidationError, ForbiddenError } from "../shared/errors.js";
import { isSuspended, getSuspensionReason, getOfflineLock } from "../auth/license.js";
import {
  handleToolCall,
  normalizeSearchLimit,
  toCallToolResult,
  TOOL_DEFINITIONS,
  headlessToolError,
  MCP_READ_TOOLS,
  toolShape,
  type ToolResult,
} from "./tools.js";
import { DERIVED_ANNOTATIONS_SUFFIX } from "../nodes/service.js";
import { suffixOf } from "../db/sql.js";
import type { Nest } from "../shared/types.js";
import { NEUTRAL_READ_ONLY, canSeeLicenseDetail, offlineLockMessage } from "../auth/license-copy.js";
import { FREE_TIER_EXCEEDED_MESSAGE, writesAllowed } from "../auth/free-tier.js";
import { HEADLESS_READER_SERVER_TOOLS, isHeadlessIdentity } from "../auth/headless.js";
import { isSystemUser } from "../auth/systems.js";
import {
  METACOGNITION_TOOL_DEFINITIONS,
  isMetacognitionTool,
  requestMayUseMetacognition,
} from "./metacognition-tools.js";
import { metacognitionEnabled } from "../metacognition/manage.js";
import { isInitializeRequest, serverConnectInstructions } from "./connect-instructions.js";

// Server-level tools that mutate. The top-level /mcp route carries no
// suspend/license middleware (unlike the per-nest access guard), so the
// kill-switch + license gates that every per-nest write honors must be
// enforced here or these two writes would bypass both. Reads stay open when
// suspended/unlicensed, matching the REST policy.
const SERVER_WRITE_TOOLS = new Set([
  "nest_create",
  "context_create",
  "context_upload",
  "context_update",
  "context_delete",
  "context_move",
  "context_submit_review",
  "context_request_access",
  "context_task_log",
  "context_bulk_update",
  "context_metacognition_configure",
  "context_metacognition_run",
  "context_metacognition_remove",
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
  // Doc counts in one grouped query, the same one the dashboard's GET /nests
  // uses. Counting by a filesystem scan per nest (every document read off the
  // bucket mount) made this index slower with every nest a user could reach,
  // until callers like The Owl's chat page timed out on it. The derived
  // `— Annotations` projections are left out, like every listing does.
  // Scoped to the caller's nests. Best-effort, like the scan it replaced: a
  // failed count reads as unknown (null), never takes the index down.
  const db = getDb();
  let docsByNest: Map<string, number> | null = new Map();
  if (rows.length) {
    try {
      const countRows = (await db.all(
        `SELECT nest_id,
                COUNT(DISTINCT CASE
                  WHEN ${suffixOf(db, "node_id", DERIVED_ANNOTATIONS_SUFFIX.length)} <> ?
                  THEN node_id END) AS c
           FROM node_versions
          WHERE nest_id IN (${rows.map(() => "?").join(", ")})
          GROUP BY nest_id`,
        [DERIVED_ANNOTATIONS_SUFFIX, ...rows.map((n) => n.id)],
      )) as Array<{ nest_id: string; c: number }>;
      // Number(): Postgres returns COUNT as a string.
      docsByNest = new Map(countRows.map((r) => [r.nest_id, Number(r.c)]));
    } catch (err) {
      console.error("[index] document counts unavailable:", err);
      docsByNest = null;
    }
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
      return {
        id: n.id,
        name: n.name,
        description: n.description,
        visibility: n.visibility,
        permission,
        // No version rows = an empty nest, so 0; null only when the count failed.
        document_count: docsByNest ? (docsByNest.get(n.id) ?? 0) : null,
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
 * Per-nest tools the server-level endpoint also serves, with a `nest` arg
 * added. Their schemas and descriptions are the PER-NEST definitions, not
 * copies: the hand-kept subset drifted (no `status`/`approved_only` on list,
 * no context_versions at all) and the SDK silently strips keys a schema
 * doesn't declare, so `ctx` could send a field that vanished while the call
 * reported success.
 */
const SERVER_NEST_TOOLS = [
  // Fan-out reads — `nest` optional: omit it to span every accessible nest.
  ...FANOUT_READ_TOOLS,
  // Targeted reads and writes — `nest` required.
  "context_get",
  "context_resolve",
  "context_comments",
  "context_versions",
  "context_create",
  "context_upload",
  "context_update",
  "context_delete",
  "context_move",
  "context_submit_review",
  "context_request_access",
  "context_task_log",
  "context_relations",
  "context_add_relation",
  "context_remove_relation",
  "context_boards",
  "context_board_items",
  "context_bulk_update",
];

function withNestArg(tool: { name: string; description: string; inputSchema: unknown }) {
  const fanout = FANOUT_READ_TOOLS.has(tool.name);
  const schema = tool.inputSchema as { properties?: object; required?: string[] };
  return {
    name: tool.name,
    description: fanout
      ? `${tool.description} On this server-level endpoint, omit \`nest\` to run it across ALL accessible nests (each hit names its nest).`
      : `${tool.description} On this server-level endpoint, \`nest\` (id, name or slug) is required.`,
    inputSchema: {
      ...schema,
      properties: { ...(fanout ? NEST_ARG_OPTIONAL : NEST_ARG), ...schema.properties },
      required: [...(fanout ? [] : ["nest"]), ...(schema.required ?? [])],
    },
  };
}

export const SERVER_TOOL_DEFINITIONS = [
  {
    name: "nest_index",
    description:
      "Grounded index of every nest these credentials can read: name, id, permission, document count. Call this FIRST.",
    inputSchema: { type: "object" as const, properties: {} },
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
  ...SERVER_NEST_TOOLS.map((name) => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
    if (!tool) throw new Error(`server-level tool ${name} has no per-nest definition`);
    return withNestArg(tool);
  }),
  // Metacognition agents (CU-wdqcq05rqq): the per-nest definitions with
  // `nest` required. Advertised per request only while both feature flags are
  // on and the caller administers some nest (createServerMcp); each call
  // re-checks owner/admin on the named nest.
  ...METACOGNITION_TOOL_DEFINITIONS.map(withNestArg),
];

/**
 * The tools an OAuth grant may call with only `nests:read`.
 *
 * Deliberately an ALLOW-list of read-only tools rather than a deny-list of
 * writes: a tool added later and forgotten about defaults to requiring
 * `nests:write`, which fails closed. The reverse would silently hand every new
 * write tool to read-only grants.
 *
 * Only OAuth callers are affected. A cnst_ key or an MCP ticket carries no
 * scope and keeps doing whatever the user themselves can do.
 */
const READ_ONLY_SERVER_TOOLS = new Set([
  "nest_index",
  "context_query",
  "context_search",
  "context_list",
  "context_overview",
  "context_get",
  "context_resolve",
  "context_comments",
  "context_versions",
  "context_boards",
  "context_board_items",
]);

/** Exported so a test can assert every defined tool is classified. */
export function serverToolNeedsWrite(name: string): boolean {
  return !READ_ONLY_SERVER_TOOLS.has(name);
}

/**
 * Does this grant reach this tool?
 *
 * `nests:write` implies `nests:read` — a grant that may create documents but
 * not read them is useless, and treating them as disjoint let a write-only
 * grant read everything while its consent screen mentioned only writing.
 * Both directions are checked here so neither can be forgotten again.
 */
export function scopeAllows(granted: string[], toolName: string): boolean {
  const canWrite = granted.includes("nests:write");
  const canRead = canWrite || granted.includes("nests:read");
  return serverToolNeedsWrite(toolName) ? canWrite : canRead;
}

async function handleServerToolCall(
  toolName: string,
  args: any,
  userId: string,
  userEmail: string,
  nestScope: string | null,
  baseUrl: string,
  apiKeyId: string | null,
  apiKeyLabel: string | null,
  client?: ClientMetadata,
  headless = false,
  capability: "read" | "write" = "write",
  /** A person's own full credential (CU-wdqcq05rz6) — see McpToolContext. */
  contributorCredential = false,
): Promise<ToolResult> {
  // Headless access keys (CU-wdqcq0314u): nest_create and every other
  // server-only tool are refused here; per-nest tools are re-checked in
  // handleToolCall.
  if (headless && !HEADLESS_READER_SERVER_TOOLS.has(toolName)) {
    return headlessToolError(toolName);
  }
  // CAPABILITY GATE (read-only keys) for the server tools handled inline here
  // (nest_index is read; nest_create is a write). The nest-parameterized tools
  // route through handleToolCall → runTool, whose own capability gate covers
  // them (incl. the context_create bootstrap write).
  if (capability === "read" && !MCP_READ_TOOLS.has(toolName)) {
    return `This API key is read-only and cannot call "${toolName}". Read-only keys may only read, query, search, and export. Mint a read-write key for changes.`;
  }
  if (toolName === "nest_index") {
    const nests = await buildNestIndex(userId, nestScope);
    // `data` is what `ctx vault list` reads to list each nest as `<alias>/<nest>`.
    const data = { nests };
    if (!nests.length) return { text: "No nests accessible with these credentials.", data };
    return { text: renderNestIndexMarkdown(nests, baseUrl), data };
  }

  // Kill-switch + license gate for writes — parity with per-nest write path
  // (both ask writesAllowed, so the Free tier applies here too).
  if (SERVER_WRITE_TOOLS.has(toolName) && !(await writesAllowed())) {
    if (!(await canSeeLicenseDetail(userId))) {
      return NEUTRAL_READ_ONLY;
    }
    if (isSuspended()) {
      const reason = getSuspensionReason();
      return `This server is suspended by PromptOwl; writes are blocked${
        reason ? ` — ${reason}` : ""
      }. Contact support@promptowl.ai.`;
    }
    const offlineSince = getOfflineLock();
    if (offlineSince) return offlineLockMessage(offlineSince);
    return FREE_TIER_EXCEEDED_MESSAGE;
  }

  if (toolName === "nest_create") {
    if (nestScope) {
      return "This credential is scoped to a single nest and cannot create new ones.";
    }
    // A named system works inside the nests it was granted; it never creates
    // (and so never owns) one (CU-wdqcq0538g).
    if (await isSystemUser(userId)) {
      return "A system key cannot create nests. Ask a nest admin to grant this system the nest it needs.";
    }
    try {
      const nest = await createNest(
        userId,
        String(args.name ?? ""),
        args.description ? String(args.description) : undefined,
      );
      return `Created nest "${nest.name}" (id: ${nest.id}). Add documents with context_create, retrieve with the other tools.`;
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ForbiddenError) return err.message;
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

    // Prose for chat clients (one section per nest); `data` for `ctx`, the
    // per-nest payloads merged with every hit naming the nest it came from.
    // Failed or erroring nests are skipped (best-effort, like nest_index) —
    // unless EVERY nest errored: that is the caller's input (a malformed
    // selector, say), not an empty result, so surface the error.
    const parts: string[] = [];
    let firstError: ToolResult | undefined;
    let firstRejection: PromiseRejectedResult | undefined;
    const tag = (n: IndexedNest, items: unknown) =>
      Array.isArray(items) ? items.map((it) => ({ ...it, nest: { id: n.id, name: n.name } })) : [];
    // Per-nest lists, merged below — kept apart so no nest can crowd out the rest.
    const perNestDocs: unknown[][] = [];
    const perNestHits: unknown[][] = [];
    let count = 0;
    let nodesTraversed = 0;
    let hopsUsed = 0;
    let mode: string | undefined;
    for (const r of results) {
      if (r.status !== "fulfilled") {
        firstRejection ??= r;
        continue;
      }
      const { nest: n, result } = r.value;
      if (typeof result !== "string" && result.isError) {
        firstError ??= result;
        continue;
      }
      parts.push(`## ${n.name} (${n.id})\n\n${typeof result === "string" ? result : result.text}`);
      const d = (typeof result === "string" ? undefined : result.data) as any;
      if (!d) continue;
      perNestDocs.push(tag(n, d.documents));
      perNestHits.push(tag(n, d.results));
      count += d.count ?? 0;
      nodesTraversed += d.traversal?.nodes_traversed ?? 0;
      hopsUsed = Math.max(hopsUsed, d.traversal?.hops_used ?? 0);
      mode ??= d.traversal?.mode;
    }
    // Round-robin: each nest's first hit, then each nest's second, … Search
    // carries no relevance score to rank by across nests (per nest it is a
    // term-containment filter, title matches first), and a nest-by-nest concat
    // cut at `limit` would let the first nests fill every slot.
    const interleave = (lists: unknown[][]) => {
      const out: unknown[] = [];
      for (let i = 0; lists.some((l) => i < l.length); i++) {
        for (const l of lists) if (i < l.length) out.push(l[i]);
      }
      return out;
    };
    if (!parts.length && firstError) return firstError;
    // Same as a single-nest call that threw.
    if (!parts.length && firstRejection) throw firstRejection.reason;
    const documents = interleave(perNestDocs);
    // The caps one nest applies, over the merged set (search 20, max 200;
    // list 50) — otherwise N nests hand back N pages.
    const listLimit =
      typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 50;
    const data =
      toolName === "context_search"
        ? { results: interleave(perNestHits).slice(0, normalizeSearchLimit(args.limit)), count }
        : toolName === "context_query"
          ? { documents, traversal: { mode: mode ?? "selector", hops_used: hopsUsed, nodes_traversed: nodesTraversed } }
          : { documents: documents.slice(0, listLimit) };

    // Overview is prose only — an empty `documents` would read as an empty vault.
    const reply = (text: string): ToolResult =>
      toolName === "context_overview" ? text : { text, data };
    if (!nonEmpty.length) {
      return reply("All accessible nests are empty. Use context_create to add documents first.");
    }
    if (!parts.length) return reply("No results found across any accessible nests.");
    return reply(parts.join("\n\n---\n\n"));
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
    apiKeyId,
    apiKeyLabel,
    client,
    capability,
    contributorCredential,
  });
}

function createServerMcp(
  userId: string,
  userEmail: string,
  nestScope: string | null,
  baseUrl: string,
  apiKeyId: string | null,
  apiKeyLabel: string | null,
  c: Context<AuthEnv>,
  headless = false,
  capability: "read" | "write" = "write",
  /** Offer the metacognition tools: flags on, and a person with a full
   *  credential who owns or administers at least one nest (route handler). */
  offerMetacognition = false,
  /** Returned in the `initialize` result (connect-instructions.ts). */
  instructions?: string,
): McpServer {
  const server = new McpServer(
    { name: "contextnest-server", version: "1.0.0" },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );

  const toolDefs = headless
    ? SERVER_TOOL_DEFINITIONS.filter((t) => HEADLESS_READER_SERVER_TOOLS.has(t.name))
    : SERVER_TOOL_DEFINITIONS;
  for (const tool of toolDefs) {
    // Read-only keys see only the read tools (handleServerToolCall still
    // refuses the writes on its own).
    if (capability === "read" && !MCP_READ_TOOLS.has(tool.name)) continue;
    if (isMetacognitionTool(tool.name) && !offerMetacognition) continue;
    const shape = toolShape(tool.inputSchema);
    server.tool(tool.name, tool.description, shape, async (args) => {
      // Scope check. Present only for OAuth callers; undefined means a key or
      // a ticket, which this must not restrict.
      const granted = c.get("oauthScope");
      if (granted && !scopeAllows(granted, tool.name)) {
        const needed = serverToolNeedsWrite(tool.name)
          ? "nests:write"
          : "nests:read";
        return toCallToolResult(
          `This connection wasn't authorized for that. "${tool.name}" needs the ${needed} scope — reconnect and approve it to use this tool.`,
        );
      }
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
        apiKeyId,
        apiKeyLabel,
        attributeRequest(c, undefined, connectionClient(server)),
        headless,
        capability,
        credentialMayContribute(c),
      );
      return toCallToolResult(out);
    });
  }
  return server;
}

/**
 * Does this caller get the metacognition tools on the server-level endpoint?
 * Both flags on, a person (not a system or access key), and owner/admin on at
 * least one nest these credentials reach — the per-nest endpoint's rule, over
 * every nest, since the nest is only named at call time.
 */
async function offersMetacognition(c: Context<AuthEnv>, userId: string): Promise<boolean> {
  if (!metacognitionEnabled()) return false;
  // The server is rebuilt per request, so only pay for the lookup when this
  // request can use the answer: a tools/list, or a call to one of these tools
  // (which re-checks owner/admin on the named nest anyway). The peek never
  // reads past 64 KB: those requests are a few KB at most, so anything bigger
  // (declared, or read so far on a chunked body) is some other write.
  const CAP = 64 * 1024;
  if (Number(c.req.header("content-length") ?? 0) > CAP) return false;
  const text = await readCapped(c.req.raw.clone().body, CAP);
  if (text === null) return false;
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  const wants = requestMayUseMetacognition(body);
  if (!wants) return false;
  if (await isSystemUser(userId)) return false;
  const person = (await getDb().get("SELECT COALESCE(is_service, 0) AS s FROM users WHERE id = ?", [userId])) as
    | { s: number }
    | undefined;
  if (config.AUTH_MODE !== "open" && (!person || person.s)) return false;
  // Open mode is the owner everywhere; a server admin administers any nest
  // (resolveNestPermission), the ones it can only reach by link included.
  if (config.AUTH_MODE === "open" || (await isServerAdminUserId(userId))) return true;
  // Owning a nest settles it without a lookup per nest; otherwise check the
  // nests shared with the caller (no document counts — buildNestIndex's cost).
  const scope = c.get("nestScope");
  const owned = (await listNests(userId)).filter((n) => !scope || n.id === scope);
  if (owned.length) return true;
  for (const n of await listSharedNests(userId)) {
    if (scope && n.id !== scope) continue;
    const perm = await resolveNestPermission(n.id, userId);
    if (perm === "owner" || perm === "admin") return true;
  }
  return false;
}

/** The stream's text, or null once it passes `cap` bytes (or can't be read). */
async function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export const serverMcpRoutes = new Hono<AuthEnv>();

// POST/GET/DELETE /mcp — stateless, one server per request, same transport
// shape as the per-nest endpoint.
serverMcpRoutes.all("/", async (c) => {
  const userId = c.get("userId");
  const userEmail = await getUserEmail(userId);
  const headless = await isHeadlessIdentity(userId);
  const capability = c.get("keyCapability") ?? "write";
  const baseUrl = requestBaseUrl(c.req.url);
  // Every readable nest's standing instructions, on the initialize request
  // only (CU-wdqcq05rn0). The index is the same scoped, deduped list
  // nest_index serves, so a nest-scoped key hears about its nest alone.
  let instructions: string | undefined;
  if (await isInitializeRequest(c.req.raw)) {
    try {
      instructions = await serverConnectInstructions(
        await buildNestIndex(userId, c.get("nestScope")),
        { userId, userEmail },
        baseUrl,
      );
    } catch (err) {
      console.error("[mcp] server connect instructions unavailable", err);
    }
  }
  const server = createServerMcp(
    userId,
    userEmail,
    c.get("nestScope"),
    baseUrl,
    c.get("apiKeyId") ?? null,
    c.get("apiKeyLabel") ?? null,
    c,
    headless,
    capability,
    !headless && capability === "write" && (await offersMetacognition(c, userId)),
    instructions,
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
  // Same gate as the nest_index tool: an OAuth grant needs read scope (or
  // write, which implies it). Absent = a key or ticket, which carry no scope.
  const granted = c.get("oauthScope");
  if (granted && !scopeAllows(granted, "nest_index"))
    return c.json(
      { error: "This connection wasn't authorized to read nests — reconnect and approve nests:read.", code: "insufficient_scope" },
      403,
    );
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
  - Targeted reads (\`nest\` required): \`context_get\`, \`context_resolve\`, \`context_comments\`, \`context_versions\`,
    \`context_boards\`, \`context_board_items\`
  - Writes (\`nest\` required): \`nest_create\`, \`context_create\`, \`context_update\`,
    \`context_delete\`, \`context_move\`, \`context_submit_review\`,
    \`context_request_access\` (ask for write access when a write is refused),
    \`context_task_log\` (log what you did on a task: working / done / blocked),
    \`context_bulk_update\` (one change over up to 100 nodes)
- \`${B}/nests/<nest-id>/mcp\` — per-nest, the full toolset. Same names as the
  server-level tools without the \`nest\` argument, plus:
  - read: \`context_init\` (operating instructions plus the nest's always-include documents — call first), \`context_instructions_history\`, \`context_export\`, \`context_table_query\`, \`context_versions\`
  - write: \`context_update\`, \`context_table_rows\` (change table rows by key), \`context_delete\`, \`context_move\`, \`context_request_deletion\`, \`context_request_access\`, \`context_bulk_update\`
  - boards: \`context_boards\`, \`context_board_items\` (a board as a sortable, grouped list)
  - review: \`context_submit_review\`, \`context_approve\`, \`context_reject\`, \`context_review_queue\`, \`context_my_drafts\`
  - comments: \`context_comment\`, \`context_resolve_comment\`
  - people: \`context_stewards\`, \`context_assign_steward\`, \`context_share_nest\`, \`context_grant\`
  - admin: \`context_instructions_update\` (owner/admin: replace CONTEXT.md), \`context_deletion_queue\`, \`context_resolve_deletion\`, \`context_access_requests\`, \`context_resolve_access_request\`, \`context_unsynced_list\`, \`context_sync_folder\`
  - \`workflow_*\` (runs, edges, edge types) when the nest's workflow plane is on
  - metacognition (owner/admin, when \`FEATURE_METACOGNITION\` is on too — also on
    \`${B}/mcp\` with \`nest\`): \`context_metacognition_list\`, \`context_metacognition_suggest\`
    (a starting config read off the agent document), \`context_metacognition_configure\`
    (call with \`dry_run: true\` first and show the person the returned \`summary\`
    before saving), \`context_metacognition_run\`, \`context_metacognition_remove\`; stats via
    \`workflow_runs_list { agent, agent_stats: true }\`
  Sharing a slice is one call: \`context_grant\` with
  \`{ "email", "target_type": "document" | "folder", "target", "role": "read" | "write" }\`
  — \`target\` is a node id (\`nodes/win-loss-log\`) or a folder prefix
  (\`nodes/gtm/deals\`). The recipient reaches exactly that document, or
  everything under that folder, and nothing else in the nest. Owner/admin only.

Both endpoints answer \`initialize\` with \`instructions\`: the nest's CONTEXT.md
(per-nest) and the approved text of its **always-include** documents — the
standing rules for any work in the nest, filtered to what these credentials can
read. Most clients put them in the system prompt; follow them.

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
ctx vault list                                  # lists contextnest/<nest> for each nest
ctx search "pricing" --vault contextnest        # reads span every nest
ctx update nodes/x --tags a,b --vault contextnest/<nest>   # a write names one nest
# or pin one nest by its own endpoint
ctx vault add mynest --url ${B}/nests/<nest-id>/mcp --bearer-env CONTEXTNEST_API_KEY
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
