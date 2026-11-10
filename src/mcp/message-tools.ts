/**
 * Channel messages over MCP (PO-1196, team chat C1) — the twins of the
 * message routes (channels/message-routes.ts). Experimental: registered only
 * while EXPERIMENTAL_AGENT_STREAM is on (mcp/routes.ts) and re-checked here.
 *
 *   context_message_read    one message by id (the permalink lookup), with
 *                           its edit history on request              — read tier
 *   context_message         react | unreact | edit | delete | pin | unpin |
 *                           save | unsave on one message             — write tier
 *   context_channel_search  search a nest's channels, or every nest the
 *                           caller is a member of (`all_nests`)       — read tier
 *
 * Pins are listed with `context_channels { action: "pins", name }` and saved
 * items with `context_my_work { sections: ["saved"] }`, so neither needs a
 * tool of its own. Each tool returns its service's object as
 * structuredContent, the same object REST returns (parity).
 *
 * Inline schemas: Community-only tables over the comment-thread store; the
 * engine has no message operation to import a descriptor from
 * (scripts/check-mcp-schemas.mjs baseline raised 103 → 106, documented).
 */
import { config } from "../config.js";
import { listVisibleNests } from "../nests/service.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { getDb } from "../db/client.js";
import { messageText, type ChannelNewMessage } from "../channels/channel-service.js";
import { messageClient } from "../channels/message-meta.js";
import { RateLimitedError, type ActingCaller } from "../channels/message-access.js";
import { addReaction, removeReaction } from "../channels/reactions.js";
import { deleteMessage, editMessage, messageHistory, type MessageHistory } from "../channels/message-edits.js";
import { pinMessage, unpinMessage } from "../channels/pins.js";
import { saveMessage, unsaveMessage } from "../channels/saved.js";
import { searchAcrossNests, searchChannelMessages, type SearchResult } from "../channels/message-search.js";
import { lookupMessage, type MessageLookup } from "../channels/message-routes.js";
import { mentionsLine } from "../channels/post-message.js";
import { READ_ONLY_KEY_REFUSAL } from "./channel-tools.js";
import { toolError, type McpToolContext, type ToolResult } from "./tools.js";

export const MESSAGE_TOOL_DEFINITIONS = [
  {
    name: "context_message_read",
    description:
      "Read one channel message by its id (or a post's thread id for its opening message): the channel it is in, its thread id, whether it is a reply, " +
      "and the message with its reactions, pinned / saved state, permalink `url`, `edited_at` and tombstone state. " +
      "With `history: true` also returns `edits`: the bodies it had before each edit, newest first. Members of the nest only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "The message id (from context_channel_read: a reply's `id`, or a post's `message_id` / thread id)." },
        history: { type: "boolean", description: "Also return the message's earlier bodies (`edits`)." },
      },
      required: ["message"],
    },
  },
  {
    name: "context_message",
    description:
      "Act on one channel message. `action`: \"react\" / \"unreact\" (with `emoji`: one emoji or a shortcode such as :+1:) adds or removes your reaction; " +
      "\"edit\" (with `body`) changes a message you wrote — an agent only one it wrote itself — keeping the history and re-notifying any name it adds; " +
      "\"delete\" removes a message you wrote (a nest owner or admin may delete anyone's), leaving a tombstone and keeping replies; " +
      "\"pin\" / \"unpin\" pin it in its channel; \"save\" / \"unsave\" keep it in your saved items (context_my_work sections: [\"saved\"]). " +
      "`message` is a message id or, for a post, its thread id. People added to the nest only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "react", "unreact", "edit", "delete", "pin", "unpin", "save", "unsave".' },
        message: { type: "string", description: "The message id (or a post's thread id)." },
        emoji: { type: "string", description: "react / unreact: one emoji (👍) or a shortcode (:+1:, thumbsup, tada, eyes, …)." },
        body: { type: "string", description: "edit: the new text of the message." },
      },
      required: ["action", "message"],
    },
  },
  {
    name: "context_channel_search",
    description:
      "Search channel messages. Every word in `q` must occur (case-insensitive); results come newest first with an `excerpt`, `highlights` (offsets into the excerpt), " +
      "the channel, thread id, message id and permalink `url`. Narrow with `channel` (a name), `from` (a login email, or \"me\"), `before` / `after` (a timestamp or a message id). " +
      "Searches this nest; `all_nests: true` searches every nest you are a member of (a nest-scoped key still sees this nest only). " +
      "At most the 1,000 newest matches are considered (`ceiling`); pass `before` to reach older ones. Deleted messages are never found. Members only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        q: { type: "string", description: "What to search for (at least 2 characters; every word must match)." },
        channel: { type: "string", description: "Only this channel (its name)." },
        from: { type: "string", description: 'Only messages by this login (an email), or "me".' },
        before: { type: "string", description: "Only messages before this timestamp or message id." },
        after: { type: "string", description: "Only messages after this timestamp or message id." },
        limit: { type: "number", description: "Results per page (default 20, max 50)." },
        offset: { type: "number", description: "Results to skip." },
        all_nests: { type: "boolean", description: "Search every nest you are a member of, not only this one." },
      },
      required: ["q"],
    },
  },
];

