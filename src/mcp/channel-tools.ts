/**
 * Channels over MCP (PO-1179; S4b PO-1190) — the REST twins of
 * /nests/:id/channels. Experimental: registered only while
 * EXPERIMENTAL_AGENT_STREAM is on (mcp/routes.ts), and re-checked here.
 *
 *   context_channels      list (default) | agents | mark_read | create | archive | unarchive
 *   context_channel_read  a channel's timeline, one thread, or what is new since
 *
 * Posting is `context_comment { channel, body }` — the same tool and the same
 * @mention fan-out as a document comment; a channel only adds that the poster
 * must be a person added to the nest.
 *
 * Each tool calls the same service function its REST route calls and returns
 * that function's object as structuredContent, so the two surfaces cannot
 * drift (AC-CH-07).
 *
 * A read-only key (AC-AX-06) is offered `context_channels` as a list-only
 * tool (`READ_KEY_TOOL_VIEWS`: a narrower schema and read-only hints, so
 * tools/list tells the truth) and every writing action answers
 * READ_ONLY_KEY_REFUSAL.
 *
 * Inline schemas: channels are Community-only (a node convention plus the
 * comment-thread store); the engine has no channel operation to import a
 * descriptor from (scripts/check-mcp-schemas.mjs baseline raised, documented).
 */
import { config } from "../config.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import {
  createChannel,
  listChannels,
  listKnownAgents,
  markChannelRead,
  readChannel,
  setChannelArchived,
  timelineText,
  type ChannelView,
} from "../channels/channel-service.js";
import { toolError, type McpToolContext, type ToolResult } from "./tools.js";

/** What a write tool answers a read-only key (AC-AX-06). */
export const READ_ONLY_KEY_REFUSAL = "This key is read-only; use a read-write key to post or to change anything.";

export const CHANNEL_TOOL_DEFINITIONS = [
  {
    name: "context_channels",
    description:
      "Channels in this nest: Slack-style conversations where agents and people post, reply in threads and @tag each other, next to the knowledge. " +
      'action "list" (default) returns the channels, each with `unread` (messages by others since you last marked it read) and `last_activity_at`; ' +
      '"agents" returns the agent handles you can @tag and whether tagging one sends a wake-up; "mark_read" clears your unread for one channel; ' +
      '"create" makes one (name, optional purpose) and "archive" / "unarchive" hides or restores one (these three need write access). ' +
      'Post with context_comment { channel: "<name>", body }; read with context_channel_read.',
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "list" (default), "agents", "mark_read", "create", "archive", "unarchive".' },
        name: { type: "string", description: 'Channel name, e.g. "ops" (mark_read, create, archive, unarchive).' },
        purpose: { type: "string", description: "What the channel is for (create). Stored as the channel node's body." },
        include_archived: { type: "boolean", description: "list: include archived channels." },
      },
    },
  },
  {
    name: "context_channel_read",
    description:
      "Read a channel: its top-level posts, latest activity first, each with its reply count and thread id, paged with limit/offset. " +
      "Pass `thread` (a post's id) to read that post and its replies oldest first. Pass `since` (the `next_since` of your last read, or a timestamp) " +
      "to get only the posts and replies written after it, oldest first, with a new `next_since`. `channel` takes the name, \"#name\" or the node id. " +
      'Each message names who wrote it (as "<agent>, on behalf of <person>" when an agent declared itself), lists its `mentions` (person, known agent or nobody), ' +
      "and carries `cards`: the nest artifacts it links ([[wikilinks]], document and hosted-artifact URLs), " +
      "each with title, type, stage and version when you can read it, or marked unresolved when you can't.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: 'Channel name ("ops"), "#ops" or its node id (from context_channels).' },
        thread: { type: "string", description: "A post's id, to read that thread instead of the timeline." },
        since: { type: "string", description: "Return only messages after this: a message id (next_since) or a timestamp." },
        limit: { type: "number", description: "Posts (or new messages) per page (default 50, max 200)." },
        offset: { type: "number", description: "Posts to skip (default 0)." },
      },
      required: ["channel"],
    },
  },
];

const LIST_ONLY_PROPERTIES = {
  action: { type: "string", description: 'One of "list" (default) or "agents".' },
  include_archived: { type: "boolean", description: "list: include archived channels." },
};

/**
 * How a tool is offered to a READ-ONLY key when it differs from the full
 * tool: a subset of the same schema and hints that describe what that key can
 * actually do with it. Only `context_channels` today.
 */
export const READ_KEY_TOOL_VIEWS: Record<
  string,
  {
    description: string;
    schema: { type: "object"; properties: Record<string, unknown> };
    annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  }
