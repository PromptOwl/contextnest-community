/**
 * Memory snowball over MCP (team chat C6, PO-1199) — the twins of the
 * routes in src/memory/routes.ts. Each tool calls the same service function
 * its REST route calls and returns that object as structuredContent, so the
 * two surfaces cannot drift.
 *
 *   context_remember           POST /threads/:id/remember        (write tier; not behind the channels switch, like context_promote_thread)
 *   context_correct            POST /threads/:id/correct         (write tier; same)
 *   context_decisions          GET  /decisions                   (read; members)
 *   context_channel_knowledge  GET  /channels/:name/knowledge    (read; members; behind EXPERIMENTAL_AGENT_STREAM)
 *   context_channel_watch      GET/PUT /channels/:name/watch, POST …/watch/run   (admin tool; behind the switch)
 *
 * Inline schemas: five Community-only tools (the comment-thread store, the
 * review queue and the metacognition agent are this edition's), so the
 * engine has no descriptor to import (scripts/check-mcp-schemas.mjs
 * baseline 103 → 108, documented there).
 */
import { config } from "../config.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { messageClient } from "../channels/message-meta.js";
import { rememberText, rememberThread } from "../memory/remember.js";
import { correctNode, correctText } from "../memory/correct.js";
import { decisionsText, listDecisions } from "../memory/decisions.js";
import { channelKnowledge, knowledgeText } from "../memory/knowledge.js";
import { getChannelWatch, runChannelWatchAs, runText, setChannelWatch, watchText } from "../memory/watcher.js";
import { channelsHint, READ_ONLY_KEY_REFUSAL } from "./channel-tools.js";
import { toolError, type McpToolContext, type ToolResult } from "./tools.js";

export const MEMORY_TOOL_DEFINITIONS = [
  {
    name: "context_remember",
    description:
      "Remember this: turn one message (message_id) or a whole thread into a proposed node — a note, decision, task or fact — the way your own draft would land: " +
      "on a governed nest a draft in the review queue, requested by you; elsewhere published. The node quotes the source with names and times, its `source_thread` points back at the thread, " +
      "and the thread gets a reply linking it. Remembering the same message (or thread) as the same kind again returns the existing node (`existing: true`). " +
      "Needs write access to the nest; if you declared client.agent, the proposal is under your person's login with you recorded as proposer. Get ids from context_channel_read or context_comments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        thread: { type: "string", description: "The thread (post) id." },
        message_id: { type: "string", description: "One message of the thread to remember; omit for the whole thread." },
        kind: { type: "string", description: 'What it is: "note" (default), "decision", "task" or "fact". Decides the folder (notes/, decisions/, tasks/, facts/) and the tag.' },
        title: { type: "string", description: "The node's title (default: the message's first line, at most 80 characters)." },
        summary: { type: "string", description: "One or two lines in your words, placed above the quoted source." },
        folder: { type: "string", description: "Folder under nodes/ to create it in (overrides the kind's default)." },
      },
      required: ["thread"],
    },
  },
  {
    name: "context_correct",
    description:
      "Mark a message as a correction of a node and propose the edit: a new draft version of that node — its current body with a marked block " +
      '"Correction from #<channel> (<date>), by <name>" quoting the message, or `replacement` as the new body — submitted for review by you; the thread gets a reply linking the node. ' +
      "Needs edit access to the node (ask a writer or @mention one otherwise); a node with a review already pending is refused. The same message against the same node twice returns `existing: true`.",
    inputSchema: {
      type: "object" as const,
      properties: {
        thread: { type: "string", description: "The thread (post) id the message is in." },
        message_id: { type: "string", description: "The message that states the correction." },
        node_id: { type: "string", description: "The node it corrects." },
        replacement: { type: "string", description: "The node's new full body, when the correction is best applied as text rather than appended." },
        note: { type: "string", description: "One line for the reviewer." },
      },
      required: ["thread", "message_id", "node_id"],
    },
  },
  {
    name: "context_decisions",
    description:
      "Lists the decision ledger: every node promoted or remembered as a decision from a conversation, newest first, with who decided, when, its review status and the source thread. Members of the nest only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Decisions per page (default 50, max 200)." },
        offset: { type: "number", description: "Decisions to skip." },
      },
    },
  },
  {
    name: "context_channel_knowledge",
    description:
      "Lists what a channel taught the nest: the nodes produced from its threads — promoted, remembered, corrected, or proposed by the channel watcher — each with its status (draft, pending_review, approved, published, rejected), who and when, plus the open review requests on them.",
    inputSchema: {
      type: "object" as const,
      properties: { channel: { type: "string", description: 'Channel name ("ops"), "#ops" or its node id.' } },
      required: ["channel"],
    },
  },
  {
    name: "context_channel_watch",
    description:
      "Add the nest's metacognition agent to a channel so it proposes what the conversation settled (nodes, edits, relations) as drafts for review — it never posts. " +
      'action "get" (default) shows the watch; "set" saves it: enabled, mode "quiet" (run after quiet_minutes with no new message) or "asks" (only on "@nest remember this"), ' +
      'agent (needed when the nest has several); "run" runs it now. Owner or admin only (reading the setting: any member). Without a model key the setting saves but is inactive.',
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: 'Channel name ("ops"), "#ops" or its node id.' },
        action: { type: "string", description: 'One of "get" (default), "set", "run".' },
        enabled: { type: "boolean", description: "set: false keeps the setting but stops it running." },
        mode: { type: "string", description: 'set: "quiet" or "asks".' },
        quiet_minutes: { type: "number", description: "set, quiet mode: minutes with no new message before it runs (1–1440, default 10)." },
        agent: { type: "string", description: "set: the metacognition agent's node id (needed when the nest has more than one)." },
      },
      required: ["channel"],
    },
  },
];

