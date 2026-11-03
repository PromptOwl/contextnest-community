/**
 * Hootie's tools — what the model may do mid-answer, beyond reading what it
 * was given. A small registry: each tool is declared once (name, description,
 * JSON-schema input, a status line for the panel) with a `run` that acts AS
 * THE CALLER. agent.ts offers them to the model, checks each call against the
 * turn (allowlist, budget), reports it to the panel and frames its result as
 * data; nothing about the loop is specific to one tool.
 *
 * Read-only: `search_nest` (ticket B) and the seven read tools (H1), each a
 * thin wrapper over the MCP operation an external agent would call — through
 * `handleToolCall`, as the signed-in person, so the result is exactly what
 * that person gets from the same op and lands in the same trace and access
 * log, attributed to Hootie. A tool that writes must not run on the model's
 * say-so — it would need the person's approval in the loop first.
 *
 * Must-never 4: every node id, title or board the model passes is checked
 * against the turn's allowlist BEFORE anything runs (`validate`), and the
 * allowlist grows only from what these tools' own results returned.
 */
import { resolveContext, type ContextNodeSummary } from "../nodes/context-service.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { engineCache } from "../nodes/engine.js";
import { handleToolCall, type ToolResult } from "../mcp/tools.js";
import { canUserApproveMany } from "../governance/stewardship-service.js";
import type { BoardListResult } from "../nests/board-items.js";
import type { RelationsResult } from "../nodes/relations.js";
import { defuseFence, type Gathered } from "./retrieval.js";
import { artifactText, isHtmlBody, trimToTokens } from "./artifact-text.js";
import { STATUS } from "./status.js";
import { admitBoard, admitNodeRef, type ToolKind, type TurnContext } from "./turn.js";

export interface ToolOutput {
  /** What the model reads back. */
  content: string;
  isError?: boolean;
}

/** A status line: server template text, and the node it names (a chip). */
export interface StatusLine {
  text: string;
  node?: { id: string; title: string };
}

export interface HootieTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Which budget a call spends (§3.12). */
  kind: ToolKind;
  /**
   * The server's check before anything runs: input shape, allowed values,
   * and every id/title/board against the turn's allowlist. An error message
   * (fixed copy — it never echoes what was asked for) or null.
   */
  validate?(input: unknown): string | null;
  /** The panel's line while it runs ("Searching the nest for …"). */
  status(input: unknown): string | StatusLine | Promise<string | StatusLine>;
  /** Run as the caller. Invalid input is an error result, never a throw. */
  run(input: unknown, signal: AbortSignal): Promise<ToolOutput>;
}

/** Everything a tool may act with: the caller's identity, never more. */
export interface ToolContext {
  nestId: string;
  userId: string;
  userEmail: string;
  baseUrl: string;
  /** Activity-log attribution: Hootie's reads are Hootie's. */
  client: ClientMetadata;
  /** The question's retrieval so far; search results join it, so the answer
   *  can cite them. */
  gathered: Gathered;
  /** The turn: what the model may name, and what it has spent. */
  turn: TurnContext;
  /** Nodes the read tools handed this caller, so an answer can cite them. */
  seen: Map<string, ContextNodeSummary>;
  /** The caller reaches this nest only through document or folder shares:
   *  no board surface for them, as over REST and MCP (security r1 F4). */
  grantOnly?: boolean;
}

/** Tokens per search: two searches stay well under one anchor's budget. */
export const SEARCH_BUDGET = 4000;
/** Tokens of one document body a read hands the model. */
export const READ_BUDGET = 3000;
const MAX_QUERY_CHARS = 300;
const MAX_LIST = 50;

function queryOf(input: unknown): string | null {
  const q = (input as { query?: unknown } | null)?.query;
  if (typeof q !== "string") return null;
  const t = q.replace(/\s+/g, " ").trim();
  return t && t.length <= MAX_QUERY_CHARS ? t : null;
}

/** Let the model name what a server read returned, and cite it. */
function allow(ctx: ToolContext, n: { id: string; title: string; type?: string; tags?: string[] }): void {
  ctx.turn.allowNode(n.id, n.title);
  if (!ctx.gathered.has(n.id) && !ctx.seen.has(n.id)) {
    ctx.seen.set(n.id, { id: n.id, title: n.title, type: n.type ?? "document", tags: n.tags ?? [] });
  }
}