const NAMES = new Set(MESSAGE_TOOL_DEFINITIONS.map((t) => t.name));

export function isMessageTool(name: string): boolean {
  return NAMES.has(name);
}

function refusal(err: unknown): ToolResult {
  if (err instanceof NotFoundError) return toolError(err.message, "DOCUMENT_NOT_FOUND");
  if (err instanceof ForbiddenError) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof ConflictError) return toolError(err.message, "VALIDATION_FAILED");
  if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
  if (err instanceof RateLimitedError) return toolError(`${err.message} (retry after ${err.retryAfterSeconds}s)`, "VALIDATION_FAILED");
  if (err instanceof AppError && err.statusCode === 403) return toolError(err.message, "UNAUTHORIZED_ACTION");
  throw err;
}

const callerOf = (ctx: McpToolContext, supplied: unknown): ActingCaller => ({
  nestId: ctx.nestId,
  userId: ctx.userId,
  userEmail: ctx.userEmail,
  crossNest: ctx.crossNest === true,
  // The stored attribution names an agent only when the caller declared one
  // (the call's own `client.agent`, or the MCP handshake's name).
  client: messageClient(ctx.client, supplied, ctx.apiKeyLabel),
});

function messageLine(m: ChannelNewMessage, channel: string): string {
  return `**${m.actor.label}** in #${channel} (${m.created_at}) [thread ${m.thread_id}${m.reply ? ", reply" : ""}; message ${m.id}]: ${messageText(m)}\n${m.url}`;
}

export function searchText(r: SearchResult, q: string): string {
  if (r.results.length === 0) return `No messages match "${q}".`;
  const lines = r.results.map(
    (h) => `- **${h.actor.label}** in #${h.channel} · ${h.nest_name} (${h.created_at}) [thread ${h.thread_id}; message ${h.message_id}]: ${h.excerpt}\n  ${h.url}`,
  );
  const { offset, has_more } = r.pagination;
  return `${r.results.length} match(es) for "${q}", newest first${offset ? `, from ${offset}` : ""}:\n${lines.join("\n")}${
    has_more ? `\n\nMore: pass offset ${offset + r.results.length}.` : ""
  }\n\nRead a thread with context_channel_read { channel, thread }; act on a message with context_message { action, message }.`;
}