> = {
  context_channels: {
    description:
      "List the channels in this nest (action \"list\", the default), or the agent handles that can be @tagged (\"agents\"). " +
      "This key is read-only: it can read channels with context_channel_read, and cannot post, create or archive.",
    schema: { type: "object", properties: LIST_ONLY_PROPERTIES },
    annotations: { title: "List channels", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
};

const NAMES = new Set(CHANNEL_TOOL_DEFINITIONS.map((t) => t.name));

export function isChannelTool(name: string): boolean {
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

function channelLine(c: ChannelView): string {
  const posts = `${c.post_count} post${c.post_count === 1 ? "" : "s"}`;
  const unread = c.unread ? `, ${c.unread} unread` : "";
  const last = c.last_activity_at ? `, last activity ${c.last_activity_at}` : "";
  return `- **${c.title}** (${c.id}) — ${posts}${unread}${last}${c.archived ? ", archived" : ""}${c.purpose ? `: ${c.purpose.split("\n")[0]}` : ""}`;
}

type ChannelCaller = { nestId: string; userId: string; userEmail: string; crossNest: boolean };

const callerOf = (ctx: McpToolContext): ChannelCaller => ({
  nestId: ctx.nestId,
  userId: ctx.userId,
  userEmail: ctx.userEmail,
  crossNest: ctx.crossNest === true,
});

/**
 * " Channels here: #a, #b." — what a wrong channel name is answered with, so
 * the caller's next call can be right (AC-AX-03). Only the channels this
 * caller can read; "" when there are none or channels are off.
 */
export async function channelsHint(ctx: McpToolContext): Promise<string> {
  if (!config.EXPERIMENTAL_AGENT_STREAM) return "";
  const { channels } = await listChannels(callerOf(ctx)).catch(() => ({ channels: [] as ChannelView[] }));
  if (channels.length === 0) return "";
  return ` Channels here: ${channels.map((c) => `#${c.name}`).join(", ")}. Post with context_comment { channel: "<name>", body }.`;
}

export async function runChannelTool(
  toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<ToolResult> {
  if (!config.EXPERIMENTAL_AGENT_STREAM) {
    return toolError(
      "Channels are an experimental feature that is not enabled on this server (EXPERIMENTAL_AGENT_STREAM).",
      "DOCUMENT_NOT_FOUND",
    );
  }
  const caller = callerOf(ctx);
  try {
    if (toolName === "context_channel_read") {
      try {
        const t = await readChannel(caller, {
          channel: args.channel,
          thread: args.thread,
          since: args.since,
          limit: args.limit,
          offset: args.offset,
        });
        return { text: timelineText(t), data: t };
      } catch (err) {
        if (err instanceof NotFoundError && err.message === "Channel not found") {
          return toolError(`Channel not found: ${String(args.channel ?? "")}.${await channelsHint(ctx)}`, "DOCUMENT_NOT_FOUND");
        }
        throw err;
      }
    }

    const action = String(args.action ?? "list").toLowerCase();
    if (action === "list") {
      const data = await listChannels(caller, { includeArchived: args.include_archived === true });
      const text = data.channels.length
        ? `# Channels (${data.channels.length})\n\n${data.channels.map(channelLine).join("\n")}\n\nRead one with context_channel_read { channel: "<name>" }; post with context_comment { channel: "<name>", body }.`
        : 'No channels yet. Create one with context_channels { action: "create", name }.';
      return { text, data };
    }
    if (action === "agents") {
      const data = await listKnownAgents(caller);
      const text = data.agents.length
        ? `# Agents you can @tag (${data.agents.length})\n\n${data.agents
            .map((a) => `- @${a.handle} — ${a.wakeable ? "woken by a mention" : "no webhook: it finds mentions in its context_my_work"}`)
            .join("\n")}`
        : "No known agents in this nest yet. An agent becomes known when an admin gives its handle a webhook, or when it posts in a channel declaring client.agent.";
      return { text, data };
    }
    // Every other action writes — a read-only key is told so plainly.
    if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
    if (action === "mark_read") {
      const data = await markChannelRead(caller, args.name);
      return { text: `Marked ${data.channel.title} read.`, data };
    }
    if (action === "create") {
      const data = await createChannel({ ...caller, client: ctx.client }, { name: args.name, purpose: args.purpose });
      return {
        text: `Created ${data.channel.title} (${data.channel.id}). Post with context_comment { channel: "${data.channel.name}", body }.`,
        data,
      };
    }
    if (action === "archive" || action === "unarchive") {
      const data = await setChannelArchived({ ...caller, client: ctx.client }, args.name, action === "archive");
      return { text: `${data.channel.title} is ${data.channel.archived ? "archived" : "active"}.`, data };
    }
    return toolError(`Unknown action "${action}" — use list, agents, mark_read, create, archive or unarchive.`, "VALIDATION_FAILED");
  } catch (err) {
    return refusal(err);
  }
}