export function searchNestTool(ctx: ToolContext): HootieTool {
  return {
    name: "search_nest",
    kind: "search",
    description:
      "Search this nest for documents. Use it when the documents you have don't answer the question: " +
      "try other words — synonyms, the likely title of the document, the names involved. " +
      "Returns the matching documents you haven't seen yet, which you may cite like the others.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords or a short question, different from what already failed.",
        },
      },
      required: ["query"],
    },
    validate: (input) =>
      queryOf(input) ? null : `query must be a non-empty string of at most ${MAX_QUERY_CHARS} characters.`,
    // One fixed template whatever the nest holds (§3.5 as amended): the
    // query is the model's words, built only from what this person typed or
    // could read, so echoing it reveals nothing — while a line that changed
    // with hidden content would (security r1 F1).
    status: (input) => {
      const q = queryOf(input);
      return q ? `Searching the nest for “${q.length > 80 ? q.slice(0, 79) + "…" : q}”` : "Searching the nest";
    },
    run: async (input) => {
      const query = queryOf(input);
      if (!query) {
        return { content: `query must be a non-empty string of at most ${MAX_QUERY_CHARS} characters.`, isError: true };
      }
      // The same gated path as every other Hootie read — as the caller,
      // recorded as Hootie's read in the activity log.
      const r = await resolveContext({
        nestId: ctx.nestId,
        userId: ctx.userId,
        baseUrl: ctx.baseUrl,
        client: ctx.client,
        body: { prompt: query, max_tokens: SEARCH_BUDGET },
      });
      const { added, repeated } = ctx.gathered.take(r);
      for (const n of r.nodes) ctx.turn.allowNode(n.id, n.title);
      const lines: string[] = [];
      if (added.length === 0) {
        lines.push(
          repeated.length
            ? `Nothing new for "${query}": it only matched documents you already have.`
            : `No documents in this nest match "${query}".`,
        );
      } else {
        lines.push(`${added.length} new document${added.length === 1 ? "" : "s"} for "${query}":`, "", "<documents>");
        lines.push(defuseFence(added.map((a) => a.block).join("\n\n---\n\n")));
        lines.push("</documents>");
      }
      if (added.length && repeated.length) {
        lines.push("", `Also matched, already above: ${repeated.map((n) => `[[${n.title}]]`).join(", ")}.`);
      }
      return { content: lines.join("\n") };
    },
  };
}

// ─── The read tools (H1, §3.2) ─────────────────────────────────────────────

/** The MCP op, as this person, through the one entry point every agent uses:
 *  same gate, same result, same trace and access log — attributed to Hootie. */
async function callOp(ctx: ToolContext, op: string, args: Record<string, unknown>): Promise<ToolResult> {
  const engine = await engineCache.get(ctx.nestId);
  return handleToolCall(op, args, {
    storage: engine.storage,
    queryEngine: engine.query,
    versionManager: engine.versions,
    nestId: ctx.nestId,
    userId: ctx.userId,
    userEmail: ctx.userEmail,
    baseUrl: ctx.baseUrl,
    // A signed-in person, never a key: Hootie runs on no API key.
    apiKeyId: null,
    client: { ...ctx.client, turn_id: ctx.turn.turnId },
  });
}

/** The op's structured payload, or null when it refused / found nothing. */
function dataOf<T>(r: ToolResult): T | null {
  return typeof r === "string" || r.isError ? null : (r.data as T);
}

/** An op's refusal reaches the model as fixed copy: its own error text can
 *  carry a title or id the caller asked about. */
const UNAVAILABLE: ToolOutput = { content: "That isn't available to this person.", isError: true };
const NOT_ALLOWED =
  "Not allowed: name a document only by an id or exact title from this conversation's documents or tool results.";

const nodeRefSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "The document's id, exactly as a result gave it" },
    title: { type: "string", description: "Or its exact title, as a result gave it" },
  },
} as const;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** Only these keys, each passing its check. */
function checkInput(input: unknown, checks: Record<string, (v: unknown) => boolean>): boolean {
  const obj = input ?? {};
  if (!isPlainObject(obj)) return false;
  // Own keys only: a "__proto__" or "constructor" key must not reach a
  // check through the prototype (security r1 F5).
  return Object.entries(obj).every(([k, v]) => v === undefined || (Object.hasOwn(checks, k) && checks[k](v)));
}