export async function runMessageTool(toolName: string, args: Record<string, any>, ctx: McpToolContext): Promise<ToolResult> {
  if (!config.EXPERIMENTAL_AGENT_STREAM) {
    return toolError(
      "Channels are an experimental feature that is not enabled on this server (EXPERIMENTAL_AGENT_STREAM).",
      "DOCUMENT_NOT_FOUND",
    );
  }
  try {
    if (toolName === "context_message_read") {
      const caller = callerOf(ctx, undefined);
      const look = await lookupMessage(caller, args.message);
      const data: MessageLookup & { edits?: MessageHistory["edits"] } = { ...look };
      let text = messageLine(look.message, look.channel.name);
      if (args.history === true) {
        // A tombstone has no history to serve: `edits: []`, not a refusal.
        const h = look.message.deleted ? { edits: [] } : await messageHistory(caller, null, args.message);
        data.edits = h.edits;
        text += h.edits.length
          ? `\n\nEarlier versions (newest first):\n${h.edits.map((e) => `- ${e.replaced_at} by ${e.by.label}: ${e.body}`).join("\n")}`
          : "\n\nNever edited.";
      }
      return { text, data };
    }

    if (toolName === "context_channel_search") {
      const q = String(args.q ?? "");
      const input = { q: args.q, channel: args.channel, from: args.from, before: args.before, after: args.after, limit: args.limit, offset: args.offset };
      let data: SearchResult;
      if (args.all_nests === true && ctx.crossNest === true) {
        const names = new Map<string, string>();
        for (const n of await listVisibleNests(ctx.userId)) names.set(n.id, n.name ?? n.id);
        data = await searchAcrossNests({ userId: ctx.userId, userEmail: ctx.userEmail }, names, input);
      } else {
        const nest = (await getDb().get("SELECT name FROM nests WHERE id = ?", [ctx.nestId])) as { name: string } | undefined;
        data = await searchChannelMessages(callerOf(ctx, undefined), nest?.name ?? null, input);
      }
      return { text: searchText(data, q), data };
    }

    if (toolName !== "context_message") return toolError(`Unknown tool: ${toolName}`, "VALIDATION_FAILED");
    if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
    const caller = callerOf(ctx, args.client);
    const action = String(args.action ?? "").toLowerCase();
    switch (action) {
      case "react": {
        const data = await addReaction(caller, null, args.message, args.emoji);
        return { text: `Reacted. Reactions on ${data.message_id}: ${reactionsLine(data.reactions)}`, data };
      }
      case "unreact": {
        const data = await removeReaction(caller, null, args.message, args.emoji);
        return { text: `Removed your reaction. Reactions on ${data.message_id}: ${reactionsLine(data.reactions)}`, data };
      }
      case "edit": {
        const data = await editMessage(caller, null, args.message, args.body);
        const line = mentionsLine(data.mentions);
        return { text: `Edited message ${data.message.id}.${line ? ` ${line}` : ""}\n${data.message.url}`, data };
      }
      case "delete": {
        const data = await deleteMessage(caller, null, args.message);
        return { text: `Deleted message ${data.message.id}; a tombstone keeps its place and its replies.`, data };
      }
      case "pin":
      case "unpin": {
        const data = action === "pin" ? await pinMessage(caller, null, args.message) : await unpinMessage(caller, null, args.message);
        return { text: `Message ${data.message.id} is ${data.message.pinned ? "pinned" : "not pinned"}.`, data };
      }
      case "save":
      case "unsave": {
        const data = action === "save" ? await saveMessage(caller, null, args.message) : await unsaveMessage(caller, null, args.message);
        return { text: `Message ${data.message.id} is ${data.message.saved ? "in" : "out of"} your saved items.`, data };
      }
      default:
        return toolError(`Unknown action "${action}" — use react, unreact, edit, delete, pin, unpin, save or unsave.`, "VALIDATION_FAILED");
    }
  } catch (err) {
    return refusal(err);
  }
}

function reactionsLine(reactions: Array<{ emoji: string; count: number }>): string {
  return reactions.length ? reactions.map((r) => `${r.emoji} ${r.count}`).join(", ") : "none";
}