/** Tools that follow the channels switch (the rest work on document threads too). */
export const MEMORY_CHANNEL_TOOLS = new Set(["context_channel_knowledge", "context_channel_watch"]);
const NAMES = new Set(MEMORY_TOOL_DEFINITIONS.map((t) => t.name));

export function isMemoryTool(name: string): boolean {
  return NAMES.has(name);
}

function refusal(err: unknown): ToolResult {
  if (err instanceof NotFoundError) return toolError(err.message, "DOCUMENT_NOT_FOUND");
  if (err instanceof ForbiddenError) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof ConflictError) return toolError(err.message, "DOCUMENT_ALREADY_EXISTS");
  if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
  if (err instanceof AppError && err.statusCode === 403) return toolError(err.message, "UNAUTHORIZED_ACTION");
  throw err;
}

export async function runMemoryTool(toolName: string, args: Record<string, any>, ctx: McpToolContext): Promise<ToolResult> {
  const caller = { nestId: ctx.nestId, userId: ctx.userId, userEmail: ctx.userEmail };
  if (MEMORY_CHANNEL_TOOLS.has(toolName) && !config.EXPERIMENTAL_AGENT_STREAM) {
    return toolError("Channels are an experimental feature that is not enabled on this server (EXPERIMENTAL_AGENT_STREAM).", "DOCUMENT_NOT_FOUND");
  }
  try {
    switch (toolName) {
      case "context_remember": {
        if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
        const data = await rememberThread(
          { ...caller, client: ctx.client, replyClient: messageClient(ctx.client, args.client, ctx.apiKeyLabel) },
          { thread: args.thread, message_id: args.message_id, kind: args.kind, title: args.title, summary: args.summary, folder: args.folder },
        );
        return { text: rememberText(data), data };
      }
      case "context_correct": {
        if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
        const data = await correctNode(
          { ...caller, client: ctx.client, replyClient: messageClient(ctx.client, args.client, ctx.apiKeyLabel) },
          { thread: args.thread, message_id: args.message_id, node_id: args.node_id, replacement: args.replacement, note: args.note },
        );
        return { text: correctText(data), data };
      }
      case "context_decisions": {
        const data = await listDecisions(caller, { limit: args.limit, offset: args.offset });
        return { text: decisionsText(data), data };
      }
      case "context_channel_knowledge": {
        try {
          const data = await channelKnowledge(caller, args.channel);
          return { text: knowledgeText(data), data };
        } catch (err) {
          if (err instanceof NotFoundError && err.message === "Channel not found") {
            return toolError(`Channel not found: ${String(args.channel ?? "")}.${await channelsHint(ctx)}`, "DOCUMENT_NOT_FOUND");
          }
          throw err;
        }
      }
      case "context_channel_watch": {
        const action = String(args.action ?? "get").toLowerCase();
        const name = String(args.channel ?? "");
        if (action === "get") {
          const data = await getChannelWatch(caller, args.channel);
          return { text: watchText(data.watch, name.replace(/^#/, "")), data };
        }
        if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
        if (action === "set") {
          const data = await setChannelWatch(caller, args.channel, { enabled: args.enabled, mode: args.mode, quiet_minutes: args.quiet_minutes, agent: args.agent });
          return { text: `Saved. ${watchText(data.watch, data.watch.channel)}`, data };
        }
        if (action === "run") {
          const data = await runChannelWatchAs(caller, args.channel);
          return { text: runText(data.result, name.replace(/^#/, "")), data };
        }
        return toolError(`Unknown action "${action}" — use get, set or run.`, "VALIDATION_FAILED");
      }
      default:
        return toolError(`Unknown tool: ${toolName}`, "VALIDATION_FAILED");
    }
  } catch (err) {
    return refusal(err);
  }
}