const oneOf = (...xs: string[]) => (v: unknown) => typeof v === "string" && xs.includes(v);
const intIn = (lo: number, hi: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const shaped = (re: RegExp) => (v: unknown) => typeof v === "string" && re.test(v);

function taskBits(n: { status?: string; assignee?: string; priority?: string; due?: string; completed_at?: string }): string {
  const bits = [
    n.status,
    n.assignee ? `assignee ${n.assignee}` : null,
    n.priority ? `priority ${n.priority}` : null,
    n.due ? `due ${n.due}` : null,
    n.completed_at ? "done" : null,
  ].filter(Boolean);
  return bits.length ? ` — ${bits.join(", ")}` : "";
}

function getNodeTool(ctx: ToolContext): HootieTool {
  return {
    name: "get_node",
    kind: "read",
    description:
      "Read one document in full — its fields, tags, task details and relations, and its body. " +
      "Name it by the id or exact title a document or tool result gave you.",
    input_schema: nodeRefSchema,
    validate: (input) =>
      checkInput(input, { id: () => true, title: () => true }) && admitNodeRef(ctx.turn, input) ? null : NOT_ALLOWED,
    status: (input) => {
      const id = admitNodeRef(ctx.turn, input)!;
      const title = ctx.turn.allowNodes.get(id)!;
      return { text: STATUS.node(title), node: { id, title } };
    },
    run: async (input) => {
      const id = admitNodeRef(ctx.turn, input);
      if (!id) return { content: NOT_ALLOWED, isError: true };
      const d = dataOf<{
        id: string;
        frontmatter: { title: string; type?: string; tags?: string[]; metadata?: { fields?: Record<string, unknown> } };
        body: string | null;
        assignee?: string;
        due?: string;
        priority?: string;
        relations?: RelationsResult["relations"];
      }>(await callOp(ctx, "context_get", { id }));
      if (!d) return UNAVAILABLE;
      const type = d.frontmatter.type || "document";
      allow(ctx, { id: d.id, title: d.frontmatter.title, type, tags: d.frontmatter.tags });
      let body = d.body || "(no content)";
      if (isHtmlBody(type, body)) body = artifactText(body);
      body = trimToTokens(body, READ_BUDGET).text;
      const fields = d.frontmatter.metadata?.fields;
      const lines = [
        `Title: ${d.frontmatter.title}`,
        `Id: ${d.id}`,
        `Type: ${type}`,
        d.frontmatter.tags?.length ? `Tags: ${d.frontmatter.tags.join(" ")}` : null,
        d.assignee ? `Assignee: ${d.assignee}` : null,
        d.priority ? `Priority: ${d.priority}` : null,
        d.due ? `Due: ${d.due}` : null,
        fields && Object.keys(fields).length
          ? `Fields: ${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("; ")}`
          : null,
        ...relationLines(ctx, d.relations ?? []),
      ].filter(Boolean);
      return { content: `${lines.join("\n")}\n\n---\n\n${body}` };
    },
  };
}

/** Only the relations the caller can read (the op already leaves the others
 *  out of `relations`); no hidden counts, no blocked verdict that rests on
 *  them (§3.2: no "N more hidden"). */
function relationLines(ctx: ToolContext, relations: RelationsResult["relations"]): string[] {
  return relations.map((r) => {
    allow(ctx, { id: r.node.id, title: r.node.title, type: r.node.type });
    return `Relation: ${r.type.replace(/_/g, " ")} ${r.node.title} (${r.node.id}${r.node.done ? ", done" : ""})`;
  });
}

const NODE_STATUSES = ["draft", "pending_review", "approved", "published", "rejected"];

function listNodesTool(ctx: ToolContext): HootieTool {
  return {
    name: "list_nodes",
    kind: "read",
    description:
      "List this nest's documents and tasks you can read, optionally by type, tag or status. " +
      "Each row has the id and title to read it with get_node, and a task's assignee, priority and due date.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Node type, e.g. document or task" },
        tag: { type: "string", description: "A tag (leading # optional)" },
        status: { type: "string", enum: NODE_STATUSES },
        limit: { type: "number", description: `At most this many rows (1–${MAX_LIST})` },
      },
    },
    validate: (input) =>
      checkInput(input, {
        type: shaped(/^[a-z][a-z0-9_-]{0,40}$/),
        tag: shaped(/^#?[\p{L}\p{N}_:./-]{1,80}$/u),
        status: oneOf(...NODE_STATUSES),
        limit: intIn(1, MAX_LIST),
      })
        ? null
        : `Invalid filter: type and tag are single words, status is one of ${NODE_STATUSES.join(" | ")}, limit 1–${MAX_LIST}.`,
    status: () => STATUS.listNodes,
    run: async (input) => {
      const { type, tag, status, limit } = (input ?? {}) as Record<string, any>;
      const d = dataOf<{ documents: Array<{ id: string; title: string; type: string; status: string; tags?: string[]; assignee?: string; due?: string; priority?: string }> }>(
        await callOp(ctx, "context_list", { type, tag, status, limit: limit ?? MAX_LIST }),
      );
      if (!d) return UNAVAILABLE;
      const rows = d.documents.map((n) => {
        allow(ctx, n);
        return `- ${n.title} (${n.id}) [${n.type}]${taskBits(n)}${n.tags?.length ? ` · tags ${n.tags.join(" ")}` : ""}`;
      });
      const head = `${rows.length} document${rows.length === 1 ? "" : "s"}${rows.length ? ":" : "."}`;
      return { content: [head, ...rows].join("\n") };
    },
  };
}

