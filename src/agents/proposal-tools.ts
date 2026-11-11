/**
 * The propose_* tools a conversation turn offers the model (C7, PO-1198).
 *
 * Hootie never writes. These tools record what the model WANTS to write;
 * nothing runs when they are called. After the answer, ask-nest.ts turns each
 * recorded proposal into the thing this server already has for a write that
 * waits on a person: a draft authored by `hootie` submitted to the review
 * queue (`createNode` / `updateNode` with `alwaysDraft`, then
 * `submitForReview` — the metacognition agent's own path), plus a card in the
 * thread that names the review. A writer decides it with the ordinary
 * approve / reject (REST `…/approve`, MCP `context_approve`), and the approval
 * publishes it as the approver's decision.
 *
 * Same discipline as the read tools (hootie/tools.ts): bounded input, a
 * node named only by an id or title the turn was handed (admitNodeRef), at
 * most `max` proposals per turn, fixed copy back to the model.
 */
import type { HootieTool } from "../hootie/tools.js";
import { admitNodeRef, type TurnContext } from "../hootie/turn.js";

export type ProposalKind = "create_node" | "edit_node";

export interface PendingProposal {
  kind: ProposalKind;
  /** What the write would be: title/type/folder/content, or node_id/append. */
  target: Record<string, unknown>;
  /** The card's text: what a person sees before deciding. Model text. */
  preview: string;
}

const MAX_TITLE = 200;
const MAX_CONTENT = 8000;
const MAX_FOLDER = 80;
const MAX_PREVIEW = 1200;
const FOLDER_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
const NODE_TYPES = ["document", "task"] as const;

/** Lines the system prompt adds when these tools are offered. */
export const PROPOSAL_PROMPT_LINES = [
  "You cannot write to the nest. When the person asks you to create a document or task, or to add something to a document, call propose_create_node or propose_edit_node ONCE per thing: it records a proposal that a writer approves or rejects in the thread — nothing is written by the call. Then tell the person what you proposed, in one line. Never claim that something was created or changed.",
];

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

function preview(head: string, body: string): string {
  const flat = body.replace(/\r/g, "").trim();
  const cut = flat.length > MAX_PREVIEW ? `${flat.slice(0, MAX_PREVIEW - 1)}…` : flat;
  return `${head}\n${cut}`;
}

const CREATE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: `The new document's title (at most ${MAX_TITLE} characters)` },
    content: { type: "string", description: `Its body, markdown (at most ${MAX_CONTENT} characters)` },
    type: { type: "string", enum: [...NODE_TYPES], description: 'document (default) or task' },
    folder: { type: "string", description: 'Folder under nodes/, e.g. "decisions" or "tasks" (optional)' },
  },
  required: ["title", "content"],
} as const;

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    node: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, exactly as a result gave it" },
        title: { type: "string", description: "Or its exact title, as a result gave it" },
      },
    },
    append: { type: "string", description: `Text to add at the end of the document, markdown (at most ${MAX_CONTENT} characters)` },
  },
  required: ["node", "append"],
} as const;

export function proposalTools(ctx: { turn: TurnContext; proposals: PendingProposal[]; max: number }): HootieTool[] {
  const { turn, proposals, max } = ctx;
  const full = () => (proposals.length >= max ? `You have made ${max} proposals this turn; tell the person what else you would propose.` : null);
  const record = (p: PendingProposal) => {
    proposals.push(p);
    return {
      content: `Recorded proposal ${proposals.length} (${p.kind}). Nothing has been written: it will be shown in the thread as a card for a writer to approve or reject. Tell the person what you proposed.`,
    };
  };
  const createTool: HootieTool = {
    name: "propose_create_node",
    kind: "read",
    description:
      "Propose a NEW document or task in this nest. Nothing is created: a writer sees the proposal as a card in the thread and approves or rejects it. Use it when the person asks you to create, record, or write something down.",
    input_schema: CREATE_SCHEMA as unknown as Record<string, unknown>,
    validate: (input) => {
      if (!isPlainObject(input)) return "Invalid input.";
      const keys = Object.keys(input);
      if (!keys.every((k) => Object.hasOwn(CREATE_SCHEMA.properties, k))) return "Invalid input: title, content, type, folder only.";
      if (!text(input.title, MAX_TITLE)) return `title is required (at most ${MAX_TITLE} characters).`;
      if (!text(input.content, MAX_CONTENT)) return `content is required (at most ${MAX_CONTENT} characters).`;
      if (input.type !== undefined && !(NODE_TYPES as readonly unknown[]).includes(input.type)) return "type is document or task.";
      if (input.folder !== undefined) {
        const f = text(input.folder, MAX_FOLDER);
        if (!f || !FOLDER_RE.test(f)) return "folder is lowercase slug segments, e.g. decisions or gtm/deals.";
        if (f === "channels" || f.startsWith("channels/")) return "folder: channels is where channels live; propose documents elsewhere.";
      }
      return null;
    },
    status: () => "Proposing a new document",
    run: async (input) => {
      const spent = full();
      if (spent) return { content: spent, isError: true };
      const i = input as Record<string, unknown>;
      const title = text(i.title, MAX_TITLE)!;
      const content = text(i.content, MAX_CONTENT)!;
      const type = (i.type as string | undefined) ?? "document";
      const folder = i.folder === undefined ? (type === "task" ? "tasks" : undefined) : (text(i.folder, MAX_FOLDER) as string);
      return record({
        kind: "create_node",
        target: { title, type, folder: folder ?? null, content },
        preview: preview(`Create ${type} "${title}"${folder ? ` in nodes/${folder}` : ""}:`, content),
      });
    },
  };
  const editTool: HootieTool = {
    name: "propose_edit_node",
    kind: "read",
    description:
      "Propose adding text to the END of a document you were given this turn (name it by id or exact title). Nothing changes: a writer sees the proposal as a card in the thread and approves or rejects it.",
    input_schema: EDIT_SCHEMA as unknown as Record<string, unknown>,
    validate: (input) => {
      if (!isPlainObject(input)) return "Invalid input.";
      if (!Object.keys(input).every((k) => Object.hasOwn(EDIT_SCHEMA.properties, k))) return "Invalid input: node and append only.";
      if (!text(input.append, MAX_CONTENT)) return `append is required (at most ${MAX_CONTENT} characters).`;
      if (!isPlainObject(input.node) || !Object.keys(input.node).every((k) => k === "id" || k === "title")) return "node is { id } or { title }.";
      return admitNodeRef(turn, input.node)
        ? null
        : "Not allowed: name a document only by an id or exact title from this conversation's documents or tool results.";
    },
    status: (input) => {
      const id = admitNodeRef(turn, (input as { node: unknown }).node)!;
      const title = turn.allowNodes.get(id)!;
      return { text: `Proposing an edit to “${title}”`, node: { id, title } };
    },
    run: async (input) => {
      const spent = full();
      if (spent) return { content: spent, isError: true };
      const i = input as Record<string, unknown>;
      const id = admitNodeRef(turn, i.node);
      if (!id) return { content: "Not allowed.", isError: true };
      const title = turn.allowNodes.get(id)!;
      const append = text(i.append, MAX_CONTENT)!;
      return record({
        kind: "edit_node",
        target: { node_id: id, title, append },
        preview: preview(`Add to "${title}" (${id}):`, append),
      });
    },
  };
  return [createTool, editTool];
}