function listBoardsTool(ctx: ToolContext): HootieTool {
  return {
    name: "list_boards",
    kind: "read",
    description: "List this nest's boards you can see: id, name and what the columns are. Read one with board_items.",
    input_schema: { type: "object", properties: {} },
    validate: (input) => (checkInput(input, {}) ? null : "list_boards takes no input."),
    status: () => STATUS.listBoards,
    run: async () => {
      const d = dataOf<{ boards: Array<{ id: string; name: string; dimension: string }> }>(await callOp(ctx, "context_boards", {}));
      if (!d) return UNAVAILABLE;
      const rows = d.boards.map((b) => {
        ctx.turn.allowBoard(b.id, b.name);
        return `- ${b.name} (${b.id}) — columns by ${b.dimension}`;
      });
      return { content: [`${rows.length} board${rows.length === 1 ? "" : "s"}${rows.length ? ":" : "."}`, ...rows].join("\n") };
    },
  };
}

const BOARD_SORTS = ["rank", "title", "status", "assignee", "priority", "due", "updated", "created"];

function boardItemsTool(ctx: ToolContext): HootieTool {
  return {
    name: "board_items",
    kind: "read",
    description:
      "A board's items, grouped into its columns, as you can see them: title, id, status, assignee, priority, due. " +
      "Name the board by an id or name list_boards gave you.",
    input_schema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board id or name from list_boards" },
        sort: { type: "string", enum: BOARD_SORTS },
        dir: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "number", description: "Rows (1–100)" },
      },
      required: ["board"],
    },
    validate: (input) => {
      if (!checkInput(input, { board: () => true, sort: oneOf(...BOARD_SORTS), dir: oneOf("asc", "desc"), limit: intIn(1, 100) })) {
        return `Invalid input: sort is one of ${BOARD_SORTS.join(" | ")}, dir asc | desc, limit 1–100.`;
      }
      return admitBoard(ctx.turn, (input as { board?: unknown }).board)
        ? null
        : "Not allowed: name a board by an id or name list_boards returned in this conversation.";
    },
    status: (input) => STATUS.board(ctx.turn.allowBoards.get(admitBoard(ctx.turn, (input as { board: unknown }).board)!)!),
    run: async (input) => {
      const { board, sort, dir, limit } = input as Record<string, any>;
      const id = admitBoard(ctx.turn, board);
      if (!id) return { content: "Not allowed.", isError: true };
      const d = dataOf<BoardListResult>(await callOp(ctx, "context_board_items", { board: id, sort, dir, limit: limit ?? 100 }));
      if (!d) return UNAVAILABLE;
      const label = new Map(d.groups.map((g) => [g.key, g.label]));
      const count = new Map(d.groups.map((g) => [g.key, g.count]));
      const lines = [`Board “${d.board.name}”: ${d.total} item${d.total === 1 ? "" : "s"}.`];
      let group: string | null = null;
      for (const r of d.items) {
        if (r.group !== group) {
          group = r.group;
          lines.push(`## ${label.get(r.group)} (${count.get(r.group)})`);
        }
        allow(ctx, r);
        // A parent is named only when the caller can read it (the op leaves
        // parent_title off otherwise).
        if (r.parent && r.parent_title) allow(ctx, { id: r.parent, title: r.parent_title });
        lines.push(`- ${r.title} (${r.id})${taskBits(r)}${r.parent && r.parent_title ? ` · parent ${r.parent_title}` : ""}`);
      }
      if (d.items.length < d.total) lines.push(`Showing the first ${d.items.length}.`);
      return { content: lines.join("\n") };
    },
  };
}

function reviewQueueTool(ctx: ToolContext): HootieTool {
  return {
    name: "review_queue",
    kind: "read",
    description: "The documents waiting for review that this person can review (approve or reject).",
    input_schema: { type: "object", properties: {} },
    validate: (input) => (checkInput(input, {}) ? null : "review_queue takes no input."),
    status: () => STATUS.reviewQueue,
    run: async () => {
      const r = await callOp(ctx, "context_review_queue", { status: "pending" });
      // Plain text is the op's "nothing pending"; an error is not "all clear".
      if (typeof r !== "string" && r.isError) return UNAVAILABLE;
      const requests = dataOf<{ requests: Array<{ nodeId: string; title: string | null; version: number; priority: string; requestedBy: string }> }>(r)?.requests ?? [];
      // The queue holds the whole nest's requests; Hootie tells this person
      // only about the ones they may review — the same check approve uses —
      // and counts after that filter.
      const verdicts = await canUserApproveMany(ctx.nestId, requests.map((r) => r.nodeId), ctx.userEmail);
      const mine = requests.filter((r) => verdicts.get(r.nodeId)?.allowed);
      const rows = mine.map((r) => {
        const title = r.title || r.nodeId;
        allow(ctx, { id: r.nodeId, title });
        return `- ${title} (${r.nodeId}) v${r.version} — ${r.priority} priority, submitted by ${r.requestedBy}`;
      });
      const head = `${rows.length} item${rows.length === 1 ? "" : "s"} you can review${rows.length ? ":" : "."}`;
      return { content: [head, ...rows].join("\n") };
    },
  };
}

function nodeFieldsTool(ctx: ToolContext): HootieTool {
  return {
    name: "node_fields",
    kind: "read",
    description: "This nest's custom field definitions: key, label, type and allowed options.",
    input_schema: { type: "object", properties: {} },
    validate: (input) => (checkInput(input, {}) ? null : "node_fields takes no input."),
    status: () => STATUS.fields,
    run: async () => {
      const r = await callOp(ctx, "context_fields", {});
      // Nest configuration, no document content: the op's own words.
      if (typeof r === "string") return { content: r };
      return r.isError ? UNAVAILABLE : { content: r.text };
    },
  };
}

function nodeRelationsTool(ctx: ToolContext): HootieTool {
  return {
    name: "node_relations",
    kind: "read",
    description: "A task's relations — what it blocks, what blocks it, related and duplicate items — by id or exact title.",
    input_schema: nodeRefSchema,
    validate: (input) =>
      checkInput(input, { id: () => true, title: () => true }) && admitNodeRef(ctx.turn, input) ? null : NOT_ALLOWED,
    status: (input) => {
      const id = admitNodeRef(ctx.turn, input)!;
      const title = ctx.turn.allowNodes.get(id)!;
      return { text: STATUS.relations(title), node: { id, title } };
    },
    run: async (input) => {
      const id = admitNodeRef(ctx.turn, input);
      if (!id) return { content: NOT_ALLOWED, isError: true };
      const d = dataOf<RelationsResult>(await callOp(ctx, "context_relations", { id }));
      if (!d) return { content: "No relations to show for that document.", isError: true };
      const lines = relationLines(ctx, d.relations);
      return { content: lines.length ? lines.join("\n") : "No relations you can see." };
    },
  };
}

/** The registry for one question: search first, then the reads. */
export function hootieTools(ctx: ToolContext): HootieTool[] {
  return [
    searchNestTool(ctx),
    getNodeTool(ctx),
    listNodesTool(ctx),
    ...(ctx.grantOnly ? [] : [listBoardsTool(ctx), boardItemsTool(ctx)]),
    reviewQueueTool(ctx),
    nodeFieldsTool(ctx),
    nodeRelationsTool(ctx),
  ];
}
